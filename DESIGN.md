# DESIGN

## Data model

Four tables (see `migrations/001_init.sql`):

- **approval_requests** — the aggregate. `status` ∈ pending | approved | rejected | cancelled (enforced by CHECK). `reviewer_user_ids` stored as a JSON array — the service never joins on reviewers, they are opaque external IDs. `decision_comment` (approve) and `decision_reason` (reject/cancel) are separate columns to keep semantics explicit.
- **audit_log** — append-only trail: who (actor_user_id), what (action), on which request, when, plus a small JSON `details` snapshot.
- **idempotency_keys** — stored responses keyed by (workspace_id, key, endpoint) with a hash of the request body.
- **outbox_events** — events written transactionally with the change; `published_at IS NULL` marks unpublished ones.

## Service boundaries

The service owns only the approval process. Publications, scenarios, users and workspaces live in neighbouring services and are referenced by opaque string IDs (`sourceId`, `reviewerUserIds`, `workspace_id`). No foreign-key or existence checks against them — validating that `pub_123` exists is the source service's job, and coupling here would make the service unable to accept requests when neighbours are down.

Authorization is delegated to the caller (API gateway / auth service in real life): the service trusts the identity and action list presented by the auth stub and only enforces them.

## Workspace isolation

`workspace_id` comes from the authenticated context and is part of the WHERE clause of every query. A row from another workspace is indistinguishable from a missing row (404) — no existence leak. Additionally the stub rejects requests where the token workspace doesn't match the path workspace (403).

## Handling retries (idempotency)

POST endpoints accept an `Idempotency-Key`. First execution stores `(key, endpoint, body-hash, response)`; a retry with the same key and body replays the stored response, a retry with the same key and a different body gets `409`. Keys are scoped per workspace. Decision endpoints are additionally guarded by the state machine: even without a key, a repeated approve hits the `pending`-only transition and cannot produce a second final state.

## State machine

`pending` is the only non-final state. Transitions: pending → approved | rejected | cancelled. The check (`status = 'pending'`) and the UPDATE run inside one transaction, and the UPDATE itself carries `AND status = 'pending'`, so two concurrent decisions cannot both win.

## Events / integrations

Transactional outbox: the domain change, the audit record and the event are committed atomically. Event types: `approval_request.created|approved|rejected|cancelled`; payloads carry only IDs and metadata (requestId, workspaceId, actor, occurredAt) — consumers fetch details via the API if needed, and no sensitive content can leak through the broker. A separate relay process (not part of the task) would poll `published_at IS NULL` and publish to Kafka/RabbitMQ/etc., marking rows as published.

## Keeping secrets out

- Responses are produced by a single whitelist serializer (`toPublic`); nothing else is ever returned.
- Request logging records method, path, status and duration — never headers, bodies or query strings.
- Event payloads contain only identifiers and timestamps.
- The service stores no tokens, emails, storage keys or provider payloads at all.

## Known trade-offs

- **SQLite + single process** — chosen for a friction-free local run. The SQL is standard; moving to PostgreSQL means swapping the driver and rerunning migrations. Concurrency guarantees currently lean on SQLite's single-writer model.
- **Auth stub via headers** — deliberately trivial; in production this would be a JWT/OIDC token validated at the gateway, with the same {workspace, user, actions} claims.
- **Idempotency keys are never evicted** — a TTL cleanup job would be needed in production.
- **Offset pagination** — fine at this scale; cursor pagination would be the next step.
- **No optimistic locking on updates beyond the status guard** — sufficient for the current state machine, would revisit if requests become mutable.
