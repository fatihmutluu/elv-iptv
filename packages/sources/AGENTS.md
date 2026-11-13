# sources (`@elv/sources`)

M3U and XMLTV scanners and the Xtream client.

## Commands
- `pnpm --filter @elv/sources typecheck` type-checks this package.
- `pnpm --filter @elv/sources test` runs its Vitest tests.
- `pnpm -w check` runs every repository check.

## Rules
- Pure TypeScript: no `react`, `react-native`, `expo*`, `electron` or `node:*` imports.
  Platform access goes through ports defined in `@elv/domain`.
- Source-first: `exports` points at `src/index.ts`; there is no build step.
- Allowed workspace dependencies: domain.
- Tests live beside the code as `*.test.ts`.

## API
- `scanM3u(chunks, { batchSize?, baseUrl? })` streams an M3U/M3U8 playlist (byte chunks) into `M3uBatch`es of typed
  `M3uEntry` values in bounded memory; the last batch has `done: true`, the `M3uHeader` and `ScanStats`. It never
  throws on bad content (warnings: `extinf-without-url`, `exthttp-malformed`, `line-too-long`); lines over 1 MiB are skipped.
  Implementation: `m3u.ts` (byte-level line machine), `m3u-attrs.ts` (attribute, directive and URL helpers),
  `m3u-types.ts` (types).
- Utilities: `decodeUtf8`, `ByteBuffer`, `decodeEntities`, `createStats`/`warn`; test helpers in `test-chunks.ts`.
