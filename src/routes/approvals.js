'use strict';
const { Router } = require('express');
const { requireAction } = require('../auth');
const { withIdempotency } = require('../services/idempotency');
const svc = require('../services/approvals');

module.exports = function approvalsRouter(db) {
  const r = Router({ mergeParams: true });

  r.post('/', requireAction('approval:create'),
    (req, res) => withIdempotency(db, req, res, () => svc.create(db, req)));

  r.get('/', requireAction('approval:read'), (req, res) => {
    const out = svc.list(db, req);
    res.status(out.status).json(out.body);
  });

  r.get('/:requestId', requireAction('approval:read'), (req, res) => {
    const out = svc.getOne(db, req);
    res.status(out.status).json(out.body);
  });

  r.post('/:requestId/approve', requireAction('approval:decide'),
    (req, res) => withIdempotency(db, req, res, () => svc.decide(db, req, 'approve')));

  r.post('/:requestId/reject', requireAction('approval:decide'),
    (req, res) => withIdempotency(db, req, res, () => svc.decide(db, req, 'reject')));

  r.post('/:requestId/cancel', requireAction('approval:cancel'),
    (req, res) => withIdempotency(db, req, res, () => svc.decide(db, req, 'cancel')));

  return r;
};
