# engine-media3 (`@elv/engine-media3`)

Android-only Expo module: the Media3 1.11.1 `PlayerEngine` and its `Media3Surface` view (player core spec 6.1).

## API and contract
- `createMedia3Engine(): PlayerEngine | null` (`src/index.ts`; `null` without `ElvEngineMedia3`) creates a native
  `Engine` shared object; `release()` frees it. `Media3Surface({ engine, style?, resizeMode?, testID? })` renders
  `Media3SurfaceView` bound to that object (one view per engine), else `null`.
- Native (`ElvEngineMedia3Module`, `LoadRequest`): `load(flattened LoadCommand)`, `retry`, `play`, `pause`, `seek`,
  `selectAudioTrack`, `selectSubtitleTrack`, `stop`, `recreate`, `onEngineEvent`, sync `uptimeMs()`. Non-finite
  `startMs`/`seek` values are ignored. `load` takes its token, others adopt a newer one; `liveSeek: false`.
- Library `AndroidManifest.xml` declares `WAKE_LOCK` and `ACCESS_WIFI_STATE` for `C.WAKE_MODE_NETWORK`.

## Threading, player factory, codecs and view
- `Media3Engine` + `CommandFence`: runs `ExoPlayer` on its `HandlerThread`; synchronous `CommandFence` coalesces
  superseded `load`/`retry`/`recreate` and filters stale events by `(mediaEpoch, token)`; `OnDestroy`/release cancels
  OkHttp and tears down player/threads; `seek()` updates `lastVodPositionMs` only when `isCurrentMediaItemSeekable`;
  `handleAudioFocusDenied`, `playAsHls`, and one-shot audio escalation all advance `ConnectionGate` generation.
- `PlayerFactory` + `LoadControlConfig`: Live (`backBufferMs = 0`, low-RAM `10–20 s`) vs VOD (`5/12 s` back-buffer,
  `15–30 s`) split with rebuild on Live/VOD switch; low-RAM (`< 1.5 GiB`) disables `prioritizeTimeOverSizeThresholds`
  (`16 MiB` hard cap); `DefaultTrackSelector` (mixed-audio adaptiveness, capability invalidation, `CaptioningManager`
  gated on system `isEnabled`); `C.WAKE_MODE_NETWORK`, pinned timeouts, `TAKE_AUDIO_FOCUS` fallback, VOD `SeekParameters`.
- `CodecPolicy` + `FfmpegAudio`: LGPL-2.1+ FFmpeg 9.0.2 (`ON` default, `PREFER` on `softwareAudio` or one-shot audio
  decoder fallback); `AudioCapabilitiesReceiver` cache (stopped on `dispose`); hardware-first video ordering, DV->HEVC
  fallback, and stub DTS `MediaCodec` filter without HDMI passthrough.
- `SurfaceController` + `Media3SurfaceView` (`VIEW.md`): `250 ms` bounded detach (disposed short-circuit),
  `offered === active` guard on `attachToNewPlayer`, `awaitingVideoSize` gate, `PrepareFence` shutter, cues, `keepsScreenOn`.

## Playback, tracks, requests and errors
- `EventReporter` gates callbacks behind `PrepareFence` + `MediaItem.mediaId`, ignores `SupersededMediaException`,
  holds state (`rate = 0`, no OSD pause/stall) on `TRANSIENT_AUDIO_FOCUS_LOSS`, escalates audio decoder/sink failures,
  recovers `BEHIND_LIVE_WINDOW` (`<= 2`), and distinguishes valid VOD EOF from empty unplayed VOD / live `ended`.
- `TrackInspection` + `TrackSelectorBridge` expose selected or FFmpeg-decodable `FORMAT_EXCEEDS_CAPABILITIES` audio,
  resolve `und` tracks via `formatId` / `(codec, channels)`, gate `CaptioningManager` on system `isEnabled`, ignore
  `Tracks.EMPTY`, guard unmatched IDs, and preserve cues on active-subtitle re-select.
- `SourceType` + `MediaSources`: HLS (`TS_FLAGS`, `5 s` PTS timeout, `8.0` live stuck coefficient); `.ts`/unknown live
  use `TsOnlyExtractorsFactory`; widened TS search (`1,800`/`2,400` packets) and VOD `constantBitrateSeekingAlwaysEnabled`.
- `ConnectionGate` (4-thread daemon `closer`, per-connection dispatch), `GatedDataSource`, `StreamHttp` (`writeTimeout`
  `10 s`, cross-origin credential stripping), `SniffingDataSource` / `ResponseSniffing` (incremental early-stop sniffing,
  `Locale.ROOT`), `ServiceOwnedRetryPolicy`, `ErrorMapping`, and `redactUrl`.

## Tests and rules
- `pnpm --filter @elv/engine-media3 test`; in `apps/tv-mobile/android` (`EXPO_TV=1`): `./gradlew.bat
  :elv-engine-media3:testDebugUnitTest :elv-engine-media3:assembleRelease` and `:connectedDebugAndroidTest`.
  Imports `expo-modules-core`, `@elv/playback` types and `react`/`react-native` peers only.
