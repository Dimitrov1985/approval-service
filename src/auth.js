'use strict';
// Auth stub for local runs.
// The request must identify: workspace (X-Workspace-Id), user (X-User-Id)
// and a list of granted actions (X-Actions, comma-separated).
// Example: X-Actions: approval:read,approval:create

function auth(req, res, next) {
  const userId = req.header('X-User-Id');
  const workspaceId = req.header('X-Workspace-Id');
  const actions = (req.header('X-Actions') || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  if (!userId || !workspaceId) {
    return res.status(401).json({ error: { code: 'unauthorized', message: 'X-User-Id and X-Workspace-Id headers are required' } });
  }
  if (workspaceId !== req.params.workspaceId) {
    return res.status(403).json({ error: { code: 'forbidden', message: 'Token workspace does not match requested workspace' } });
  }
  req.auth = { userId, workspaceId, actions };
  next();
}

function requireAction(action) {
  return (req, res, next) => {
    if (!req.auth.actions.includes(action)) {
      return res.status(403).json({ error: { code: 'forbidden', message: `Missing required action: ${action}` } });
    }
    next();
  };
}

module.exports = { auth, requireAction };
