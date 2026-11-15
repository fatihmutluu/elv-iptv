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
- Source (`SourceType.kt`): `.m3u8`/`.m3u` HLS; `.ts` and extensionless live: TS extractor only (non-IDR keyframes,
  access units); else sniffed. A playlist answer is prepared once as HLS (same URL, same generation).
- States: `opening` on prepare, `buffering`, `ready`, `playing`, `paused` (not wanted), `ended`; a live media that
  ends sends `error network`. `stall`: buffering while wanted after it played. `clock` anchors when the effective rate
  (speed while playing, else 0) changes, on seeks and once a second while playing; `durationMs` (VOD), `liveEdgeMs`
  (live, window end) when known. Extension renderers are `ON` by default (`PREFER` + software audio first when
  `options.softwareAudio` is set, #69). Buffers: 15-30 s, start 1 s, after rebuffer 2 s, 16 MB low-RAM else 32 MB.

## Requests and errors (`ConnectionGate`, `GatedDataSource`, `StreamHttp`, sniffing, `LoadRetry`, `ErrorMapping`)
- Every prepare, `stop`, `recreate` and `dispose` begins a generation before stopping/releasing ExoPlayer and
  force-closes older connections on the closer thread (cancelling OkHttp and interrupting `open`). Connections stay
  counted until closed, forcing again at 1 s and dropping cancelled ones 1.5 s later; `releasePlayer` drops superseded
  connections once force-close finishes (`dispose` shuts the closer down and clears keep-screen-on).
- HTTP: `media3-datasource-okhttp`, one client per engine (dispatcher: 64 calls, 16/host; shared pool), connect 3.5 s,
  read 10 s, redirects, `LoadCommand.headers` (`Authorization`/`Cookie`/`Proxy-Authorization` stripped off-origin or on
  `https->http`), else `http.agent` (OkHttp 4.9.2 `compileOnly`). Responses read ahead 1 KB (`classifyResponse`; keys
  and `Content-Range` slices at `position > 0` skipped; RFC 3629 UTF-8; WebVTT/TTML/XML/SRT segments allowed).
- `failsAtOnce`: an HTTP status skips Media3's retries on progressive media and before the first HLS manifest; then
  HLS segments and refreshes retry except 401/403/429/509. Notices and refused requests always fail at once.
- `mapError`: 401/403/404/429/509 keep `http-<code>`, other statuses `http-other`, a notice `connection-limit`, invalid
  decoder surface `surface-lost`; 3xxx and 2006/2007 `unsupported-format`, malformed 3001/3002 when live or played
  `network`; other 2xxx, behind-live-window `network`, 4/5/7xxx `decoder`, 6xxx `drm`, timeout `engine-wedged`.
  `detail`: error name and `redactUrl(uri)` (credentials `***`), no exception text; `LoadRequest` text: no URL/header.

## Tests and rules
- Vitest: `pnpm --filter @elv/engine-media3 test`. JVM (JUnit 4, Robolectric; `ANDROID_HOME`), after the app build,
  in `apps/tv-mobile/android`: `APP_VARIANT=development EXPO_TV=1 ./gradlew.bat :elv-engine-media3:testDebugUnitTest`.
  Imports `expo-modules-core`, `@elv/playback` types and the `react`/`react-native` peers only.
