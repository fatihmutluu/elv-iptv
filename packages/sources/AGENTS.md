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
- `scanM3u(chunks, { batchSize?, baseUrl?, decompressor?, maxDecompressedBytes? })` streams M3U/M3U8 (plain or gzip `1f 8b`
  via `decodeMaybeGzip`) into `M3uBatch`es in bounded memory; final batch has `done: true`, `M3uHeader`, `ScanStats`.
  Failure contract (same as `scanXmltv`): returns `Result<void>`; input throw -> `err` (own category/code, `AbortError` ->
  `network`/`aborted`, else `network`/`stream-failed`) with no `done` batch. Never throws on bad content (warnings:
  `not-a-url`, `extinf-without-url`, `exthttp-malformed`, `line-too-long`, `attr-quote`, `inline-logo-stripped`); strips
  >4 KiB `data:` logos in O(1) memory (`m3u-logo-filter.ts`), skips >1 MiB lines. Splits `#http`/`#rtmp`/`#rtsp`/`#udp`/`#rtp`
  `backupUrls`, normalizes `udp://@`/`rtp://@`, trims `tvg-id`/`channel-id`, supports `\"`/`\'`/`\\` escapes, limits Sat>IP
  prefix stripping to live (`finishEntry`), validates artwork URLs (`artwork-url.ts`: `http(s)://` or bounded non-SVG
  `data:image/*` across M3U/XMLTV/Xtream). Prototype-free `extra`/`kodiProps`/`headers.other`/`header.attrs`. Rejects HLS.
  Files: `m3u.ts`, `m3u-logo-filter.ts`, `m3u-attrs.ts`, `m3u-url.ts`, `m3u-types.ts`, `artwork-url.ts`.
- Utilities: `decodeMaybeGzip` (`gzip-stream.ts` + `gzip-member-splitter.ts`, multi-member `.gz`, 256 MiB ceiling),
  `decodeLegacyCodepage`/`decodeCodepageSlice` (`codepages.ts`, `windows-1256`/`iso-8859-6`/`windows-1254`/`windows-1252`/`windows-1251`),
  `detectAndDecodeText`/`normalizeBomChunks` (`encoding.ts`), `toElvError`, `decodeUtf8`, `ByteBuffer`, `decodeEntities`, `createStats`/`warn`.
- `scanXmltv(chunks, { batchSize?, channels?, programmeChannels?, from?, to?, decompressor?, maxDecompressedBytes?, preferredLanguages? })`
  streams XMLTV via `decodeMaybeGzip`, 512 B POSIX `ustar` tar header strip, and `normalizeBomChunks` (UTF-8/16/32 BOM, locking
  UTF-8 over conflicting prologs) into `XmltvBatch`es (`channels`, `programmes` with epoch-ms times supporting numeric/`Z`/`UTC`/`GMT`
  offsets, `isLive`/`isNew`/`previouslyShown`). Decodes legacy prologs (`windows-1252`/`iso-8859-1`, `windows-1254`/`iso-8859-9`,
  `windows-1251`, `windows-1256`, `iso-8859-6`), trims channel IDs, ranks multi-language `<title>`/`<sub-title>`/`<desc>` by
  `preferredLanguages`, strips inline HTML & Unicode superscripts, ranks `<episode-num>` (`xmltv_ns` > `onscreen` > `dd_progid` >
  `<desc>` `S##E##`). Salvages stray `<` / bare `&`; skips malformed or >1 MiB elements. Files: `xmltv.ts`, `xml-tokens.ts`,
  `xmltv-children.ts`, `xmltv-meta.ts`, `xmltv-time.ts`, `xmltv-types.ts`.
- `createXtreamClient({ http, server, username, password, transport?, maxBodyBytes?, backupServers?, primaryCooldownMs?, cooldown429Ms?, serverTimezone? })`
  wraps `player_api.php` (`account`, `categories`, `liveStreams`/`vodStreams`/`series`, streaming `streamLiveStreams`/`streamVodStreams`/`streamSeries`,
  `seriesInfo`, `vodInfo`, `shortEpg`), `playlistUrl`, `guideUrl`, `streamUrl`; `streamXtreamRecords` (`xtream-stream.ts`) parses `[...]` and numeric-keyed
  `{ "0": ... }` incrementally in `O(batchSize)` memory; `probeXtreamLiveFormat` (`xtream-probe.ts`) auto-detects `ts` vs `m3u8` in <=512 B.
  Per-`HttpClient` account-scoped `429` cooldowns (`Retry-After`, no failover on `429`) and ordered mirror failover (`xtream-mirrors.ts`).
  Empty `{}` -> `[]`, `[]` -> `{}`; array `episodes` keep Season `0` and deduplicate. Credentials only in URL builders; errors omit URLs.
  Files: `xtream.ts`, `xtream-stream.ts`, `xtream-probe.ts`, `xtream-json.ts`, `xtream-mirrors.ts`, `xtream-records.ts`, `xtream-normalize.ts`, `xtream-types.ts`.
