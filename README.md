# approval-service

Backend service for content approval: accepts approval requests for content (publications, scenarios, edits, external items) and records the final decision — approve, reject or cancel.

Stack: **Node.js 22 + Express + SQLite** (built-in `node:sqlite`, zero native dependencies).

## Run locally

Requires Node.js >= 22.

```bash
npm install
npm start            # http://localhost:3000, DB file at ./data/approval.db
```

Migrations run automatically on startup (see `migrations/`, tracked in `schema_migrations`).

A minimal test UI is available at http://localhost:3000 (not part of the task, just convenient for poking the API).

## Run with Docker

```bash
docker compose up --build
# service on http://localhost:3000, data persisted in the approval-data volume
```

## Run tests

```bash
npm test
```

13 integration tests cover auth, validation, workspace isolation, idempotency, final-state transitions, audit trail and outbox events.

## Auth (local stub)

Every `/api/v1/**` request must carry three headers:

| Header | Meaning | Example |
|---|---|---|
| `X-User-Id` | acting user | `usr_1` |
| `X-Workspace-Id` | authenticated workspace, must match the workspace in the path | `ws_1` |
| `X-Actions` | comma-separated granted actions | `approval:read,approval:create` |

Actions: `approval:read` (GET), `approval:create` (create), `approval:decide` (approve/reject), `approval:cancel` (cancel).
Missing identity → `401`. Workspace mismatch or missing action → `403`.

## API

```
GET  /health
GET  /ready
POST /api/v1/workspaces/{workspace_id}/approval-requests
GET  /api/v1/workspaces/{workspace_id}/approval-requests?status=&limit=&offset=
GET  /api/v1/workspaces/{workspace_id}/approval-requests/{request_id}
POST /api/v1/workspaces/{workspace_id}/approval-requests/{request_id}/approve   { "comment": "Approved" }
POST /api/v1/workspaces/{workspace_id}/approval-requests/{request_id}/reject    { "reason": "Brand tone is wrong" }
POST /api/v1/workspaces/{workspace_id}/approval-requests/{request_id}/cancel    { "reason": "Draft was removed" }
```

### Example

```bash
curl -X POST http://localhost:3000/api/v1/workspaces/ws_1/approval-requests \
  -H 'Content-Type: application/json' \
  -H 'X-User-Id: usr_1' -H 'X-Workspace-Id: ws_1' \
  -H 'X-Actions: approval:create' \
  -H 'Idempotency-Key: 4f7c2a1e' \
  -d '{
    "sourceType": "publication",
    "sourceId": "pub_123",
    "title": "Instagram reel draft",
    "description": "Needs final approval",
    "reviewerUserIds": ["usr_1", "usr_2"]
  }'
```

## Idempotency

Send an `Idempotency-Key` header with any POST. Retrying the same key + same body replays the stored response (`Idempotency-Replayed: true` header) and never creates duplicates. Same key + different body → `409 idempotency_conflict`.

## Guarantees

- **Workspace isolation** — workspace is part of every query; foreign rows look like `404`.
- **Final states are final** — `approved` / `rejected` / `cancelled` can never transition again (`409 invalid_state`); the state check and update happen in one transaction.
- **Audit trail** — every successful change writes who/what/when to `audit_log`.
- **Events** — every change also writes an event to `outbox_events` in the same transaction, ready for a future relay to a message broker.
- **No secrets in output** — responses are built from an explicit field whitelist; logs contain method/path/status only, never bodies or headers.

See `DESIGN.md` for details and trade-offs.
