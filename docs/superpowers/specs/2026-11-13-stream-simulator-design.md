# Stream simulator — Design

- Status: approved (owner delegated Round 1 decisions on 2026-11-13)
- Date: 2026-11-13
- Issue: #24. Foundation spec: §6.1 (tests), §6.2 (budgets), §5.4 (data), §10 Round 1 item 1.

## 1. Why
Every Round 1 gate and feature needs a provider to talk to: parser and import tests need playlists and guides of
realistic size and messiness, the player gates need live and on-demand streams with faults on cue, and the
black-box compatibility pass needs a server that records exactly what a reference player requests. Real providers
are off limits in tests (spec §5.8), public test streams are flaky, and none of them can fail on command. The
simulator is one local server that plays all these roles, deterministically, with no third-party content.

## 2. Goals
- Serve synthetic M3U playlists, an Xtream-compatible API, XMLTV guides, logos and FFmpeg-generated media from
  fixtures generated from a seed, so the same seed always yields the same bytes.
- Fail on command: HTTP errors, stalls, drops, slow starts, redirects, text notices and connection limits.
- Log every request (method, path, query, headers, timing, response status, bytes, connection count) as JSONL.
- Start from tests (`startSim()` in Vitest) and from the command line (`pnpm sim`), on Windows, macOS and Linux,
  reachable from emulators (`0.0.0.0` binding; the Android emulator reaches the host at `10.0.2.2`).

## 3. Non-goals
- No assertion DSL, harness app or player event log analysis; they arrive with the player gate (#7). This round
  only stores harness events posted to it.
- No DASH, fMP4 HLS, subtitles in media, DRM or catch-up media yet; later gates add recipes. Catch-up URLs are
  logged and answered with a plain recorded stream so the compatibility pass can read the requested time format.
- Not shipped in any app build; it is test infrastructure.

## 4. Approaches considered
1. **Node server in `tools/` using only built-ins (chosen).** Same language as the repo, runs under Node 24 type
   stripping like the other tools, no new runtime dependencies, unit-testable with Vitest, starts in-process from
   tests.
2. Off-the-shelf media server (for example an RTSP/HLS server binary) plus a stub API server. Rejected: two
   processes, no fault scripting on the API side, a binary to pin on three operating systems, and no per-request
   log in one place.
3. A workspace package under `packages/`. Rejected: `packages/` holds app layers with purity rules (no `node:*`),
   and the simulator is a Node program.

## 5. Design

### 5.1 Location and entry points
- Code in `tools/src/sim/`, one module per concern (catalog, m3u, xtream, xmltv, media, faults, log, server).
  Files stay under the 400-line soft limit.
- `tools/bin/sim.ts` parses arguments; the root script `pnpm sim` runs it:
  `pnpm sim [--port 7878] [--host 127.0.0.1|0.0.0.0] [--seed 1] [--clock <ISO time>] [--log <file>] [--prepare]`.
  It prints one line with the base URL and the emulator URL, then stays quiet.
- `startSim(options) → Promise<{ url, port, requests(), clear(), close() }>` for tests; `port: 0` picks a free port.
- `--prepare` generates all media up front (CI can cache it); otherwise media is generated on first request.

### 5.2 Catalog
- One deterministic catalog per seed: live channels, VOD movies, series with seasons and episodes, categories,
  and guide programmes. Names are fictional ("Channel 0042", "Movie 0007", "Series 0003 S01E02"), never brands.
- Catalog sizes come from named profiles:
  - `small`: 50 live, 30 movies, 5 series, 10 categories (default; fast tests and manual runs).
  - `large`: 25,000 live and 75,000 VOD entries (100k total, the spec §6.2 import budget), 300 categories, a
    guide of 7 days for 5,000 channels.
  - `compat`: every tag and edge case of §5.4, for parser tests and the compatibility pass.
- Each catalog stream points at a media recipe (§5.6) and may carry a fault spec (§5.7), so faults also work through
  Xtream URLs that a client builds itself.

### 5.3 Accounts
- Synthetic accounts only, defined in code: `demo`/`demo` (profile `small`, 1 connection), `large`/`large`
  (profile `large`, 2 connections), `compat`/`compat` (profile `compat`, 1 connection), `expired`/`expired`
  (status Expired), `quirks`/`quirks` (profile `small` with provider quirks, §5.5). Wrong credentials get the
  Xtream-style auth failure.

### 5.4 Playlists (M3U)
- Xtream-style: `GET /get.php?username&password&type=m3u_plus&output=ts|m3u8|hls`.
- Direct: `GET /playlists/<profile>.m3u` and `.m3u8`.
- Playlist header carries `url-tvg` pointing at the matching guide. Entries use `#EXTINF` with `tvg-id`,
  `tvg-name`, `tvg-logo`, `tvg-chno`, `group-title`.
- The `compat` profile adds one entry per case, each with a distinct stream id so the request log shows which ones a
  client fetched:
  - attributes: `tvg-shift`, `tvg-rec`, `radio="true"`, `x-tvg-url`, `#EXTGRP`, missing `tvg-id`, duplicate ids,
    empty names, very long names, quotes and commas in names, Turkish and right-to-left names;
  - catch-up: `catchup` = `default`, `append`, `shift`, `flussonic`, `flussonic-hls`, `xc`, `fs` with
    `catchup-source` templates using `${start}`, `${end}`, `${utc}`, `${lutc}`, `${timestamp}`, `${duration}`,
    `${offset}`, `{utc}`, `{start}`, `{Y}-{m}-{d}`, and `catchup-days`;
  - headers: `#EXTVLCOPT:http-user-agent=…` and `#EXTVLCOPT:http-referrer=…`, `#EXTHTTP` JSON headers;
  - `#KODIPROP` adaptive and licence lines (the stream itself is a plain stream);
  - URL forms: relative URL, a URL that answers `302` (the simulator speaks plain HTTP only), credentials in the
    URL, `udp://`, `rtp://` and `rtmp://` URLs (nothing listens; the client's handling is what matters), a URL that
    returns 404;
  - file forms, served as separate playlists so one failure does not hide the rest: `compat-crlf-bom.m3u`
    (UTF-8 with BOM and CRLF) and `compat-truncated.m3u` (last line cut mid-attribute); the main `compat.m3u`
    carries blank and comment lines.
- `GET /playlists/broken/<status>.m3u` answers the playlist request itself with that status.

### 5.5 Xtream-compatible API
- `GET /player_api.php?username&password` returns `user_info` (username, password, status, exp_date, is_trial,
  active_cons, created_at, max_connections, allowed_output_formats) and `server_info` (url, port, https_port,
  server_protocol, rtmp_port, timezone, timestamp_now, time_now).
- `action=`: `get_live_categories`, `get_live_streams`, `get_vod_categories`, `get_vod_streams`, `get_vod_info`,
  `get_series_categories`, `get_series`, `get_series_info`, `get_short_epg`, `get_simple_data_table`; each accepts
  `category_id` where providers do. Field names follow the widely documented de facto shape (for example live
  streams carry `num`, `name`, `stream_type`, `stream_id`, `stream_icon`, `epg_channel_id`, `added`,
  `category_id`, `tv_archive`, `tv_archive_duration`, `direct_source`). Implementers work from this list and
  public API descriptions, never from GPL or unlicensed client code.
- The `quirks` account returns what real panels do: numbers as strings, `null` icons, empty strings for missing
  values, HTML entities in names, a category id that matches no category, and duplicate stream ids.
- Guide: `GET /xmltv.php?username&password`.
- Streams: `/live/<u>/<p>/<id>.ts`, `/live/<u>/<p>/<id>.m3u8`, `/<u>/<p>/<id>` (short live form),
  `/movie/<u>/<p>/<id>.<ext>`, `/series/<u>/<p>/<id>.<ext>`, `/timeshift/<u>/<p>/<duration>/<start>/<id>.ts`
  and `/streaming/timeshift.php?username&password&stream&start&duration`.

### 5.6 Media
- FFmpeg is found through `FFMPEG_PATH` or `PATH`; without it, media requests answer 503 with a clear text body
  and media tests skip with a visible note. CI installs FFmpeg.
- Recipes are generated once into a cache (`.cache/sim-media/<recipe-hash>/`, gitignored) from `lavfi` sources
  with a burned-in frame counter and timecode and a 1 kHz tone. Round 1 recipes:
  - `h264-aac-720p25` (the default), `hevc-main10-1080p25`, `mpeg2-ac3-576i25` (interlaced, the common IPTV
    case), `aac-radio` (audio only).
  - Each recipe is a 10-minute loop at low bitrate, encoded with a 1-second GOP.
- Live TS: each request starts an FFmpeg copy process that loops the recipe at real time and pipes MPEG-TS to the
  response, so timestamps stay continuous; the process ends when the client disconnects.
- Live HLS: a sliding-window media playlist (6 segments of 2 s) whose position follows the simulator clock over
  pre-cut segments of the recipe, with `#EXT-X-DISCONTINUITY` at the loop point.
- VOD: the recipe file served with correct `Range` and `206` handling (`.mp4` and `.mkv` containers).
- Logos: 16 small two-colour PNGs written with `node:zlib` (`/logos/<n>.png`), reused by id, so logos work
  without FFmpeg.

### 5.7 Faults
- A fault spec is a short string, attached to a catalog stream or overridden with the `fault` query parameter:
  `status=<code>`, `drop@<s>`, `stall<n>s@<s>`, `slow-start=<s>`, `redirect`, `text-notice` (200 with a short
  text body instead of media), `rate=<kbps>`. Several are joined with `,`.
- Connection limit: the simulator counts open media responses per account; beyond `max_connections` it answers
  per account policy with `509`, `403` or a `text-notice`. The count is in every log line.
- Fault specs are parsed by one tested function; an unknown fault is a 400 with the parse error, never ignored.

### 5.8 Request log and harness events
- Every request becomes one JSON line: time, method, path, query (with `password` values replaced by `***`),
  headers (user agent, referer, range, accept-encoding, if-modified-since and all others), status, bytes sent,
  duration, account, stream id, recipe, fault, and open connections for the account.
- `GET /_sim/requests` returns the log, `DELETE /_sim/requests` clears it; `--log <file>` appends to a file.
- `POST /_sim/events` stores JSONL lines from a harness app (validated as JSON, size-capped); reading them back is
  `GET /_sim/events`. Analysis comes with #7.

### 5.9 Guides (XMLTV)
- `GET /guides/<profile>.xml` and `.xml.gz` (also served for `/xmltv.php`), streamed rather than built in memory.
- Programmes cover a window around the simulator clock (default 2 days back, 7 forward), with titles,
  descriptions, categories and episode numbers; times use `+0000` and, in `compat`, other offsets.
- The `compat` guide adds: channels matched only by display name, an unknown channel, overlapping programmes,
  entities and CDATA, a programme crossing midnight, and one malformed programme element.
- `--clock` fixes "now" so tests and logs are reproducible.

## 6. Testing
- Vitest unit tests for the catalog (determinism per seed, sizes per profile), M3U writer (every compat case),
  Xtream handlers (shapes, quirks, auth failures), XMLTV writer, fault parser and log redaction.
- Integration tests start `startSim({ port: 0 })` and drive it with `fetch`: playlist and API round trips, range
  requests, connection limit, each fault, log content, and that no password ever appears in the log.
- One media smoke test generates a 2-second recipe and checks the TS stream starts with a PAT and a keyframe; it
  skips without FFmpeg locally and must run in CI.
- `pnpm check` stays fast: the `large` profile is exercised by a test that counts entries in a streamed response
  without keeping the body in memory.

## 7. Constraints
- Erasable TypeScript only, `.ts` import suffixes, Node built-ins only (`node:http`, `node:zlib`,
  `node:child_process`, `node:crypto`, `node:fs`), no new dependencies.
- No real provider data, no owner credentials, no third-party media or brand names in fixtures.
- Binding defaults to `127.0.0.1`; `0.0.0.0` only when asked, since the simulator answers anyone on the network.
- `tools/AGENTS.md` documents `pnpm sim`, the accounts and the profiles.

## 8. Left to the builder
- Exact JSON values beyond the listed fields, programme title generators, logo artwork, internal module split,
  and how the HLS segment cutter caches segments, as long as §6 holds and the output is deterministic per seed.
