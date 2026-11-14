# engine-media3 (`@elv/engine-media3`)

Android-only Expo module: the Media3 1.11.1 `PlayerEngine` and its `Media3Surface` view (player core spec 6.1).

## API and contract
- `createMedia3Engine(): PlayerEngine | null` (`src/index.ts`; `null` without the native module `ElvEngineMedia3`)
  creates a native `Engine` shared object; `release()` frees it (later calls are no-ops). `Media3Surface({ engine,
  style?, resizeMode?, testID? })` renders `Media3SurfaceView` bound to that object (one view per engine), else `null`.
- Native: `load(flattened LoadCommand)`, `retry`, `play`, `pause`, `seek`, `stop`, `recreate`, event `onEngineEvent`
  (`atMs` uptime; TS maps it to `performance.now() - max(0, uptimeMs() - atMs)`), sync `uptimeMs()`. `load` takes its
  token, others adopt a newer one; events carry the current token. Capabilities: all but live seek and track choice.

## Threading and view
- ExoPlayer runs on the engine's `HandlerThread` (application looper), built at creation; JS calls post there and
  return; events run there (`emit` hops to JS). `OnDestroy` (JS reload) and `sharedObjectDidRelease` dispose engines.
- `Media3SurfaceView` (details in `VIEW.md`): a fixed `SurfaceView` (never on top) under a black zap shutter (each
  `load` until that media's first frame, behind a fence), at the display aspect ratio (`fit`/`fill`) with bars beside
  it; the engine posts shutter, size and screen-on reports. A surface detach is the only UI-thread wait (3 s cap).

## Playback
- Every prepare (`load`, `retry`) builds a new media source, `playWhenReady = true`; `retry`: live at the default
  position, VOD at the current one. `stop` clears the media; `recreate` rebuilds ExoPlayer (same surface), left idle.
- Source by URL (`SourceType.kt`): `.m3u8`/`.m3u` HLS; `.ts` and extensionless live use the TS extractor only (flags
  `ALLOW_NON_IDR_KEYFRAMES`, `DETECT_ACCESS_UNITS`); anything else sniffs containers. A progressive guess answered with
  a playlist is prepared once as HLS from the same URL, in the same gate generation (no error event).
- States: `opening` on prepare, `buffering`, `ready`, `playing`, `paused` (not wanted), `ended`; a live media that
  ends sends `error network`. `stall`: buffering while wanted after it played. `clock` anchors when the effective rate
  (speed while playing, else 0) changes, on seeks and once a second while playing; `durationMs` (VOD), `liveEdgeMs`
  (live, window end) when known. `options.softwareAudio`: software audio decoders first, extension renderers (#69).
  Buffers: 15-30 s, start 1 s, after rebuffer 2 s, target 16 MB when low-RAM (`isLowRamDevice`, < 1.5 GB) else 32 MB.

## Requests and errors (`ConnectionGate`, `GatedDataSource`, `StreamHttp`, sniffing, `LoadRetry`, `ErrorMapping`)
- Each prepare and `stop` begins a generation and force-closes older connections at once on the closer thread: the
  OkHttp call is cancelled (socket closed, also mid-connect) and an `open` in progress is interrupted. A connection is
  counted until Media3 closes it; a newer `open` waits for that (forcing again after 1,000 ms, `Log.w`).
- HTTP: `media3-datasource-okhttp` on React Native's OkHttp 4.9.2 (the extension's 4.12.0 excluded): connect 3,500 ms,
  read 10,000 ms (over the 8 s start timeout), OkHttp redirects, `LoadCommand.headers`. Responses are read ahead 1 KB
  and judged by request kind (`classifyResponse`): progressive `#EXTM3U` is HLS, playlists need `#EXTM3U`, readable
  text that is no MPEG-TS nor, for segments, WebVTT is the notice; keys are never read.
- `failsAtOnce`: an HTTP status skips Media3's retries on progressive media and before the first HLS manifest; then
  HLS segments and refreshes retry except 401/403/429/509. Notices and refused requests always fail at once.
- `mapError`: 401/403/404/429/509 keep `http-<code>`, other statuses `http-other`, a notice `connection-limit`; 3xxx
  and 2006/2007 (no permission, cleartext) `unsupported-format`, but malformed 3001/3002 when live or played `network`;
  other 2xxx, behind-live-window `network`, 4/5/7xxx `decoder`, 6xxx `drm`, timeout `engine-wedged`, else `unknown`.
  `detail`: error name and `redactUrl(uri)` (credentials `***`), no exception text; `LoadRequest` text: no URL/header.

## Tests and rules
- Vitest: `pnpm --filter @elv/engine-media3 test`. JVM (JUnit 4, Robolectric), after `pnpm run:app android-tv build`, in
  `apps/tv-mobile/android`: `APP_VARIANT=development EXPO_TV=1 ./gradlew.bat :elv-engine-media3:testDebugUnitTest`
  (needs `ANDROID_HOME`). Imports `expo-modules-core`, `@elv/playback` types and the `react`/`react-native` peers only.
