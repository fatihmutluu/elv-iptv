# engine-media3 (`@elv/engine-media3`)

Android-only Expo module: the Media3 1.11.1 `PlayerEngine`, `Media3Surface` view, `MediaSessionService`, TV standby
monitor, and mobile window helpers (player core spec 6.1).

## API and contract
- `createMedia3Engine(): PlayerEngine | null` (`src/index.ts`; `null` without `ElvEngineMedia3`) creates a native
  `Engine` shared object; `release()` frees it. Helpers: `setMedia3PitchLock`, `setMedia3MediaMetadata`,
  `setMedia3BackgroundAudioEnabled`, `subscribeMedia3RemoteMediaAction`. `Media3Surface` renders `Media3SurfaceView`.
- Native (`ElvEngineMedia3Module`, `LoadRequest`): `load(flattened LoadCommand + externalSubtitles? + subtitleStyle? + secondarySubtitleTrackId? + bufferPreset? + decoderMode? + allowLegacyTls?)`, `retry`, `play`, `pause`, `seek`, `setScrubbing`/`setSpeed`/`setPitchLock` (VOD, `[0.25, 4.0]`), `setAudioDelay`/`setSubtitleDelay` (`[-30_000, 30_000]` ms), `selectVideoQuality` (`#59`), `selectAudioTrack`, `selectSubtitleTrack`, `selectSecondarySubtitleTrack` (`#402`), `addExternalSubtitle` (`#32`, `#308`), `setSubtitleStyle` (`#32`), `setAudioBoostDb`, `setMediaMetadata`, `setBackgroundAudioEnabled`, `supportsHardwareHevc4k`, `stop`, `recreate`, `onEngineEvent`, `onRemoteMediaAction`, `uptimeMs()`, `readClipboardText()`/`pickPlaylistFile()` (`AndroidSourceImport.kt`, `#51`).
- Module events & window controls: `onStandbyChanged` (TV `StandbyMonitor`, 6 s debounce), `onSafeAreaInsetsChanged`
  (`max(systemBars, displayCutout)` dp, zero on TV), `onPictureInPictureChanged`, `setOrientationLocked`,
  `requestTemporaryOrientation`, `applyShortEdgesCutoutMode`, `getSafeAreaInsets`, `isStatusBarFullscreen`,
  `enterPictureInPicture` (`[0.418410, 2.39]`), `notifyPictureInPictureModeChanged`.
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
- `PlayerFactory` + `LoadControlConfig`: splits `StreamKind` (`RAW_TS_LIVE`, `HLS_LIVE`, `VOD`) x `BufferPreset` with
  RAM-proportional cap & low-RAM `16 MiB` hard cap; `DefaultTrackSelector` (`AudioOffloadPreferences`, `CaptioningManager`).
- `CodecPolicy` + `PolicyVideoRenderer` + `FfmpegAudio` + `AudioEffectsController`: LGPL-2.1+ FFmpeg 9.0.2; off-UI-thread
  4K HEVC probe; `VideoDecoderMode` (`auto`/`hardware`/`software`, `#411`); `DeviceQuirks`; stereo-only `LoudnessEnhancer`.
- `SurfaceController` + `Media3SurfaceView` (`VIEW.md`): `SurfaceView` + opt-in `useTextureView` + `surfaceRecreationToken`
  + `250 ms` detach; `AssOverlayBridge` (`ass-media` OpenGL overlay below shutter, `#223`); primary + top `secondarySubtitleView`
  with live `SubtitleStyleMapper` (`#32`, `#402`).

## Playback, tracks, requests and errors
- `EventReporter` gates callbacks behind `PrepareFence` + `MediaItem.mediaId`, reports `playbackParameters.speed`,
  emits live time-shift window bounds (`liveSeekableStartMs`, `liveEdgeMs`, `timeShiftSupported`) via `TimeShiftWindowPolicy` from `Timeline.Window` (`#28`),
  ignores `SupersededMediaException`, holds on transient audio focus loss, escalates audio failures, stops session on error.
- `TimeShiftRingBuffer` (`cacheDir/timeshift/`, strictly capped at `64 MiB` low-RAM / `256 MiB` standard, synchronous deletion on `reset()`/`close()` and `load`/`stop`/`recreate`/`dispose`) keeps bounded live time-shift off ExoPlayer's `16 MiB` low-RAM heap cap (`#28`).
- `SubtitleSanitizer` repairs mojibake/SDH; `TimedSubtitleCueBuffer` + `SecondarySubtitleController` + `DualSubtitleTrackSelector`
  + `ExternalSubtitleLoader` power delayed/dual/dynamic sidecar subtitles; `StreamHttp.subtitleDataSourceFactory` isolates
  external subtitle headers/cookies (`#308`); `OffsetForwardingAudioSink`; `TrackInspection` + `VideoQualityInspection`.
- `SourceType` + `MediaSources` + `HlsInitSynthesis`: VOD HLS-TS `EXT-X-MAP` synthesis; `TsOnlyExtractorsFactory`;
  `ConnectionGate` (4-thread daemon `closer`), `GatedDataSource`, `StreamHttp`, `SniffingDataSource`, `ErrorMapping`.

## Tests and rules
- `pnpm --filter @elv/engine-media3 test`; in `apps/tv-mobile/android` (`EXPO_TV=1`): `./gradlew.bat :elv-engine-media3:testDebugUnitTest :elv-engine-media3:assembleRelease` & `:connectedDebugAndroidTest`. Imports `expo-modules-core`, `@elv/playback` types, `react`/`react-native` peers only.
