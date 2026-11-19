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
- Tests live beside the code as `*.test.ts`. Integration and performance tests (real HTTP against the
  simulator, 100k entries in CI, 500k with `SIM_HUGE=1`) live in `tools/test/sources-*.test.ts`.

## API
- `scanM3u(chunks, { batchSize?, baseUrl? })` streams an M3U/M3U8 playlist (byte chunks) into `M3uBatch`es of typed
  `M3uEntry` values in bounded memory (draining every full batch per chunk); the last batch has `done: true`, `M3uHeader`
  (`present` when `#EXTM3U` was seen) and `ScanStats`. Failure contract (same as `scanXmltv`): returns `Result<void>`; an input
  that throws returns `err` (own category/code if ElvError-shaped, `AbortError` -> `network`/`aborted`, else
  `network`/`stream-failed`) with no `done` batch. Never throws on bad content (warnings: `not-a-url`, `extinf-without-url`,
  `exthttp-malformed`, `line-too-long`, `attr-quote`); lines over 1 MiB are skipped. Non-`#` lines need `xx://` or, with
  `baseUrl`, no whitespace/`<`/`{`/`"`. `extra`, `kodiProps`, `headers.other` (empty/null header values ignored) and `header.attrs`
  have no prototype. Raw quotes inside an attribute drop that attribute and recover the title after the last attribute comma (`attr-quote`).
  Files: `m3u.ts`, `m3u-attrs.ts`, `m3u-url.ts`, `m3u-types.ts`. Rejects HLS media/master manifests with `source-format`/`hls-manifest`.
- Utilities: `detectAndDecodeText` (`encoding.ts`, UTF-8/UTF-16/UTF-32 BOM + Turkish `Windows-1254` / `CP1252`), `toElvError`, `decodeUtf8`, `ByteBuffer`, `decodeEntities`, `createStats`/`warn`; test helpers in `test-chunks.ts`.
- `scanXmltv(chunks, { batchSize?, channels?, programmeChannels?, from?, to?, decompressor? })` streams XMLTV into `XmltvBatch`es
  (`channels`, `programmes` with epoch-ms times; `batchSize` bounds `channels + programmes`) in bounded memory; returns
  `err` `source-format`/`gzip-unsupported` without `Decompressor`, `gzip-corrupt` on bad gzip, else `ok`. `channels` filters both;
  `programmeChannels` filters programmes per open tag so a caller-grown `Set` works. Malformed elements or elements over 1 MiB are
  skipped with warnings (`programme-*`, `channel-*`, `element-too-long`). Missing `<title>` yields `title: ''`.
  Files: `xmltv.ts`, `xml-tokens.ts`, `xmltv-children.ts`, `xmltv-time.ts`, `xmltv-types.ts`.
- `createXtreamClient({ http, server, username, password, transport?, maxBodyBytes? })` wraps `player_api.php`: `account`,
  `categories`, `liveStreams`/`vodStreams`/`series` (optional `categoryId`), `seriesInfo`, `vodInfo`, `shortEpg`, plus `playlistUrl`,
  `guideUrl` and `streamUrl` (play time only). Empty `{}` list replies become `[]`; empty PHP `[]` object replies become `{}`;
  array-encoded `episodes` (`[[...], [...]]`) preserve Season `0` index, flat `episodes` arrays work, and duplicate episode ids
  deduplicate. Errors: `auth/*`, `network/*`, `source-format/*` (`invalid-json`, `unexpected-shape`, `too-large`). Credentials appear
  only in the three URL builders; error `detail` never holds a URL. Files: `xtream.ts`, `xtream-json.ts`, `xtream-records.ts`, `xtream-normalize.ts`.
