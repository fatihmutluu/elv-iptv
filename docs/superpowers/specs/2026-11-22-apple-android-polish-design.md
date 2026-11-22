# Apple & Android Platform Polish Design Spec (`#79`, `#234`, `#415`, `#411`)

- **Date:** 2026-11-22
- **Issues:** `#79`, `#234`, `#415`, `#411`
- **Design Language:** Cinema Quietude v2 (`docs/design/UI_UX_PHILOSOPHY.md`)
- **Related ADR:** [ADR 0014: Persistent User Data Storage on tvOS and iOS](../../adr/0014-tvos-user-data-persistence.md)

## 1. Goals & Scope

Complete the final platform polish wave across Apple (`iOS`, `iPadOS`, `tvOS`) and Android (`Android`, `Android TV`, `Fire OS`):

1. **`#79` — Persist user data on tvOS hardware:** Preserve favorites, watch progress, and forward-compatible local profile metadata across `Library/Caches/catalog.db` purges via iCloud `NSUbiquitousKeyValueStore` (`900 KB` ceiling) + guaranteed `NSUserDefaults` local fallback (`384 KB` ceiling), strictly keeping all credentials inside Apple Keychain.
2. **`#234` — Identify AirPlay receiver capabilities via Bonjour TXT & suspend local stall watchdog:** Probe `_airplay._tcp` Bonjour TXT `model` metadata when AirPlay is active to distinguish Apple receivers (surround passthrough) from third-party receivers (stereo AAC-LC fallback), and observe `AVPlayer.isExternalPlaybackActive` to suspend local-render stall watchdogs and display-sleep locks during AirPlay handoff.
3. **`#415` — iPadOS `UIKeyCommand` hardware keyboard shortcuts & iOS safe-area Fit-mode video insets:** Register native `UIKeyCommand` playback shortcuts on iOS/iPadOS (yielding unconditionally to focused text inputs and throttling key auto-repeat), apply `safeAreaInsets` to `AetherSurfaceView` video + subtitle framing in `fit` mode on iOS while keeping `fill` and `stretch` edge-to-edge, and supply live iOS safe-area insets to `PlayerOsd` in portrait and landscape.
4. **`#411` — Manual `Auto / Hardware / Software` video decoder preference for Android Media3:** Add a persisted `androidDecoderMode` preference in `@elv/domain`, expose it in Android Playback Settings and `PlayerSettingsSheet` (EN + TR), and wire it end-to-end through `@elv/playback` and `@elv/engine-media3` (`LoadRequest`, `CodecPolicy`, `PolicyVideoRenderer`, `PlayerFactory`, `Media3Engine`).

## 2. Detailed Design

### 2.1 `#79` — tvOS & iOS Purge-Safe User Data Persistence
- **Pure backup serializer & reconciler (`packages/data/src/user-state-backup.ts`):**
  - Export `UserDataStore` (`read(): string | undefined; write(value: string): void; maxBytes?: number;`), `DEFAULT_USER_DATA_MAX_BYTES = 393_216` (`384 KB`), `ICLOUD_USER_DATA_MAX_BYTES = 921_600` (`900 KB`), `UserDataProfileEntry`, `UserDataSnapshot`, `encodeUserDataSnapshot`, `decodeUserDataSnapshot`, `saveUserDataSnapshot`, and `reconcileUserData`.
  - Schema `v: 1` stores `{ v: 1, favorites: [...], progress: [...], profiles?: [...] }`.
  - **Credential hygiene:** Any `logo` URL containing `userinfo`, auth query keys (`username`, `password`, `token`, `auth`, `key`, `pass`, `pwd`), or non-`http(s)` scheme is dropped (`null`) prior to serialization. Credentials never leave `SecretStore` (Keychain).
  - **Deterministic byte-budget eviction:** When UTF-8 byte length exceeds `maxBytes`, preserve `profiles` first, then `favorites` (`addedAt DESC`), then `progress` ordered with unwatched in-progress items (`watched === false`, `updatedAt DESC`) ahead of completed items (`watched === true`, `updatedAt DESC`), trimming oldest overflow rows until `utf8ByteLength <= maxBytes`.
  - **Reconciliation (`reconcileUserData(db, store)`):** Runs on startup immediately after `reconcileManifest(db, manifest)`. If SQLite already contains any row in `favorites` or `watch_progress`, refreshes the snapshot via `saveUserDataSnapshot(db, store)` and returns `{ favoritesRestored: 0, progressRestored: 0 }`. When both tables are empty (cache purge), decodes `store.read()` and inserts valid favorites and progress rows inside a single SQLite transaction (`INSERT OR IGNORE`), returning restored counts.
  - **Mutation mirroring (`packages/data/src/catalog.ts`):** Optional `userData?: UserDataStore` on `CatalogDeps`. After `saveProgress`, `setWatched`, `clearProgress`, `toggleFavorite`, `setFavorite`, and `removeSource`, trigger best-effort `saveUserDataSnapshot(db, userData)`.
- **Apple native persistent KV bridge (`modules/engine-aether/ios/Engine/ApplePersistentKVStore.swift` + `ElvEngineAetherModule.swift`):**
  - Expose `readPersistentValue(key: String) -> String?`, `writePersistentValue(key: String, value: String) -> Bool`, and `persistentStorageBudgetBytes() -> Int` on `ElvEngineAether`.
  - Pure Swift entitlement/budget helper in `Core/PersistentStoreBudget.swift` + native store reading from `NSUbiquitousKeyValueStore.default` first when entitled (falling back to `NSUserDefaults.standard`) and writing to iCloud KVS (`<= 900 KB`) when entitled + always writing a byte-safe copy (`<= 384 KB`) to `NSUserDefaults.standard` so local purge recovery works offline and never breaches tvOS's `500 KB` limit.
- **App wiring (`apps/tv-mobile/src/storage/settings-store.ts` + `apps/tv-mobile/src/catalog/device.ts`):**
  - `createAppleUserDataStore(key)` delegates to `@elv/engine-aether`'s persistent KV bridge when present and falls back to React Native `Settings` (`NSUserDefaults`, `maxBytes = 393_216`).
  - `device.ts` passes `userData` on `Platform.OS === 'ios'` (key `'elv.catalog.userstate.v1'`) to `reconcileUserData(db, userData)` and `createCatalogService({ ..., userData })`.

### 2.2 `#234` — Apple AirPlay Bonjour TXT Capability Probe & Stall-Watchdog Suspension
- **Pure Swift classifier (`modules/engine-aether/ios/Core/AirPlayCapability.swift`):**
  - `parseAirPlayTxtModel(_ txt: [String: String]) -> String?` extracts trimmed `model` (case-insensitive key).
  - `classifyAirPlayReceiver(model: String?) -> AirPlayReceiverClass` maps Apple model prefixes (`AppleTV`, `AudioAccessory`, `Mac`, `iMac`, `MacBook`, `Macmini`, `MacPro`, `MacStudio`, `iPad`, `iPhone`) to `.appleSurround`, non-empty non-Apple strings to `.thirdPartyStereo`, and empty/nil to `.unknown`.
  - `AirPlayCapabilityTracker` maps active AirPlay output port names + discovered Bonjour `_airplay._tcp` TXT records to `AirPlayAudioMode` (`.surroundPassthrough` for local playback or verified `.appleSurround`, `.stereoAacLc` for `.thirdPartyStereo` or unverified AirPlay routes).
- **Native AirPlay observer (`modules/engine-aether/ios/Engine/AetherAirPlayMonitor.swift` + `AetherAudioSessionController.swift` + `AetherBackend+Subscriptions.swift`):**
  - Start `NWBrowser` (`_airplay._tcp`) lazily ONLY while an `.airPlay` route or `AVPlayer.isExternalPlaybackActive` is active; stop immediately on return to local playback, `stopMedia()`, or `dispose()`.
  - Enable `player.allowsExternalPlayback = true` and observe `player.publisher(for: \.isExternalPlaybackActive, options: [.initial, .new])`.
  - Observe `AVAudioSession.routeChangeNotification` for `.newDeviceAvailable` / `.categoryChange` / `.oldDeviceUnavailable` to inspect current `.airPlay` port name and update `audioSessionController.setMultichannelEnabled(mode == .surroundPassthrough)`.
  - Emit `BackendObservation.externalPlayback(active: Bool)` -> `EngineCore` (`externalPlaybackActive`), which releases local `setKeepScreenOn(false)` while active, suppresses local `.stall(.start)` transitions while remote rendering owns playback, and emits `EngineEventOut.externalPlayback(attempt: token, active: Bool)` to JavaScript.
  - Declare `NSBonjourServices: ['_airplay._tcp']` in `apps/tv-mobile/config/build-app-config.ts` (`ios.infoPlist`).
- **Playback core (`packages/playback`):**
  - Add `{ type: 'externalPlayback'; active: boolean }` to `EngineEvent` and `readonly externalPlaybackActive?: boolean` to `PlaybackState`.
  - Route in `createEngineEventRouter` -> `hooks.onExternalPlayback?.(event.active)`.
  - In `recovery.ts`: set `externalPlayback = active`, gate `canWatchStall()` on `!externalPlayback`, cancel active watchdog timers on `active === true`, and reset `externalPlayback = false` on `resetItem()` / `reset()`.

### 2.3 `#415` — iPadOS `UIKeyCommand` Shortcuts & iOS Safe-Area Fit-Mode Video Insets
- **Pure Swift surface layout (`modules/engine-aether/ios/Core/SurfaceLayout.swift`):**
  - `resolveSurfaceVideoRect(boundsWidth, boundsHeight, safeAreaInsets, resizeMode, applySafeAreaOnFit)` insets `playerView` and `subtitleOverlayView` by clamped non-negative `safeAreaInsets` ONLY when `applySafeAreaOnFit && resizeMode == .fit` (`#if os(iOS)`). Keeps `fill`, `stretch`, tvOS, and `shutterView` edge-to-edge (`bounds`).
- **iOS safe-area insets for OSD (`modules/engine-aether` + `apps/tv-mobile/src/App.tsx`):**
  - Override `safeAreaInsetsDidChange()` and re-layout on `setResizeMode(_:)` inside `AetherSurfaceView.swift`.
  - Expose `getAppleSafeAreaInsets()` / `subscribeAppleSafeAreaInsets()` on `ElvEngineAether` (`#if os(iOS)`) and wire into `apps/tv-mobile/src/App.tsx` for `Platform.OS === 'ios' && !Platform.isTV` so `PlayerOsd` respects top/side/bottom safe areas in both portrait and landscape.
- **iPadOS `UIKeyCommand` playback shortcuts (`modules/engine-aether/ios/Core/HardwareKeyboardShortcut.swift` + `Engine/AetherKeyCommandHost.swift` + `packages/features`):**
  - Pure Swift `HardwareKeyboardMapper` maps `Space` (`play-pause`), `Left` (`seek-back`), `Right` (`seek-forward`), `Up` (`channel-up` on live / `volume-up` on VOD), `Down` (`channel-down` on live / `volume-down` on VOD), `M` (`mute`), `F` (`aspect`), and `Escape` (`back`).
  - **Strict guards:** Returns `nil` unconditionally whenever `isTextInputFocused == true`, suppresses auto-repeat on toggle keys (`Space`, `M`, `F`, `Escape`), and throttles arrow repeat cadence to `>= 200 ms` so held arrow keys never flood seeks/zaps.
  - On `#if os(iOS)`, `AetherSurfaceView` exposes `keyCommands` (with `wantsPriorityOverSystemBehavior = true` when playback is active and no `UITextInput` is first responder) and yields immediately whenever any `UITextField`, `UITextView`, or `UITextInput` becomes first responder or begins editing.
  - Emits `onHardwareKey` (`{ key }`) from `ElvEngineAetherModule` -> `subscribeAppleHardwareKeys` in `@elv/engine-aether` -> `OpenVideoEngine.onHostKey` in `apps/tv-mobile/src/App.tsx`.
  - Extend `HostKey` in `packages/features/src/ports/video-host.ts` with `'aspect' | 'volume-up' | 'volume-down'`, handle in `routeHostKey` (`toggleResizeMode`, `stepVolumeBy(+5/-5)`), and expose optional native Apple `setMuted` / `setVolume` hooks on `AetherEngine` (`AVPlayer.isMuted` / `AVPlayer.volume`) wired into `OpenVideoEngine`.

### 2.4 `#411` — Android Media3 Manual `Auto / Hardware / Software` Video Decoder Preference
- **Domain preference (`@elv/domain`):**
  - Add `ANDROID_DECODER_MODES = ['auto', 'hardware', 'software'] as const`, `AndroidDecoderMode`, and `androidDecoderMode: AndroidDecoderMode` (default `'auto'`) to `ExtendedPreferencesFields` & `DEFAULT_PREFERENCES`.
- **Localization (`@elv/i18n`):**
  - Add EN & TR translations for `settings.playback.videoDecoder`, `settings.playback.videoDecoder.auto`, `settings.playback.videoDecoder.hardware`, `settings.playback.videoDecoder.software`, and `player.videoDecoder`.
- **Playback port (`@elv/playback`):**
  - Add optional `decoderMode?: AndroidDecoderMode` to `LoadOptions`, `TuneRequest`, and `NativeLoadCommand`, forwarded through `sendLoad()` and `bridgeNativeEngine`.
- **Android Media3 native (`modules/engine-media3`):**
  - Add `VideoDecoderMode` (`AUTO`, `HARDWARE`, `SOFTWARE`) + `parseVideoDecoderMode` in `LoadRequest.kt`, carried on `LoadRequest.decoderMode`.
  - In `CodecPolicy.kt`:
    - `extensionRendererModeFor(softwareAudio, decoderMode)`: returns `EXTENSION_RENDERER_MODE_PREFER` when `softwareAudio || decoderMode == VideoDecoderMode.SOFTWARE`, else `EXTENSION_RENDERER_MODE_ON`.
    - `selectDecoders(..., decoderMode)`:
      - `AUTO`: preserves existing `#184` hardware-first + automatic crash fallback behavior.
      - `HARDWARE`: keeps only non-software video decoders (`!isSoftwareVideoCodec(info)`).
      - `SOFTWARE`: orders software video decoders strictly ahead of hardware (filtering to software video decoders when at least one software decoder is present, falling back to `getDecoderInfosSortedBySoftwareOnly` otherwise) immediately on load without waiting for hardware codec failures.
    - `PolicyVideoRenderer.getDecoderInfos`: enforces `HARDWARE` (filter to hardware-only), `SOFTWARE` (prefer software-only, bypassing hardware-only filtering), and `AUTO` (existing confirmed-hardware filter).
  - In `PlayerFactory.kt` & `Media3Engine.kt`: forward `decoderMode` into `buildPlayer(...)`, trigger player rebuild whenever `playerDecoderMode != next.decoderMode`, and preserve/reset cleanly across `recreate()` and new loads.
- **UI wiring (`@elv/features`):**
  - `PlaybackSettingsPanel` & `useTvSettingsNavigation`: render Video Decoder (`Auto` / `Hardware` / `Software`) option row when `showAndroidDecoder` is true (defaults to `Platform.OS === 'android'`), with full 10-foot TV D-pad focus rows synchronized cleanly.
  - `PlayerSettingsSheet` & `PlayerScreen`: pass `androidDecoderMode` + `onSelectAndroidDecoderMode` when on Android (or supplied), exposing a quick `Video decoder` row in `PlayerSettingsSheet` that updates preferences and smoothly reloads the active stream at the current position (VOD) or live edge (Live) with the new `decoderMode`.

## 3. Verification Plan
- Strict TDD (`RED -> GREEN -> REFACTOR`) across all packages and native modules.
- `pnpm check` (`11 passed, 0 failed`).
- Windows Android Gradle unit suite: `:elv-engine-media3:testDebugUnitTest` (`BUILD SUCCESSFUL`).
- Apple `elv-mac` (on AC power, wrapped in `caffeinate -dimsu`): `swift test --package-path modules/engine-aether/ios` + Xcode 26.4.1 iOS & tvOS Simulator builds.
- Independent `Gemini 4 Neon (XHigh)` whole-branch PR review (`VERDICT: PASS`).
- All GitHub Actions CI checks (`checks`, `pr-title`, `native`, `cla`, `security-gate`, `android-mobile`, `android-tv`, `ios`, `tvos`, `desktop`) green before squash-merge.
