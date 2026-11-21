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
- `scanM3u(chunks, { batchSize?, baseUrl?, decompressor?, maxDecompressedBytes? })` streams an M3U/M3U8 playlist (plain or
  gzip `1f 8b` via `decodeMaybeGzip`) into `M3uBatch`es of typed `M3uEntry` values in bounded memory (draining every full
  batch per chunk); the last batch has `done: true`, `M3uHeader` (`present` when `#EXTM3U` was seen) and `ScanStats`.
  Failure contract (same as `scanXmltv`): returns `Result<void>`; an input that throws returns `err` (own category/code if
  ElvError-shaped, `AbortError` -> `network`/`aborted`, else `network`/`stream-failed`) with no `done` batch. Never throws on
  bad content (warnings: `not-a-url`, `extinf-without-url`, `exthttp-malformed`, `line-too-long`, `attr-quote`,
  `inline-logo-stripped`); oversized inline `data:` logos (> 4 KiB) are stream-stripped in O(1) memory (`m3u-logo-filter.ts`),
  other lines over 1 MiB are skipped. Splits `#http`/`#rtmp`/`#rtsp` inline backups into `backupUrls` (preserving `#fragment`)
  and `.xml/http`/`.gz/http`/`;` `url-tvg` lists. Non-`#` lines need `xx://` or, with `baseUrl`, no whitespace/`<`/`{`/`"`.
  `extra`, `kodiProps`, `headers.other` and `header.attrs` have no prototype. Files: `m3u.ts`, `m3u-logo-filter.ts`,
  `m3u-attrs.ts`, `m3u-url.ts`, `m3u-types.ts`. Rejects HLS media/master manifests with `source-format`/`hls-manifest`.
- Utilities: `decodeMaybeGzip` (`gzip-stream.ts`, multi-member `.gz` + `DEFAULT_MAX_DECOMPRESSED_BYTES` 256 MiB ceiling),
  `decodeLegacyCodepage` (`codepages.ts`, `windows-1256`/`iso-8859-6`/`windows-1254`/`windows-1252`), `detectAndDecodeText`
  (`encoding.ts`), `toElvError`, `decodeUtf8`, `ByteBuffer`, `decodeEntities`, `createStats`/`warn`; test helpers in `test-chunks.ts`.
- `scanXmltv(chunks, { batchSize?, channels?, programmeChannels?, from?, to?, decompressor?, maxDecompressedBytes? })` streams
  XMLTV via `decodeMaybeGzip` into `XmltvBatch`es (`channels`, `programmes` with epoch-ms times; `batchSize` bounds total) in
  bounded memory; returns `err` `source-format`/`gzip-unsupported` without `Decompressor`, `gzip-corrupt`, or `too-large`, else
  `ok`. `channels` filters both; `programmeChannels` filters per open tag. Salvages stray `<` and bare `&`; malformed or > 1 MiB
  elements skip with warnings (`programme-*`, `channel-*`, `element-too-long`). Files: `xmltv.ts`, `xml-tokens.ts`,
  `xmltv-children.ts`, `xmltv-time.ts`, `xmltv-types.ts`.
- `createXtreamClient({ http, server, username, password, transport?, maxBodyBytes?, backupServers?, primaryCooldownMs?, cooldown429Ms?, serverTimezone? })`
  wraps `player_api.php`: `account`, `categories`, `liveStreams`/`vodStreams`/`series`, `seriesInfo`, `vodInfo`, `shortEpg`
  (with `start`/`end` IANA timezone fallback + legacy codepage base64 decoding), plus `playlistUrl`, `guideUrl`, `streamUrl`.
  Tracks per-`HttpClient` account-scoped `429` cooldowns (`Retry-After`, never fails over on `429`) and ordered mirror failover
  with primary promotion (`xtream-mirrors.ts`). Empty `{}` -> `[]`, `[]` -> `{}`; array `episodes` preserve Season `0` and
  deduplicate. Credentials appear only in URL builders; errors never hold URLs. Files: `xtream.ts`, `xtream-json.ts`,
  `xtream-mirrors.ts`, `xtream-records.ts`, `xtream-normalize.ts`, `xtream-types.ts`.
