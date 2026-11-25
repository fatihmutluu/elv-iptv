# engine-media3 (`@elv/engine-media3`)

Android-only Expo module: the Media3 1.11.1 `PlayerEngine`, `Media3Surface` view, `MediaSessionService`, TV standby
monitor, and mobile window helpers (player core spec 6.1).

## API and contract
- `createMedia3Engine(options?): Media3PlayerEngine | null` (`src/index.ts`; `null` without `ElvEngineMedia3`) creates a native `Engine` shared object with optional Multi-View `{ handleAudioFocus?, multiViewTileCount? }` (`#34`, `#221`); `release()` frees it. Helpers: `configureMedia3MultiView`, `setMedia3PitchLock`, `setMedia3MediaMetadata`, `setMedia3BackgroundAudioEnabled`, `setMedia3NightModeDrc` (`#115`), `setMedia3DisplaySync` (`#116`), `setMedia3AudioDelayByRefreshRate` (`#115`), `getDrmCapabilities` (`#272`), `subscribeMedia3RemoteMediaAction`, `getAndroidThermalState`, `subscribeAndroidThermalState`, `getAndroidDeviceMemoryInfo`, `enterAndroidPictureInPicture` (optional `sourceRect`), `setAndroidAutoEnterPictureInPicture` (API 31+), `isExternalPlayerSupported`/`launchExternalPlayer` (`#406`). `Media3Surface` renders `Media3SurfaceView`.
- Native (`ElvEngineMedia3Module`, `LoadRequest`): `load(flattened LoadCommand + externalSubtitles? + subtitleStyle? + secondarySubtitleTrackId? + bufferPreset? + decoderMode? + allowLegacyTls? + dnsFamily? + hostOverride? + drm? + autoFrameRate? + nightModeDrc? + audioDelayByRefreshRateMs? + programId?)`, `retry`, `play`, `pause`, `seek`, `setScrubbing`/`setSpeed`/`setPitchLock` (VOD, `[0.25, 4.0]`), `setAudioDelay`/`setSubtitleDelay` (`[-30_000, 30_000]` ms), `setAudioDelayByRefreshRate` (`[-1000, 1000]` ms, `#115`), `setNightModeDrc` (`off`/`light`/`night`, `#115`), `setDisplaySync` (`off`/`seamless`/`always`, `#116`), `selectVideoQuality` (`#59`), `selectProgram` (`#304`), `selectAudioTrack`, `selectSubtitleTrack`, `selectSecondarySubtitleTrack` (`#402`), `addExternalSubtitle` (`#32`, `#308`), `setSubtitleStyle` (`#32`), `setAudioBoostDb`, `setMediaMetadata`, `setBackgroundAudioEnabled`, `configureMultiView` (`#34`, `#221`), `supportsHardwareHevc4k`, `stop`, `recreate`, `onEngineEvent`, `onRemoteMediaAction`, `uptimeMs()`, `getThermalState()`, `getDeviceMemoryInfo()`, `getDrmCapabilities()` (`#272`), `readClipboardText()`/`pickPlaylistFile()` (`AndroidSourceImport.kt`, `#51`), `launchExternalPlayer()` (`ExternalPlayerLauncher.kt`, `REQUEST_CODE_EXTERNAL_PLAYER`, `#406`).
- Module events & window controls: `onStandbyChanged` (TV `StandbyMonitor`, 6 s debounce), `onThermalStateChanged` (`ThermalMonitor`, API 29+ `PowerManager` watchdog, `#232`), `onSafeAreaInsetsChanged` (`max(systemBars, displayCutout)` dp, zero on TV), `onPictureInPictureChanged`, `setOrientationLocked`, `requestTemporaryOrientation`, `applyShortEdgesCutoutMode`, `getSafeAreaInsets`, `isStatusBarFullscreen`, `enterPictureInPicture` (`[0.418410, 2.39]` + optional `sourceRectHint`), `setAutoEnterPictureInPicture` (API 31+ non-TV, `#34`), `notifyPictureInPictureModeChanged`.
- Manifest declares `WAKE_LOCK`, `ACCESS_WIFI_STATE`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`,
  `POST_NOTIFICATIONS`, and `ElvPlaybackSessionService` (`mediaPlayback` foreground `MediaSessionService`, `#412`).

## Threading, session, codecs and view
- `Media3Engine` + `CommandFence` + `PlaybackSpeedPolicy`: runs `ExoPlayer` on its `HandlerThread`; `CommandFence`
  coalesces superseded commands; rebuilds on `(softwareAudio, preferHevc, StreamKind, BufferPreset, VideoDecoderMode)`,
  re-applying VOD `PlaybackParameters` (`#264`); resets speed to `1.0` and `isScrubbingModeEnabled = false` on load/stop.
- `MediaSessionController` + `ElvPlaybackSessionService` + `SessionCallbackPolicy` (`#132`, `#412`): owns `MediaSession`
  on the playback looper with a `ForwardingPlayer` routing next/prev/stop to `onRemoteMediaAction`, swaps players safely
  before releasing old instances, strips artwork credentials, restricts untrusted controllers to transport commands, and
  attaches/removes sessions on `ElvPlaybackSessionService` so Media3 manages foreground notifications atomically.
- `PlayerFactory` + `LoadControlConfig` + `VodBufferPolicy`: splits `StreamKind` (`RAW_TS_LIVE`, `HLS_LIVE`, `VOD`) x `BufferPreset` with
  RAM-proportional cap, low-RAM `16 MiB` hard cap, Multi-View tile scaling (`targetBufferBytes / tileCount` floored at
  `8 MiB`, conservative durations, secondary tiles `handleAudioFocus = false`, `#34`), and adaptive VOD read-ahead/back-buffer scaling with HTTP `429`/`509` throttle backoff (`#350`); `DefaultTrackSelector`
  (`AudioOffloadPreferences`, `CaptioningManager`).
- `CodecPolicy` + `PolicyVideoRenderer` + `FfmpegAudio` + `AudioEffectsController` + `NightModeDrcPolicy`: LGPL-2.1+ FFmpeg 9.0.2; off-UI-thread
  4K HEVC probe; `VideoDecoderMode` (`auto`/`hardware`/`software`, `#411`); `DeviceQuirks`; stereo-only `LoudnessEnhancer` & API 28+ `DynamicsProcessing` Night-Mode DRC (`#115`).
- `PtsFrameRateEstimator` + `DisplayRefreshController` (`#199`, `#116`): `VideoFrameMetadataListener` 24–60 frame PTS FPS fallback when `format.frameRate == NO_VALUE`, same-resolution `Display.Mode` AFR with guaranteed `preferredDisplayModeId = 0` restore on stop/dispose/OFF, and per-refresh-rate A/V delay (`#115`).
- `SurfaceController` + `Media3SurfaceView` (`VIEW.md`): `SurfaceView` + opt-in `useTextureView` + `surfaceRecreationToken`
  + `250 ms` detach; `AssOverlayBridge` (`ass-media` OpenGL overlay below shutter, `#223`); primary + top `secondarySubtitleView`
  with live `SubtitleStyleMapper` (`#32`, `#402`).

## Playback, tracks, requests and errors
- `EventReporter` gates callbacks behind `PrepareFence` + `MediaItem.mediaId`, reports `playbackParameters.speed`,
  emits live time-shift window bounds (`liveSeekableStartMs`, `liveEdgeMs`, `timeShiftSupported`) via `TimeShiftWindowPolicy` from `Timeline.Window` (`#28`) and VOD `bufferHealth` (contiguous `bufferedBehindMs` + throttled paused VOD ticks, `#350`),
  ignores `SupersededMediaException`, holds on transient audio focus loss, escalates audio failures, stops session on error.
- `TimeShiftRingBuffer` (`cacheDir/timeshift/`, strictly capped at `64 MiB` low-RAM / `256 MiB` standard, synchronous deletion on `reset()`/`close()` and `load`/`stop`/`recreate`/`dispose`) keeps bounded live time-shift off ExoPlayer's `16 MiB` low-RAM heap cap (`#28`).
- `VodEphemeralCache` + `VodCacheController` (`cacheDir/vod-cache/s-<uuid>`, per-session `index.db`, `RedactingVodCache` stripping `exo_redir`, refcounted `CacheDataSource` handles torn down strictly after `player` stop/release, off-main-thread delete, one-shot startup orphan sweep, `#350`).
- `SubtitleSanitizer` repairs mojibake/SDH; `TimedSubtitleCueBuffer` + `SecondarySubtitleController` + `DualSubtitleTrackSelector`
  + `ExternalSubtitleLoader` power delayed/dual/dynamic sidecar subtitles; `StreamHttp.subtitleDataSourceFactory` isolates
  external subtitle headers/cookies (`#308`); `OffsetForwardingAudioSink`; `TrackInspection` + `VideoQualityInspection` + `ProgramInspection` (`#304`).
- `SourceType` (`HLS`, `DASH`, `SMOOTH_STREAMING`, `TS`, `PROGRESSIVE`) + `MediaSources` + `DrmConfigBuilder` (`#272`) + `HlsInitSynthesis`: VOD HLS-TS `EXT-X-MAP` synthesis; ClearKey (`LocalMediaDrmCallback` JWK) & Widevine/PlayReady/remote ClearKey (`HttpMediaDrmCallback`, zero secret logs) + `FrameworkMediaDrm` L1/L3 probe; `TsOnlyExtractorsFactory`;
  `ConnectionGate` (4-thread daemon `closer`), `GatedDataSource`, `StreamHttp` (`ScopedDns` + `networkScopedClient` for per-source `dnsFamily` / exact-origin literal-IP `hostOverride`, `#172`), `IsolatedSubtitleDataSource` (`#308`), `SniffingDataSource`, `ErrorMapping`.

## Tests and rules
- `pnpm --filter @elv/engine-media3 test`; in `apps/tv-mobile/android` (`EXPO_TV=1`): `./gradlew.bat :elv-engine-media3:testDebugUnitTest :elv-engine-media3:assembleRelease` & `:connectedDebugAndroidTest`. Imports `expo-modules-core`, `@elv/playback` types, `react`/`react-native` peers only.
