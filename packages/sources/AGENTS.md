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
  `M3uEntry` values in bounded memory; the last batch has `done: true`, the `M3uHeader` (`present` is true when `#EXTM3U`
  was seen) and `ScanStats`. Failure contract (same as `scanXmltv`): the generator returns `Result<void>`; an input that
  throws returns `err` (own category/code if ElvError-shaped, an `AbortError` is `network`/`aborted`, else
  `network`/`stream-failed`) and no `done` batch is yielded. It never throws on bad content (warnings: `not-a-url`,
  `extinf-without-url`, `exthttp-malformed`, `line-too-long`, `attr-quote`); lines over 1 MiB are skipped. A non-`#` line
  is an entry only with a scheme (`xx://`) or, with `baseUrl`, without whitespace, `<`, `{` or `"`, so an HTML or JSON
  body answered with status 200 yields no entries. `extra`, `kodiProps`, `headers.other` and `header.attrs` have no prototype.
  A raw quote inside an attribute value drops that attribute, keeps the clean ones and starts the name after the first
  comma following the last `="..."` value (warning `attr-quote`).
  Files: `m3u.ts` (line machine), `m3u-attrs.ts` (attribute, directive, URL helpers), `m3u-types.ts`.
- Utilities: `toElvError` (input errors to `ElvError`), `decodeUtf8`, `ByteBuffer`, `decodeEntities`, `createStats`/`warn`; test helpers in `test-chunks.ts`.
- `scanXmltv(chunks, { batchSize?, channels?, programmeChannels?, from?, to?, decompressor? })` streams an XMLTV guide into `XmltvBatch`es
  (`channels`, `programmes` with epoch-ms times, batch size counts channels plus programmes) in bounded memory; the generator returns
  `err` `source-format`/`gzip-unsupported` for gzip input without a `Decompressor` and otherwise `ok`. `channels` filters channel events and programmes; `programmeChannels` filters only programmes and is consulted per
  programme, so a `Set` the caller grows while reading channel batches works (channels read so far are yielded in a batch before the next programme is consulted). Filters run on the
  open tag, so skipped elements are never decoded. A programme or channel that cannot be read is skipped with one
  warning and scanning resumes at the next `<programme`/`<channel` (warnings: `programme-missing-start`,
  `-missing-channel`, `-bad-time`, `-malformed`, `-unclosed`, `-truncated`, `channel-*`, `element-too-long`).
  Elements over 1 MiB are skipped. Corrupt gzip returns `err` `source-format`/`gzip-corrupt`; an input iterable that throws returns `err` (own category/code if ElvError-shaped, else `network`/`stream-failed`); on any `err` no `done` batch is yielded. A programme without `<title>` gets `title: ''`. Files: `xmltv.ts` (run loop, gzip sniffing), `xml-tokens.ts`, `xmltv-children.ts`, `xmltv-time.ts`, `xmltv-types.ts`.
- `createXtreamClient({ http, server, username, password, transport? })` returns an `XtreamClient` over the `player_api.php`
  endpoints: `account`, `categories`, `liveStreams`/`vodStreams`/`series` (optional `categoryId` to bound one call),
  `seriesInfo`, `vodInfo`, `shortEpg`, plus `playlistUrl`, `guideUrl` and `streamUrl` (play time only). Numbers and
  numeric strings are equal, `''`/null/missing are absent, text is entity-decoded and trimmed, `category_ids` beats
  `category_id` (an empty list falls back to it), repeated ids merge (union of `categoryIds`), epoch fields are milliseconds. Errors: `auth`
  (`invalid-credentials`, `account-<status>`, `http-401`, `http-403`), `network` (`request-failed`, `http-<status>`,
  `stream-failed`, transport codes), `source-format` (`invalid-json`, `unexpected-shape`, `too-large`). Every method takes a last `{ signal? }` argument; an
  abort (also mid-body) is `network`/`aborted`, a stalled body `network`/`timeout`. A `server` without `://` gets
  `http://` prepended. `maxBodyBytes` (default 128 MiB) caps the one growing buffer a response is read into. Credentials appear only in
  the three URL builders; error `detail` never holds a URL. Use per-category calls for big providers.
  Files: `xtream.ts` (`server` may be a pasted `player_api.php`/`get.php`/`xmltv.php` URL; query and fragment are dropped;
  an empty `{}` list reply is `[]`), `xtream-records.ts`, `xtream-normalize.ts` (`toNumber`, `toText`, `mergeById`).
