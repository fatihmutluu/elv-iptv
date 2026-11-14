# Stream simulator reference

Specs: [stream simulator](superpowers/specs/2026-11-13-stream-simulator-design.md) and
[simulator corpus](superpowers/specs/2026-11-14-sim-corpus-design.md).

## Streams
- Streams: VOD `/movie|series/<u>/<p>/<id>.mp4|mkv` (`Range`); live `/live/<u>/<p>/<id>.ts`, `/live/<u>/<p>/<id>` (no extension, TS),
  `/<u>/<p>/<id>` (short form, TS), `*/relative/<id>.ts` (FFmpeg loop, killed on disconnect); `.m3u8` (6x2 s window,
  `/hls/<recipe>/<seq>.ts`);
  `/redirect/<id>.ts` (302); catch-up (`/timeshift/...`, `/streaming/timeshift.php`, `/catchup/<id>.ts`,
  `archive-|index-|timeshift_abs-` paths) answers a plain recorded file.
  TS live and VOD over `maxConnections`: 509, 403 or a notice.

## Accounts
- Accounts (password = username): `demo` (small, 1 connection), `large` (2), `compat` (1), `expired`, `quirks`
  (real-panel shapes: CRLF playlist, +0100 guide), `huge` (500k entries, 2 connections; opt-in, not in `pnpm check`).

## Data routes
- Routes: `/get.php`, `/player_api.php`, `/xmltv.php`; `/playlists/<profile>[-variant].m3u|.m3u8`,
  `/playlists/broken/<status>.m3u`, `/guides/<profile>.xml[.gz]`, `/logos/<0-15>.png`, `/_sim/requests` (GET, DELETE),
  `/_sim/events` (GET, POST JSONL <= 1 MB). Log: passwords `***`.

## Faults
- Faults: `?fault=<spec>`, parts joined by `,`: `status=<200-599>`, `slow-start=<s>`, `redirect`, `text-notice` (before
  any route), `drop@<s>`, `stall<n>s@<s>`, `rate=<kbps>`, `type=<mime>`, `redirect=hls`. Drop, stall and rate apply to TS and VOD responses only
  (not HLS segments or data routes). Unknown: 400. Catalog faults (1013, 1014) act like a query.
- `type=<mime>` relabels the `Content-Type` of live TS, the live `.m3u8` and movie/episode responses (also ranged
  ones); the body is unchanged. Not catch-up, HLS segments or data routes. The first `type` part wins.
- `redirect=hls` answers 302 to `/live/<u>/<p>/<id>.m3u8` (query kept, `fault` dropped) for `/live/<u>/<p>/<id>[.ts]`
  and `/<u>/<p>/<id>`. Any other path (the `.m3u8` itself, movies, data routes) skips it and is served normally,
  so a rule without a `count` redirects the TS once and then serves the playlist.

## Runtime fault rules
Rules attach a fault spec to the streams of one account at run time, for players that build their own URLs.
- `POST /_sim/faults` with `{ "account": "<username>", "stream": "<id>" | "*", "spec": "<fault spec>", "count"?: <n> }`
  answers `201 {"id":"r<k>"}`. Ids count up from `r1` and are never reused. `stream` may be a string or integer id.
  `400` (`text/plain`, the reason) for a body that is not a JSON object, an unknown account, a `stream` that is not
  `*` or a decimal id, an empty or malformed `spec` (the fault parser's message) and a `count` that is not a positive
  integer. `413` over 64 KB. Stream ids are not checked against the catalog; a rule for an id the account lacks
  never matches because unknown ids answer 404 first.
- `GET /_sim/faults` lists `[{ id, account, stream, spec, remaining }]` in creation order; `remaining` is null for an
  unlimited rule. Expired rules are gone.
- Matching: stream requests after credentials passed (live TS in every URL form, the live `.m3u8` at the account
  URL, movies and episodes). Not `/hls/...` segments, catch-up, data routes or `/_sim/`. `stream: "*"` matches every
  id of the account.
- Precedence: the `?fault=` query, then the newest matching rule, then the catalog fault. One source applies;
  nothing is merged.
- Counting: a rule is consumed when chosen, GET and HEAD alike, even if the request then fails for another reason
  (no FFmpeg, connection limit); at 0 it is removed. Parallel requests consume it once each.
- A plain `redirect` rule without a `count` redirects every retry, a loop the client must break: give it a count.
- Log: each entry has `faultRule` (the rule id or null); `fault` is the applied spec from any source.
- Resets: `DELETE /_sim/faults`, `DELETE /_sim/requests` and `SimHandle.clear()` remove every rule.
