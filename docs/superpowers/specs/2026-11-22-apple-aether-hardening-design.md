# Apple AetherEngine, tvOS Focus/Tiering & Cross-Platform Audio/Buffer Hardening

**Date:** 2026-11-22  
**Branch:** `fix/apple-aether-hardening`  
**Issues:** `#426`, `#427`, `#441`, `#186`, `#187`, `#442`

---

## 1. Goal & Scope

Harden `@elv/engine-aether`, tvOS focus/hit-testing/hardware tiering (`@elv/ui-kit`, `@elv/features`, `apps/tv-mobile`), `@elv/playback` native bridge, and Android Bluetooth audio route detection (`@elv/engine-media3`) across 6 issues:

1. **`#426` Background `surface-lost` race elimination:** Decouple iOS/tvOS background transitions (`UIApplication.didEnterBackgroundNotification`) from fatal `"surface-lost"` errors in `EngineCore.surfaceChanged(available:isBackground:)` so `AppState` `'background'` -> `svc.stop()` never races a fatal error while keeping true foreground surface destruction on the existing `"surface-lost"` recovery path.
2. **`#427` `AVAudioSession` playback category & headphone disconnect pause:** Configure `AVAudioSession` (`.playback`, `.moviePlayback`, `setSupportsMultichannelContent(true)`, `setActive(true)`) on playback start and deactivate with `.notifyOthersOnDeactivation` on stop/dispose; replace the racy 1,500 ms `systemPauseUntilUptimeMs` window with `AudioSessionPolicy` (handling interruption `.began`/`.ended` with `.shouldResume`, and pausing immediately + latching `.systemPaused` on `.oldDeviceUnavailable` so delayed `.paused` callbacks never auto-resume over speakers).
3. **`#441` Apple `AetherEngine` core fixes:**
   - Switch `MediaPlan` / `EngineLoadOptions` `displayCriteriaOwner` default to `.engine` so tvOS Match Frame Rate / Dynamic Range works immediately.
   - Serialize `selectAudioTrack` against ALL queued `seekTask` replacements via a `while let pendingSeek = self.seekTask` loop.
   - Replace `LiveTsReader`'s one-shot `reconnectedOnce` boolean with a time-windowed reconnect budget (`maxReconnectsInWindow = 3`, `reconnectWindowSeconds = 60.0`, stable streaming reset `30.0 s`) using injectable monotonic clock.
   - Capture `target.errorInfo` and `currentReader?.lastFailure` synchronously when `$state == .error` fires and fence under `engineLoadSerial > 0 ? engineLoadSerial : activeLoadSerial` so rapid `stop()`/`load()` or pre-open failures never drop or read stale errors.
4. **`#186` tvOS idle `TvFocusAnchor`, decorative artwork hit-test guard & 3 GB Apple TV 4K tiering:**
   - Mount `TvFocusAnchor` in `AppShell` boot canvas, `App.tsx` pending gate view, `PlayerGateScreen` idle fallback, and replace inline anchors in `PlayerScreen` and `BrowseParts`.
   - Add `decorative?: boolean` (`pointerEvents="none"`, `accessible={false}`, `accessibilityElementsHidden`, `importantForAccessibility="no"`) to `ArtworkImage` and apply to decorative backdrops in `HomeHero`, `DetailHero`, and `LiveWatchStage`.
   - Expose Apple machine identifier (`ElvEngineAether.deviceModel()`) via `uname` / `SIMULATOR_MODEL_IDENTIFIER`, classify `AppleTV5,*` (2 GB) and `AppleTV6,*` (3 GB) as `'mid-power'` via `resolveAppleHardwareTier`, and disable heavy blur (`renderBlur`) on mid-power Apple TV hardware.
5. **`#187` `AVPlayer` buffer-empty precedence & Android API 33+ Bluetooth audio route detection:**
   - Evaluate `AVPlayerItem.isPlaybackBufferEmpty` strictly BEFORE `isPlaybackBufferFull || isPlaybackLikelyToKeepUp` (and respect `AVPlayer.timeControlStatus == .waitingToPlayAtSpecifiedRate` for `.toMinimizeStalls` / `.evaluatingBufferingRate`) via pure `evaluateAVPlayerBuffering` wired to KVO in `AetherBackend+Subscriptions`.
   - Add `AudioRouteDetector` in `@elv/engine-media3` using `AudioManager.getAudioDevicesForAttributes(STREAM_AUDIO_ATTRIBUTES)` on API 33+ (falling back to `GET_DEVICES_OUTPUTS` on API 28–32) and matching strictly BT audio sink types (`A2DP`, `SCO`, `BLE_HEADSET`, `BLE_SPEAKER`, `BLE_BROADCAST`) so BT HID remotes are never misclassified as BT audio outputs.
6. **`#442` Apple `AetherEngine` parity (`setRate()`, `MACaptionAppearance` + VoiceOver, hidden-OSD Combine throttle):**
   - Wire `setSpeed(attempt, rate)` across `NativeEngineHandle` -> `bridgeNativeEngine` -> `ElvEngineAetherModule` -> `EngineObject` -> `EngineCore` (clamped `[0.25, 4.0]`, VOD-only, reset to `1.0` on `load`/`retry`/`stop`/`recreate`/`release`, propagated into `ClockAnchorOut.rate`) -> `AetherBackend` -> `AetherEngine.setRate(Float(rate))`.
   - Resolve system caption styling via `MediaAccessibility` (`MACaptionAppearanceCopyForegroundColor`, `BackgroundColor`, `WindowColor`, `GetRelativeCharacterSize`, `CopyFontDescriptorForStyle`) refreshed on `kMACaptionAppearanceSettingsChangedNotification` + `didBecomeActiveNotification`, plus deduplicated VoiceOver cue announcements (`UIAccessibility.post(notification: .announcement, ...)`).
   - Eliminate per-frame `@MainActor` Combine churn when subtitles are inactive/empty and throttle `clock.$currentTime` emissions to coarse `5.0 s` ticks via `OsdClockThrottle` when `osdVisible == false` (wired from `PlayerScreen` -> `VideoSurfaceProps` -> `AetherSurface`).

---

## 2. Shared Cross-Component Contracts (Pinned Swift & TS Signatures)

### 2.1 `ElvAetherCore` (Swift 6, `Foundation`-only) -> `Engine/` Contracts
- `EngineCore.surfaceChanged(available: Bool, isBackground: Bool = false)`
- `EngineCore.setSpeed(_ attempt: Int, rate: Double)` + `EngineCore.setOsdVisible(_ visible: Bool)`
- `PlayerBackend`: adds `func setRate(_ rate: Double)` and `func setOsdVisible(_ visible: Bool)`
- `AudioSessionPolicy`: `handleInterruptionBegan(currentlyPlaying:)`, `handleInterruptionEnded(shouldResume:)`, `handleOldDeviceUnavailable(isRemovedAudioRoute:)`, `clearRoutePauseOnExplicitPlay()`
- `evaluateAVPlayerBuffering(isPlaybackBufferEmpty:isPlaybackBufferFull:isPlaybackLikelyToKeepUp:isWaitingToPlay:waitingToMinimizeStallsOrEvaluating:isUserPaused:) -> Bool`
- `CaptionAppearanceColor`, `CaptionAppearanceStyle`, `CaptionAppearanceSource`, `resolveCaptionAppearance(source:)`, `VoiceOverAnnouncementDeduper`
- `OsdClockThrottle(hiddenIntervalSeconds: Double = 5.0)` with `setOsdVisible(_:)`, `shouldEmit(nowSeconds:rate:isPlaying:) -> Bool`, `reset()`

### 2.2 `ElvEngineAetherModule` <-> TypeScript (`@elv/engine-aether`) Contracts
- `Engine` class: `Function("setSpeed") { engine, attempt: Int, rate: Double -> ... }`
- Module: `Function("deviceModel") -> String`
- `AetherSurfaceView`: `Prop("osdVisible") { view, visible: Bool? -> ... }`

---

## 3. Verification Strategy
- **Swift 6 CoreTests (on `elv-mac`):** `swift test --package-path modules/engine-aether/ios` (all existing + new unit tests green).
- **Apple Xcode Compile (on `elv-mac`, `. ~/.elv/env.sh`, `'AC Power'`, `caffeinate -dimsu`):** iOS + tvOS Simulator compile verifying `Engine/` compiles cleanly against `AetherEngine 7.66.1`, `MediaAccessibility`, `AVFoundation`, `UIKit`, `ExpoModulesCore`.
- **Android Gradle:** `:elv-engine-media3:testDebugUnitTest` verifying `AudioRouteDetectorTest` (`#187`).
- **Monorepo Gate:** `pnpm check` (`11 passed, 0 failed`).
- **Independent Whole-Branch Review:** `Gemini 4 Neon (High)` (`VERDICT: PASS`).
