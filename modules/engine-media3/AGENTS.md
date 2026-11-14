# engine-media3 (`@elv/engine-media3`)

Android-only Expo module: the Media3 1.11.1 `PlayerEngine` (player core spec 6.1); the surface view comes in Task 6.

## API and contract
- `createMedia3Engine(): PlayerEngine | null` (`src/index.ts`), `null` without the native module `ElvEngineMedia3`;
  each call creates a native `Engine` shared object, `release()` frees it (later calls are no-ops).
- Native: `load(flattened LoadCommand)`, `retry`, `play`, `pause`, `seek`, `stop`, `recreate`, event `onEngineEvent`
  (`atMs` in uptime), sync `uptimeMs()`; TS maps `atMs = performance.now() - max(0, uptimeMs() - atMs)` per event.
- Capabilities: TS, HLS, software audio and recreate yes; live seek and track selection no. `load` takes its token,
  other commands adopt a newer one; events carry the token current when sent.

## Threading
- ExoPlayer runs on the engine's `HandlerThread` (application looper), built at creation; JS calls post there and
  return; listeners and events run there (`emit` hops to JS). The UI thread never waits, except the Task 6 hook
  `detachSurface(surface, timeoutMs)` (bounded). `OnDestroy` (JS reload) and `sharedObjectDidRelease` dispose engines.

## Playback
- Every prepare (`load`, `retry`) builds a new media source, `playWhenReady = true`; `retry`: live at the default
  position, VOD at the current one. `stop` clears the media; `recreate` rebuilds ExoPlayer (same surface), left idle.
- Source by URL (`SourceType.kt`): `.m3u8`/`.m3u` HLS; `.ts` and extensionless live use the TS extractor only (flags
  `ALLOW_NON_IDR_KEYFRAMES`, `DETECT_ACCESS_UNITS`); anything else sniffs containers. A progressive guess answered with
  a playlist is prepared once as HLS from the same URL, in the same gate generation (no error event).
- States: `opening` on prepare, `buffering`, `ready`, `playing`, `paused` (playback not wanted), `ended`; a live media
  that ends sends `error network` instead. `stall` start/end: buffering while wanted after it played. `firstFrame`
  from `onRenderedFirstFrame`. `clock` anchors whenever the effective rate (speed while playing, else 0) changes, on
  seeks and once a second while playing; `durationMs` for VOD, `liveEdgeMs` (window end) for live when known.
- `options.softwareAudio`: rebuilds the player, software audio decoders first, extension renderers preferred (#69).

## Requests (`ConnectionGate.kt`, `GatedDataSource.kt`, `SniffingDataSource.kt`, `LoadRetry.kt`)
- Every prepare and `stop` begins a generation; an `open` waits until older generations closed, force-closes them after
  1,000 ms (`Log.w`), and `tryOpen` refuses or counts it in one locked step once superseded or current.
- HTTP: default data source, `LoadCommand.headers`, cross-protocol redirects. Every response is read ahead 1 KB and
  judged by request kind, not label (`classifyResponse`): progressive `#EXTM3U` is HLS, playlists need `#EXTM3U`,
  readable text that is no MPEG-TS (sync search) nor, for segments, WebVTT is the notice; keys are never read.
- `failsAtOnce`: an HTTP status skips Media3's retries on progressive media and before the first HLS manifest; then
  HLS segments and refreshes retry except 401/403/429/509. Notices and refused requests always fail at once.

## Errors, redaction, load control
- `mapError`: 401/403/404/429/509 keep `http-<code>`, other statuses `http-other`; a notice is `connection-limit`;
  2xxx and behind-live-window `network`; malformed 3001/3002 `network` when live or played since prepare, other 3xxx
  `unsupported-format`; 4xxx/5xxx/7xxx `decoder`; 6xxx `drm`; timeout `engine-wedged`; else `unknown`. `detail`: the
  error name plus `redactUrl(uri)` (no query, fragment, user-info; the two segments after `live|movie|series|timeshift`
  and the bare `/<u>/<p>/<id>` form become `***`), never raw exception messages.
- Buffers: 15-30 s, start 1 s, after rebuffer 2 s, target 16 MB when low-RAM (`isLowRamDevice` or < 1.5 GB) else 32 MB.

## Tests and rules
- `pnpm --filter @elv/engine-media3 test` (Vitest, `expo-modules-core` mocked). JVM (JUnit 4) after `pnpm run:app
  android-tv build`, in `apps/tv-mobile/android` (needs `ANDROID_HOME`): `APP_VARIANT=development EXPO_TV=1
  ./gradlew.bat :elv-engine-media3:testDebugUnitTest`. Imports `expo-modules-core` and `@elv/playback` types only.
