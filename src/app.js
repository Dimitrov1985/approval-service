'use strict';
const express = require('express');
const path = require('node:path');
const { auth } = require('./auth');
const approvalsRouter = require('./routes/approvals');

function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  // Request log: method, path, status, duration. Never bodies or headers,
  // so no secrets/tokens/emails can end up in logs.
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      console.log(`${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${ms.toFixed(1)}ms`);
    });
    next();
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/ready', (_req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'not_ready' });
    }
  });

  app.use('/api/v1/workspaces/:workspaceId/approval-requests', auth, approvalsRouter(db));

  app.use((_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'bad_request', message: 'Invalid JSON body' } });
    }
    console.error(`unhandled_error ${err.name}: ${err.message}`);
    res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } });
  });

  return app;
}

module.exports = { createApp };
