# Format Corpus Gate & Stream-Sniffing Hardening Design (`#74`)

- **Date:** 2026-11-15
- **Issue:** `#74` (`0.1` milestone — Format corpus gate & cross-platform verification)
- **Depends on:** `#8` (`mpv` desktop engine), `#69` (Media3 LGPL FFmpeg audio extension), `#7` (`@elv/engine-aether`), `#73` (audio/subtitle track selection)

## 1. Goal

Prove that every media recipe, container, audio/video codec, subtitle format, and delivery quirk in the stream simulator's `corpus` profile plays without error across all seven `0.1` targets (**Android TV**, **Fire OS**, **Android phone**, **Apple TV**, **iPhone/iPad**, **Windows**, and **macOS**), and close the stream-sniffing and empty-VOD edge cases uncovered during the player-core review.

## 2. Root-Caused Sniffing & Engine Edge Cases

1. **Live MPEG-TS mislabelled as an HLS playlist (`Content-Type: application/vnd.apple.mpegurl`):**
   - *Current bug:* `SniffingDataSource.kt` skips `readAhead` when `isHlsContentType(contentType)` is true on `RequestKind.PROGRESSIVE`, and `ResponseSniffing.kt`, `ResponseSniffing.swift`, and `LiveTsReader.swift` classify progressive responses as HLS playlists from the `Content-Type` header alone. A raw MPEG-TS stream served with `application/vnd.apple.mpegurl` or `application/x-mpegurl` is handed to the HLS parser and never plays.
   - *Fix:* Always read ahead up to `SNIFF_BYTES` (`1024`) on progressive responses before classifying. Classify a progressive response as `HLS` / `.playlist` **only** when the body prefix (after optional UTF-8 BOM and ASCII whitespace) starts with `#EXTM3U`.

2. **Live MPEG-TS mislabelled as `text/html` on Apple (`ResponseSniffing.swift` & `LiveTsReader.swift`):**
   - *Current bug:* `classifyProgressive` in `ResponseSniffing.swift` returns `.notice` whenever `isProgressiveNoticeContentType(contentType)` is true—before checking `hasTsSync` or printable UTF-8—and `LiveTsReader.handleStatus` rejects `2xx` reconnects in `.streaming` on `isProgressiveNoticeContentType(contentType)` alone. Corpus channel `1012` (`type=text/html`) fails on Apple.
   - *Fix:* Judge progressive responses by body bytes first (matching Android's `ResponseSniffing.kt`): `#EXTM3U` -> `.playlist`; non-empty printable UTF-8 without TS sync -> `.notice`; `hasTsSync` -> `.media(formatHint: "mpegts")`. On `.streaming` single-drop reconnect in `LiveTsReader`, do not reject `2xx` headers on `Content-Type` alone before inspecting bytes.

3. **Two-byte MPEG-TS sync false positive (`0x47` = ASCII `'G'`):**
   - *Current bug:* `hasTsSync` in both `ResponseSniffing.kt` and `ResponseSniffing.swift` accepts `count >= 2` sync bytes (`189..376` bytes). A short printable ASCII provider notice that happens to place two `'G'` characters 188 bytes apart is misclassified as MPEG-TS instead of `NOTICE`.
   - *Fix:* Require at least **3** consecutive `0x47` sync bytes spaced 188 bytes apart (`positions.size >= 3` / `count >= 3`, requiring `>= 377` bytes; `SNIFF_BYTES = 1024` holds 5 full 188-byte packets).

4. **Mid-file / range WebVTT & `text/vtt` subtitle segments (`ResponseSniffing.kt`):**
   - *Current bug:* `isSubtitleSegment` checks `startsWith(WEBVTT)`, `<tt`, `<?xml`, and an anchored `^` `SRT_CUE` regex. A mid-file byte-range slice of WebVTT, a WebVTT segment beginning with `NOTE`/`STYLE`/cue identifiers before the first timestamp, or a `MM:SS.mmm --> MM:SS.mmm` WebVTT timestamp without hours fails `startsWith(WEBVTT)` and `^`-anchored `SRT_CUE`, causing `SniffingDataSource` to throw `ProviderNoticeException` (`connection-limit`).
   - *Fix:* Accept `contentType` `text/vtt` (when not HTML) and match unanchored WebVTT/SubRip cue timing lines (`(?m)^\s*(?:\d+:)?\d{2}:\d{2}[.,]\d{3}[ \t]*-->[ \t]*(?:\d+:)?\d{2}:\d{2}[.,]\d{3}`) anywhere in the `SNIFF_BYTES` prefix.

5. **Empty HTTP 200 (`0`-byte body) on VOD across Media3, Aether, and `mpv`:**
   - *Current bug:* When an HTTP server answers `200 OK` with `Content-Length: 0` (0 bytes) on a VOD URL:
     - Media3 `SniffingDataSource` returns `ResponseKind.MEDIA` for `filled == 0`, `ProgressiveMediaPeriod` immediately finishes loading with 0 tracks, and `EventReporter.kt` emits `state: "ended"` even though `played == false`.
     - Aether `EngineCore.swift` emits `state: .ended` on `.phase(.ended)` for VOD even when `!played && !framed`.
     - Desktop `mpv` (`derive.ts` + `errors.ts`) maps `end-file` `reason: "eof"` on VOD to `{ kind: 'ended' }` even when `media.restarted === false`.
   - *Fix:*
     - Simulator: add `empty` fault (`fault=empty` -> `200 OK` with `Content-Length: 0` and empty body) in `tools/src/sim/faults.ts` and `request-faults.ts`.
     - Media3 (`SniffingDataSource.kt` + `ResponseSniffing.kt` + `EventReporter.kt`): an initial (`dataSpec.position == 0L`, no `Content-Range`) `PROGRESSIVE` or `MANIFEST` response with `filled == 0` throws `ProviderNoticeException` when `isNoticeContentType(contentType, hls = false)` and otherwise fails as empty media (`EOFException` / `network`), and `EventReporter.kt` maps `state == "ended"` when `!played` to an `"network"` error (`"empty media ended before playback"`) rather than `"ended"`.
     - Aether (`EngineCore.swift` + `LiveTsReader.swift`): `.phase(.ended)` when `!played && !framed` (even on VOD) reports a `network` error (`"vodEndedBeforePlay"`) instead of `.state(.ended)`, and a 0-byte `2xx` in `LiveTsReader` fails with `.notice` (if notice `Content-Type`) or transport EOF rather than `.media`.
     - Desktop `mpv` (`derive.ts` + `errors.ts`): pass `played: media.restarted` into `classifyEnd`; when `reason === 'eof'` and `!p.played`, return `connection-limit` if `Mime-type: 'text/'` was logged, otherwise `network` (`'empty-vod-eof'`), never `{ kind: 'ended' }`.

## 3. Simulator Corpus Additions

Extend `tools/src/sim/corpus.ts` and `tools/src/sim/faults.ts`:
1. Add corpus live channel `1014` (`'Stream labelled as a playlist'`, `'h264-aac-720p25'`, group `4` `'Edge cases'`, fault `'type=application/vnd.apple.mpegurl'`).
2. Add request-level fault `empty` in `faults.ts` / `request-faults.ts` (`200 OK`, `content-length: 0`, preserving any `type=<mime>` fault header).

## 4. Automated Corpus Verification Harness (`--corpus`)

Add corpus verification mode to both gate runners so every `0.1` platform runs an automated, repeatable proof against `corpus` (`maxConnections = 1`):

1. **Corpus Test Matrix (28 items per platform):**
   - **14 Live Streams:**
     - `1001`..`1011` as `.ts` (all 11 recipes: H.264 720p25 AAC, HEVC 1080p25 8-bit, HEVC 1080p25 10-bit, MPEG-2 576i25 AC-3, H.264 576p25 MP2, AAC radio, H.264 1080i25, H.264 720p50 E-AC-3 5.1, H.264 720p29.97 MP3, 2-audio + DVB subs, resolution switch 720p/1080p).
     - `1012` as `.ts` (`Stream labelled as a web page`, `Content-Type: text/html`).
     - `1013` as **extensionless** `/<user>/<pass>/1013` (`302` redirect to `/live/<user>/<pass>/1013.m3u8`).
     - `1014` as `.ts` (`Stream labelled as a playlist`, `Content-Type: application/vnd.apple.mpegurl`).
   - **1 Live HLS Master + WebVTT Stream:**
     - `1010.m3u8` (`h264-2audio-subs-720p25` master playlist with `tur` + `eng` WebVTT subtitle renditions).
   - **12 VOD Container Movies (`.mp4` & `.mkv`):**
     - `200001`..`200012` with each movie's actual container extension from `corpusCatalog(1)` (`6` MP4 + `6` MKV, covering HEVC, MPEG-2 + AC-3, MP2, E-AC-3 5.1, MP3, AAC radio, 1080i, res-switch, and 2-audio + embedded subs in both MP4 `mov_text` and MKV `subrip`).
   - **1 VOD HLS + WebVTT Stream + 1 Empty-200 VOD Fault Check:**
     - `200010.m3u8` (VOD HLS master playlist + WebVTT renditions) -> reaches `playing`, selects subtitle track without `ProviderNoticeException`.
     - `200001.mp4?fault=empty` -> fails cleanly (`status.kind === 'failed'`, never `ended` or wedged).

2. **Pass Criteria per Platform:**
   - Every playable item reaches `playing` (`firstFrameAt !== undefined`, clock anchor advancing) within budget; audio-only `aac-radio` (`1006`, `200006`) reaches `playing` without video tracks; `1010` / `200010` expose `>= 2` audio tracks and `>= 2` text tracks (where track API from `#73` is active).
   - Empty-200 VOD (`200001.mp4?fault=empty`) reaches `failed` (never `ended`, never hangs).
   - Simulator log for account `corpus` (`maxConnections: 1`) records **`0` `509` limit responses** across the entire sequential sweep!
   - JSON report written to `docs/learned/gates/corpus-<target>.json` (`android-tv`, `fire-os`, `android-phone`, `tvos`, `ios`, `desktop-windows`, `desktop-macos`) and summarized in `docs/learned/README.md`.
