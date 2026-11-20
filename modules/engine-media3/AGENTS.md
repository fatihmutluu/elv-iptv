# engine-media3 (`@elv/engine-media3`)

Android-only Expo module: the Media3 1.11.1 `PlayerEngine` and its `Media3Surface` view (player core spec 6.1).

## API and contract
- `createMedia3Engine(): PlayerEngine | null` (`src/index.ts`; `null` without `ElvEngineMedia3`) creates a native
  `Engine` shared object; `release()` frees it. `Media3Surface({ engine, style?, resizeMode?, testID? })` renders
  `Media3SurfaceView` bound to that object (one view per engine), else `null`.
- Native (`ElvEngineMedia3Module`, `LoadRequest`): `load(flattened LoadCommand)`, `retry`, `play`, `pause`, `seek`,
  `selectAudioTrack`, `selectSubtitleTrack`, `stop`, `recreate`, `onEngineEvent`, sync `uptimeMs()`. Non-finite
  `startMs`/`seek` values are ignored. `load` takes its token, others adopt a newer one; `liveSeek: false`.

## Threading, player factory, codecs and view
- `Media3Engine` runs `ExoPlayer` on its `HandlerThread` (application looper); `OnDestroy` and `sharedObjectDidRelease`
  cancel OkHttp calls immediately and tear down player and threads. Terminal `STATE_ENDED`/`playerError` prepares
  rebuild `ExoPlayer` while keeping the attached `Surface`.
- `PlayerFactory` + `LoadControlConfig`: `15–30 s` window, `1/2 s` start, `16/32/48 MiB` RAM-tiered byte target with
  `prioritizeTimeOverSizeThresholds = true`, `5/12 s` keyframe back-buffer, `DefaultTrackSelector` (mixed-audio
  adaptiveness, capability invalidation, `CaptioningManager` defaults), `C.WAKE_MODE_NETWORK`, `500 ms` release / `2 s`
  detach / `30 s` stuck-buffering timeouts, `enablePerStreamMediaProgression`, `TAKE_AUDIO_FOCUS` `SecurityException`
  fallback, and VOD `SeekParameters` (`PREVIOUS_SYNC` resume/rewind, `CLOSEST_SYNC` forward).
- `CodecPolicy` + `FfmpegAudio`: LGPL-2.1+ FFmpeg 9.0.2 (`ON` default, `PREFER` on `softwareAudio`), hardware-first
  video ordering, hardware-only initial UHD/HEVC/VP9/AV1/DV pass unlocking software fallback after `>= 2` hardware
  failures or Rung 4, silent stub DTS `MediaCodec` filter without HDMI passthrough, and `AudioDecodePath` lookup.
- `SurfaceController` + `Media3SurfaceView` (`VIEW.md`): valid `Surface` attach/detach, `awaitingVideoSize` zap gate,
  `PrepareFence` shutter serials, cues and `keepsScreenOn`.

## Playback, tracks, requests and errors
- `EventReporter` gates callbacks behind `PrepareFence` + `MediaItem.mediaId`, ignores `SupersededMediaException`,
  maps transient audio-focus suppression to `paused`, emits audio-only `firstFrame` keeping the shutter closed, recovers
  `BEHIND_LIVE_WINDOW` in place (`<= 2`), and distinguishes valid VOD EOF from empty unplayed VOD / live `ended`.
- `TrackInspection` + `TrackSelectorBridge` include selected `FORMAT_EXCEEDS_CAPABILITIES` audio, ignore `Tracks.EMPTY`,
  keep `CaptioningManager` defaults on `Default`, guard unmatched IDs, keep cues on active-subtitle re-select, match
  `(id, language, label)` with ISO 639-1/2/BCP-47 parity, and emit confirmed selections.
- `SourceType` + `MediaSources`: `.m3u8`/`.m3u` and 256-entry cached `#EXTM3U` discoveries use HLS (`TS_FLAGS`, `5 s`
  PTS timeout, `8.0` live stuck coefficient); `.ts` and unknown live extensions use `TsOnlyExtractorsFactory`; known
  containers and VOD sniff (`CBR` seeking, artwork disabled, RAM-scaled TS search bytes).
- `ConnectionGate`, `GatedDataSource`, `StreamHttp`, `SniffingDataSource`, `ResponseSniffing`, `LoadRetry`,
  `ErrorMapping`, `UrlRedaction`: generation-gated sockets with bounded stalled-closer drop; sanitized headers and
  cross-origin `Authorization`/`Cookie`/`Proxy-Authorization`/`X-Api-Key`/`X-Auth-Token` stripping; `1 KB` EOF-aware
  sniffing (`\u000B`/`\u000C` text, 3-packet TS sync, WebVTT/TTML/SRT segments, direct `manifestLoaded`, retryable
  post-manifest empty HLS refreshes); `ServiceOwnedRetryPolicy` (`causeOf` + fallback blocking); `407 -> http-401`,
  `410/451 -> http-404`, `458/460–463/469` and notices -> `connection-limit`; strict allowlist `redactUrl`.

## Tests and rules
- `pnpm --filter @elv/engine-media3 test`; in `apps/tv-mobile/android` (`EXPO_TV=1`): `./gradlew.bat
  :elv-engine-media3:testDebugUnitTest :elv-engine-media3:assembleRelease` and `:connectedDebugAndroidTest`.
  Imports `expo-modules-core`, `@elv/playback` types and `react`/`react-native` peers only.
