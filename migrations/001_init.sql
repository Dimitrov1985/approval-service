CREATE TABLE approval_requests (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL,
  source_type       TEXT NOT NULL CHECK (source_type IN ('publication','scenario','edit','external')),
  source_id         TEXT NOT NULL,
  title             TEXT NOT NULL,
  description       TEXT,
  reviewer_user_ids TEXT NOT NULL DEFAULT '[]',
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  created_by        TEXT NOT NULL,
  decided_by        TEXT,
  decision_comment  TEXT,
  decision_reason   TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_requests_workspace ON approval_requests (workspace_id, created_at DESC);

CREATE TABLE audit_log (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  request_id    TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  action        TEXT NOT NULL,
  details       TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_audit_request ON audit_log (request_id, created_at);

CREATE TABLE idempotency_keys (
  workspace_id    TEXT NOT NULL,
  key             TEXT NOT NULL,
  endpoint        TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body   TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key, endpoint)
);

CREATE TABLE outbox_events (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  payload      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  published_at TEXT
);
