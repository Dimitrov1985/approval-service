'use strict';
const crypto = require('node:crypto');

// Replays a stored response when the same client request is retried
// with the same Idempotency-Key, so retries never create duplicates.
function withIdempotency(db, req, res, handler) {
  const key = req.header('Idempotency-Key');
  if (!key) {
    const out = handler();
    return res.status(out.status).json(out.body);
  }
  const endpoint = `${req.method} ${req.baseUrl}${req.path}`;
  const requestHash = crypto.createHash('sha256')
    .update(JSON.stringify(req.body ?? {})).digest('hex');

  const existing = db.prepare(
    'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE workspace_id = ? AND key = ? AND endpoint = ?'
  ).get(req.auth.workspaceId, key, endpoint);

  if (existing) {
    if (existing.request_hash !== requestHash) {
      return res.status(409).json({ error: { code: 'idempotency_conflict', message: 'Idempotency-Key was already used with a different request body' } });
    }
    res.set('Idempotency-Replayed', 'true');
    return res.status(Number(existing.response_status)).json(JSON.parse(existing.response_body));
  }

  const out = handler();
  if (out.status < 500) {
    db.prepare(
      'INSERT INTO idempotency_keys (workspace_id, key, endpoint, request_hash, response_status, response_body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(req.auth.workspaceId, key, endpoint, requestHash, out.status, JSON.stringify(out.body), new Date().toISOString());
  }
  return res.status(out.status).json(out.body);
}

module.exports = { withIdempotency };
