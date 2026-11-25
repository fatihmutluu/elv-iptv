# @elv/sync-server

Self-hostable zero-knowledge E2EE sync, universal QR pairing, and opt-in redacted telemetry/feedback backend.

## Runtimes
- **Cloudflare Workers + D1**: `src/worker.ts` + `wrangler.toml` + `migrations/0001_init.sql`.
- **Node 24 HTTP**: `pnpm --filter @elv/sync-server start` (`src/node-server.ts`, in-memory storage).
- Zero third-party runtime dependencies; uses Web Standard `Request`/`Response`/`crypto.subtle` and `node:http` (Node entry only).

## Routes
- `GET /health` — liveness probe.
- `GET /account-deletion`, `POST /account-deletion` — public EN/TR account deletion guide and non-enumerating request form.
- `POST /v1/auth/register`, `POST /v1/auth/login`, `POST /v1/auth/refresh`, `POST /v1/auth/logout`, `DELETE /v1/auth/account`.
- `POST /v1/pair/create`, `POST /v1/pair/claim`, `GET /v1/pair/poll/:id` (5m TTL, single-use atomic consumption).
- `GET /v1/vault`, `PUT /v1/vault` (optimistic concurrency via `expectedRevision`, opaque ciphertext only).
- `POST /v1/telemetry`, `POST /v1/feedback` (strict allowlist + secret/URL/path rejection + remote kill-switch).
- `GET /v1/admin/digest` (constant-time `Bearer <ADMIN_TOKEN>`).

## Commands & Rules
- `pnpm --filter @elv/sync-server test` — Vitest + v8 coverage (`>= 90%` lines).
- `pnpm --filter @elv/sync-server typecheck` — `tsc --noEmit`.
- Use `.ts` relative import suffixes and erasable TypeScript so Node 24 runs `src/node-server.ts` directly.
- Never store raw passwords, vault keys, stream URLs, credentials, IPs, or watched titles.
