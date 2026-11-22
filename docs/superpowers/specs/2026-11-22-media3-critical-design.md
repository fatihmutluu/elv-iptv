# Wave 5A — Media3 Critical Reliability, Memory, Surface & Track Hardening

**Date:** 2026-11-22
**Branch:** `fix/media3-critical`
**Closes:** `#422`, `#423`, `#424`, `#436`, `#437`, `#438`

## 1. Goal

Harden `@elv/engine-media3` across six high-impact failure modes before shipping device-specific quirks or new playback features:
1. Prevent 1 GB TV stick OOM crashes on high-bitrate streams and stop wasting back-buffer RAM on non-seekable live streams (`#422`).
2. Guarantee single-connection `ConnectionGate` generation isolation across every player rebuild/recovery path, including `handleAudioFocusDenied()` and `playAsHls()` (`#423`).
3. Eliminate the 3,000 ms Android UI-thread `CountDownLatch` ANR hazard in `Media3SurfaceView.detachSurface()` while closing surface-epoch re-attach races (`#424`).
4. Auto-escalate non-DTS audio decoder failures once to FFmpeg software audio, decouple transient audio-focus suppression from explicit user pause, and declare `WAKE_LOCK` + `ACCESS_WIFI_STATE` in the Media3 library manifest (`#436`).
5. Eliminate early-seek VOD resume position poisoning and single-thread `closer` head-of-line blocking (`#437`).
6. Fix Media3 track, MPEG-TS, OkHttp, and sniffing edge cases: `AudioCapabilitiesReceiver` caching, stable `und` track resolution, `CaptioningManager` gating, wider low-RAM TS search + VOD CBR seeking, FFmpeg-decodable `FORMAT_EXCEEDS_CAPABILITIES` audio selection, explicit OkHttp `writeTimeout`, and incremental prefix sniffing (`#438`).

## 2. Design Decisions & Contracts

### 2.1 Memory-Safe `LoadControlConfig` & Live/VOD Split (`#422`)
- `LoadControlConfig.kt` adds `live: Boolean = false` to `loadControlFor(lowRam, live)` and `loadControlForMemory(isLowRamDevice, totalMemBytes, live)`:
  - **Low-RAM (`isLowRamDevice || totalMemBytes < 1536 MiB`):** `prioritizeTimeOverSizeThresholds = false` so `targetBufferBytes = 16 MiB` is a strict hard ceiling on 4K/high-bitrate streams; standard/high-RAM keeps `prioritizeTimeOverSizeThresholds = true`.
  - **Live (`live = true`):** `backBufferMs = 0`, `retainBackBufferFromKeyframe = false`, `minBufferMs = if (lowRam) 10_000 else 15_000`, `maxBufferMs = if (lowRam) 20_000 else 30_000`.
  - **VOD (`live = false`):** `backBufferMs = if (lowRam) 5_000 else 12_000`, `retainBackBufferFromKeyframe = true`, `minBufferMs = 15_000`, `maxBufferMs = 30_000`.
- `PlayerFactory` accepts a `loadControlForLive: (Boolean) -> LoadControlValues` provider (built from `DeviceMemoryProfile` read once from `ActivityManager`), and `Media3Engine` tracks `playerLive: Boolean` so switching between Live and VOD rebuilds `ExoPlayer` with the matching `DefaultLoadControl`.

### 2.2 Strict `ConnectionGate` Generation Isolation (`#423`)
- `Media3Engine.handleAudioFocusDenied()` calls `prepare(current, currentVodPositionOrStart(current), newGeneration = true)` so `beginGeneration()` advances before rebuilding the player and `ConnectionGate.awaitPreviousClosed()` waits for prior sockets to close before opening the replacement request.
- `Media3Engine.playAsHls()` likewise calls `prepare(next, currentVodPositionOrStart(next), newGeneration = true)` after validating `detectedIn == generation`, ensuring no stale progressive socket overlaps the HLS manifest open.
- Any in-place audio decoder escalation (`#436`) also uses `newGeneration = true`.

### 2.3 Bounded UI-Thread Surface Detach & Surface-Epoch Safety (`#424`)
- `Media3SurfaceView.DETACH_TIMEOUT_MS` drops from `3_000L` to `250L`, eliminating ANR stalls when `ExoPlayer.release()` or `MediaCodec.release()` is slow.
- `Media3Engine.detachSurface()` short-circuits immediately when `commandFence.isDisposedNow` without posting or blocking on a stopped playback looper.
- `SurfaceController` verifies `offered === active && active.isValid` inside `attachToNewPlayer()`, guaranteeing a surface invalidated or destroyed on the UI thread before `detachNow` executes can never be bound to a rebuilt `ExoPlayer`.

### 2.4 Audio Decoder Escalation, Transient Suppression & Network Wake Permissions (`#436`)
- `EventReporter` detects audio decoder/sink failures (`MediaCodecRenderer.DecoderInitializationException` with `MimeTypes.isAudio(mimeType)`, `AudioSink.InitializationException`, `AudioSink.WriteException`, or `ERROR_CODE_AUDIO_TRACK_INIT_FAILED` / `ERROR_CODE_AUDIO_TRACK_WRITE_FAILED` / audio `ERROR_CODE_DECODER_INIT_FAILED` / `ERROR_CODE_DECODING_FAILED`) and invokes `onAudioCodecFailed: () -> Boolean`.
- `Media3Engine` handles `onAudioCodecFailed()` once per `load()` when `!playerSoftwareAudio`: flips `audioFallbackAttempted = true`, snapshots VOD position, and re-prepares with `next.copy(softwareAudio = true)` (`EXTENSION_RENDERER_MODE_PREFER`) and `newGeneration = true`. Subsequent failures propagate normally as `"decoder"` errors.
- `EventReporter.stateOf(player)` treats `PLAYBACK_SUPPRESSION_REASON_TRANSIENT_AUDIO_FOCUS_LOSS` while `playWhenReady == true` as a non-terminal state hold (`null`), preventing false `"paused"` transitions that pop the player OSD or desynchronize `togglePlayPause`, while keeping `nowStalled = false` and `effectiveRate = 0f` until focus resumes. Explicit pause (`!playWhenReady`) and non-transient suppression still emit `"paused"`.
- `modules/engine-media3/android/src/main/AndroidManifest.xml` declares `android.permission.WAKE_LOCK` and `android.permission.ACCESS_WIFI_STATE` so `ExoPlayer.Builder.setWakeMode(C.WAKE_MODE_NETWORK)` works on Android and Android TV without runtime permission rejections.

### 2.5 Seekability Guard & Concurrent Closer Pool (`#437`)
- `Media3Engine.seek()` writes `lastVodPositionMs = clamped` strictly after confirming `player != null && current.isCurrentMediaItemSeekable`.
- `Media3Engine.closer` uses a bounded multi-thread daemon `ThreadPoolExecutor(corePoolSize = 4, maximumPoolSize = 4, keepAliveTime = 10, TimeUnit.SECONDS, LinkedBlockingQueue())` with `allowCoreThreadTimeOut(true)`.
- `ConnectionGate.forceClose()` submits each superseded `ForceClosable` as an independent `closer.execute` task (with per-connection `RejectedExecutionException` handling) so a wedged socket/DNS close never head-of-line-blocks sibling or newer generation closes.

### 2.6 Track, MPEG-TS, OkHttp & Incremental Sniffing Fixes (`#438`)
- `CodecPolicy` caches `AudioCapabilities` via `AudioCapabilitiesReceiver` (started on the playback looper with safe fallback when receiver registration is unavailable, and unregistered on `Media3Engine.dispose()`), eliminating synchronous `AudioCapabilities.getCapabilities()` calls on every DTS decoder lookup.
- `TrackInspection` + `TrackSelectorBridge`:
  - `TrackInfoSnapshot` and `TrackChoice` carry `formatId`, `codec`, and `channels`; `resolveCandidate()` matches `und` tracks (no language/label) by `formatId`, then `(codec, channels)`, before falling back to positional `"$groupIndex:$trackIndex"`.
  - `isSelectableTrack()` accepts unselected `FORMAT_EXCEEDS_CAPABILITIES` audio tracks when `ffmpegSupportsAudio(format.sampleMimeType)` is true.
  - `PlayerFactory` and `TrackSelectorBridge` gate `setPreferredTextLanguageAndRoleFlagsToCaptioningManagerSettings()` behind `CaptioningManager.isEnabled == true` (and never apply system CaptioningManager defaults over an explicit `SubChoice.Selected` choice).
- `MediaSources`:
  - `tsSearchBytesFor(lowRam = true)` widens from `600 * 188` to `1_800 * 188` packets (`2_400 * 188` on normal RAM).
  - `tsCapableFactory(lowRam, live)` sets `setConstantBitrateSeekingAlwaysEnabled(!live)` for VOD progressive/TS seeking while leaving live streams unaffected.
- `StreamHttp`: sets explicit `.writeTimeout(WRITE_TIMEOUT_MS, TimeUnit.MILLISECONDS)` (`10_000L`) alongside `CONNECT_TIMEOUT_MS` and `READ_TIMEOUT_MS`.
- `SniffingDataSource`: evaluates `canStopSniffing(kind, prefix, filled)` incrementally after each `upstream.read()` chunk (stopping early on confirmed 3-packet MPEG-TS sync, unambiguous binary media prefix, or `#EXTM3U` manifest header) instead of always blocking until `SNIFF_BYTES` (`1024`) arrive; `ResponseSniffing.kt` uses `Locale.ROOT` for ASCII lowercasing.

## 3. Verification

- Strict TDD across all modified Kotlin files with Robolectric + JUnit 4 (`./gradlew.bat :elv-engine-media3:testDebugUnitTest :elv-engine-media3:assembleRelease`).
- Full workspace verification (`pnpm check` -> `11 passed, 0 failed`).
- Independent `Gemini 4 Neon (High)` whole-branch code review (`VERDICT: PASS`).
