'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { openDb, migrate } = require('../src/db');
const { createApp } = require('../src/app');

function makeApp() {
  const db = openDb(':memory:');
  migrate(db);
  return { app: createApp(db), db };
}

const ALL = 'approval:read,approval:create,approval:decide,approval:cancel';
const H = (ws, user = 'usr_1', actions = ALL) => ({
  'X-Workspace-Id': ws, 'X-User-Id': user, 'X-Actions': actions,
});
const BODY = {
  sourceType: 'publication', sourceId: 'pub_123',
  title: 'Instagram reel draft', description: 'Needs final approval',
  reviewerUserIds: ['usr_1', 'usr_2'],
};
const BASE = (ws) => `/api/v1/workspaces/${ws}/approval-requests`;

test('health and ready respond', async () => {
  const { app } = makeApp();
  assert.equal((await request(app).get('/health')).status, 200);
  assert.equal((await request(app).get('/ready')).status, 200);
});

test('401 without auth headers', async () => {
  const { app } = makeApp();
  const res = await request(app).get(BASE('ws_1'));
  assert.equal(res.status, 401);
});

test('403 when token workspace does not match path workspace', async () => {
  const { app } = makeApp();
  const res = await request(app).get(BASE('ws_1')).set(H('ws_2'));
  assert.equal(res.status, 403);
});

test('403 when required action is missing', async () => {
  const { app } = makeApp();
  const res = await request(app).post(BASE('ws_1')).set(H('ws_1', 'usr_1', 'approval:read')).send(BODY);
  assert.equal(res.status, 403);
});

test('create, get one, list', async () => {
  const { app } = makeApp();
  const created = await request(app).post(BASE('ws_1')).set(H('ws_1')).send(BODY);
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'pending');
  assert.equal(created.body.createdBy, 'usr_1');
  assert.deepEqual(created.body.reviewerUserIds, ['usr_1', 'usr_2']);

  const one = await request(app).get(`${BASE('ws_1')}/${created.body.id}`).set(H('ws_1'));
  assert.equal(one.status, 200);
  assert.equal(one.body.id, created.body.id);

  const listed = await request(app).get(BASE('ws_1')).set(H('ws_1'));
  assert.equal(listed.status, 200);
  assert.equal(listed.body.total, 1);
  assert.equal(listed.body.items[0].id, created.body.id);
});

test('validation: 422 on bad payload', async () => {
  const { app } = makeApp();
  const res = await request(app).post(BASE('ws_1')).set(H('ws_1'))
    .send({ sourceType: 'nope', title: '', reviewerUserIds: [] });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'validation_error');
});

test('workspace isolation: another workspace sees nothing', async () => {
  const { app } = makeApp();
  const created = await request(app).post(BASE('ws_a')).set(H('ws_a')).send(BODY);
  assert.equal(created.status, 201);

  const foreignGet = await request(app).get(`${BASE('ws_b')}/${created.body.id}`).set(H('ws_b'));
  assert.equal(foreignGet.status, 404);

  const foreignList = await request(app).get(BASE('ws_b')).set(H('ws_b'));
  assert.equal(foreignList.body.total, 0);

  const foreignDecision = await request(app)
    .post(`${BASE('ws_b')}/${created.body.id}/approve`).set(H('ws_b')).send({});
  assert.equal(foreignDecision.status, 404);
});

test('idempotency: same key replays, no duplicates; same key + other body → 409', async () => {
  const { app, db } = makeApp();
  const key = 'idem-123';
  const first = await request(app).post(BASE('ws_1')).set(H('ws_1')).set('Idempotency-Key', key).send(BODY);
  const second = await request(app).post(BASE('ws_1')).set(H('ws_1')).set('Idempotency-Key', key).send(BODY);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(second.body.id, first.body.id);
  assert.equal(second.headers['idempotency-replayed'], 'true');

  const { n } = db.prepare('SELECT COUNT(*) AS n FROM approval_requests').get();
  assert.equal(Number(n), 1);

  const conflict = await request(app).post(BASE('ws_1')).set(H('ws_1'))
    .set('Idempotency-Key', key).send({ ...BODY, title: 'Other title' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'idempotency_conflict');
});

test('approve is final: reject/cancel afterwards → 409', async () => {
  const { app } = makeApp();
  const created = await request(app).post(BASE('ws_1')).set(H('ws_1')).send(BODY);

  const approved = await request(app)
    .post(`${BASE('ws_1')}/${created.body.id}/approve`)
    .set(H('ws_1', 'usr_2')).send({ comment: 'Approved' });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, 'approved');
  assert.equal(approved.body.decidedBy, 'usr_2');
  assert.equal(approved.body.decisionComment, 'Approved');

  const rejected = await request(app)
    .post(`${BASE('ws_1')}/${created.body.id}/reject`)
    .set(H('ws_1', 'usr_2')).send({ reason: 'Brand tone is wrong' });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error.code, 'invalid_state');

  const cancelled = await request(app)
    .post(`${BASE('ws_1')}/${created.body.id}/cancel`)
    .set(H('ws_1')).send({ reason: 'Draft was removed' });
  assert.equal(cancelled.status, 409);
});

test('reject and cancel require a reason', async () => {
  const { app } = makeApp();
  const created = await request(app).post(BASE('ws_1')).set(H('ws_1')).send(BODY);
  const noReason = await request(app)
    .post(`${BASE('ws_1')}/${created.body.id}/reject`).set(H('ws_1')).send({});
  assert.equal(noReason.status, 422);

  const cancelled = await request(app)
    .post(`${BASE('ws_1')}/${created.body.id}/cancel`)
    .set(H('ws_1')).send({ reason: 'Draft was removed' });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal(cancelled.body.decisionReason, 'Draft was removed');
});

test('every successful change leaves an audit trail and an outbox event', async () => {
  const { app, db } = makeApp();
  const created = await request(app).post(BASE('ws_1')).set(H('ws_1')).send(BODY);
  await request(app)
    .post(`${BASE('ws_1')}/${created.body.id}/approve`)
    .set(H('ws_1', 'usr_2')).send({ comment: 'ok' });

  const audit = db.prepare('SELECT action, actor_user_id FROM audit_log ORDER BY created_at').all();
  assert.deepEqual(audit.map((a) => a.action), ['approval_request.created', 'approval_request.approved']);
  assert.equal(audit[0].actor_user_id, 'usr_1');
  assert.equal(audit[1].actor_user_id, 'usr_2');

  const events = db.prepare('SELECT type FROM outbox_events ORDER BY created_at').all();
  assert.deepEqual(events.map((e) => e.type), ['approval_request.created', 'approval_request.approved']);
});

test('public payload contains only whitelisted fields', async () => {
  const { app } = makeApp();
  const created = await request(app).post(BASE('ws_1')).set(H('ws_1')).send(BODY);
  const expected = ['id', 'workspaceId', 'sourceType', 'sourceId', 'title', 'description',
    'reviewerUserIds', 'status', 'createdBy', 'decidedBy', 'decisionComment',
    'decisionReason', 'createdAt', 'updatedAt'];
  assert.deepEqual(Object.keys(created.body).sort(), [...expected].sort());
});

test('status filter in list', async () => {
  const { app } = makeApp();
  const a = await request(app).post(BASE('ws_1')).set(H('ws_1')).send(BODY);
  await request(app).post(BASE('ws_1')).set(H('ws_1')).send({ ...BODY, title: 'Second' });
  await request(app).post(`${BASE('ws_1')}/${a.body.id}/approve`).set(H('ws_1')).send({});

  const pending = await request(app).get(`${BASE('ws_1')}?status=pending`).set(H('ws_1'));
  assert.equal(pending.body.total, 1);
  const approved = await request(app).get(`${BASE('ws_1')}?status=approved`).set(H('ws_1'));
  assert.equal(approved.body.total, 1);
});
