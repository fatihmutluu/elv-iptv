# Media3 Device Quirks, Buffer Presets, HLS Init Synthesis, Surface Modes & Android Lifecycle Hardening

**Date:** 2026-11-22  
**Branch:** `fix/media3-device-quirks`  
**Issues:** `#143`, `#144`, `#147`, `#150`, `#183`, `#184`, `#222`, `#255`, `#260`, `#261`, `#262`, `#266`  
**Depends on:** Wave 5A (`#455`, merged on `main`)

---

## 1. Goal & Scope

Harden `@elv/engine-media3`, `@elv/playback`, `@elv/domain`, `@elv/features`, and `apps/tv-mobile` against real-world Android phone, tablet, Fire OS, and Android TV hardware/firmware quirks without violating zero-blink UI rules, low-RAM OOM bounds, or clean-room licensing constraints.

All 12 issues are delivered together in one cohesive, TDD-verified PR:

1. **`#143` HDMI-CEC / TV standby release:** Detect Android TV `DisplayManager` `STATE_OFF`/`STATE_DOZE`/`STATE_SUSPEND` and `ACTION_HDMI_AUDIO_PLUG` unplugged state with a mandatory `6,000 ms` debounce (preventing AFR mode switches from self-killing playback), emitting `'background'` to `AppLifecyclePort` only when an active display/HDMI sink was previously seen.
2. **`#144` Fresh `SurfaceView` recreation token on 4K decoder reset:** Add `surfaceRecreationToken` (incremented only on Rung 3 `recreate` after consecutive `decoder` failures, never on normal channel zaps) so `Media3SurfaceView` replaces only child index `0` (`SurfaceView`/`TextureView`), keeps `ZapShutter` (index `1`) and `SubtitleView` (index `2`) z-order intact, and ignores late `surfaceDestroyed` callbacks from retired surfaces.
3. **`#147` Stream-type `LoadControl` split + user buffer presets:** Split `LoadControlConfig` across `StreamKind` (`RAW_TS_LIVE`, `HLS_LIVE`, `VOD`) and `BufferPreset` (`auto`, `balanced`, `large`) persisted backward-compatibly in `@elv/domain` `PreferencesSnapshot` (`version: 1`), preserving Wave 5A's strict low-RAM (`< 1.5 GiB` / `isLowRamDevice`) `16 MiB` hard cap (`prioritizeTimeOverSizeThresholds = false`) and `backBufferMs = 0` on non-seekable live.
4. **`#150` 4K HEVC hardware probe & rolling rebuffer downgrade:** Probe `MediaCodecList` off the UI thread (on the playback `HandlerThread`) for hardware-accelerated `3840x2160` HEVC decoding; raise `bufferForPlaybackAfterRebufferMs` to damp rebuffer oscillation; add rolling non-seek rebuffer stall tracking (`>= 3` stalls within `120_000 ms`) in `@elv/playback` `StallWatchdog` / `ladder` to escalate cleanly to alternates/downgrade.
5. **`#183` VOD HLS-TS `EXT-X-MAP` SPS/PPS synthesis:** Synthesize a minimal valid MPEG-TS init segment (PAT + PMT + SPS/PPS) for finished VOD HLS-TS playlists (`!live && hasEndTag`) that lack `#EXT-X-MAP` and `#EXT-X-DISCONTINUITY`, serving synthesized `data:video/mp2t;base64,...` init URIs through `DataSchemeDataSource` inside `HlsDataSourceFactory` so `OkHttpDataSource` never receives `data:` URIs.
6. **`#184` Hardware-first video decoder selector & subtitle mojibake sanitization:** Upgrade `PolicyVideoRenderer.getDecoderInfos` to filter software decoders (`omx.google.*`, `c2.android.*`, `c2.google.*`) only when a hardware decoder confirms format support (profile/level/resolution), safely keeping software fallback when hardware rejects; add idempotent UTF-8-as-Latin-1/Windows-1252 mojibake repair (`SubtitleSanitizer`) preserving valid UTF-8 (including Turkish diacritics) and DVB/PGS bitmap cues.
7. **`#222` `AudioOffloadPreferences`, capability invalidation & `isScrubbingModeEnabled`:** Enable `AudioOffloadPreferences.AUDIO_OFFLOAD_MODE_ENABLED` alongside `setAllowInvalidateSelectionsOnRendererCapabilitiesChange(true)` (explicitly keeping tunneling disabled); wire `setScrubbing(attempt, scrubbing)` across `@elv/playback` -> `@elv/engine-media3` -> `ExoPlayer.isScrubbingModeEnabled` (VOD-only, reset unconditionally on `load`/`stop`/`recreate`/`retry`/cancel).
8. **`#255` Android `SHORT_EDGES` cutout mode & `displayCutout` safe insets:** Configure `android:windowLayoutInDisplayCutoutMode="shortEdges"` for non-TV builds in `withAndroidDisplay` and runtime `AndroidWindowHelper`; read `max(systemBars, displayCutout)` via `WindowInsetsCompat` into `ViewportProvider` (`safeArea`) while keeping `PlayerSurface` full-bleed edge-to-edge and TV cutout insets at `0`.
9. **`#260` `TAKE_AUDIO_FOCUS`, `AudioTrack` drift guard & `LoudnessEnhancer` 5.1 protection:** Keep `TAKE_AUDIO_FOCUS` `SecurityException` fallback; configure safe `DefaultAudioSink` handling; add `AudioEffectsController` guarding `LoudnessEnhancer` against `audioSessionId == 0`, multichannel (`channelCount > 2`) streams, OEM `AudioEffect` exceptions, and AOSP DRC drift (5-minute gain refresh cancelled cleanly on stop/release/dispose).
10. **`#261` Amlogic `CodecMaxValues`, Sony Bravia frame-drop & output-surface quirks:** Inject deterministic `DeviceQuirks` into `PolicyVideoRenderer`: enforce `>= 1920x1089` `CodecMaxValues` floor on Amlogic SoCs/codecs for seamless 720p -> 1080p adaptive switches, add bounded consecutive-drop mitigation for Sony Bravia panel frame-drop cascades, and guard broken `setOutputSurface` SoCs.
11. **`#262` RAM-proportional `LoadControl` & opt-in `TextureView` fallback:** Scale non-low-RAM `targetBufferBytes` proportionally to `totalMemBytes / 18` (clamped cleanly per preset while keeping low-RAM strictly capped at `16 MiB`); add opt-in `useTextureView` (`false` default, persisted in preferences) on `Media3SurfaceView` with clean `Surface` lifecycle release in `onSurfaceTextureDestroyed` and identical `ZapShutter`/`SubtitleView`/`SurfaceFit` layout.
12. **`#266` `SmartOrientationListener`, `statusBars` fullscreen check & PiP aspect clamping:** Configure `supportsPictureInPicture` on non-TV `MainActivity` (`withAndroidDisplay`), add `SmartOrientationController` (sensor-guided orientation release, disabled on touch-lock and destroy), check `!insets.isVisible(WindowInsetsCompat.Type.statusBars())` (never `systemBars()`), clamp PiP aspect ratio strictly to `[0.418410, 2.390000]` (fallback `16:9`), suppress `AppState` `'background'` stream teardown while in PiP, and hide OSD/lock overlays during PiP.

---

## 2. Shared Cross-Component Contracts (Pinned Signatures)

### 2.1 Kotlin Internal Contracts (`io.github.fatihmutluu.elv.media3`)

1. **`LoadControlConfig.kt`:**
   - `enum class BufferPreset(val wireName: String) { AUTO("auto"), BALANCED("balanced"), LARGE("large") }` + `fun parseBufferPreset(raw: String?): BufferPreset`
   - `enum class StreamKind { RAW_TS_LIVE, HLS_LIVE, VOD }`
   - `fun loadControlForStream(isLowRamDevice: Boolean, totalMemBytes: Long, streamKind: StreamKind, preset: BufferPreset = BufferPreset.AUTO): LoadControlValues`
   - Keep `loadControlFor(lowRam: Boolean, live: Boolean = false)` and `loadControlForMemory(isLowRamDevice: Boolean, totalMemBytes: Long, live: Boolean = false)` as backward-compatible wrappers.
2. **`LoadRequest.kt`:**
   - Add `val bufferPreset: BufferPreset = BufferPreset.AUTO` on `LoadRequest`, parsed in `parseLoadArgs(args)`.
   - `internal fun LoadRequest.streamKind(): StreamKind`
3. **`PlayerFactory.kt`:**
   - `DeviceMemoryProfile.loadControl(streamKind: StreamKind, preset: BufferPreset = BufferPreset.AUTO): LoadControlValues` (plus existing `loadControl(live: Boolean)` overload).
   - `PlayerFactory` primary constructor accepts `loadControlForStream: (StreamKind, BufferPreset) -> LoadControlValues` and `deviceQuirks: DeviceQuirks = DeviceQuirks.fromBuild()` (keeping existing secondary constructors intact for backwards compatibility!).
   - `PlayerFactory.build(softwareAudio: Boolean, preferHevcOverDolbyVision: Boolean = false, live: Boolean = false, streamKind: StreamKind = if (live) StreamKind.HLS_LIVE else StreamKind.VOD, bufferPreset: BufferPreset = BufferPreset.AUTO): ExoPlayer`
4. **`CodecPolicy.kt`:**
   - `internal data class DeviceQuirks(val manufacturer: String, val brand: String, val model: String, val hardware: String, val board: String, val socModel: String)` with `companion object { fun fromBuild(): DeviceQuirks }`
   - `CodecPolicy.supportsHardwareHevc4k: Boolean` (volatile, defaults `false` until probe finishes)
   - `CodecPolicy.startHardwareHevc4kProbe(handler: Handler)` (runs `MediaCodecList` query on `handler`, never synchronously on caller/UI thread).
5. **`SubtitleSanitizer.kt`:**
   - `internal fun sanitizeSubtitleText(text: CharSequence): CharSequence`
   - `internal fun sanitizeCues(cues: List<Cue>): List<Cue>`
6. **`AudioEffectsController.kt`:**
   - `internal class AudioEffectsController(private val handler: Handler, ...)`
   - `fun setBoostDb(db: Double)`
   - `fun onAudioSessionIdChanged(sessionId: Int)`
   - `fun onTracksChanged(tracks: Tracks)`
   - `fun onStop()`
   - `fun release()`

### 2.2 TypeScript Bridge & Preferences Contracts

- **`@elv/domain`:**
  - `export type BufferPreset = 'auto' | 'balanced' | 'large';`
  - `export const BUFFER_PRESETS = ['auto', 'balanced', 'large'] as const;`
  - `PreferencesSnapshot` adds `readonly bufferPreset: BufferPreset` (default `'auto'`) and `readonly useTextureView: boolean` (default `false`), keeping `PREFERENCES_SCHEMA_VERSION = 1` backward-compatible.
- **`@elv/playback`:**
  - `LoadOptions` & `NativeLoadCommand` add `bufferPreset?: BufferPreset`.
  - `TuneRequest` adds `bufferPreset?: BufferPreset`.
  - `PlaybackState` adds `readonly surfaceRecreationToken: number` (starts at `0`, increments only on Rung 3 `recreate` after `decoder` error).
  - `PlayerEngine` & `NativeEngineHandle` & `PlaybackService` add optional `setScrubbing?(...)`.
  - `RecoveryConfig` adds `rollingRebufferThreshold: number` (default `3`) and `rollingRebufferWindowMs: number` (default `120_000`).
- **`@elv/engine-media3` (`src/index.ts`):**
  - `Media3SurfaceProps` adds `surfaceRecreationToken?: number` and `useTextureView?: boolean`.
  - Exports `subscribeAndroidStandby`, `applyAndroidShortEdgesCutoutMode`, `getAndroidSafeAreaInsets`, `subscribeAndroidSafeAreaInsets`, `enterAndroidPictureInPicture`, `subscribeAndroidPictureInPicture`, `requestTemporaryOrientation` (all safe no-ops when native module absent).
- **`@elv/features`:**
  - `VideoSurfaceProps` adds `surfaceRecreationToken?: number` and `useTextureView?: boolean`.
  - `OpenVideoEngine` adds optional `enterPictureInPicture?: (aspectWidth?: number, aspectHeight?: number) => boolean` and `onPictureInPictureChange?: (listener: (inPip: boolean) => void) => () => void`.

---

## 3. Verification Strategy

- **Strict TDD (`RED -> GREEN -> REFACTOR`):** Every behavior covered by failing unit tests first across Kotlin (Robolectric/JUnit) and TypeScript (Vitest/Jest).
- **Android Native Gate:** `./gradlew.bat :elv-engine-media3:testDebugUnitTest :elv-engine-media3:assembleRelease` in `apps/tv-mobile/android`.
- **Monorepo Gate:** `pnpm check` (`11 passed, 0 failed`).
- **Independent Whole-Branch Code Review:** `Gemini 4 Neon (High)` (`VERDICT: PASS`) before opening PR.
