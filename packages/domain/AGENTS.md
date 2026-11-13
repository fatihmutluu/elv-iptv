# domain (`@elv/domain`)

Models, ids, Result/errors, clock, logging and the ports (storage, sql, http, keys, secure store).

## Commands
- `pnpm --filter @elv/domain typecheck` type-checks this package.
- `pnpm --filter @elv/domain test` runs its Vitest tests.
- `pnpm -w check` runs every repository check.

## Rules
- Pure TypeScript: no `react`, `react-native`, `expo*`, `electron` or `node:*` imports.
  Platform access goes through ports defined in `@elv/domain`.
- Source-first: `exports` points at `src/index.ts`; there is no build step.
- Allowed workspace dependencies: none.
- Tests live beside the code as `*.test.ts`.

## Public surface (scanners round)
- `Result`, `ElvError`, `ok`, `err`, `elvError` in `result.ts`; error details never carry credentials.
- `HttpClient`, `FetchLike`, `createFetchHttpClient`, `httpStatusError`, `Decompressor` in `http.ts` (port plus a fetch adapter); a non-2xx status is `auth/http-401|403` or `network/http-<status>` everywhere (`httpStatusError`). Callers must iterate or discard every body; a GET that fails before any response with a connection-reset-class error (`ECONNRESET`, `EPIPE`, `UND_ERR_SOCKET`, "other side closed") is retried exactly once (stale keep-alive sockets), sharing the original timeout and never after an abort; a silent body ends with
  `network`/`timeout` after `idleTimeoutMs` (default 30 s) and an abort with `network`/`aborted`.
- `SqlDriver`, `SqlValue`, `SecretStore`, `Scheduler` in `sql.ts` (catalog import ports). `SqlDriver` serializes calls:
  inside `transaction(fn)` use only the `tx` it receives (awaiting the outer driver there never resolves); `tx.batch`
  joins the open transaction; transactions do not nest. `SecretStore` keys use only letters, digits, `.`, `-`, `_`.
  `Scheduler.yieldNow()` must yield a macrotask (timer, `setImmediate`, frame), never just a resolved promise.
- `SourceKind`, `ContentKind`, `TransportSettings`, `transportHeaders` in `source.ts`.
- `normalizeStreamUrl`, `xtreamKey`, `m3uKey` in `content-key.ts`: credential-free catalog identity that keeps distinct streams apart (ADR 0011).
- The tsconfig adds the `DOM` lib for `AbortController`, timers and `Response` types only; no runtime DOM use.
