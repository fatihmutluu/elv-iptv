# engine-media3 (`@elv/engine-media3`)

Android-only Expo module: the Media3 1.11.1 `PlayerEngine` (player core spec 6.1); the surface view comes in Task 6.

## API and contract
- `createMedia3Engine(): PlayerEngine | null` (`src/index.ts`); `null` where the native module `ElvEngineMedia3` is
  absent. Each call creates a native `Engine` shared object; `release()` frees it (later calls are no-ops).
- Native: commands `load(flattened LoadCommand)`, `retry`, `play`, `pause`, `seek`, `stop`, `recreate`, event
  `onEngineEvent` (an `EngineEvent` whose `atMs` values are uptime stamps), sync `uptimeMs()`. TS maps
  `atMs = performance.now() - max(0, uptimeMs() - atMs)` per event, like `@elv/remote-keys`.
- Capabilities: TS, HLS, software audio and recreate yes; live seek and track selection no. Token: `load` takes its
  token, every other command adopts a newer one; events carry the token current when sent.

## Threading
- ExoPlayer lives on the engine's `HandlerThread` (its application looper); JS calls post there and return at once;
  listeners and events run there (`SharedObject.emit` hops to the JS thread). The UI thread never waits, except the
  Task 6 hook `detachSurface(surface, timeoutMs)` for `surfaceDestroyed` (bounded). The player is built at creation.
- Module `OnDestroy` (JS reload) and `sharedObjectDidRelease` dispose engines: player released, thread quit.

## Playback
- Every prepare (`load`, `retry`) builds a new media source from the request with `playWhenReady = true`. `retry`:
  live at the default position, VOD at the current one. `stop` clears the media. `recreate` releases and rebuilds
  ExoPlayer with the same surface and leaves it idle; the service follows with `load`.
- Source by URL (`SourceType.kt`): `.m3u8`/`.m3u` HLS; `.ts` and extensionless live use the TS extractor only (flags
  `ALLOW_NON_IDR_KEYFRAMES`, `DETECT_ACCESS_UNITS`); anything else sniffs containers (MP4, MKV, ...).
- States: `opening` on prepare, `buffering`, `ready`, `playing`, `paused` (playback not wanted), `ended`; a live media
  that ends sends `error network` instead. `stall` start/end: buffering while wanted after it played. `firstFrame`
  from `onRenderedFirstFrame`. `clock` anchors whenever the effective rate (speed while playing, else 0) changes, on
  seeks and once a second while playing; `durationMs` for VOD, `liveEdgeMs` (window end) for live when known.
- `options.softwareAudio`: rebuilds the player with software audio decoders first and extension renderers preferred;
  without the FFmpeg extension (#69) only the platform's software codecs (AAC, MP3, Opus, ...) are added.

## Connection gate (`ConnectionGate.kt`, `GatedDataSource.kt`)
- Every prepare and `stop` begins a new generation. Each request's `open` waits until no older generation has an open
  connection; after 1,000 ms it force-closes them (`Log.w`). A superseded generation's `open` is refused.
- HTTP: default data source, `User-Agent` and other `LoadCommand.headers`, cross-protocol redirects. HTTP status errors,
  notices and refused requests fail at once (the service owns retries); other I/O keeps Media3's retries.

## Errors, redaction, load control
- `mapError`: 401/403/404/429/509 keep `http-<code>`, other statuses `http-other`; a 2xx notice body (`text/*` on
  progressive, HTML, XHTML or JSON anywhere) is `connection-limit`; Media3 codes: 2xxx and behind-live-window `network`,
  3xxx `unsupported-format`, 4xxx/5xxx/7xxx `decoder`, 6xxx `drm`, timeout `engine-wedged`, else `unknown`.
- `detail` is the Media3 error name plus `redactUrl(uri)`: no query, fragment or user-info; the two segments after
  `live|movie|series|timeshift` and the bare `/<u>/<p>/<id>` form become `***`. Never raw exception messages.
- Buffers: 15-30 s, start 1 s, after rebuffer 2 s, target 16 MB when low-RAM (`isLowRamDevice` or < 1.5 GB) else 32 MB.

## Tests and rules
- `pnpm --filter @elv/engine-media3 test` (Vitest, `expo-modules-core` mocked). JVM (JUnit 4) after `pnpm run:app
  android-tv build`, in `apps/tv-mobile/android` (needs `ANDROID_HOME`): `APP_VARIANT=development EXPO_TV=1
  ./gradlew.bat :elv-engine-media3:testDebugUnitTest`. Imports `expo-modules-core` and `@elv/playback` types only.
