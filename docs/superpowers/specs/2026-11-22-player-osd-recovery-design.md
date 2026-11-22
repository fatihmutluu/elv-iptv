# Player OSD, Recovery Watchdogs, Subtitles, Touch Scrubbing & Dolby Vision Fallback Spec

**Date:** 2026-11-22  
**Issues:** `#421`, `#433`, `#314`, `#321`, `#136`, `#440`, `#189`  
**Packages:** `@elv/domain`, `@elv/playback`, `@elv/ui-kit`, `@elv/features`, `@elv/engine-media3`, `@elv/engine-aether`, `@elv/tv-mobile`, `@elv/desktop`  
**Status:** Accepted

## 1. Goals

Harden end-to-end playback recovery, watchdogs, native decoder/subtitle behavior, and Cinema Quietude player UX across mobile, tablet, TV, and desktop:

1. **Playback recovery & live-flag reset (`#433`):**
   - Reset single-use live recovery flags (`liveCleanEndRetried`, `liveFrozenResetTried`) in `packages/playback/src/recovery.ts` after `stableRestoreMs` (30 s) of healthy playing, and ensure `watchdog.onPlaying(...)` arms the stable-restore timer whenever `isBudgetUsed(...) || liveCleanEndRetried || liveFrozenResetTried` (so long-running live streams that recovered once can recover again hours later).
   - Ensure full Rung-4 alternate loop traversal (including failed alternate resolvers advancing cleanly to the next alternate before container fallback / `giveUp()`).

2. **Byte-progress-aware VOD start timeout & panel refusal coverage (`#314`):**
   - Preserve verified HTTP `458` / `460–463` / `469` -> `'connection-limit'` mapping across JS, Media3, Aether, and desktop `mpv`.
   - Add `{ type: 'progress'; bytesReceived?: number; atMs: number }` to `EngineEvent` (clock-mapped in `native-bridge.ts`).
   - While `status.kind === 'tuning'` on VOD, active byte-transfer progress extends the VOD start deadline in bounded increments up to a hard ceiling (`vodStartMaxTimeoutMs`, default `30_000` ms) so slow progressive opens / trailing `moov` atoms complete without false timeouts while dead sockets still fail within `startTimeoutMs` (`8_000` ms).
   - Emit throttled transfer progress events during `tuning` from Media3 (`TransferListener`), Aether, and desktop `mpv` (`demuxer-cache-state`).

3. **Zero-decoded-frame black-screen watchdog & network-aware stall deferral (`#321`):**
   - Add optional `decodedVideoFrames?: number` and `hasVideoTrack?: boolean` to `ClockAnchor`.
   - In `stall-watchdog.ts`:
     - **Zero-decoded-frame watchdog:** When a video stream (`hasVideoTrack === true`) is actively playing with advancing `positionMs` (`rate > 0`) while `decodedVideoFrames === 0` across `zeroFrameWindowMs` (default `liveStallWindowMs` = `4_000` ms), trigger decoder recovery (`ladder.escalate({ code: 'decoder' }, true)`).
     - **Bounded network-aware stall deferral:** During a mid-stream `stall`, if recent `progress` events arrived within `liveStallWindowMs`, defer stall escalation up to `maxStallDeferrals` (default `3`) before escalating, preventing premature socket teardown during heavy rebuffering while keeping failure strictly bounded.
   - Wire frame-count and network-activity telemetry in Media3 (`EventReporter.kt` / `Media3Engine.kt`) and desktop `mpv` (`live-session.ts` / `derive.ts`).

4. **Dolby Vision Profile 7 -> 8.1 / HEVC fallback & whole-word ISO 639-2(T+B) parity (`#189`):**
   - Sync missing ISO 639-2(T+B) codes (`bod`/`tib`, `mya`/`bur`, etc.) across `packages/domain/src/languages.ts`, `modules/engine-media3/.../TrackInspection.kt`, and `modules/engine-aether/ios/Core/TrackLanguage.swift`, adding explicit anti-substring tests (`"es"` never matches `"Chinese"`/`"Japanese"`, `"ger"`/`"deu"` -> `"de"`, `"fre"`/`"fra"` -> `"fr"`).
   - Add optional `preferHevcOverDolbyVision?: boolean` on `LoadOptions` / `NativeLoadCommand` and Dolby Vision Profile 7 (`dvhe.07`/`dvh1.07`) fallback handling:
     - On Media3 (`CodecPolicy.kt` + `Media3Engine.kt`): detect Profile 7 streams on unsupported displays/decoders or DV video decoder init/decode failure and fall back cleanly to Profile 8.1 / HEVC (`VIDEO_H265`) base-layer decoding instead of failing with black screen or fatal decoder error.
     - On Apple Aether (`ErrorMapping.swift` + `EngineCore.swift`): map Dolby Vision hardware-only failures on eligible fallback paths to recoverable `'decoder'` when HEVC fallback has not been tried yet, enabling seamless fallback rather than immediate terminal `'unsupported-format'`.

5. **OSD auto-hide, touch tap-to-toggle, desktop cursor hide & `Space` guard (`#421`):**
   - Default `autoHideOsdMs` (3,500 ms) in `AppShell` / `PlayerScreen` so the auto-hide timer actually runs in production (still overridable via prop for tests).
   - Add single-tap video-canvas OSD toggle on touch (`phone` / `tablet`, disabled while `locked`, modal open, `failed`, `paused`, or `ended`, and guarded against swipe/scrub gestures).
   - Add `10 px` pointer-move deadzone (`touch-hover-guard.ts`) and desktop idle cursor hiding (`cursor: none` when OSD hides during playback).
   - Handle `Space` / `Spacebar` cleanly on desktop web (`useDesktopPlayerShortcuts.ts` + `web-keys.ts` coordination) so `Space` toggles play/pause exactly once without activating a `Tab`-focused non-modal OSD button (and never fires inside editable inputs or open modals).

6. **Input hotkey guard & subtitle lift above visible OSD (`#136`):**
   - Suppress browser context menu on `PlayerScreen` desktop canvas (`onContextMenu`) and ensure all global player hotkeys (including `Space`/`Backspace`) stay strictly ignored inside editable inputs and IME composition.
   - Propagate `subtitleBottomInsetPx` through `VideoSurfaceProps` -> `PlayerSurface` -> `Media3Surface` (`SubtitleView.setBottomPaddingFraction(...)`) and `AetherSurface` (`AetherSubtitleOverlayView` / `SubtitleLayout.placeSlotPill` bottom inset) whenever the mobile/TV OSD is visible, resetting to `0` when OSD hides.

7. **Browse focus preservation, `resizeMode` wiring, touch-lock orientation & touch drag scrubbing (`#440`):**
   - Preserve TV browse focus coordinates across `PlayerScreen` mount/unmount via a lightweight focus-restoration store (`BrowseFocusMemoryProvider` in `AppShell`) read/updated by `HomeScreen`, `LiveScreen`, `CatalogDiscoveryScreen`, `DetailScreen`, and `SearchScreen`.
   - Wire `resizeMode` (`'fit' | 'fill'`) through `VideoSurfaceProps`, `apps/tv-mobile/src/App.tsx`, `PlayerSurface`, and a clean Fit/Fill toggle inside `PlayerSettingsSheet` (aligned with Cinema Quietude v2 — zero extra clutter on the primary playback bar).
   - Expose native Android orientation lock (`ElvEngineMedia3Module.setOrientationLocked(locked)` using `SCREEN_ORIENTATION_LOCKED` / `SCREEN_ORIENTATION_UNSPECIFIED`, bridged via `OpenVideoEngine.setOrientationLocked`) and call it on touch lock/unlock + guarantee unlock on unmount or target change.
   - Add native touch drag scrubbing (`PanResponder` / responder lifecycle) with floating timecode preview pill and single coalesced seek commit on release to `VodProgressBar.tsx` for phone/tablet (`!isWeb && !isTv`).

## 2. Invariants & Verification

- Pure packages (`@elv/domain`, `@elv/playback`) keep `>= 90%` line coverage and zero forbidden imports.
- All UI changes follow `docs/design/UI_UX_PHILOSOPHY.md` (Cinema Quietude v2, zero-blink, zero extra primary-bar clutter).
- `pnpm check` passes (`0 failed`), plus Kotlin/Android unit tests where available on Windows.
