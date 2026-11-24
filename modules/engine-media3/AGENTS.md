# engine-media3 (`@elv/engine-media3`)

Android-only Expo module: the Media3 1.11.1 `PlayerEngine`, `Media3Surface` view, `MediaSessionService`, TV standby
monitor, and mobile window helpers (player core spec 6.1).

## API and contract
- `createMedia3Engine(): PlayerEngine | null` (`src/index.ts`; `null` without `ElvEngineMedia3`) creates a native
  `Engine` shared object; `release()` frees it. Helpers: `setMedia3PitchLock`, `setMedia3MediaMetadata`,
  `setMedia3BackgroundAudioEnabled`, `subscribeMedia3RemoteMediaAction`. `Media3Surface` renders `Media3SurfaceView`.
- Native (`ElvEngineMedia3Module`, `LoadRequest`): `load(flattened LoadCommand + bufferPreset? + decoderMode? +
  allowLegacyTls?)`, `retry`, `play`, `pause`, `seek`, `setScrubbing`/`setSpeed`/`setPitchLock` (VOD, `[0.25, 4.0]`),
  `setAudioDelay`/`setSubtitleDelay` (`[-30_000, 30_000]` ms, `#203`, `#59`), `selectVideoQuality` (adaptive ABR, `#59`),
  `setAudioBoostDb`, `setMediaMetadata`, `setBackgroundAudioEnabled`, `supportsHardwareHevc4k`, `selectAudioTrack`,
  `selectSubtitleTrack`, `stop`, `recreate`, `onEngineEvent`, `onRemoteMediaAction`, `uptimeMs()`, plus zero-permission
  `readClipboardText()` / `pickPlaylistFile()` (`AndroidSourceImport.kt`, SAF `ACTION_OPEN_DOCUMENT`, 64 MiB cap, `#51`).
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
- `SurfaceController` + `Media3SurfaceView` (`VIEW.md`): `SurfaceView` default + opt-in `useTextureView` +
  `surfaceRecreationToken` swap with retired-callback suppression; `250 ms` bounded detach.

## Playback, tracks, requests and errors
- `EventReporter` gates callbacks behind `PrepareFence` + `MediaItem.mediaId`, reports `playbackParameters.speed`,
  emits live time-shift window bounds (`liveSeekableStartMs`, `liveEdgeMs`, `timeShiftSupported`) via `TimeShiftWindowPolicy` from `Timeline.Window` (`#28`),
  ignores `SupersededMediaException`, holds on transient audio focus loss, escalates audio failures, stops session on error.
- `TimeShiftRingBuffer` (`cacheDir/timeshift/`, strictly capped at `64 MiB` low-RAM / `256 MiB` standard, synchronous deletion on `reset()`/`close()` and `load`/`stop`/`recreate`/`dispose`) keeps bounded live time-shift off ExoPlayer's `16 MiB` low-RAM heap cap (`#28`).
- `SubtitleSanitizer` repairs mojibake and strips `U+FFFD`; `TimedSubtitleCueBuffer` buffers cues (<= 128) for live
  non-flushing subtitle delay; `OffsetForwardingAudioSink` offsets audio clock without reallocating; `TrackInspection` +
  `VideoQualityInspection` + `TrackSelectorBridge` expose audio/subtitle tracks and adaptive video renditions.
- `SourceType` + `MediaSources` + `HlsInitSynthesis`: VOD HLS-TS `EXT-X-MAP` synthesis; `TsOnlyExtractorsFactory`;
  `ConnectionGate` (4-thread daemon `closer`), `GatedDataSource`, `StreamHttp`, `SniffingDataSource`, `ErrorMapping`.

## Tests and rules
- `pnpm --filter @elv/engine-media3 test`; in `apps/tv-mobile/android` (`EXPO_TV=1`): `./gradlew.bat :elv-engine-media3:testDebugUnitTest :elv-engine-media3:assembleRelease` & `:connectedDebugAndroidTest`. Imports `expo-modules-core`, `@elv/playback` types, `react`/`react-native` peers only.
