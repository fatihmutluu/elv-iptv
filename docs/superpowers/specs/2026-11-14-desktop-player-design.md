# Desktop player for 0.1 — Design

- Status: approved (owner delegated all development decisions on 2026-11-14)
- Date: 2026-11-14
- Issue: #8. Player core spec `2026-11-14-player-core-design.md` §5 (port, service), §7 (gate); foundation spec §1.4,
  §3, §5.5, §10, §11; ADR 0002 (desktop).

## 1. Why
Version 0.1 is a plain, flawless live and VOD player, and the owner tests it on Windows, macOS and an iPhone. The
foundation design for desktop (libmpv rendering offscreen, frames copied through shared memory to a WebGL canvas under
DOM overlays) works in an MIT project, but it costs weeks of native work and an LGPL build pipeline for a benefit (DOM
menus over video) that a plain player does not need. mpv already plays what the hostile IPTV formats demand (raw
MPEG-TS over HTTP, MPEG-2 video, MP2, AC-3 and DTS audio, MKV) and ships an on-screen controller with seek, pause and
track selection. This spec puts mpv behind the same `PlayerEngine` port as Android, so `PlaybackService` (tune tokens,
recovery ladder, connection-limit path) runs unchanged on desktop, and moves the integrated overlay to Round 2.

## 2. Goals
- A desktop `PlayerEngine` in the Electron main process that drives one mpv process per player window over mpv's JSON
  IPC and passes the player core contract (tokens, one media at a time, stable error codes, clock anchors).
- A typed IPC bridge (preload `contextBridge`) and a renderer engine proxy, so `@elv/playback`'s `PlaybackService` runs
  in the renderer as on Android. The renderer stays sandboxed and loads no native addon.
- Presentation: on Windows mpv draws into a frameless child window kept on the player area (`--wid`); on macOS mpv
  shows its own window. mpv's on-screen controller (OSC) gives seek, pause, audio and subtitle selection in 0.1.
- LGPL-only mpv runtimes for Windows x64 and macOS arm64, fetched by a pinned `tools` script, packaged by
  electron-builder, with licence notices and build information.
- `pnpm gate desktop` on Windows (this PC) and on the owner's Mac over SSH when reachable, with the Android budgets.

## 3. Non-goals
- DOM overlays over video, the offscreen frame-copy design and custom player controls: Round 2, with the design
  language (new issue).
- Desktop catalog storage (#75); the menu and channel pickers (#13); VOD controls through the port (#73; on desktop
  they map to mpv `aid`/`sid`); Linux (best effort later); Windows arm64 and Intel Macs.
- Store builds, Mac App Store sandboxing, code signing and notarisation: 0.1 ships direct downloads; signing needs the
  owner.

Anti-goals (from the player core, plus one): a stale event never changes a newer tune; a zap never holds two provider
connections; no mpv process may keep a stream open after the app closed or crashed.

## 4. Existing solutions
Private scan of 2026-11-14 (`.superpowers/research/reports/desktop-player-scan-2026-11.md`) and checks made for this
spec on mpv 0.42.0 docs, release assets, licence files and issues (no GPL source file opened):
- **IPTVnator (MIT):** a frame-copy engine and a native-view engine, both experimental. Its docs report that mpv `wid`
  renders black inside Electron on macOS, that DOM cannot draw over a child window (#1571, #1743), and that Windows
  Smart App Control blocks unsigned helper executables (#1975). Its frame-copy code is the Round 2 base.
- **mpv 0.42.0 (2026-11-05):** JSON IPC over `--input-ipc-server` (named pipe on Windows, Unix socket elsewhere) or
  `--input-ipc-client` (an inherited fd, or since 0.42 a Windows handle; mpv quits when that connection closes; the IPC
  exposes `run`, so it must stay private). `loadfile <url> <flags> <index> <options>`: since 0.38 per-file options need
  index `-1`; the command returns before the old file has stopped. `start-file` and `end-file` carry
  `playlist_entry_id`; `end-file` has `reason` (`eof`, `stop`, `quit`, `error`, `redirect`) and `file_error`.
  `--demuxer-termination-timeout` (0.1 s; forceful close when loading is aborted). New libcurl network backend, on by
  default, with connection reuse and transparent retries. Log messages are documented as hints that should not be
  parsed. A D3D11 render API for libmpv arrived (relevant for Round 2).
- **Licence (mpv `Copyright`):** `-Dgpl=false` yields LGPLv2.1+ when no GPL-only file is built; none of the GPL-only
  files (X11, VAAPI, VDPAU, OSS, JACK, DVB, DVD, CDDA, legacy Direct3D) matter on Windows or macOS. Upstream adds that
  LGPL mode is intended for libmpv and building the CLI in LGPL mode is "currently not recommended".
- **Windows binaries:** nobody publishes an LGPL mpv executable. zhongfly/mpv-winbuild (MIT recipe, 30-day retention)
  ships LGPL only as `mpv-dev-lgpl-*` (libmpv, built with `-Dcplayer=false`); its players are GPL. The official 0.42.0
  release has `libmpv-v0.42.0-x86_64-w64-mingw32-lgpl.zip` (GPG-signed; one static `libmpv-2.dll`: mpv `-Dgpl=false`,
  FFmpeg `--enable-version3` without `--enable-gpl`, x264, x265, rubberband, vidstab, xvid and frei0r disabled; only
  `LICENSE.LGPL` inside). The official `mpv.exe` builds embed `-Dgpl=true`.
- **macOS binaries:** Homebrew mpv and FFmpeg are GPL; MPVKit and libmpv-darwin-build ship libmpv frameworks, no
  player; so we build it. **Chromium playback** (mpegts.js, hls.js) lacks MPEG-2, MP2, DTS and MKV: rejected.

## 5. Design

### 5.1 Process layout
- Main process: `MpvEngine` implements `PlayerEngine`, one per player window, and owns one mpv process (started with
  the engine, kept across zaps), one IPC connection and, on Windows, one video window. Asynchronous I/O only.
- Preload: exposes a frozen `window.elv.player` through `contextBridge`; no raw `ipcRenderer` reaches the page.
- Renderer: `createDesktopEngine()` returns a `PlayerEngine` proxy over `window.elv.player`; `PlaybackService` and the
  player screen use it exactly like the Android engine.

### 5.2 mpv runtime and licensing
- **Windows x64:** `elv-mpv.exe`, a small launcher of ours (C, about 100 lines, `apps/desktop/native/mpv-host/`) that
  hands its `--option=value` arguments to libmpv, turns on what the CLI has and libmpv leaves off
  (`input-default-bindings`, `input-vo-keyboard`, `osc`), and runs until mpv shuts down. It links dynamically to the
  official LGPL `libmpv-2.dll` of mpv 0.42.0 (zip SHA-256
  `8e5f77430efc53ef175804ba6618527e3af0448a0dcabf04d3cc72659d1a6fce`; GPG signature checked whenever the pin changes).
  It is a separate process, so libmpv never loads into Electron and users can still replace the DLL.
- **macOS arm64:** built by us in a GitHub Actions macOS job: FFmpeg (shared libraries, no `--enable-gpl` or
  `--enable-nonfree`, VideoToolbox on), libplacebo, libass with FreeType, FriBidi and HarfBuzz, LuaJIT (the OSC is
  Lua), mpv 0.42.0 with `-Dgpl=false` and the CLI on; GPL dependencies off (rubberband, dvdnav, cdio). Dylibs are
  relocated beside the binary and re-signed ad hoc (Apple Silicon refuses unsigned code). mpv 0.42 needs FFmpeg 6.1+
  and libplacebo 7.387+. If the LGPL CLI misbehaves, macOS takes the Windows launcher shape over our own LGPL libmpv.
- One workflow, `mpv-runtime.yml`, produces both as `<platform>-<arch>/` with the binaries, `LICENSES/` (one text per
  bundled component) and `BUILDINFO.json` (versions, source URLs and hashes, configure flags). A licence gate in the
  workflow and in the fetch script refuses a runtime whose embedded configuration contains `-Dgpl=true`,
  `--enable-gpl` or `--enable-nonfree`, or a library missing from the licence allowlist.
- `pnpm mpv fetch` (a `tools` script, called by the desktop `dev` and `build`) downloads the runtime by SHA-256 pin into
  the gitignored `apps/desktop/resources/mpv/<platform>-<arch>/`: on Windows the official upstream LGPL libmpv archive
  (pinned URL and SHA-256) plus our launcher built locally; on macOS the pinned workflow artifact through `gh` (re-run
  the workflow when it expires). No release or tag of this repository is involved (controller decision, §9). electron-builder `extraResources` copies the
  folder with its notices to `resources/mpv/`, outside asar.

### 5.3 Engine commands
- Launch options, fixed and never read from a user config: `no-config`, `idle=yes`, `force-window=immediate`,
  `keep-open=no`, `ytdl=no`, `load-scripts=no` (the built-in OSC stays), `save-position-on-quit=no`,
  `resume-playback=no`, `terminal=no`, `title=ELV IPTV`, `hwdec=auto-safe`, `network-timeout=10`, `curl-enabled=no`
  (§9), `input-conf` pointing at our bindings, `wid` (Windows) or `geometry` (macOS), and the IPC transport (§5.5).
  Stream URLs and headers never appear in argv.
- `load`: `loadfile <url> replace -1 <options>`; the options carry the request headers (`user-agent`, `referrer`, the
  rest in `http-header-fields`), `start` for `startMs` and the per-kind cache limits. mpv resets per-file options when
  the file ends, so one channel's headers never reach the next.
- `retry`: the same `loadfile` for the current URL and options under the new token (live at the edge; VOD with `start`
  at the last anchored position). On mpv, ladder rungs 1 and 2 send the same command and differ only in token.
- `play`/`pause`: `set pause no|yes`. `seek`: `seek <s> absolute`. `stop`: `stop`. `recreate`: `quit`, kill after
  500 ms, respawn on the same window. `release`: `quit`, close the video window, drop listeners. Commands are queued
  and written in order; nothing awaits mpv; a failed reply becomes an `error` event.
- Capabilities: `mpegTsOverHttp`, `hls`, `recreate`, `audioTrackSelection`, `subtitleTrackSelection` true; `liveSeek`
  and `softwareAudioFallback` false (FFmpeg already decodes audio in software, so rung 4 goes to the alternates).

### 5.4 Engine events, tokens and one media
- **Entry table:** each `loadfile` is tagged with its command's token. After its reply the engine reads
  `playlist/0/id` (a replace leaves one entry) before it sends the next `loadfile`, so every mpv `playlist_entry_id`
  maps to exactly one token. `start-file` and `end-file` go through the table; property changes count for the entry
  between its `start-file` and `end-file` and are dropped outside that window. Other commands with a newer token adopt
  it for the current entry (port contract).
- **Observed:** properties `pause`, `paused-for-cache`, `core-idle`, `seeking`, `time-pos`, `duration`, `speed`,
  `demuxer-cache-state`, `video-params`, `track-list`; events `start-file`, `file-loaded`, `playback-restart`,
  `end-file`, `client-message`, and `log-message` after `request_log_messages`.
- **States:** `opening` on `start-file`; `buffering` from `file-loaded` until playback restarts, and while
  `paused-for-cache`; `playing` on `playback-restart` while not paused; `paused` from `pause`; `ended` on
  `end-file eof` for VOD. For live, `end-file eof` is a `network` error: a live stream has no end, and the ladder
  reconnects.
- **firstFrame:** the first `playback-restart` of a media with `video-params` set (audio-only media: the first
  restart). **stall:** `paused-for-cache` turning true and false while playing.
- **Clock:** anchors from `time-pos`, with `atMs` read when the message arrives and mapped to the renderer clock
  (§5.5). Rate is 0 while paused, paused for cache, seeking or idle, otherwise `speed`. `durationMs` comes from
  `duration` (VOD), `liveEdgeMs` from the cache end in `demuxer-cache-state` (live). Anchors go out on restart, on
  pause, cache and speed changes and on seeks, otherwise at most once a second; other `time-pos` updates stay in main.
- **Errors** (from `end-file reason=error`, failed replies and process events):
  - HTTP status from the media's log lines (`HTTP error <status>`; FFmpeg networking is pinned by `curl-enabled=no`):
    401, 403, 404, 429 and 509 map to their codes, other statuses to `http-other`.
  - A text or HTML notice instead of a stream (the simulator's `text-notice`) maps to `connection-limit`; the signal
    in the pinned runtime's output is fixed by fixtures in the first task.
  - Refused, reset or timed-out connections and live EOF: `network`. `unrecognized file format`:
    `unsupported-format`. Decoder and output init failures, `no audio or video data played`: `decoder`. `drm` never.
  - mpv exit, IPC disconnect or no reply within 3 s: `engine-wedged` (the rebuild rung respawns). The video window
    lost: `surface-lost`. Anything else: `unknown`.
  - `detail` is redacted (no query, user-info or credential path segments); raw log text never leaves main.
  - Log text is not an API: the parser is tested against lines recorded from the pinned runtime for every simulator
    fault, and a runtime update re-records them.
- **One media at a time:** mpv stops the current file before it opens the replacement and closes the stream forcefully
  when loading is aborted. The gate checks this in the simulator log. If any overlap or 509 shows, `load` becomes
  `stop`, wait for the old entry's `end-file`, then `loadfile` (one extra round trip); the chosen mode goes into
  `apps/desktop/AGENTS.md`.

### 5.5 IPC
- **mpv transport:** macOS uses `--input-ipc-client=fd://3` over the spawn's socketpair, so mpv quits when the app's
  end closes and a crashed app cannot leave a stream open. Windows uses `--input-ipc-server` on
  `\\.\pipe\elv-mpv-<random>`; there mpv quits when its `--wid` parent window dies with the app, and main kills a
  recorded leftover mpv pid on start. Only main connects; the endpoint name is random per process and never logged.
- **Renderer and main:** one contract module, `apps/desktop/src/shared/player-ipc.ts`, with types and runtime guards
  shared by main, preload and renderer:
  - `player:open` / `player:close` (invoke): create or release the engine of the calling window. `open` returns the
    `engineId` and a main clock reading for the offset handshake (`offset = renderer midpoint − main reading`, the
    pattern `@elv/remote-keys` uses for `uptimeMs`).
  - `player:command` (send, renderer to main): `{ engineId, command }`, one variant per port command, no reply.
  - `player:event` (main to renderer): `{ engineId, event }`, a port `EngineEvent` with `atMs` on the renderer clock.
  - `player:area` (send): the player area in CSS pixels and its visibility, for the video window (Windows) or the first
    placement of mpv's window (macOS).
  - `player:ui` (main to renderer): presentation events outside the port: `key` (bindings pressed in the mpv window:
    channel up and down, Back, fullscreen) and `closed` (the user closed mpv's window on macOS; the app calls `stop()`).
- Main checks every message with the guards: an unknown engine, a wrong shape, a URL that is not `http` or `https`, or
  header names and values with control characters are dropped and logged without the payload.

### 5.6 Presentation
- **Windows:** the engine creates a video `BrowserWindow` (frameless, `parent` = the app window, skipped in the task
  bar, black background, no web content, sandboxed) and passes its HWND (`getNativeWindowHandle`, as uint32) to mpv as
  `--wid`. Main keeps it on the player area on `player:area` and on the app window's move, resize, maximise,
  fullscreen and display changes, and hides it with the area or when the app minimises. It is created once per player
  screen (one `surface created` per run); zaps never re-create it.
- **macOS:** mpv shows its own window (`force-window`), placed over the player area on first show and then left to the
  user, while the app window shows the player screen and the status line. The window survives zaps. A user close
  sends `closed`; mpv respawns on the next load.
- **Controls:** mpv's OSC (seek bar, pause, audio and subtitle selection). Our bindings file keeps mpv's defaults and
  adds PageUp/PageDown for channel up/down, Escape for Back, `f` and double-click for fullscreen, each as
  `script-message elv-key <name>`, forwarded as `player:ui` `key`. On Windows fullscreen is the app window's (the video
  window follows); mpv's own fullscreen is not used with `--wid`.
- **Status:** nothing draws over the child window, so on Windows the DOM status line (tuning, recovery rung, provider
  limit, failure with Retry) sits outside the video rect; on a failure the video window hides and the Retry card shows
  in the player area.

### 5.7 Security and privacy
- The app window keeps `sandbox`, `contextIsolation` and no `nodeIntegration`; the CSP is unchanged.
- URLs and headers travel renderer to main to the mpv socket only; never argv, environment, logs or files. mpv writes no
  watch-later or log files. Only `http` and `https` URLs reach `loadfile`, so a hostile playlist cannot point mpv at
  `file:`, `edl:`, `av:` or other mpv protocols.

## 6. Gate
- `pnpm gate desktop [--build] [--runs 3] [--baseline file] [--budgets warn|fail] [--out file]`: fetches the runtime if
  missing, starts the simulator (`node tools/bin/sim.ts`, FFmpeg required), launches the development app with
  `--elv-gate=player?channels=…&zaps=…&vod=…&faults=…` (honoured only in development builds) and reads one
  `ELV_GATE_PLAYER {json}` line that main prints for the renderer's gate driver (a dev-only `gate:report` channel,
  typed and tested like the others).
- The driver uses the real service and the proxy engine: it zaps between `demo` live channels, plays a VOD file with one
  seek and one pause, then runs the faults. Metrics as in the player core spec §7: `ttffColdMs`, `ttffWarmMs { p50,
  p95 }`, `zapMs { p50, p95, max }`, `surfaceCreated`, `staleEventsDropped`, `failures`, `recoveries`, plus `mpvSpawns`
  and `loadMode`. The runner adds `limitResponses` and `overlapMs` from `/_sim/requests` with the per-account overlap
  helper it shares with `pnpm gate player`.
- Budgets as on Android: cold < 2.0 s, warm p50 < 1.0 s, zap p95 ≤ 2.0 s, one surface creation and one mpv spawn per
  run, no stale event applied, zero 509 or limit responses on the one-connection `demo` account; `overlapMs` is
  reported and warned above 0.
- Fault runs, with the player core pass rules: `drop@5` is `playing` again within 10 s; `status=404` reaches
  `failed(http-404)` within 10 s; `status=509` enters `limited` within 2 s and loads again only after the backoff;
  `text-notice` enters `limited`. An orphan run kills the Electron main process during playback and passes when the
  simulator sees the stream closed within 2 s.
- Baselines: `docs/learned/gates/player-desktop-windows.json` (this PC) and `player-desktop-macos.json` (the owner's Mac
  over SSH while the owner is logged in at the console; report-only). CI runs the unit and contract tests; the gate
  stays local in 0.1, like the Android player gate's phase 1.

## 7. Testing
- Test-first for all TypeScript. The pure parts (command encoding, entry table and token mapping, state, clock and stall
  derivation, error mapping and log parsing, redaction, IPC guards, area-to-bounds maths) are modules without
  `electron` imports, at 90% line coverage or more in Vitest.
- `MpvEngine` runs the shared engine contract suite from `@elv/playback/testing` (added there if #7 has not added it)
  against a scripted fake mpv that speaks JSON IPC on a real socket or pipe; the fake engine and the Android engine run
  the same suite. The renderer proxy runs it over an in-memory bridge.
- Integration tests with the real runtime and the simulator (skipped when either is missing): a live tune, a zap
  checked against the simulator log, and each fault's recorded log lines.
- The Playwright `_electron` smoke opens the gate route with one channel and waits for `firstFrame` (skipped without
  the runtime); it is not part of `pnpm check`. The C launcher only passes options; the integration tests cover it.

## 8. Left to the builder
- File and helper names; payload fields beyond §5.5; the exact bindings file; header escaping for the
  `http-header-fields` list syntax (tested); how the pinned runtime reveals a `text-notice` body.
- Cache and probe options for fast zaps (`demuxer-max-bytes`, `demuxer-readahead-secs`, `demuxer-lavf-probesize` and
  `demuxer-lavf-analyzeduration`, `cache-pause-wait`), tuned on the gate and recorded in `apps/desktop/AGENTS.md`.
- Whether Windows can switch to `--input-ipc-client=handle://` (no named endpoint, mpv quits with the app) if Node can
  hand over a suitable inheritable duplex pipe.
- The macOS helper's bundle shape (a minimal `.app` wrapper so the Dock and menu bar show the product name, not mpv).
- The workflow toolchains (MSYS2 mingw-w64 on `windows-latest`; Xcode, meson and ninja on a macOS arm64 runner),
  caching and the electron-builder wiring.

## 9. Decisions made during design
- 0.1 desktop playback is an LGPL mpv process per player window, driven over JSON IPC by an engine in the Electron main
  process, with `PlaybackService` in the renderer over a typed proxy; neither libmpv in-process nor frame-copy.
  Frame-copy with DOM overlays moves to Round 2 (new issue), with IPTVnator's MIT code as the base and libmpv's D3D11
  render API to evaluate.
- Windows presents through `--wid` into a dedicated child window; macOS through mpv's own window, because `wid` renders
  black inside Electron there. mpv's OSC is the 0.1 control surface. `loadfile replace` is the default one-media
  mechanism, verified by the gate, with stop-then-load as the recorded fallback.
- After the licence check: no LGPL mpv executable exists for Windows, so Windows uses our launcher over the official
  LGPL libmpv 0.42.0 instead of a pinned third-party player build; macOS uses our own LGPL mpv build from CI. Our own
  Windows mpv and FFmpeg build with replaceable DLLs is a follow-up issue before any public release. No GPL in shipped
  builds; notices and build information ship with every runtime.
- `curl-enabled=no` in 0.1: the libcurl backend is a week old and changes log text and connection reuse; FFmpeg
  networking is the proven path. Revisit after 0.1.
- macOS uses `--input-ipc-client` so mpv cannot outlive the app; Windows keeps `--input-ipc-server` with the `--wid`
  parent as the lifetime guard; the orphan run tests both.
- If the macOS runtime slips, the owner's Mac test falls back to the iPad app on Apple Silicon ("Designed for iPad")
  with the Apple engine: a mitigation, not a goal.
- Resolved by the controller (owner delegated development decisions): no runtime pre-release; binaries come from
  upstream (Windows) or the CI artifact (macOS), pinned by SHA-256. Signing `elv-mpv.exe` and the macOS helper is not
  needed for the owner's 0.1 test (Windows 10 has no Smart App Control; macOS ad-hoc signing and an "Open anyway"
  step) and is tracked as an issue before any public release.
- The first implementation task amends ADR 0002 and foundation §4, §5.5 and §11 (0.1 uses the external mpv process;
  frame-copy is Round 2). Implementation starts once #7 phase 1 (`@elv/playback`) is on `main`.

## 10. Risks
| Risk | Mitigation |
|---|---|
| `--wid` into an Electron window is undocumented: Chromium may paint over or blank mpv's child window; a cross-process child window shares the input queue, so a hung mpv can stall the app's input; alignment lags while dragging | First task is a spike on this PC; the 3 s IPC watchdog kills a wedged mpv; fallback is mpv's own window as on macOS (presentation change only) |
| No pinnable LGPL mpv executable; the official LGPL libmpv bundles FFmpeg and dozens of libraries statically with only `LICENSE.LGPL` | Our launcher keeps the DLL replaceable; notices generated for every bundled library; own Windows build before a public release; legal review before the first store submission (foundation §12) |
| An LGPL mpv CLI is upstream-discouraged, and the macOS build of FFmpeg, mpv and dependencies takes days | Licence gate in the workflow; launcher fallback over our own libmpv; the iPad app for the owner's test |
| The one-media rule and the error codes depend on mpv internals and log text | Simulator-log overlap in the gate; stop-then-load fallback; log fixtures per runtime; `curl-enabled=no` |
| An orphan mpv after a crash holds the provider's only connection | `--input-ipc-client` on macOS, the `--wid` parent and a pid sweep on Windows; the orphan gate run |
| Unsigned executables are blocked by Smart App Control and Gatekeeper | Owner test builds run locally or ad-hoc signed; signing is a tracked issue before release |
| Two windows on macOS (a second Dock icon, focus changes) feel unpolished | Accepted for 0.1; the Round 2 integrated design removes it |
