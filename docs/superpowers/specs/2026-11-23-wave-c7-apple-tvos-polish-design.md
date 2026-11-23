# Wave C7 — Apple iOS & tvOS Native Polish Design (`#413`, `#414`, `#225`, `#85`)

- **Date:** 2026-11-23
- **Issues:** `#413`, `#414`, `#225`, `#85`
- **Epics closed upon merge:** `#339` (Apple AetherEngine), `#341` (Focus & Remote)
- **Design philosophy:** Cinema Quietude v2 (`docs/design/UI_UX_PHILOSOPHY.md`) — zero-blink, zero hardcoded hex, `reduceMotion` compliance, 3 GB Apple TV memory bounds (`mid-power` tier).

## 1. `#413` — Apple `MPNowPlayingInfoCenter`, `MPRemoteCommandCenter` & Background Audio Mode

### Architecture
- `AetherEngine` `7.66.1` exposes opt-in `owns*NowPlaying` flags (all `false` by default) and `backgroundPlaybackEnabled`. Keeping `AetherEngine`'s built-in Now Playing flags `false` ensures `EngineCore` stays the single source of truth for `userPaused`, attempt tokens, clock anchors, playback speed, and JS `PlaybackService` synchronization.
- **Pure Foundation policy (`modules/engine-aether/ios/Core/NowPlayingPolicy.swift`):**
  - `NowPlayingMetadata` (`title`, `subtitle`, `artworkUrl`, `isLive`, `canStepTrack`) and `NowPlayingPlaybackState` (`isActive`, `isPlaying`, `isLive`, `rate`, `positionSeconds`, `durationSeconds`).
  - `sanitizeNowPlayingArtworkUrl(_:)`: allows only `http`/`https`, strips `user`/`password` URL components, strips or rejects URLs with credential query parameters (`username`, `password`, `token`, `auth`, `pass`, `user`, `key`, `apikey`, `api_key`, `access_token`).
  - `NowPlayingPolicy`: computes `NowPlayingCommandCapabilities` (live streams disable seek/skip/rate commands; `nextTrack`/`previousTrack` enabled only when `canStepTrack == true`; idle/stopped disables every command and clears snapshot to `nil`), and throttles routine clock refreshes (`>= 5 s` unless state/metadata/rate changed or position jumped `>= 1.5 s`).
- **Native MediaPlayer bridge (`modules/engine-aether/ios/Engine/AetherNowPlayingBridge.swift`):**
  - `@MainActor` bridge over `MPNowPlayingInfoCenter.default()` and `MPRemoteCommandCenter.shared()`.
  - Registers all command targets (`play`, `pause`, `togglePlayPause`, `stop`, `skipForward`, `skipBackward`, `changePlaybackPosition`, `changePlaybackRate`, `nextTrack`, `previousTrack`) with `[weak self]`, stores every `(MPRemoteCommand, Any)` token, initializes every command `isEnabled = false`, and explicitly removes every target + clears `nowPlayingInfo = nil` on `dispose()` (zero retain cycles or leaked targets).
  - Routes transport commands (`play`/`pause`/`togglePlayPause`/`seek`/`skip`/`setSpeed`) through `EngineMainDriver` -> `EngineCore`, and routes `nextTrack`/`previousTrack`/`stop` via `EngineObject` `"onRemoteMediaAction"` event (`'next' | 'previous' | 'stop'`) -> `apps/tv-mobile/src/App.tsx` `onHostKey` (`'channel-up' | 'channel-down' | 'stop'`), matching Android Media3 parity.
  - Fetches sanitized artwork off `@MainActor` with a 4 MiB byte cap and generation-token cancellation on channel zap, stop, or dispose.
- **Background audio mode:**
  - `apps/tv-mobile/config/build-app-config.ts`: add `UIBackgroundModes: ['audio']` to `ios.infoPlist` ONLY when `!tv` (iOS/iPadOS mobile builds; omitted on tvOS builds).
  - `AetherBackend`: default `backgroundAudioEnabled = false` (single-connection IPTV safety). `setBackgroundAudioEnabled(_:)` updates live `engine?.backgroundPlaybackEnabled` and persists across `installFreshEngine()`. `AVAudioSession` remains `.playback`/`.moviePlayback` while background audio is active and deactivates cleanly on `stopMedia()`/`dispose()`.

## 2. `#414` & `#225` — Native tvOS `UIPress`/`UITouch` Remote Forwarding, Directional Pan Disambiguation & 500ms Ambient Backdrop

### Native Apple Remote Keys & Directional Pan (`modules/remote-keys/`)
- Enable Apple platform autolinking in `modules/remote-keys/expo-module.config.json` (`"platforms": ["android", "apple"]`, `"apple": { "modules": ["ElvRemoteKeysModule"] }`) and add `modules/remote-keys/ios/ElvRemoteKeys.podspec` (`:ios => '18.0', :tvos => '18.0'`) plus Swift 6 SPM `Package.swift` for `Core/` + `CoreTests/`.
- **Pure Foundation core (`modules/remote-keys/ios/Core/`):**
  - `TvPressKeyMap.swift`: maps Apple `UIPress.PressType` kinds (`upArrow`, `downArrow`, `leftArrow`, `rightArrow`, `select`, `menu`, `playPause`, `pageUp`, `pageDown`) to our canonical key codes (`19, 20, 21, 22, 23, 4, 85, 92, 93`) and tracks held keys to deduplicate downs, ignore orphan ups, and emit blur cancellations on resign-active.
  - `DirectionalPanPolicy.swift`: locks initial Siri Remote touch-surface pan axis (`horizontal` vs `vertical`) after clearing deadzone (`18 pt`) with a `1.35×` dominance ratio; once locked, orthogonal movement is ignored so horizontal timeline scrubbing never opens drawers and vertical drawer swipes never trigger accidental seeks; suppressed completely when `isEnabled == false`.
- **Native Expo module (`modules/remote-keys/ios/Apple/ElvRemoteKeysModule.swift`):**
  - Compiles cleanly on both iOS (safe no-op) and tvOS (`#if os(tvOS)`).
  - Under `#if os(tvOS)`: installs a non-consuming `TvPressObserverGestureRecognizer` (`cancelsTouchesInView = false`, simultaneous recognition) on the key `UIWindow` while `onKey` is observed, emitting real `down`/`up`/`canceled` phases with `systemUptime * 1000`, plus `blur` on `UIApplication.willResignActiveNotification`.
  - Under `#if os(tvOS)`: installs an indirect-touch `TvDirectionalPanGestureRecognizer` driven by `DirectionalPanPolicy`, disabled by default and enabled via `setPanGestureEnabled(true)` strictly when the player is active with no overlay/sheet open, emitting `"onPanGesture"` (`{ axis, phase, translation, velocity }`).
- **JS integration:**
  - `packages/ui-kit/src/tv/remote-dispatcher.ts`: use native `raw` (`ElvRemoteKeys`) `down`/`up`/`cancel`/`blur` source on `Platform.OS === 'ios' && Platform.isTV` while keeping `retainTvMenuKey()` active (and without dual-subscribing `TVEventHandler`).
  - `packages/features/src/ports/video-host.ts` + `packages/features/src/player/useTvPanGesture.ts`: enable `setTvPanGestureEnabled` only during unobstructed TV playback; horizontal locked pans drive VOD preview-scrub (`onScrubPreview`/`onScrubCommit`/`onScrubCancel`); vertical locked pans open Info (downward) or Channel Drawer (upward) without seeking.

### 500ms-Debounced Ambient Backdrop (`packages/features/src/shared/AmbientBackdrop.tsx`)
- Renders a full-bleed ambient artwork backdrop behind TV browse rails (`HomeScreen` when focused on rails below the hero; `CatalogDiscoveryScreen` for Movies & Series).
- Debounces focus changes by `500 ms` (`AMBIENT_BACKDROP_DEBOUNCE_MS = 500`), cancelling pending timers during rapid D-pad navigation so intermediate cards never trigger image loads or crossfade churn.
- Crossfades smoothly over `320 ms` (`useNativeDriver: Platform.OS !== 'web'`) at subtle ambient cinema opacity behind `<Scrim>` / `theme.colors.bgCanvas`.
- Honors `theme.reduceMotion` and 3 GB `mid-power` Apple TV memory tier (`lowPowerTier`: instant single-layer swap, `maxDecodePx={640}`, zero simultaneous dual-layer decode).

## 3. `#85` — AetherEngine Toolchain Re-Check Record
- Tested newest upstream tag `AetherEngine 7.73.0` (`bbcf3b8359252b361258dc79817c4f81683df7b8`) on `2026-11-23` using `Xcode 26.4.1 (17E202)` / `Apple Swift 6.3.1` across all 3 required targets (`tvOS Simulator`, `tvOS` device, `iOS Simulator`, `Release` config).
- All 3 targets fail deterministically at `Sources/AetherEngine/Diagnostics/PerFrameBenchmark.swift:374:16` (`error: the compiler is unable to type-check this expression in reasonable time`).
- Pin remains `7.66.1`; findings recorded in `docs/adr/0003-playback-engines.md`, `docs/superpowers/specs/2026-11-14-player-core-design.md`, and GitHub issue `#85`.
