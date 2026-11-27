# @elv/sync-server

Self-hostable zero-knowledge E2EE sync, universal QR pairing, and opt-in redacted telemetry/feedback backend.

## Runtimes
- **Cloudflare Workers + D1**: `src/worker.ts` + `wrangler.toml` + `migrations/0001_init.sql`, `migrations/0002_wave_p9_pairing_telemetry.sql`.
- **Node 24 HTTP**: `pnpm --filter @elv/sync-server start` (`src/node-server.ts`, in-memory storage).
- Zero third-party runtime dependencies; uses Web Standard `Request`/`Response`/`crypto.subtle` and `node:http` (Node entry only).

## Routes
- `GET /health` — liveness probe.
- `GET /account-deletion`, `POST /account-deletion` — public EN/TR account deletion guide and non-enumerating request form.
- `POST /v1/auth/register`, `POST /v1/auth/login`, `POST /v1/auth/refresh`, `POST /v1/auth/logout`, `POST /v1/auth/pair-token`, `DELETE /v1/auth/account`.
- `POST /v1/pair/create`, `POST /v1/pair/lookup`, `POST /v1/pair/respond`, `POST /v1/pair/transfer`, `POST /v1/pair/approve`, `POST /v1/pair/cancel`, `POST /v1/pair/claim` (legacy), `GET /v1/pair/poll/:id` (strict 2-phase SAS-gated 8-digit X25519 bidirectional pairing, 5m TTL, 3-attempt lockout, atomic single-responder & burn-after-read payload consumption).
- `GET /v1/vault`, `PUT /v1/vault` (optimistic concurrency via `expectedRevision`, opaque ciphertext only).
- `POST /v1/telemetry`, `POST /v1/feedback` (strict 13-kind allowlist + sanitized `deviceProfile` + secret/URL/path/email rejection + remote kill-switch).
- `GET /v1/admin/digest` (constant-time `Bearer <ADMIN_TOKEN>`; includes crashes/errors, catalog imports, and device technical profiles).

## Commands & Rules
- `pnpm --filter @elv/sync-server test` — Vitest + v8 coverage (`>= 90%` lines).
- `pnpm --filter @elv/sync-server typecheck` — `tsc --noEmit`.
- Use `.ts` relative import suffixes and erasable TypeScript so Node 24 runs `src/node-server.ts` directly.
- Never store raw passwords, vault keys, stream URLs, credentials, IPs, or watched titles.
