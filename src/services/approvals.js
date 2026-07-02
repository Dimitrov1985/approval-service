'use strict';
const crypto = require('node:crypto');
const { inTransaction } = require('../db');

const SOURCE_TYPES = ['publication', 'scenario', 'edit', 'external'];
const FINAL_STATUS = { approve: 'approved', reject: 'rejected', cancel: 'cancelled' };

const now = () => new Date().toISOString();
const newId = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

// Public serializer: only whitelisted fields ever leave the service.
// No secrets, tokens, emails, storage keys or provider payloads are stored,
// and nothing outside this list is returned.
function toPublic(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    title: row.title,
    description: row.description,
    reviewerUserIds: JSON.parse(row.reviewer_user_ids),
    status: row.status,
    createdBy: row.created_by,
    decidedBy: row.decided_by,
    decisionComment: row.decision_comment,
    decisionReason: row.decision_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function writeAudit(db, workspaceId, requestId, actorUserId, action, details) {
  db.prepare(
    'INSERT INTO audit_log (id, workspace_id, request_id, actor_user_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(newId('aud'), workspaceId, requestId, actorUserId, action, JSON.stringify(details ?? {}), now());
}

// Outbox pattern: events are written in the same transaction as the change
// and can later be published to a broker by a separate relay.
function emitEvent(db, type, payload) {
  db.prepare(
    'INSERT INTO outbox_events (id, type, payload, created_at) VALUES (?, ?, ?, ?)'
  ).run(newId('evt'), type, JSON.stringify(payload), now());
}

function validationError(messages) {
  return { status: 422, body: { error: { code: 'validation_error', message: messages.join('; ') } } };
}

function getRow(db, workspaceId, requestId) {
  // Workspace is always part of the WHERE clause: rows from another
  // workspace are indistinguishable from missing rows (404, no data leak).
  return db.prepare(
    'SELECT * FROM approval_requests WHERE id = ? AND workspace_id = ?'
  ).get(requestId, workspaceId);
}

function create(db, req) {
  const b = req.body ?? {};
  const errors = [];
  if (!SOURCE_TYPES.includes(b.sourceType)) errors.push(`sourceType must be one of: ${SOURCE_TYPES.join(', ')}`);
  if (typeof b.sourceId !== 'string' || !b.sourceId.trim()) errors.push('sourceId is required');
  if (typeof b.title !== 'string' || !b.title.trim()) errors.push('title is required');
  if (b.description != null && typeof b.description !== 'string') errors.push('description must be a string');
  if (!Array.isArray(b.reviewerUserIds) || b.reviewerUserIds.length === 0
      || !b.reviewerUserIds.every((x) => typeof x === 'string' && x.trim())) {
    errors.push('reviewerUserIds must be a non-empty array of strings');
  }
  if (errors.length) return validationError(errors);

  const id = newId('apr');
  const ts = now();
  const { workspaceId, userId } = req.auth;

  inTransaction(db, () => {
    db.prepare(
      `INSERT INTO approval_requests
        (id, workspace_id, source_type, source_id, title, description, reviewer_user_ids, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    ).run(id, workspaceId, b.sourceType, b.sourceId, b.title.trim(), b.description ?? null,
      JSON.stringify(b.reviewerUserIds), userId, ts, ts);
    writeAudit(db, workspaceId, id, userId, 'approval_request.created',
      { sourceType: b.sourceType, sourceId: b.sourceId });
    emitEvent(db, 'approval_request.created',
      { requestId: id, workspaceId, sourceType: b.sourceType, sourceId: b.sourceId, createdBy: userId, occurredAt: ts });
  });

  return { status: 201, body: toPublic(getRow(db, workspaceId, id)) };
}

function list(db, req) {
  const { status } = req.query;
  const limit = Math.min(Number.parseInt(req.query.limit ?? '50', 10) || 50, 200);
  const offset = Math.max(Number.parseInt(req.query.offset ?? '0', 10) || 0, 0);

  let where = 'workspace_id = ?';
  const params = [req.auth.workspaceId];
  if (status) {
    if (!['pending', 'approved', 'rejected', 'cancelled'].includes(status)) {
      return validationError(['status filter must be one of: pending, approved, rejected, cancelled']);
    }
    where += ' AND status = ?';
    params.push(status);
  }
  const rows = db.prepare(
    `SELECT * FROM approval_requests WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM approval_requests WHERE ${where}`).get(...params);

  return { status: 200, body: { items: rows.map(toPublic), total: Number(n), limit, offset } };
}

function getOne(db, req) {
  const row = getRow(db, req.auth.workspaceId, req.params.requestId);
  if (!row) return { status: 404, body: { error: { code: 'not_found', message: 'Approval request not found' } } };
  return { status: 200, body: toPublic(row) };
}

function decide(db, req, action) {
  const b = req.body ?? {};
  if (action === 'approve') {
    if (b.comment != null && typeof b.comment !== 'string') return validationError(['comment must be a string']);
  } else if (typeof b.reason !== 'string' || !b.reason.trim()) {
    return validationError(['reason is required']);
  }

  const { workspaceId, userId } = req.auth;
  const target = FINAL_STATUS[action];

  return inTransaction(db, () => {
    const row = getRow(db, workspaceId, req.params.requestId);
    if (!row) return { status: 404, body: { error: { code: 'not_found', message: 'Approval request not found' } } };

    // A request in a final state can never move to another final state.
    if (row.status !== 'pending') {
      return { status: 409, body: { error: { code: 'invalid_state', message: `Request is already ${row.status} and cannot be ${target}` } } };
    }

    const ts = now();
    const comment = action === 'approve' ? (b.comment ?? null) : null;
    const reason = action === 'approve' ? null : b.reason.trim();

    db.prepare(
      `UPDATE approval_requests
       SET status = ?, decided_by = ?, decision_comment = ?, decision_reason = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'pending'`
    ).run(target, userId, comment, reason, ts, row.id, workspaceId);

    writeAudit(db, workspaceId, row.id, userId, `approval_request.${target}`,
      action === 'approve' ? { comment } : { reason });
    emitEvent(db, `approval_request.${target}`,
      { requestId: row.id, workspaceId, decidedBy: userId, occurredAt: ts });

    return { status: 200, body: toPublic(getRow(db, workspaceId, row.id)) };
  });
}

module.exports = { create, list, getOne, decide };
