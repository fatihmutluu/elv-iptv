# Wave C6 Design Spec — Android Media3 Native Services & Audio Polish (`#412`, `#132`, `#264`)

## Scope
Implements all 3 Android Media3 issues in a single focused wave:
1. **`#412` — Android Foreground Playback Service & `MediaStyle` Lock-Screen Notification:** Integrate `androidx.media3:media3-session` `MediaSession` + foreground `MediaSessionService` (`FOREGROUND_SERVICE_MEDIA_PLAYBACK`) with synchronized title/subtitle/artwork metadata, lock-screen/shade/Bluetooth controls, clean stop/failure dismissal, and opt-in `backgroundAudioPlayback` (default `false` for single-connection IPTV safety).
2. **`#132` — `MediaSession` Untrusted-Controller Callback & Fire OS Voice Permission:** Harden `MediaSession.Callback.onConnect` so untrusted external controllers receive strictly bounded playback transport commands (blocking queue/media-item/track mutations), and conditionally declare `com.amazon.permission.media.session.voicecommandcontrol` on TV / Amazon Fire OS builds.
3. **`#264` — Playback Speed Pitch-Lock Toggle (`audioTimeStretching`) on Media3:** Implement `setSpeed(rate)` and `setPitchLock(locked)` on `Media3Engine` using `PlaybackParameters(speed, pitchLock ? 1.0f : speed)` on VOD streams (persisted across player rebuilds, clamped `[0.25, 4.0]`), wired to `@elv/domain`'s existing `pitchLock` preference.

## Architecture

### 1. Domain, i18n & Features (`@elv/domain`, `@elv/i18n`, `@elv/features`)
- **`@elv/domain`:** Add `backgroundAudioPlayback: boolean` (default `false` — also reused by Wave C7 `#413` on Apple!) to `PreferencesSnapshot` & `DEFAULT_PREFERENCES`.
- **`@elv/i18n`:** Add EN + TR parity keys `settings.backgroundAudio` ("Background audio playback" / "Arka planda ses oynatma") & `settings.backgroundAudioHint` ("Keep audio playing with the screen off on mobile; single-connection providers may disconnect on reconnect" / "Mobilde ekran kapalıyken sesi oynatmaya devam eder; tek bağlantılı sağlayıcılarda yeniden bağlanırken akış kesilebilir").
- **`@elv/features`:**
  - Expose `backgroundAudioPlayback` toggle in `PlaybackSettingsPanel.tsx` for mobile/tablet form factors (`phone` / `tablet`, hidden on `tv` & `desktop`).
  - In `usePlayerTargetHandoff.ts`: when `appLifecycle` emits `'background'`, keep playback alive if `backgroundAudioPlayback === true`; otherwise continue stopping cleanly so single-connection providers never leak active sockets!

### 2. Android Media3 Native Engine & Session Service (`modules/engine-media3`)
- **Gradle & Manifest:**
  - `modules/engine-media3/android/build.gradle`: add `implementation "androidx.media3:media3-session:$media3"`.
  - `modules/engine-media3/android/src/main/AndroidManifest.xml`: add `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, `POST_NOTIFICATIONS` (zero forbidden permissions — `release-hygiene` compliant), and `<service android:name=".ElvPlaybackSessionService" android:foregroundServiceType="mediaPlayback" android:exported="true">` with `androidx.media3.session.MediaSessionService` intent filter.
- **`SessionCallbackPolicy.kt` (`#132`):** Pure unit-testable policy helper for `MediaSession.Callback.onConnect(session, controller)`:
  - Notification / system controller receives full playback commands needed for notification rendering; untrusted external controllers receive `SessionCommands.EMPTY` and strictly standard transport `Player.Commands` (`PLAY_PAUSE`, `SEEK_IN_CURRENT_MEDIA_ITEM`, `SEEK_BACK`, `SEEK_FORWARD`, `SEEK_TO_PREVIOUS_MEDIA_ITEM`, `SEEK_TO_NEXT_MEDIA_ITEM`, `STOP`, `GET_CURRENT_MEDIA_ITEM`, `GET_METADATA`), stripping media-item/queue/track mutations.
- **`ElvPlaybackSessionService.kt` & `MediaSessionController.kt` (`#412`):**
  - Holds an active `MediaSession` created strictly on `Media3Engine`'s dedicated playback looper (`HandlerThread("ElvMedia3").looper`) with a lightweight `ForwardingPlayer` delegating `seekToNext`/`seekToPrevious`/`seekToNextMediaItem`/`seekToPreviousMediaItem` to a JS remote-action callback (`onRemoteMediaAction`: `'next' | 'previous'`) when `canStepTrack == true` while live/VOD transport (`play`, `pause`, `seekTo`, `stop`) runs directly on `ExoPlayer`!
  - On `Media3Engine.buildPlayer()` rebuilds/recreates, seamlessly calls `mediaSession.setPlayer(wrappedNewPlayer)` without dropping the notification!
  - Updates `MediaMetadata` via `setMediaMetadata(title, subtitle, artworkUrl, isLive, canStepTrack)` (sanitizing `artworkUrl` to strict `http`/`https` without userinfo/credential query params!).
  - Promotes `ElvPlaybackSessionService` via `try/catch (IllegalStateException)` around `ContextCompat.startForegroundService(...)` (Android 12+ safe); stops service and releases `MediaSession` immediately on `stop()`, terminal failure, or `dispose()` so zero notifications linger.
- **`Media3Engine.kt` & `ElvEngineMedia3Module.kt` (`#264`, `#412`):**
  - Add `setSpeed(rate: Double)` (clamped `[0.25f, 4.0f]`, ignored on live streams) and `setPitchLock(locked: Boolean)` applying `PlaybackParameters(currentSpeed, if (pitchLock) 1.0f else currentSpeed)` and re-applying across `buildPlayer()` rebuilds.
  - Add `setMediaMetadata(...)` & `setBackgroundAudioEnabled(enabled: Boolean)` + expose `onRemoteMediaAction` event (`'next' | 'previous'`).
- **`modules/engine-media3/src/index.ts`:** Update `CAPABILITIES.rate = true`, expose `setSpeed`, `setPitchLock`, `setMediaMetadata`, `onRemoteMediaAction` on the native engine bridge!

### 3. Mobile/TV App & Fire OS Config (`apps/tv-mobile`)
- **`apps/tv-mobile/config/build-app-config.ts` (`#132`):** Conditionally include `com.amazon.permission.media.session.voicecommandcontrol` in `android.permissions` when `tv || store === 'amazon'` (omitted on mobile Play Store builds); update `build-app-config.test.ts`.
- **`apps/tv-mobile/src/App.tsx`:** Forward `setPitchLock`, `setMediaMetadata`, and `onRemoteMediaAction` (`'next'` -> `'channelUp'`, `'previous'` -> `'channelDown'`) on the Media3 `OpenVideoEngine` wrapper!

## Verification
- `pnpm check` passes `11 passed, 0 failed` (`>= 90%` coverage in pure packages, `modules/engine-media3/AGENTS.md <= 50` lines).
- Android `expo prebuild --platform android --no-install` + `./gradlew.bat :elv-engine-media3:testDebugUnitTest` passes (`BUILD SUCCESSFUL`).
- Independent whole-branch review (`VERDICT: PASS`) and green GitHub CI (`android-mobile`, `android-tv`, `checks`, `security-gate`).
