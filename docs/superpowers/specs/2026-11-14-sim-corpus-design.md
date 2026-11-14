# Simulator format corpus and runtime faults — Design

- Status: approved (owner delegated all development decisions on 2026-11-14)
- Date: 2026-11-14
- Issues: #46 (closed by this work), #74 (first half: recipes and the `corpus` account; the cross-platform player gate
  run stays in #74). Feeds #73 (seek, audio and subtitle switching) and the player gate of #7. Builds on the stream
  simulator spec (`2026-11-13-stream-simulator-design.md`, §5.6 media, §5.7 faults) and foundation spec §6.1.

## 1. Why
Version 0.1 must play every common provider format on live and VOD, including seek, audio language and subtitle
switching. The simulator has four recipes, one audio track per stream, no subtitles, and faults only through `?fault=`
or two fixed catalog faults on `small`. A player that builds its own Xtream URLs never sends `?fault=`, so recovery
from 403, drops and stalls cannot be tested on imported sources, and format detection (wrong `Content-Type`,
extensionless URLs that redirect to HLS) has no fixture.

## 2. Existing solutions (scan of 2026-11-14)
- **Public test streams and corpora:** vendor-hosted sample HLS streams, adaptive-streaming test vectors from industry
  forums, codec conformance bitstreams from standards bodies, and openly licensed short films. Rejected as the source:
  CI and repository tests stay offline and never depend on third-party hosts (foundation §5.8); they are real content
  under mixed licences (attribution terms, some without a licence); they cannot fail on cue; none matches the IPTV
  matrix we need (two tagged audio tracks next to subtitles, MP2 in 576p, a mid-stream resolution change in one
  TS). Synthetic generation from `lavfi` sources stays the choice: deterministic, tiny, no rights questions.
- **Installed FFmpeg** (9.0.1 essentials build on Windows, `--enable-gpl --enable-version3`; the simulator only runs
  it as a separate process and ships nothing). Checked with `-encoders`, `-muxers`, `-h muxer=hls` and test encodes:
  - Can: video `libx264` (progressive and interlaced, `field_order=tt` verified), `libx265` 8 and 10 bit,
    `mpeg2video`; audio `aac`, `ac3`, `eac3` (5.1 verified), `mp2`, `libmp3lame`; text subtitles `srt`/`subrip`,
    `webvtt`, `mov_text`, `ass`, `ttml`; muxers `mpegts`, `mp4`, `matroska`, `hls`, `webvtt`, `concat` demuxer.
  - Cannot: bitmap subtitles from text. `dvbsub` and `dvdsub` encoders exist but refuse text input ("Subtitle
    encoding currently only possible from text to text or bitmap to bitmap", verified); there is no teletext, PGS or
    CEA-608/708 caption encoder. WebVTT muxed into MPEG-TS becomes an opaque `bin_data` stream (verified), not a
    standard carriage. `dca` (DTS) and `truehd` are experimental.
  - The CI Linux image installs its distribution FFmpeg (6.1 series), built with the same external encoders
    (`libx264`, `libx265`, `libmp3lame`). Every option below exists since FFmpeg 6.0. A build without `libmp3lame`
    is handled in §5.4.
- **The other widely used open-source media pipeline framework** documents a DVB subtitle encoder fed with rendered
  text frames, the only text-to-bitmap route we know of. Rejected for now: a second multi-hundred-MB toolchain on three
  operating systems and CI, plugin sets under mixed licences, and it closes one gap only (§6). Revisit in #74.
- FFmpeg and its encoder, muxer and filter identifiers are named here because the spec must give exact settings and
  the code already depends on them; no other third-party product is named (controller's call).

## 3. Goals
- Runtime fault rules (#46) that reach the URLs a player builds; `type=<mime>` and `redirect=hls` in the same grammar.
- Seven new recipes, the existing four unchanged; one of them with two tagged audio tracks and two subtitle languages
  (SRT in MKV, `mov_text` in MP4, WebVTT renditions in an HLS master playlist).
- A `corpus` account listing every recipe as a live channel and a movie, a dated gap list, a simulator reference page.

## 4. Non-goals
- The cross-platform player gate run over the corpus (#74, second half) and the software AC-3/E-AC-3 path (#69).
- Bitmap or teletext subtitles, closed captions, alternate HLS audio renditions, fMP4 HLS, DASH, DRM (§6).
- Deleting a single rule (`DELETE /_sim/faults/<id>`), rule persistence across restarts.

## 5. Design

### 5.1 Runtime fault rules (#46)
- `POST /_sim/faults` with a JSON object `{ "account": "<username>", "stream": "<id>" | "*", "spec": "<fault spec>",
  "count"?: <n> }` answers `201` `{ "id": "r<k>" }`. Ids count up from `r1` per simulator start and never reset
  (controller's call). `stream` may also be a JSON integer (controller's call). Errors answer `400` `text/plain`:
  body not a JSON object, unknown account, `stream` not `*` or a decimal id, empty `spec` (controller's call: an empty
  spec would silently mask a catalog fault), the `FaultParseError` message of `parseFaults`, `count` not a positive
  integer. A body over 64 KB answers `413`. Stream ids are not checked against the catalog; a rule for an id the
  account lacks never matches, because unknown ids answer 404 first (controller's call).
- `GET /_sim/faults` answers `200` JSON `[{ "id", "account", "stream", "spec", "remaining" }]` in creation order;
  `stream` is echoed as a string, `remaining` is the count left or `null` for an unlimited rule. Expired rules are
  gone from the list. Rules live in memory per simulator instance.
- `DELETE /_sim/faults` clears every rule (`204`). `DELETE /_sim/requests` clears the log and the rules (the issue's
  "resets with the existing DELETE"); `SimHandle.clear()` does the same (controller's call).
- Matching: only stream requests, after credentials passed: live TS (all URL forms, including `/relative/<id>.ts`,
  which serves the `compat` account), the live `.m3u8` at the account URL, movie and episode files, and the new VOD
  `.m3u8` (§5.6). Not `/hls/...` segments and playlists (they carry no account), catch-up, data routes or `/_sim/`.
  `stream: "*"` matches every stream id of the account.
- Precedence (one source applies, nothing is merged): the `?fault=` query, then the newest matching rule, then the
  catalog fault. A rule is consumed when it is chosen, GET and HEAD alike, even if the request then fails for another
  reason (no FFmpeg, connection limit) (controller's call); at 0 it is removed.
- A rule with plain `redirect` and no `count` answers every retry with the same redirect, a loop the client must break;
  the reference page says to give it a count (controller's call).
- Log: `LogEntry` gains `faultRule: string | null` (the rule id); `fault` shows the applied spec from any source.

### 5.2 Fault grammar additions
- `type=<mime>` (`^type=[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$`, no parameters) replaces the
  `Content-Type` of a successful media response, body unchanged: live TS, the account-URL live and VOD `.m3u8`, and
  movie and episode files (200 and 206). Error answers, `/hls/...` responses and data routes keep their type
  (controller's call). Fault kind `{ kind: 'type'; mime }`.
- `redirect=hls` answers `302` to `/live/<u>/<p>/<id>.m3u8` (an absolute URL from the request's `Host`, like
  `redirect`) with the request's query minus `fault`, for the live
  account forms `/live/<u>/<p>/<id>`, `/live/<u>/<p>/<id>.ts` and `/<u>/<p>/<id>` (first segment a known username).
  On any other path, including a request that already ends in `.m3u8`, it is skipped and the next fault part applies
  (controller's call), so a rule or catalog fault `redirect=hls` never loops. Fault kind `{ kind: 'redirect-hls' }`.
  Plain `redirect` is unchanged.
- Controller note changed: extensionless live URLs need no new route — `/live/<u>/<p>/<id>` already serves TS (the
  extension is optional in the live pattern) and the short form `/<u>/<p>/<id>` exists. They gain tests and docs.

### 5.3 Shared media pipeline changes
- Recipe definitions move to `tools/src/sim/recipes.ts` (`RecipeName`, `ALL_RECIPES`, per-recipe `args`, required
  `encoders`, `mp4Args`, optional `parts` and `subtitles`); `media.ts` keeps generation and live copies.
  `ALL_RECIPES` lists the existing four, then the seven new ones in §5.4 table order.
- Every derived output and the live copy map all streams (`-map 0`): FFmpeg's default selection keeps one audio stream
  only (verified: a two-audio loop copied without `-map 0` carries one). The existing outputs are unchanged by this.
- Cache key: the four existing recipes keep their hash input `[args, seconds, 'v2']`; new recipes append their extra
  pipeline inputs (parts, subtitle languages, `'subs-v1'`) so a change regenerates them.
- Encoder probe: `missingEncoders(ffmpeg, recipe)` reads `ffmpeg -hide_banner -encoders` once per executable. A server
  request for such a recipe answers the existing 503 "this FFmpeg build lacks the <encoder> encoder needed by recipe
  <recipe>". Tests skip that recipe and print `ENCODER_SKIP_MARKER` (`FFmpeg lacks an encoder, recipe tests skipped`,
  exported next to `MEDIA_SKIP_MARKER`),
  which the `vitest` check turns into a note; with `CI=true` a missing encoder fails like missing FFmpeg does.
  `--prepare` skips such recipes and names them in its one line (controller's call).

### 5.4 Recipes
Shorthand: `PIC(s,r)` = `-f lavfi -i testsrc=size=s:rate=r`; `TONE(f)` = `-f lavfi -i sine=frequency=f:sample_rate=48000`;
`X264` = `-c:v libx264 -preset veryfast -pix_fmt yuv420p`; `CBR(b)` = `-b:v b -maxrate b -bufsize 2b`;
`GOP(n)` = `-g n -keyint_min n -sc_threshold 0`; `AAC` = `-c:a aac -b:a 64k -ac 2`. Unchanged: `h264-aac-720p25`,
`hevc-main10-1080p25`, `mpeg2-ac3-576i25`, `aac-radio`; the existing profiles keep using only these four.

| Recipe | Loop arguments (before `-t <seconds> -f mpegts`) | Notes |
|---|---|---|
| `hevc-main-1080p25` | `PIC(1920x1080,25) TONE(1000) -c:v libx265 -preset veryfast -pix_fmt yuv420p -profile:v main -b:v 1000k -x265-params keyint=25:min-keyint=25:scenecut=0:open-gop=0:log-level=error AAC` | MP4 `-tag:v hvc1`, like main10 |
| `h264-aac-1080i25` | `PIC(1920x1080,50) TONE(1000) -vf tinterlace=mode=interleave_top,format=yuv420p X264 -flags +ildct+ilme -x264-params tff=1 CBR(1500k) GOP(25) AAC` | 50 fields/s, top first |
| `h264-eac3-720p50` | `PIC(1280x720,50) TONE(1000) X264 CBR(700k) GOP(50) -c:a eac3 -b:a 192k -ac 6` | layout `5.1(side)` |
| `h264-mp2-576p25` | `PIC(720x576,25) TONE(1000) -vf setsar=64/45 X264 CBR(500k) GOP(25) -c:a mp2 -b:a 192k -ac 2` | anamorphic 16:9, DVB-like (controller's call) |
| `h264-mp3-720p30` | `PIC(1280x720,30000/1001) TONE(1000) X264 CBR(500k) GOP(30) -c:a libmp3lame -b:a 128k -ac 2` | needs `libmp3lame` |
| `h264-aac-res-switch` | two-part build below | 720p and 1080p alternate |
| `h264-2audio-subs-720p25` | `PIC(1280x720,25) TONE(1000) TONE(600) -map 0:v -map 1:a -map 2:a X264 -profile:v high -level:v 3.1 CBR(500k) GOP(25) AAC -metadata:s:a:0 language=tur -metadata:s:a:1 language=eng` | §5.5 |

- Every recipe needs `libx264` or `libx265` plus native encoders; only `libmp3lame` is commonly missing.
- `h264-mp3-720p30` keeps a 30-frame GOP: its HLS segments are 2.002 s (verified). The live playlist keeps
  `#EXTINF:2.000`; VOD playlists take the real durations (§5.6) (controller's call).
- `h264-aac-res-switch`: `part-a.ts` = `PIC(1280x720,25) X264 -profile:v high CBR(500k) GOP(25) -t <switch> -f mpegts`,
  `part-b.ts` the same at `1920x1080` with `CBR(1000k)`, both video only. A concat list in the work folder alternates
  `file 'part-a.ts'` / `file 'part-b.ts'` for `ceil(seconds / switch)` lines; the loop is
  `-f concat -i parts.txt TONE(1000) -map 0:v -map 1:a -c:v copy AAC -t <seconds> -f mpegts`. Encoding audio in the
  same pass as the parts drifts 21 ms per join (verified); video-only parts plus one continuous tone give exact 2 s
  segments with every switch on a segment boundary (verified). `switch` is 30 s, or for loops under 60 s
  `max(2, 2 * floor(seconds / 4))` so 4-second test loops switch at 2 s (controller's call). Part files and the list
  are deleted before the cache folder is published. No discontinuity tag marks a switch; only the loop point has one
  (controller's call).
- Measured for 30 s on the development machine (12 threads): HEVC 1080p 5.8 s, 1080i 5.0 s, 720p50 2.4 s, 720p25
  1.3 s; a full 600 s `--prepare` of the new recipes takes about six minutes.

### 5.5 Two audio tracks and subtitles (`h264-2audio-subs-720p25`)
- Tones: Turkish track 1000 Hz, English 600 Hz. In TS (loop, live, HLS segments) both audio PIDs carry ISO 639
  language descriptors `tur` and `eng`. No subtitles in TS (§6).
- Cues come from code in `subtitles.ts`: one cue per whole second `t` of the loop, `t` to `t+1`, text
  `TUR mm:ss` or `ENG mm:ss` of `t` (for example `TUR 00:12`) (controller's call). The same function writes SRT files
  for generation and WebVTT segments at request time; nothing comes from fixtures.
- MP4: `-i loop.ts -i tur.srt -i eng.srt -map 0 -map 1 -map 2 -c:v copy -c:a copy -c:s mov_text -movflags +faststart`;
  MKV the same with `-c:s srt` and no `-movflags`. Both add `-metadata:s:s:0 language=tur -metadata:s:s:1 language=eng -disposition:a:0 default
  -disposition:a:1 0 -disposition:s:0 0 -disposition:s:1 0`: Turkish audio is the default and no subtitle is
  (controller's call). The SRT files are deleted after muxing.
- Account-URL `.m3u8` for this recipe (live and VOD, §5.6) answers a master playlist (`tr` shown; `en` alike):
  ```
  #EXTM3U
  #EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="tr",NAME="Turkish",DEFAULT=NO,AUTOSELECT=YES,URI="/hls/<recipe>/subs/tur/<mode>.m3u8"
  #EXT-X-STREAM-INF:BANDWIDTH=700000,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720,FRAME-RATE=25.000,SUBTITLES="subs"
  /hls/<recipe>/<mode>.m3u8
  ```
  `<mode>` is `live` or `vod`. CODECS follows the pinned profile and level; BANDWIDTH is the 500k video peak plus two
  64k tracks and TS overhead (controller's call). The muxed media playlist keeps both audio tracks.
- Controller note changed: `LANGUAGE` is `tr` / `en`, not `tur` / `eng` — RFC 8216 requires an RFC 5646 tag, and
  RFC 5646 uses the two-letter code where one exists. Containers, descriptors and URL paths keep `tur` / `eng`.
- Subtitle media playlists mirror the video playlist of the same mode: same `MEDIA-SEQUENCE`, `DISCONTINUITY-SEQUENCE`,
  discontinuity tags and `EXTINF` values, URIs `/hls/<recipe>/subs/<lang>/<seq>.vtt`.
- WebVTT segment `seq` covers loop time `[2i, 2i+2)` with `i = seq mod segmentCount` (this recipe's segments are exact
  2 s; a test asserts it):
  ```
  WEBVTT
  X-TIMESTAMP-MAP=MPEGTS:<first video PTS of seg i>,LOCAL:<2i as hh:mm:ss.mmm>

  <2i> --> <2i+1>
  TUR mm:ss
  ```
  The PTS is read from the pre-cut segment file (first PES with a video stream id and a PTS, 33-bit value) and memoised
  per file; segments keep the loop's timestamps (seg i starts at 133200 + 180000·i in a 9.0.1 test), so cues line up
  with the picture across loop wraps and FFmpeg versions (controller's call). Served as `text/vtt`.
- FFmpeg's HLS muxer could write WebVTT renditions, but its numbering would not follow our clock-driven window and loop
  wrap; generating text in code keeps live and VOD consistent (the controller note's decision, kept).

### 5.6 HLS routes
- Unchanged: `/live/<u>/<p>/<id>.m3u8` answers the sliding window directly for recipes without subtitles;
  `/hls/<recipe>/<seq>.ts` segments.
- New, account-free like segments: `/hls/<recipe>/live.m3u8` (the same window as today), `/hls/<recipe>/vod.m3u8`,
  `/hls/<recipe>/subs/<lang>/live.m3u8`, `.../vod.m3u8`, `.../<seq>.vtt` (`404` for an unknown recipe or language).
- Controller note changed: the note asks live and VOD HLS variants to slide or list "like the existing HLS route", but
  no VOD HLS route exists — VOD files are MP4 and MKV only. The spec adds `/movie/<u>/<p>/<id>.m3u8` and
  `/series/<u>/<p>/<id>.m3u8` for every movie and episode: the VOD media playlist (master for the subtitle recipe),
  with credentials, rules, `type=` and no connection slot, like the live playlist. Catalog extensions stay `mp4`/`mkv`.
- VOD media playlist: `#EXT-X-VERSION:3`, `#EXT-X-TARGETDURATION:2`, `#EXT-X-MEDIA-SEQUENCE:0`,
  `#EXT-X-PLAYLIST-TYPE:VOD`, every segment `i` as `/hls/<recipe>/<i>.ts` with the `EXTINF` from FFmpeg's
  `segments/index.m3u8`, `#EXT-X-ENDLIST`. Every playlist is `application/vnd.apple.mpegurl`.

### 5.7 `corpus` account and profile
- Account `corpus` / `corpus`, profile `corpus`, `maxConnections: 1`, `status-509`, not expired, no quirks. Served by
  `/get.php`, `/player_api.php`, `/xmltv.php`, `/playlists/corpus.m3u[8]` and `/guides/corpus.xml[.gz]`; the M3U
  follows the plain (non-`compat`) writer. The seed only changes the guide (controller's call).
- Categories (ids as elsewhere: live `1`-`5`, VOD `10001`-`10005`, series `20001`): `Video codecs`, `Audio codecs`,
  `Frame rates`, `Tracks and subtitles`, `Edge cases`; the series category is `Tracks and subtitles`.
- Live (ids from 1001 in table order; guide id `ch<id>`, logo `id % 16`, no catch-up) (controller's call on grouping):

  | Category | Channels (name: recipe) |
  |---|---|
  | Video codecs | `H.264 720p25 AAC`: h264-aac-720p25; `HEVC 1080p25 8-bit`: hevc-main-1080p25; `HEVC 1080p25 10-bit`: hevc-main10-1080p25; `MPEG-2 576i25 AC-3`: mpeg2-ac3-576i25 |
  | Audio codecs | `H.264 576p25 MP2`: h264-mp2-576p25; `AAC radio`: aac-radio |
  | Frame rates | `H.264 1080i25`: h264-aac-1080i25; `H.264 720p50 E-AC-3 5.1`: h264-eac3-720p50; `H.264 720p29.97 MP3`: h264-mp3-720p30 |
  | Tracks and subtitles | `Two audio tracks and subtitles`: h264-2audio-subs-720p25 |
  | Edge cases | `Resolution switch 720p and 1080p`: h264-aac-res-switch; `Stream labelled as a web page`: h264-aac-720p25 with catalog fault `type=text/html`; `Redirect to HLS`: h264-aac-720p25 with catalog fault `redirect=hls` |

  The two fault channels (1012, 1013) are additions so an imported corpus exercises format detection without rules
  (controller's call).
- Movies (ids from 200001, same categories, `durationSec` 600 = the default recipe length, `added` 1,700,000,000):
  one per recipe in the order recipes first appear in the table, in the VOD category of the same name, named
  `<channel name> (MP4|MKV)`. MKV: hevc-main-1080p25, mpeg2-ac3-576i25,
  h264-mp2-576p25 (MP4 signals MP2 as generic MPEG audio, §6), h264-aac-1080i25, h264-aac-res-switch; MP4: the
  others; the subtitle recipe gets an MP4 and then an MKV movie, so each container appears six times
  (controller's call).
- Series 300001 `Subtitle Series`: seasons 1 and 2 with three episodes each (ids 400001-400006, titles
  `Subtitle Series S01E01` …), all `mkv`, recipe h264-2audio-subs-720p25, `durationSec` 600.
- Guide window as `small` (2 days back, 7 forward).

### 5.8 Module layout and limits
- New: `fault-rules.ts` (rule store, JSON validation; HTTP I/O stays in `server.ts`), `recipes.ts`, `subtitles.ts`
  (cues, SRT, WebVTT), `mpegts.ts` (first video PTS), `hls.ts` (all playlist text, `hlsPlaylist` moves here),
  `routes-hls.ts` (`/hls/...`, segment serving moves here), `corpus.ts`, `catalog-types.ts`.
- `catalog.ts` is at 377 lines and `corpus.ts` needs the catalog types while `catalog.ts` calls it; the type-aware
  `no-circular` rule forbids that cycle. The catalog types move to `catalog-types.ts`, which `catalog.ts` re-exports so
  existing imports keep working (controller's call). Every file stays under 400 lines.

## 6. Known gaps (`docs/learned/sim-format-gaps.md`)
| Format | Why not generated | Revisit |
|---|---|---|
| DVB bitmap subtitles in TS, PGS in MKV | no text-to-bitmap path in FFmpeg (verified); no PGS encoder | #74 |
| Teletext subtitles, CEA-608/708 captions | no encoder | #74 |
| Subtitles in TS for the subtitle recipe | follows from the two rows above; WebVTT in TS is not a standard carriage | #74 |
| HLS alternate audio renditions (`TYPE=AUDIO`) | not generated; audio stays muxed (two PIDs) | #73 if needed |
| ASS/SSA tracks in MKV | FFmpeg can write them; styling belongs to #32 | #32 |
| MP2 in MP4 | the muxer writes the generic MPEG audio object type; readers may label it MP3, so the movie is MKV | — |
| Resolution change in MP4/MKV | the sample entry or codec private data describes the first resolution; the change is in-band | #74 |
| Default subtitle in MP4 | the muxer marks the first text track enabled although no disposition is set | — |
| DTS, TrueHD | experimental encoders; rare on IPTV | — |

## 7. Testing
- `sim-faults.test.ts`: `type=text/html`, `type=application/octet-stream`, `redirect=hls` parse; `type=html`,
  `type=text/html;charset=x` and `redirect=dash` fail with the part named.
- `sim-fault-rules.test.ts` (no FFmpeg): POST/GET/DELETE shapes and every 400; `status=403` on Xtream live id 1001 of
  `demo` (403, log `fault` and `faultRule`); `count: 2` of `status=429` answers twice then not, `remaining` 1 then gone;
  query beats rule, newest rule beats older, rule beats the catalog fault of `demo` 1013; `DELETE /_sim/requests` and
  `clear()` reset; HLS segments and catch-up are never matched. With FFmpeg: `drop@1s` ends the live TS body with an
  error 1 to 3 s after the first byte; `stall2s@1s` shows a gap of at least 1.8 s between chunks.
- Delivery quirks: `redirect=hls` from `/live/u/p/1001`, `.ts` and the short form (302 to `.m3u8`, query kept,
  `fault` dropped) and skipped on `.m3u8`; with FFmpeg the extensionless forms start with a PAT, and `type=text/html`
  serves TS bytes and a ranged MP4 under that type.
- `sim-recipes.test.ts` (FFmpeg, 4 s loops): each new recipe's loop, MP4, MKV and segments probed with
  `ffmpeg -hide_banner -i <file>` stream lines (codec, size, `top first`, `29.97 fps`, `50 fps`, `5.1`,
  `SAR 64:45`, `(tur)`/`(eng)`, `hvc1`), no separate probe tool (controller's call); res-switch segment 0 is 1280x720
  and segment 1 1920x1080; `/hls/h264-mp3-720p30/vod.m3u8` lists `2.002`; `missingEncoders` against a stub list.
- `sim-subtitles.test.ts`: cue text, SRT and WebVTT text (pure); `mpegts.ts` PTS on hand-built packets; with FFmpeg
  the MKV and MP4 contain both languages' cue text, the master and subtitle playlists match §5.5, sequence and
  discontinuity numbers equal the video playlist's at the same clock, and for every segment the first cue maps to the
  segment's first video PTS within 100 ms while seg i − seg 0 equals 2i s within 100 ms.
- `sim-catalog.test.ts` / `sim-xtream.test.ts` / `sim-m3u.test.ts`: corpus shape (13 channels, 12 movies, 6 episodes),
  every `ALL_RECIPES` entry once among fault-free channels and as a movie, both containers, the account, M3U and API
  round trips. Existing tests keep passing unchanged except for the `faultRule` field and moved imports.

## 8. Documentation
- `tools/AGENTS.md` is at the 50-line limit: its simulator section shrinks to the command line, FFmpeg lookup and a
  link to a new reference page `docs/simulator.md` that holds routes, accounts, faults, rules and recipes
  (controller's call).
- `docs/learned/sim-format-gaps.md` (the §6 table) with a dated entry in `docs/learned/README.md`; `docs/INDEX.md`
  links this spec and `docs/simulator.md`.

## 9. Left to the builder
Exact error texts beyond §5.1, internal function signatures, helper names in tests, and how the PTS memo is keyed, as
long as §7 holds and output stays deterministic.
