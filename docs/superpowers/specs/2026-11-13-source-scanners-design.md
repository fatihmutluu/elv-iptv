# Source scanners and Xtream client — Design

- Status: approved (owner delegated Round 1 decisions on 2026-11-13)
- Date: 2026-11-13
- Issues: #9 (parsing half) and #25 (scanner half). Storing what these produce is the next spec (catalog import).
- Foundation spec: §4 (Parsing), §5.2, §5.3, §5.4, §6.1, §6.2.

## 1. Why
Everything the user sees starts as a provider's playlist, guide or Xtream API response, and real providers are messy:
a measured real panel serves a 37 MB, 115k-entry playlist with CRLF line endings and no guide URL, lists the same movie
under several categories, sends most channels without a guide id, and mixes numbers, numeric strings, empty strings and
nulls in one field. No maintained TypeScript parser handles this at 100k scale on a JIT-less runtime (Hermes). We own
small streaming scanners and a tolerant Xtream client in the pure packages so the same code runs on TV, mobile and
desktop and is testable in Node.

## 2. Goals
- Parse M3U/M3U8 and XMLTV from byte chunks as they arrive, in bounded memory, yielding batches for a later importer.
- Tolerate everything the simulator's `compat` and `quirks` profiles serve, and report what was skipped instead of failing.
- An Xtream client that turns the de facto API into typed, normalized records and classified errors.
- Stable content keys (spec §5.4) and per-source transport settings (User-Agent, Referer, Xtream stream format).
- Throughput that leaves the §6.2 import budgets to storage: scanning the simulator's 100k playlist and 7-day/5,000-channel
  guide in Node well under the budget, measured in a test that fails on regression.

## 3. Non-goals
- Storage, schema, import scheduling, category selection, progress UI: next spec.
- Gzip implementation: the scanners take a `Decompressor` port; platforms provide it with the importer.
- Catch-up URL building, Stalker portals, DRM: Round 3 issues. Catch-up and time-shift attributes are parsed and kept.

## 4. Approaches considered
1. **Own byte-level streaming scanners plus a tolerant Xtream client (chosen).** Matches spec §4 and research 13: no
   per-line regex, decode only the slices we keep, one code path for every runtime, easy to test chunk boundaries.
2. Decode whole text, then regex per line or a DOM XML parser. Rejected: doubles memory on 37 MB playlists and hundreds of
   MB guides, slow on Hermes, and chunk-boundary bugs move to the caller.
3. Third-party parsers. Rejected: none maintained for M3U/XMLTV in TypeScript (research 13); generic SAX parsers are strict
   on malformed XMLTV, which real guides are.

## 5. Design

### 5.1 Domain additions (`packages/domain`)
- `Result<T, E>` with `ok()`/`err()` helpers, and `ElvError { category: 'network' | 'auth' | 'source-format' | 'playback'
  | 'storage'; code: string; detail?: string }` (spec §5.3). `detail` is for logs, never shown raw, and never holds
  credentials.
- `HttpClient` port: `get(url, { headers?, signal? }) → Promise<Result<HttpResponse, ElvError>>`, where `HttpResponse`
  has `status`, lower-case `headers` and `body: AsyncIterable<Uint8Array>`. `createFetchHttpClient(fetchImpl)` adapts any
  WHATWG `fetch` with a streaming body (Node and Electron `fetch`, `expo/fetch`); it maps timeouts, DNS and TLS failures to
  `network`, 401/403 to `auth`, other non-2xx to `network` with the status in `code`.
- `Decompressor` port: `gunzip(chunks: AsyncIterable<Uint8Array>) → AsyncIterable<Uint8Array>`.
- `TransportSettings { userAgent?: string; referer?: string; xtreamFormat?: 'ts' | 'm3u8' }`, applied to every request a
  source makes (playlist, API, guide, logos, streams).
- Content keys (spec §5.4): `xtreamKey(sourceId, kind, providerId)`; `m3uKey(sourceId, url, name)` over a normalized URL:
  lower-case scheme and host, default port dropped, userinfo, query and fragment removed, and Xtream-shaped credential
  segments (`/live|movie|series|timeshift/<u>/<p>/`, `/<u>/<p>/<id>`) collapsed, so rotating tokens and credentials never
  change a key. Keys are strings; their format is internal and documented in code.

### 5.2 Shared scanning utilities (`packages/sources`)
- A UTF-8 slice decoder (`decodeUtf8(bytes, start, end)`) that does not depend on `TextDecoder` (absent or slow on some
  runtimes), replaces invalid sequences with U+FFFD and never splits a code point across chunks (the scanners carry partial
  sequences forward).
- Entity decoding for the five XML entities plus decimal and hex numeric entities; unknown entities stay literal.
- `ScanStats { lines; entries; skipped; warnings: { code; line }[] }` (warnings capped at 100, counts uncapped).

### 5.3 M3U scanner
- `scanM3u(chunks: AsyncIterable<Uint8Array>, opts?: { batchSize?: number }) → AsyncGenerator<M3uBatch>`; a batch holds up
  to `batchSize` (default 500) entries; the final batch also carries the header and `ScanStats`.
- Header: `#EXTM3U` optional; `url-tvg` and `x-tvg-url` (comma-separated lists, both kept) and other attributes kept as a map.
- Lines: BOM stripped; LF, CRLF and lone CR accepted; blank lines and unknown `#` lines ignored (counted); a truncated last
  line is kept if it is a URL and dropped with a warning if it is a broken `#EXTINF`.
- `#EXTINF:<duration> <attributes>,<name>`: attributes `key="value"` in any order, values may contain commas and the name
  may contain quotes and commas (the name is everything after the first comma that is outside quotes); unquoted values
  (`key=value`) accepted; keys lower-cased. Known keys become fields: `tvg-id`, `tvg-name`, `tvg-logo`, `tvg-chno`,
  `tvg-shift`, `group-title` (`;`-separated groups), `radio`, `catchup`, `catchup-source`, `catchup-days`, `timeshift`,
  `tvg-rec`; every other key stays in `extra` (for example `xui-id`).
- Directives between `#EXTINF` and its URL apply to that entry: `#EXTGRP` (group when `group-title` is absent),
  `#EXTVLCOPT:http-user-agent=` and `http-referrer=`/`http-referer=`, `#EXTHTTP:{json}` (`User-Agent`, `Referer`, others
  kept), `#KODIPROP:key=value` (kept raw). `#EXT-X-*` lines are ignored.
- Entry: `{ name, url, duration, tvgId?, tvgName?, tvgLogo?, chno?, shiftHours?, groups, radio, catchup?, timeshiftDays?,
  headers: { userAgent?, referer?, other }, kodiProps, extra, kindHint }`. `kindHint` is `movie` for `/movie/` paths,
  `episode` for `/series/` paths, `movie` for VOD container extensions (mkv, mp4, avi, mov, m4v, webm), else `live`.
- URLs are kept as written (relative ones resolved against the playlist URL when the caller gives one); non-HTTP schemes
  (`udp`, `rtp`, `rtmp`, …) are kept and flagged so the importer can mark them unplayable on platforms that cannot.

### 5.4 XMLTV scanner
- `scanXmltv(chunks, opts?: { batchSize?: number; channels?: ReadonlySet<string>; from?: number; to?: number; decompressor?:
  Decompressor }) → AsyncGenerator<XmltvBatch>`. Gzip input (magic bytes `1f 8b`) goes through the decompressor; without
  one it fails with `source-format`/`gzip-unsupported`.
- Events: `channel { id, names, icon? }` and `programme { channel, start, stop?, title, subTitle?, desc?, categories,
  episodeNum?, icon? }` with epoch-millisecond times parsed by hand from `YYYYMMDDHHMMSS ±HHMM` (missing offset = UTC,
  shorter forms accepted, invalid times skip the programme with a warning).
- Tolerated: XML declaration, `<!DOCTYPE>`, comments, CDATA, entities, both attribute quote styles, attributes in any
  order, unknown elements and attributes (skipped), whitespace, a programme missing `stop`, a malformed or unclosed element
  (that programme is skipped with a warning and scanning resumes at the next `<programme` or `<channel`), chunk boundaries
  anywhere including inside tags, entities and multi-byte characters.
- Filtering happens in the scanner so nothing unneeded is decoded: `channels` keeps only those channel ids, `from`/`to`
  drop programmes outside the window. Multiple `title`/`desc` elements: the first one wins.

### 5.5 Xtream client
- `createXtreamClient({ http, server, username, password, transport }) → XtreamClient`. Credentials live only in this object;
  they never appear in returned records or error details. `server` accepts a base URL with or without trailing slash or path.
- Methods (each `Promise<Result<…, ElvError>>`): `account()`, `categories(kind)`, `liveStreams(categoryId?)`,
  `vodStreams(categoryId?)`, `series(categoryId?)`, `seriesInfo(seriesId)`, `vodInfo(vodId)`, `shortEpg(streamId, limit?)`;
  `playlistUrl()` and `guideUrl()` for the scanners; `streamUrl(kind, id, extension?)` builds playback URLs on demand using
  `transport.xtreamFormat` for live (spec §5.4: built at play time, never stored).
- Normalization: numbers from numbers or numeric strings; `''`, `null` and missing are the same "absent"; names and plots
  have HTML entities decoded and whitespace trimmed; `category_ids` (when present) is the membership list, else
  `[category_id]`; `stream_type` `created_live` is live; `tv_archive`/`tv_archive_duration` become `catchupDays`; VOD and
  series records with a repeated id are merged into one record whose membership is the union (the real panel repeated
  3,515 movie ids). Unknown fields are ignored.
- Errors: `user_info.auth` 0 → `auth/invalid-credentials`; status other than `Active` → `auth/account-<status>`
  (lower-case); HTTP 401/403 → `auth`; timeouts and 5xx → `network`; non-JSON or wrong shape → `source-format`.
- Large lists: the client offers per-category calls so the importer can bound peak memory; whole-list calls stay available.

### 5.6 Simulator updates (`tools/src/sim`)
The real-panel probe showed shapes the simulator lacks. Add them so tests meet them before users do:
- every Xtream list item carries `category_ids`; for `quirks`: most `epg_channel_id` null, some `stream_type`
  `created_live`, empty `thumbnail`/`custom_sid`, series with both `release_date` and `releaseDate`, movies listed in
  several categories with the same `stream_id`;
- `get.php` for `quirks`: CRLF, no header attributes, an `#EXT-X-SESSION-DATA` line, `xui-id` on every entry, `tvg-id` only
  on live entries, `timeshift` on archive channels and no `catchup*` attributes;
- the `quirks` guide: a `<!DOCTYPE>` line and every time at `+0100`.

## 6. Testing
- Unit tests per module with inline fixtures. Every scanner fixture also runs through a chunker that splits the input at
  every byte offset (small fixtures) or at random sizes from 1 byte to 64 KB (large ones, seeded); the result must equal
  the single-chunk result. Property tests with `fast-check` (spec §6.1): generated playlists and guides round-trip through
  a reference writer and the scanner.
- Integration tests in `tools/test/` (tools may depend on product packages; pure packages may not import the simulator):
  `createFetchHttpClient(fetch)` + Xtream client + scanners against `startSim()` for `demo`, `large`, `compat`, `quirks`,
  `expired` and wrong credentials; every compat case asserted; the simulator's request log asserts the User-Agent and
  Referer from `TransportSettings` reach every request.
- Performance guard (Node, in the integration suite): the `large` playlist (100k entries) and the `large` guide scan within
  fixed ceilings (playlist ≤ 5 s, guide ≤ 30 s on the CI runner), with peak heap growth reported; the budgets in §6.2 are
  measured on devices by the gates, not here.
- Scale benchmark (opt-in with `SIM_HUGE=1`, not part of `pnpm check`): the simulator's `huge` profile (500k entries, a
  7-day guide for 20,000 channels) must scan with heap growth no larger than the `large` run plus 25 % and time that grows
  roughly linearly with input size. Users bring providers far larger than the owner's; memory must not grow with the
  playlist. The Xtream path for `huge` uses per-category calls. Results are recorded in the report and, as aggregates, in
  the private research notes next to a run against the owner's real source.
- Coverage ≥ 90 % lines for `domain` and `sources` (spec §6.1).

## 7. Constraints
- Pure TypeScript in `domain` and `sources`: no `node:*`, `react*`, `expo*`, `electron`; no `Intl`, `Date.parse` or regex per
  byte in hot loops; Hermes-compatible syntax.
- New dev dependency: `fast-check` (MIT) in `sources` and `domain`; no new runtime dependencies.
- Files ≤ 400 lines; exported APIs documented; package `AGENTS.md` updated.
- No real provider data, hosts or credentials in fixtures, tests, logs or errors.

## 8. Left to the builder
Internal state-machine layout, batch object shapes beyond the listed fields, warning codes, the reference writers used by
property tests, and how the decoder carries partial code points, as long as §6 holds.
