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
- `HttpClient`, `FetchLike`, `createFetchHttpClient`, `Decompressor` in `http.ts` (port plus a fetch adapter).
- `SourceKind`, `ContentKind`, `TransportSettings`, `transportHeaders` in `source.ts`.
- `normalizeStreamUrl`, `xtreamKey`, `m3uKey` in `content-key.ts`: credential-free catalog identity.
- The tsconfig adds the `DOM` lib for `AbortController`, timers and `Response` types only; no runtime DOM use.
