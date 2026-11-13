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
  `M3uEntry` values in bounded memory; the last batch has `done: true`, the `M3uHeader` and `ScanStats`. It never
  throws on bad content (warnings: `extinf-without-url`, `exthttp-malformed`, `line-too-long`, `attr-quote`); lines over 1 MiB are skipped.
  A raw quote inside an attribute value drops that attribute, keeps the clean ones and starts the name after the first
  comma following the last `="..."` value (warning `attr-quote`).
  Implementation: `m3u.ts` (byte-level line machine), `m3u-attrs.ts` (attribute, directive and URL helpers),
  `m3u-types.ts` (types).
- Utilities: `decodeUtf8`, `ByteBuffer`, `decodeEntities`, `createStats`/`warn`; test helpers in `test-chunks.ts`.
- `scanXmltv(chunks, { batchSize?, channels?, from?, to?, decompressor? })` streams an XMLTV guide into `XmltvBatch`es
  (`channels`, `programmes` with epoch-ms times, batch size counts programmes) in bounded memory; the generator returns
  `err` `source-format`/`gzip-unsupported` for gzip input without a `Decompressor` and otherwise `ok`. Filters run on the
  open tag, so skipped elements are never decoded. A programme or channel that cannot be read is skipped with one
  warning and scanning resumes at the next `<programme`/`<channel` (warnings: `programme-missing-start`,
  `-missing-channel`, `-bad-time`, `-malformed`, `-unclosed`, `-truncated`, `channel-*`, `element-too-long`).
  Elements over 1 MiB are skipped. Corrupt gzip returns `err` `source-format`/`gzip-corrupt`; an input iterable that throws returns `err` (own category/code if ElvError-shaped, else `network`/`stream-failed`); on any `err` no `done` batch is yielded and the run is a failure. A programme without `<title>` gets `title: ''`.
  Implementation: `xmltv.ts` (run loop, element handling, gzip sniffing), `xml-tokens.ts` (byte-level tag, attribute and
  text helpers), `xmltv-children.ts` (child elements), `xmltv-time.ts` (`parseXmltvTime`), `xmltv-types.ts`.
- `createXtreamClient({ http, server, username, password, transport? })` returns an `XtreamClient` over the `player_api.php`
  endpoints: `account`, `categories`, `liveStreams`/`vodStreams`/`series` (optional `categoryId` to bound one call),
  `seriesInfo`, `vodInfo`, `shortEpg`, plus `playlistUrl`, `guideUrl` and `streamUrl` (play time only). Numbers and
  numeric strings are equal, `''`/null/missing are absent, text is entity-decoded and trimmed, `category_ids` beats
  `category_id`, repeated ids merge (union of `categoryIds`), epoch fields are milliseconds. Errors: `auth`
  (`invalid-credentials`, `account-<status>`, `unauthorized`), `network` (`request-failed`, `server-error`, `http-status`,
  `stream-failed`, transport codes), `source-format` (`invalid-json`, `unexpected-shape`). Credentials appear only in
  the three URL builders; error `detail` never holds a URL. Each response body is read into one string, so use
  per-category calls for big providers.
  Implementation: `xtream.ts` (client, requests, errors; `server` may be a pasted `player_api.php`/`get.php`/`xmltv.php` URL, query and fragment are dropped; an empty `{}` list reply is `[]`), `xtream-records.ts` (row mappers), `xtream-normalize.ts`
  (`toNumber`, `toText`, `mergeById`), `xtream-types.ts`.
