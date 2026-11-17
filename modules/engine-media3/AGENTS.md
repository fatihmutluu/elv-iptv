# engine-media3 (`@elv/engine-media3`)

Android-only Expo module: the Media3 1.11.1 `PlayerEngine` and its `Media3Surface` view (player core spec 6.1).

## API and contract
- `createMedia3Engine(): PlayerEngine | null` (`src/index.ts`; `null` without the native module `ElvEngineMedia3`)
  creates a native `Engine` shared object; `release()` frees it (later calls are no-ops). `Media3Surface({ engine,
  style?, resizeMode?, testID? })` renders `Media3SurfaceView` bound to that object (one view per engine), else `null`.
- Native: `load(flattened LoadCommand)`, `retry`, `play`, `pause`, `seek`, `selectAudioTrack`, `selectSubtitleTrack`,
  `stop`, `recreate`, event `onEngineEvent` (`atMs` uptime, mapped via `@elv/playback`'s `bridgeNativeEngine`), sync
  `uptimeMs()`. `load` takes its token, others adopt a newer one. Capabilities: all true except `liveSeek: false`.

## Threading and view
- ExoPlayer runs on the engine's `HandlerThread` (application looper), built at creation; JS calls post there and
  return; events run there (`emit` hops to JS). `OnDestroy` (JS reload) and `sharedObjectDidRelease` dispose engines.
- `Media3SurfaceView` (details in `VIEW.md`): a fixed `SurfaceView` and `SubtitleView` (`media3-ui`) over the fitted
  video rectangle under a black zap shutter (each `load` until first frame, behind a fence), with bars beside it; the
  engine posts shutter, size, subtitle cues and screen-on reports. Surface detach is the only UI-thread wait (3 s cap).

## Playback and tracks
- Every prepare (`load`, `retry`) builds a new media source, `playWhenReady = true`; `retry`: live at the default
  position, VOD at `lastVodPositionMs` (kept across `recreate`). `stop` clears media; `recreate` rebuilds ExoPlayer.
- `TrackSelectorBridge` enumerates `C.TRACK_TYPE_AUDIO` and `C.TRACK_TYPE_TEXT` (`id = "$groupIndex:$trackIndex"`),
  emits deduplicated `tracks` events, applies `TrackSelectionOverride` (matching ID first, `(language, label)` across
  reloads), and disables `C.TRACK_TYPE_TEXT` + clears cues immediately when `subtitleTrackId` is `null` (`Off`).
- Source (`SourceType.kt`): `.m3u8`/`.m3u` HLS; `.ts` and extensionless live: TS extractor only; else sniffed. States:
  `opening`, `buffering`, `ready`, `playing`, `paused`, `ended` (live or unplayed VOD end -> `error network`), `stall`, `clock` anchors.
  `FfmpegAudio` configures LGPL-2.1+ FFmpeg 9.0.2 + `FfmpegAudioRenderer` (`ON` default, `PREFER` on `softwareAudio`).

## Requests and errors (`ConnectionGate`, `GatedDataSource`, `StreamHttp`, sniffing, `LoadRetry`, `ErrorMapping`)
- Every prepare, `stop`, `recreate` and `dispose` begins a generation before stopping/releasing ExoPlayer and
  force-closes older connections on the closer thread (cancelling OkHttp and interrupting `open`). Connections stay
  counted until closed, forcing again at 1 s and dropping cancelled ones 1.5 s later; `releasePlayer` drops superseded
  connections once force-close finishes (`dispose` shuts the closer down and clears keep-screen-on).
- HTTP: `media3-datasource-okhttp`, one client per engine (dispatcher: 64 calls, 16/host; shared pool), connect 3.5 s,
  read 10 s, redirects, `LoadCommand.headers` (`Authorization`/`Cookie`/`Proxy-Authorization` stripped off-origin or on
  `https->http`), else `http.agent` (OkHttp 4.9.2 `compileOnly`). Responses read ahead 1 KB (`classifyResponse`; keys
  and `Content-Range` slices at `position > 0` skipped; RFC 3629 UTF-8; 3 TS syncs; empty first responses fail at once; WebVTT/TTML/XML/SRT segments allowed).
- `failsAtOnce`: an HTTP status skips Media3's retries on progressive media and before the first HLS manifest; then
  HLS segments and refreshes retry except 401/403/429/509. Notices and refused requests always fail at once.
- `mapError`: 401/403/404/429/509 keep `http-<code>`, other statuses `http-other`, a notice `connection-limit`, invalid
  decoder surface `surface-lost`; 3xxx and 2006/2007 `unsupported-format`, malformed 3001/3002 when live or played
  `network`; other 2xxx, behind-live-window `network`, 4/5/7xxx `decoder`, 6xxx `drm`, timeout `engine-wedged`.
  `detail`: error name and `redactUrl(uri)` (credentials `***`), no exception text; `LoadRequest` text: no URL/header.

## Tests and rules
- Vitest: `pnpm --filter @elv/engine-media3 test`. JVM/device (`ANDROID_HOME`, in `apps/tv-mobile/android`, `EXPO_TV=1`):
  `./gradlew.bat :elv-engine-media3:testDebugUnitTest` and `:elv-engine-media3:connectedDebugAndroidTest` (`pnpm sim --port 7880`).
  Imports `expo-modules-core`, `@elv/playback` types and the `react`/`react-native` peers only.
