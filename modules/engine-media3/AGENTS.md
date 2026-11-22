# engine-media3 (`@elv/engine-media3`)

Android-only Expo module: the Media3 1.11.1 `PlayerEngine`, `Media3Surface` view, TV standby monitor, and mobile
window helpers (player core spec 6.1).

## API and contract
- `createMedia3Engine(): PlayerEngine | null` (`src/index.ts`; `null` without `ElvEngineMedia3`) creates a native
  `Engine` shared object; `release()` frees it. `Media3Surface({ engine, style?, resizeMode?,
  subtitleBottomInsetPx?, surfaceRecreationToken?, useTextureView?, testID? })` renders `Media3SurfaceView`.
- Native (`ElvEngineMedia3Module`, `LoadRequest`): `load(flattened LoadCommand + bufferPreset?)`, `retry`, `play`,
  `pause`, `seek`, `setScrubbing` (VOD-only), `setAudioBoostDb`, `supportsHardwareHevc4k`, `selectAudioTrack`,
  `selectSubtitleTrack`, `stop`, `recreate`, `onEngineEvent`, sync `uptimeMs()`.
- Module events & window controls: `onStandbyChanged` (TV `StandbyMonitor`, 6 s debounce), `onSafeAreaInsetsChanged`
  (`max(systemBars, displayCutout)` dp, zero on TV), `onPictureInPictureChanged`, `setOrientationLocked`,
  `requestTemporaryOrientation` (`SmartOrientationController`), `applyShortEdgesCutoutMode`, `getSafeAreaInsets`,
  `isStatusBarFullscreen` (`Type.statusBars()`), `enterPictureInPicture` (`[0.418410, 2.39]`), `notifyPictureInPictureModeChanged`.
- Library `AndroidManifest.xml` declares `WAKE_LOCK` and `ACCESS_WIFI_STATE` for `C.WAKE_MODE_NETWORK`.

## Threading, player factory, codecs and view
- `Media3Engine` + `CommandFence`: runs `ExoPlayer` on its `HandlerThread`; synchronous `CommandFence` coalesces
  superseded `load`/`retry`/`recreate` and filters stale events; `OnDestroy`/release stops `StandbyMonitor`,
  `SmartOrientationController`, OkHttp, `AudioEffectsController`, and threads; rebuilds player on `(softwareAudio,
  preferHevc, StreamKind, BufferPreset)` changes; resets `isScrubbingModeEnabled = false` on stop/load/retry/recreate.
- `PlayerFactory` + `LoadControlConfig`: splits `StreamKind` (`RAW_TS_LIVE`, `HLS_LIVE`, `VOD`) x `BufferPreset`
  (`auto`, `balanced`, `large`) with RAM-proportional non-low-RAM cap and low-RAM (`< 1.5 GiB`) `16 MiB` hard cap
  (`prioritizeTimeOverSizeThresholds = false`, live `backBufferMs = 0`); `DefaultTrackSelector` (`AudioOffloadPreferences`
  enabled, tunneling off, capability invalidation, `CaptioningManager` gated on `isEnabled`); `TAKE_AUDIO_FOCUS` fallback.
- `CodecPolicy` + `FfmpegAudio` + `AudioEffectsController`: LGPL-2.1+ FFmpeg 9.0.2; off-UI-thread 4K HEVC hardware probe;
  format-checked hardware-first video selector; Amlogic `CodecMaxValues` floor & Sony Bravia frame-drop quirks (`DeviceQuirks`);
  `LoudnessEnhancer` stereo-only gain boost (skips `sessionId <= 0` and `channelCount > 2`, 5 min DRC refresh).
- `SurfaceController` + `Media3SurfaceView` (`VIEW.md`): `SurfaceView` default + opt-in `useTextureView` (`TextureView`
  release on destroy) + `surfaceRecreationToken` child-0 swap with retired-callback suppression; `250 ms` bounded detach.

## Playback, tracks, requests and errors
- `EventReporter` gates callbacks behind `PrepareFence` + `MediaItem.mediaId`, ignores `SupersededMediaException`,
  holds state on `TRANSIENT_AUDIO_FOCUS_LOSS`, escalates audio decoder/sink failures, recovers `BEHIND_LIVE_WINDOW`.
- `SubtitleSanitizer` repairs UTF-8-as-Latin-1/CP1252 mojibake and strips stray `U+FFFD` while preserving bitmap cues.
- `TrackInspection` + `TrackSelectorBridge` expose selected/FFmpeg-decodable audio, resolve `und` tracks, ignore
  `Tracks.EMPTY`, and preserve cues on active-subtitle re-select.
- `SourceType` + `MediaSources` + `HlsInitSynthesis`: VOD HLS-TS `EXT-X-MAP` SPS/PPS synthesis via `data:` URI;
  `TsOnlyExtractorsFactory`; widened TS search; VOD `constantBitrateSeekingAlwaysEnabled`; `ConnectionGate` (4-thread
  daemon `closer`), `GatedDataSource`, `StreamHttp`, `SniffingDataSource`, `ServiceOwnedRetryPolicy`, `ErrorMapping`.

## Tests and rules
- `pnpm --filter @elv/engine-media3 test`; in `apps/tv-mobile/android` (`EXPO_TV=1`): `./gradlew.bat
  :elv-engine-media3:testDebugUnitTest :elv-engine-media3:assembleRelease` and `:connectedDebugAndroidTest`.
  Imports `expo-modules-core`, `@elv/playback` types and `react`/`react-native` peers only.
