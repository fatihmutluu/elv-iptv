# Wave F7A — Display AFR/HDR, Desktop Audio Passthrough, Android Night-Mode DRC & Per-Refresh-Rate Delay, and Media3 DRM

**Date:** 2026-11-25  
**Issues:** `#116`, `#188`, `#199`, `#214`, `#213`, `#115`, `#272`  
**Workstream:** `cluster:android-media3`, `cluster:apple-aether`, `cluster:desktop-mpv`, `cluster:subtitles-audio`  
**Design Alignment:** Cinema Quietude v2 (`docs/design/UI_UX_PHILOSOPHY.md`), Zero-Credentials-in-SQLite, LGPL-only native binaries.

---

## 1. Goals & Scope

1. **Auto Frame-Rate (AFR) & HDR Display Switching (`#116`, `#188`, `#199`, `#214`):**
   - Preferences (`@elv/domain`): `autoFrameRate: 'off' | 'seamless' | 'always'` (default `'seamless'`), `autoDynamicRange: boolean` (default `true`).
   - `@elv/playback`: `display-sync.ts` standard cinema/broadcast FPS snapping (`23.976, 24, 25, 29.97, 30, 50, 59.94, 60`), refresh-rate bucket mapping, and per-refresh-rate effective A/V delay resolver.
   - **Android Media3 (`#199`, `#116`):** `PtsFrameRateEstimator.kt` (`VideoFrameMetadataListener` 24–60 frame PTS delta snapping when `format.frameRate == Format.NO_VALUE`) + `DisplayRefreshController.kt` (`Display.supportedModes` matching + `preferredDisplayModeId` apply/restore + seamless/always policy).
   - **Apple Aether / tvOS (`#188`, `#116`):** Pure Swift `DisplaySyncPolicy.swift`, `AetherLoadOptions` (`displayMatchFrameRate`, `displayMatchDynamicRange`), tvOS `AVDisplayCriteria` switching preserving `resetDisplayCriteria: false` across live zaps and restoring on `dispose()` / disable, shutter-guarded against HDMI resync blink.
   - **Desktop mpv (`#214`, `#116`):** `video-sync=display-resample` when AFR is active + fullscreen display-mode refresh controller (`apps/desktop/src/main/player/display-refresh.ts`) with guaranteed restore on stop/exit/`will-quit`.
2. **Desktop Audio Passthrough (`#213`):**
   - Preferences (`@elv/domain`): `audioPassthrough` (default `false`), `audioPassthroughCodecs` (`ac3|eac3|dts|dts-hd|truehd`, default `['ac3','eac3','dts']`), `audioExclusive` (default `false`), `audioAc3Encode` (default `false`), `audioChannelLayout` (`'auto'|'stereo'|'5.1'|'7.1'`, default `'auto'`).
   - Desktop mpv: map to `--audio-spdif`, `--audio-exclusive`, `--audio-channels`, conditional `@ac3:lavcac3enc` (keeping `@elv_loudnorm` disabled whenever SPDIF or AC3 encode is active) + safe automatic fallback on AO/SPDIF open error.
3. **Android Night-Mode DRC & Per-Refresh-Rate A/V Delay (`#115`):**
   - Preferences (`@elv/domain`): `nightModeDrc: 'off' | 'light' | 'night'` (default `'off'`), `audioDelayByRefreshRateMs: Record<string, number>` (default `{}`, canonical refresh buckets, clamped `[-1000, 1000]` ms).
   - Android `AudioEffectsController.kt`: API 28+ `DynamicsProcessing` multi-band compressor + limiter presets (`off`/`light`/`night`) bound to `audioSessionId` (guarded against HAL failures and multichannel passthrough, cleanly released on session change/dispose).
   - Effective A/V delay = `baseAudioDelayMs + refreshRateOffsetMs` applied via `OffsetForwardingAudioSink` whenever display FPS settles.
4. **Media3 DRM ClearKey / Widevine / PlayReady (`#272`):**
   - `@elv/sources`: Parse `#KODIPROP:inputstream.adaptive.license_type` (`clearkey`/`org.w3.clearkey`, `widevine`/`com.widevine.alpha`, `playready`/`com.microsoft.playready`) & `license_key` (inline `kid:key` pairs, JWK JSON, or remote `http(s)://` URL + headers).
   - `@elv/data` (`SCHEMA_VERSION = 19`): Non-secret `item_drm_meta(source_id, item_key, scheme)` SQLite table + sharded `SecretStore` (`source.<id>.drm_specs`, `<= 60 KB` shards) storing all license URLs, headers, and ClearKey pairs strictly outside SQLite! Resolved at play time onto `StreamRequest.drm` (omitted when absent).
   - Android Media3 (`DrmConfigBuilder.kt`, `LoadRequest.kt`, `MediaSources.kt`): `LocalMediaDrmCallback` (EME ClearKey JWK) & `HttpMediaDrmCallback` (Widevine / PlayReady / remote ClearKey using `StreamHttp` factory) + `FrameworkMediaDrm` L1/L3 capability probe, zero logging of keys/headers/URLs.

---

## 2. Security & Quality Invariants

- **Zero DRM secrets in SQLite or logs:** ClearKey `kid:key`, license URLs, and license headers live strictly in `SecretStore` and are never logged or written into SQLite tables.
- **No silent audio failure on desktop passthrough:** AO/SPDIF init failures fall back cleanly to PCM (`audio-spdif=""`, `audio-exclusive="no"`).
- **Display mode restore guarantee:** Both Android (`preferredDisplayModeId = 0`), tvOS (`resetDisplayCriteria = true` on dispose), and Desktop (`will-quit` / stop) always restore the original display mode.
- **UI craft:** Cinema Quietude v2 tokens, zero hardcoded hex colors, zero RN `<Modal>`, 100% EN/TR i18n parity, `<= 800` lines/file, `>= 90%` line coverage in pure packages.
