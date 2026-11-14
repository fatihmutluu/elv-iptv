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
- `Media3SurfaceView` (details in `VIEW.md`): a `SurfaceView` fixed at creation (never on top) under a black zap
  shutter (from each `load` until that media's first frame; `firstFrame` once per prepare, behind a fence), sized at
  the video's display aspect ratio (`resizeMode` `fit` or `fill`) with black bars beside it, never over it. The engine
  posts shutter, picture size and screen-on reports (on while playing) to the view; a surface detach is the only
  UI-thread wait (capped at 3 s).

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

## Requests and errors (`ConnectionGate`, `GatedDataSource`, `SniffingDataSource`, `LoadRetry`, `ErrorMapping`)
- Every prepare and `stop` begins a generation; an `open` waits until older generations closed, force-closes them after
  1,000 ms (`Log.w`), and `tryOpen` refuses or counts it in one locked step once superseded or current.
- HTTP: default data source, `LoadCommand.headers`, cross-protocol redirects. Every response is read ahead 1 KB and
  judged by request kind, not label (`classifyResponse`): progressive `#EXTM3U` is HLS, playlists need `#EXTM3U`,
  readable text that is no MPEG-TS (sync search) nor, for segments, WebVTT is the notice; keys are never read.
- `failsAtOnce`: an HTTP status skips Media3's retries on progressive media and before the first HLS manifest; then
  HLS segments and refreshes retry except 401/403/429/509. Notices and refused requests always fail at once.
- `mapError`: 401/403/404/429/509 keep `http-<code>`, other statuses `http-other`, a notice `connection-limit`, 2xxx and
  behind-live-window `network`, malformed 3001/3002 `network` when live or played since prepare, other 3xxx
  `unsupported-format`, 4xxx/5xxx/7xxx `decoder`, 6xxx `drm`, timeout `engine-wedged`, else `unknown`. `detail`: error
  name plus `redactUrl(uri)` (no query, fragment or user-info; credential path segments `***`), no exception messages.

## Tests and rules
- Vitest: `pnpm --filter @elv/engine-media3 test`. JVM (JUnit 4), after `pnpm run:app android-tv build`, in
  `apps/tv-mobile/android`: `APP_VARIANT=development EXPO_TV=1 ./gradlew.bat :elv-engine-media3:testDebugUnitTest`
  (needs `ANDROID_HOME`). Imports `expo-modules-core`, `@elv/playback` types and the `react`/`react-native` peers only.
