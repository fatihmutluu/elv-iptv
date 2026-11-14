# Player core and always-mounted OSD — Design

- Status: approved (owner delegated all development decisions on 2026-11-14)
- Date: 2026-11-14
- Issue: #7. Foundation spec §5.5 (playback), §6.1 (simulator), §6.2 (budgets), §10 Round 1; ADR 0003 (playback engines).

## 1. Why
Playing a channel is the product. Every later screen (live list, guide, home, search) ends in the player, so its contract,
its recovery behaviour and its speed have to be right before screens are built on it. IPTV streams are hostile: raw
MPEG-TS over HTTP that Apple's own player cannot open, providers that allow one connection and punish a second with
429/509, streams that die mid-programme, and 1 GB TV sticks. The reference apps show the failure classes this gate exists
to prevent: late events from an earlier channel ending a newer tune, players that wedge after a stream ends, silent
infinite retries, a second connection opened during a zap, and video surfaces re-created on every channel change.

## 2. Goals
- `packages/playback` (pure TypeScript): the `PlayerEngine` port, `PlaybackService` (state machine, tune tokens, zap,
  recovery ladder, connection-limit backoff, stall watchdog), a clock-anchor position model, and `FakePlayerEngine`; all
  headless-tested.
- One native engine module per runtime behind that port, first Android TV (and Fire OS, phones), then tvOS (§6).
- A player view whose native video surface lives under an always-mounted React Native OSD; channel changes never
  re-create the surface.
- A development player gate in `apps/tv-mobile` and `pnpm gate player` in `tools`, measured on the Android TV emulator
  against the local simulator; a report-only tvOS simulator run in CI.

## 3. Non-goals
- VOD controls and track selection (seek, pause, audio and subtitle tracks): part of 0.1, specified separately in #73
  on top of this port. Aspect, subtitle styling, catch-up and time-shift (#27, #28), picture-in-picture (#34) and
  external players come after 0.1.
- Desktop playback (#8, libmpv helper) and Vega/Tizen/webOS engines.
- Screens that pick channels (#13); the gate drives the service directly.

Anti-goals: a stale event must never change the state of a newer tune; the service must never cause two simultaneous
connections to one provider account; no retry loop may run without a bound or without being visible.

## 4. Existing solutions
Scan of 2026-11-14 (private report `.superpowers/research/reports/player-engines-scan-2026-11.md`):
- **expo-video, react-native-video (MIT):** Media3 on Android but AVPlayer on Apple, which cannot open raw MPEG-TS over
  HTTP, the most common IPTV live format. They also expose no attempt correlation, no data-source or load-control hook
  (needed for connection discipline and 429/509 detection), no stable error codes and only progress ticks. Rejected for
  the player; our own Expo modules stay (ADR 0003).
- **Media3 (Apache-2.0):** 1.11.1 stable (2026-09-11), 1.12 in beta. Raw TS through `ProgressiveMediaSource` and
  `TsExtractor`, HLS through its HLS module. `DefaultPreloadManager` targets VOD feeds and would hold extra live
  connections, so it is not a zap tool here. Known risk: black frames or codec-reuse glitches on channel switches on
  some Amlogic and overlay-plane TVs.
- **Media3 FFmpeg audio extension:** official, Apache-2.0 glue; FFmpeg must be built by us without `--enable-gpl`
  (Linux or macOS build). The Jellyfin prebuilt is labelled GPL-3.0 and lags Media3, so it is not used. Deferred to its
  own issue (AC-3/E-AC-3/DTS on devices without platform decoders); the gate streams are AAC.
- **ASS subtitles:** `ass-media` (MIT over libass) is beta; it belongs to #32.
- **AetherEngine (LGPL-3.0 with an App Store/DRM exception covering its own code; FFmpeg LGPL, dynamic):** 7.66.1
  (2026-11-13), tvOS 18+, raw HTTP MPEG-TS live and HLS documented, used by several shipping IPTV apps. Very fast release
  pace (300+ releases in seven months); its CI uses Xcode 27 / Swift 6.4 while Expo SDK 58's documented minimum is
  Xcode 26.4. Its loopback path waits for about three target durations of HLS content before starting, which threatens
  the zap budget. Open issue: a crash when stopping a live source during startup on an old Apple TV, which is exactly a
  fast zap. Kept as the Apple primary, behind a build spike (§6.2).
- **MPVKit:** LGPL product (a separate GPL variant exists); its own README calls it not maintained frequently and points
  to AetherEngine; it must never be linked together with AetherEngine (FFmpeg symbol clash). **VLCKit/TVVLCKit**
  (LGPL-2.1) is the better-maintained Apple fallback. **KSPlayer** is GPL-3.0 (paid LGPL option): rejected.

Reference-app lessons already recorded in our research notes (prose, no code read):
- Tune-attempt tokens: a terminal event counts only for the attempt that is current (Moonfin).
- Bounded live recovery with growing gaps, budget restored after a clean run, a visible status line and a Retry card
  (Moonfin); a tiered ladder with a stall watchdog disarmed by user seeks (Streamyfin).
- Re-create the engine instance when it wedges after a stream ended (Streamyfin, Amlogic boxes, about 200 ms).
- Never block the UI thread on engine calls; release engines off the main thread (Streamyfin, libmpv deadlocks).
- Buffer sizes by device class; time-and-byte-bounded load control on Android TV (Streamyfin).
- A competitor's black-box pass (our own simulator log): a fixed 4 s retry rhythm for about 26 s on a 404, an error with
  the status afterwards, a raw exception name in a retry toast, about 26 ms of connection overlap during a zap, and a
  stream left open after its playlist was deleted. We do better on each (§5.4, §5.5).

## 5. Design: playback core (`packages/playback`)

### 5.1 Tune tokens and the engine port
- `AttemptToken` is a positive integer; `PlaybackService` increments it for every tune, retry rung and zap. Every engine
  command carries it and every engine event echoes it. The service drops events whose token is not the current one, so
  late events from a previous channel or rung can never change the state.
- `PlayerEngine` (port, implemented by native modules and `FakePlayerEngine`):
  - Commands are enqueue-and-return (`void`): `load({ attempt, url, headers, kind: 'live' | 'vod', startMs?, options })`,
    `retry(attempt)` (re-prepare the current media after an error or stall, at the live edge for live and at the last
    position for VOD, reusing the engine instance), `play(attempt)`, `pause(attempt)`, `seek(attempt, positionMs)`,
    `stop(attempt)`, `recreate(attempt)` (release and rebuild the native player instance, keeping the view and
    surface), `release()`.
  - Token adoption: every command carries a token; from the moment the engine receives a command with a newer token, it
    tags every later event of the current media with that token. `load` starts a new media; `retry`, `recreate` and the
    others keep the media and adopt the token.
  - `load` replaces the current media. Contract: one media at a time. Every connection of the previous media is closed
    before the new media's first request is opened. Within one media the engine may open several requests (HLS
    playlist refreshes and segments); the rule is about media boundaries, which is where a zap would otherwise hold two
    provider connections.
  - Events (`subscribe(listener) => unsubscribe`), each with `attempt`: `state` (`opening`, `buffering`, `ready`,
    `playing`, `paused`, `ended`), `firstFrame`, `clock` (a clock anchor, §5.2), `stall` (buffering with an empty forward
    buffer, with its duration), `error` (§5.3), `surface` (`created` / `destroyed`, for the gate and for surface-loss
    recovery), `metrics` (bitrate, dropped frames, decoder name; optional).
  - `capabilities`: flags the service and UI read (`mpegTsOverHttp`, `hls`, `liveSeek`, `softwareAudioFallback`,
    `recreate`, `audioTrackSelection`, `subtitleTrackSelection`).
- The service never awaits an engine call; it reacts to events. Engines do their work off the UI thread.

### 5.2 Clock anchor
- A `clock` event carries `{ positionMs, atMs, rate, durationMs? , liveEdgeMs? }` where `atMs` is the engine's monotonic
  time mapped to the JS clock by the module. `positionAt(anchor, nowMs) = positionMs + (nowMs - atMs) * rate`.
- Engines emit `clock` on start, rate change, seek, stall start/end and at most once a second otherwise. Position never
  lives in React state; the OSD reads `positionAt` in its own animation frame.

### 5.3 Errors
- `EngineError { code, httpStatus?, detail? }` with stable codes: `http-401`, `http-403`, `http-404`, `http-429`,
  `http-509`, `http-other`, `connection-limit` (a provider notice or a 509/429 body), `network` (DNS, reset, timeout),
  `unsupported-format`, `decoder`, `drm`, `surface-lost`, `engine-wedged`, `unknown`. `detail` is for diagnostics, never
  shown raw and never containing credentials (URLs are redacted before they leave the module).
- `PlaybackService` maps each code to an `ElvError` (`playback/<code>`) with one recovery hint the UI can name
  (#63 builds the messages).

### 5.4 Recovery ladder (live)
Rungs, each bounded and visible as a status the OSD can show:
- **L0 wait:** a stall shorter than the watchdog window (live 4 s) is left to the engine.
- **L1 resume:** `retry` the same media at the live edge (the engine reuses what it can).
- **L2 reconnect:** `load` the same URL again (new connection after the old one closed).
- **L3 rebuild:** `recreate` the engine instance, then `load`.
- **L4 alternate:** the next alternative the caller supplied for this item (for example the Xtream HLS URL when TS
  failed), or the engine's software-audio option when the error was `decoder`.
- **L5 fail:** stop, release the connection, report the error with its hint; the UI offers Retry.
- Gaps between rungs grow (0 s, 1 s, 2 s, 4 s); the whole ladder is bounded (about 10 s on a dead stream). A rung that
  reaches `playing` for 30 s restores the budget. Terminal codes skip the ladder: `http-401`, `http-403`, `http-404`,
  `unsupported-format`, `drm` go straight to L5 after one L2 for 404 (some panels answer 404 for a moment while a
  channel starts).
- VOD: the same rungs, reloading at the last anchored position; a reconnect loop with backoff for up to 2 minutes on
  `network` errors (Moonfin lesson), disarmed by a user seek.

### 5.5 Connection-limit path
- `http-429`, `http-509` and `connection-limit` never enter the ladder. The service stops the media (closing its
  connection), waits with backoff (2 s, 4 s, 8 s, then 15 s, at most 60 s in total), then loads again; the status names
  the provider limit. After 60 s it fails with the `connection-limit` hint.
- Account scope: `tune` carries an `accountKey` (the source id). A zap during the backoff to a channel with the same key
  is held until the backoff ends (it keeps the `limited` state with the new token and the new item); a zap to another
  account loads immediately and ends the backoff.
- A zap is serialized: the new tune's `load` is sent only after the engine reported the previous media stopped (the
  engine contract in §5.1 makes this one command; the service still never issues two `load`s without a `stop`/`load`
  boundary).

### 5.6 Service API and state
- `createPlaybackService({ engine, clock, timers, config? })`.
- `tune(request: { item, accountKey, kind, resolve: () => Promise<Result<StreamRequest>>, alternates?, startMs? }): AttemptToken`
  where `StreamRequest = { url, headers }` is built at play time by the caller (credentials stay out of the catalog;
  `@elv/data`'s `createStreamResolver` in the app). `retry()`, `stop()`, `pause()`, `play()`, `seek(ms)`.
- `subscribe(listener)` receives `PlaybackState`: `idle | tuning | playing | paused | recovering(rung, nextAtMs) |
  limited(nextAtMs) | failed(error)`, the current attempt, the latest clock anchor and per-tune timings
  (`tuneAt`, `firstFrameAt`).
- Zap rule: a new `tune` supersedes the current one immediately (new token); events of the old token are dropped.
- Config: watchdog windows, ladder gaps, budgets, connection-limit backoff; defaults as above, overridable per device
  class later.

### 5.7 FakePlayerEngine
- A scriptable engine for tests: per URL a script of timed events (`firstFrame after 300 ms`, `error http-509 at 2 s`,
  `stall for 5 s`), late delivery of events with old tokens, and an assertion helper that fails if two medias were
  open at once. Lives in `packages/playback/src/testing/` and is exported for module and app tests.

## 6. Design: native engines and the OSD

### 6.1 Android, Android TV, Fire OS: `modules/engine-media3` (`@elv/engine-media3`)
- Expo native module, Android only, Media3 pinned to 1.11.1 (`exoplayer`, `exoplayer-hls`, `datasource`). It imports
  only `expo-modules-core` and `@elv/playback` types (layer rule).
- Shape: an engine object (an Expo shared object, one per player screen) that implements `PlayerEngine` from §5.1, and
  a view `Media3Surface` that hosts a `SurfaceView` bound to an engine. The app creates the engine, passes it to the
  service and to the view. The surface type is fixed at creation and never changed at runtime; nothing between the
  surface and the window paints an opaque background, so the React Native OSD composes above it.
- Threading: the ExoPlayer instance lives on a dedicated playback thread (its application looper). Commands from JS are
  posted there and return immediately; events are sent from there. The UI thread never waits for the player.
- Connection discipline: every stream request goes through our `DataSource` wrapper with a per-engine connection gate.
  `open` of a new request waits until the previous one is closed (bounded wait, then it closes it forcibly). With
  `load` stopping the old media first, the simulator log must show zero overlap during zaps.
- Error mapping: `HttpDataSource.InvalidResponseCodeException.responseCode` gives the `http-*` codes; a `text/*` or HTML
  body on a stream request is `connection-limit` (providers answer the limit with a notice; the simulator models it);
  Media3 `PlaybackException` error codes map to `network`, `unsupported-format`, `decoder`, `drm`. URLs in `detail` are
  redacted (no query, no user-info, no credential path segments).
- Load control: time and byte bounded, start values `bufferForPlaybackMs` 1,000, `bufferForPlaybackAfterRebufferMs` 2,000,
  `minBufferMs` 15,000, `maxBufferMs` 30,000, target buffer 16 MB on low-RAM devices (`isLowRamDevice` or under 1.5 GB)
  and 32 MB otherwise. The gate may tune these; the chosen values are recorded in the module `AGENTS.md`.
- `recreate`: release the ExoPlayer on its thread and build a new one bound to the same surface. Stall watchdog support:
  `stall` events when buffering with an empty forward buffer.
- Zap presentation: the surface stays alive across channel changes. A shutter (a native black view above the surface,
  under the OSD) covers it from `load` until `firstFrame`, so no stale or garbage frame shows on overlay-plane devices.
- Picture and screen (plan amendment): the surface keeps the video's display aspect ratio (decoded size and pixel
  aspect ratio), centred with black bars beside it (`resizeMode` `fit`, default; `fill` crops), and keeps its last
  shape across a zap until the new media reports its own; the view keeps the screen on while the engine plays (and
  buffers after it played) and lets it sleep on pause, end, error, `stop` and detach, natively, without JS.
- Clock: anchors use `SystemClock.uptimeMillis`; the TypeScript side maps them to `performance.now()` with a synchronous
  `uptimeMs()` call, the same pattern as `@elv/remote-keys`.

### 6.2 Apple TV (then iOS): `modules/engine-aether`, second phase
- Same contract and view shape, implemented with AetherEngine pinned to an exact tag, optional components off, FFmpeg
  dynamic, and `AetherPlayerView` with hit-testing disabled so remote focus stays on React Native views.
- First a build spike in CI: build the tvOS app with the pinned AetherEngine using the Xcode that the `tvos` job uses
  (26.4.1). If it does not build, try in this order: the newest AetherEngine tag that builds with Swift 6.2/6.3; the
  `tvos` job on Xcode 27 if Expo SDK 58 builds with it; TVVLCKit 3.x (LGPL-2.1) as the engine. The outcome is
  recorded in §10 and in ADR 0003.
- Verified in CI only (no Mac on the development PC): the report-only `tvos-gate` job runs the player gate on the Apple
  TV simulator against the simulator streams.
- Phase 2 gets its own plan after phase 1 (playback core and Android) is merged and covers tvOS and iOS/iPadOS (the
  owner tests 0.1 on an iPhone); #7 stays open until both are done.

### 6.3 Player view and OSD in the app
- `apps/tv-mobile` wires the engine module, the service and the stream resolver. The OSD is a React Native layer that is
  mounted once per player screen and never unmounted during zaps; it shows the channel, the status line (tuning,
  recovery rung, provider limit, error with Retry) and a clock that reads `positionAt` in its own animation frame.
- Remote keys come from the focus core (`useTvKeySource`); the gate uses channel up and down and digits to zap.

## 7. Gate
- `apps/tv-mobile` dev route `elviptv://gate/player?channels=…&zaps=…&rate=…&faults=…` (development variant only, like the
  list gate): an always-mounted OSD (channel name, status line naming the recovery rung, a clock that reads
  `positionAt`), an auto-driver that zaps between simulator channels, and one `ELV_GATE_PLAYER {json}` line:
  `ttffColdMs`, `ttffWarmMs { p50, p95 }`, `zapMs { p50, p95, max }`, `surfaceCreated`, `staleEventsDropped`, `failures`,
  `recoveries { rung: count }`; the runner adds `limitResponses` and `overlapMs` from the simulator log (below).
- Metric spans: `ttffColdMs` is the first `tune()` after the engine was created to its `firstFrame` (one value per run,
  the app process fresh). `ttffWarmMs` is `tune()` to `firstFrame` for every later tune. `zapMs` is the driver's key
  dispatch time to the new channel's `firstFrame`, so it includes resolving the URL and closing the old media.
- `pnpm gate player [--avd] [--build] [--runs 3] [--baseline] [--budgets warn|fail]`: starts the simulator (FFmpeg
  required), runs the gate, reads `/_sim/requests` to compute connection overlap per account (must be 0), compares with
  `docs/learned/gates/player-android-tv.json`.
- Budgets (§6.2): cold < 2.0 s, warm p50 < 1.0 s, zap p95 ≤ 2.0 s, one surface creation per run, no stale event applied,
  and zero 509 or limit responses from the simulator on the one-connection `demo` account during the zaps (the provider's
  own view of overlap). `overlapMs` (TS stream requests of one account whose lifetimes overlap in the simulator log) is
  reported and warned above 0; the simulator sees a close slightly after the app sends it, so it is not a hard budget.
  HLS segment requests carry no account in the simulator log and are excluded.
- Fault runs (URLs built by the gate with `?fault=`): `drop@5` passes when playback is `playing` again within 10 s of the
  first drop without user action (the run ends there; the simulator would drop again); `status=404` passes when the
  service reaches `failed(http-404)` within 10 s; `status=509` passes when the service enters `limited` within 2 s and
  its next load waits for the backoff (the run ends after the second backoff).
- CI: phase 1 runs the player gate locally only (`docs/learned/gates/player-android-tv.json`); a report-only CI job is
  added once the local gate is stable (it needs FFmpeg on the runner and a decision about the emulator's `-noaudio`).
  The tvOS simulator run is phase 2.
- Measured against simulator streams (H.264/AAC TS and HLS), not public test streams: CI and repo tests never depend on
  third-party hosts, and the simulator serves the same recipes every run.

## 8. Testing
- `packages/playback` (Vitest, 100% lines): tokens and stale events, zap supersession, ladder rungs and gaps, budget
  restoration, terminal codes, connection-limit path, serialized loads, watchdog disarmed by seek, clock anchor maths,
  fake engine scripts.
- Native modules: unit tests where the platform allows (JVM for Android helpers); behaviour verified by the device gate.
- App: the gate screen with the fake engine in Jest; the real engine on the emulator through `pnpm gate player`.

## 9. Left to the builder
- Exact names of internal helpers and files; event payload field names beyond those fixed here.
- The Expo Modules API calls for shared objects and views in SDK 58 (check the Expo docs, not memory).
- Media3 class names and wiring for the data-source wrapper and the load control.

## 10. Decisions made during design
- Our own Expo engine modules, not expo-video or react-native-video: raw TS on Apple and the contract's needs (§4).
- Phase 1 is the pure core plus Android; tvOS follows after its build spike (§6.2). Why: AetherEngine's toolchain may not
  match Expo SDK 58's, and Android can prove the contract meanwhile.
- The FFmpeg audio extension, libass and the Android libmpv fallback are not part of the gate; each has its own issue.
- The gate measures simulator streams, not public test streams (§7).
- After the builder check: one media at a time (not one socket), `retry` command with token adoption, `accountKey` on
  `tune` for the connection-limit scope, explicit metric spans, fault-run pass rules, and a local-only gate in phase 1.
- Plan amendment after the surface view: aspect fit and keep-screen-on belong to the engine view (§6.1), because a
  stretched picture or a screensaver during a film is an operational defect for 0.1.
- ADR 0003 is amended: AetherEngine licence wording, MPVKit's status and the no-co-linking rule, VLCKit as the Apple
  fallback, Media3 preloading not used for live.
