# Wave F6 — OS PiP, Multi-View with Connection & Thermal Clamps, Floating Corner Mini-Player & Desktop Tray/Popout

**Date:** 2026-11-25  
**Issues:** `#34`, `#221`, `#232`, `#233`, `#158`  
**Workstream:** `cluster:player-osd`, `cluster:apple-aether`, `cluster:desktop-mpv` (Closes Epics `#345` & `#346`)  
**Design Alignment:** Cinema Quietude v2 (`docs/design/UI_UX_PHILOSOPHY.md`), Zero-Blink, `max_connections = 1` Safety, Strict Security Sandboxing.

---

## 1. Goals & Scope

1. **OS Picture-in-Picture (`#34`):**
   - **Android Mobile/Tablet (`modules/engine-media3`):** Enhance `AndroidWindowHelper.kt` with optional `sourceRectHint` and API 31+ `setAutoEnterEnabled` (`autoEnterPip` preference, default `true`), preserving clamped `[0.418410, 2.390000]` aspect ratio and `!isTvDevice` guard.
   - **Apple iOS/iPadOS/tvOS (`modules/engine-aether`):** Add `AetherPipController.swift` wrapping `AVPictureInPictureController` over the hosted `AVPlayerLayer` when on the `AVPlayer` route (with iOS 15+ `canStartPictureInPictureAutomaticallyFromInline` guarded by `#if os(iOS)`), hooking `EngineCore.setAllowDetachedSurface(true)` so surface detach is non-fatal (`#117`), and returning `false` cleanly on non-`AVPlayer` raw-TS routes so JS falls back gracefully to the in-app floating corner mini-player. Pass Apple `subscribePip` into `createComposedAppLifecycle` so PiP suppresses background stop.
   - **Player UI:** Wire `onEnterPip` into `PlayerOsdTopBar` utility cluster (desktop/tablet/landscape) & `PlayerSettingsSheet` (portrait phone/TV), and ensure `inPip === true` suppresses all OSD chrome, touch gestures, `NextEpisodeBanner`, `StillWatchingPrompt`, and `TvFocusAnchor`.
2. **Multi-View Grid + Provider `max_connections` Clamp + Thermal Watchdog (`#34`, `#221`, `#232`):**
   - **`@elv/playback` (`thermal-watchdog.ts`, `multiview-controller.ts`):**
     - Normalized `ThermalState = 'nominal' | 'fair' | 'serious' | 'critical'` and pure RAM/model/thermal tile-cap resolver: low-RAM (`< 1.5 GiB` or `isLowRamDevice`) -> `1` (Multi-View disabled); 2–3 GB devices (`< 3.5 GiB`, `AppleTV5,*`/`AppleTV6,*`) -> cap `2`; higher RAM / Desktop -> cap `4`.
     - `serious` thermal state warns and blocks adding new tiles; `critical` blocks adding tiles and automatically sheds non-primary (muted) tiles to protect the device from OS thermal termination.
     - Per-`accountKey` `ConnectionTracker` admission gate (`#221`): allows concurrent tiles across distinct sources/accounts, blocks when `activeForAccount >= maxConnections`, and strictly **awaits socket/engine close** before releasing a connection slot or admitting a replacement.
     - Single active unmuted tile (`activeAudioTileId`); muted tiles pass `handleAudioFocus = false` (Android Media3) and `primary = false` (Desktop mpv IPC) so they never steal audio focus or OS media controls.
   - **Native Thermal & RAM Probes:** Android `ThermalMonitor.kt` (`PowerManager.addThermalStatusListener`, API 29+) + `getDeviceMemoryInfo()`; Apple `ProcessInfo.thermalStateDidChangeNotification` + `physicalMemoryBytes`.
   - **Desktop Multi-Engine (`apps/desktop`):** Extend `player:open` with `{ replaceExisting?: boolean; primary?: boolean }` so `canvas` presenter can run up to 4 concurrent tiles in one `BrowserWindow`, plus `player:set-primary` for active-tile media/taskbar handoff.
   - **Multi-View UI (`packages/features/src/player/`):** Cinema Quietude pure `16:9` 2-tile / 4-tile grid (`6px` gap), subtle active-audio focus ring, hover/focus-only channel title + muted badge, inline channel picker (zero RN `<Modal>`), inline `#221` connection-limit and `#232` thermal banners, full 2D TV D-pad + mouse/touch controls.
3. **Floating Corner Mini-Player (`#233`):**
   - Hoist `playerViewMode: 'full' | 'mini'` in `AppShell.tsx` so `<AppShellPlayerView>` stays mounted in a persistent sibling slot without tearing down `PlaybackService` or `OpenVideoEngine` when returning to browse (`Home`, `Live`, `Movies`, `Series`, `Search`).
   - Minimize via OSD button, tvOS/TV live minimize path, or tablet pinch-out (`< 1.0x`); floating corner container uses Cinema Quietude glass/card tokens with `canBecomeFocused = false` on video surface and accessible Expand / Close controls so D-pad browsing is never trapped.
4. **Desktop Minimize-to-Tray & Standalone Popout Player Window (`#158`):**
   - Add `minimizeToTray: boolean` (default `false`) to `@elv/domain` preferences, persisted synchronously for main-process `BrowserWindow.on('close')` + `isQuitting` guard on `before-quit`, platform `Tray` (`Restore`, `Quit`), cursor visibility restore on show/restore, and `max_connections = 1` safety (stopping invisible live streams when `backgroundAudioPlayback === false`).
   - Add hardened standalone Popout `BrowserWindow` (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `lockDownWebContents`, `attachBrowserBackGuard`, separate `popout-window-state.json`, default `640×360`, Always-on-Top toggle) with clean `ConnectionGate`-safe detach/dock handoff and minimalist Cinema Quietude `PopoutApp.tsx` hover controls.

---

## 2. Invariants & Security

- **Zero credential/URL logging** across PiP, Multi-View, thermal, tray, and popout paths.
- **Popout window hardening:** Always calls `lockDownWebContents` and `attachBrowserBackGuard`; validates all popout/tray/multi-view IPC payloads with strict runtime guards (`hasOnlyKeys`, bounded strings, valid kinds).
- **UI craft:** Cinema Quietude v2 tokens only, zero hardcoded hex colors, zero RN `<Modal>`, 100% EN/TR `@elv/i18n` parity, zero forbidden copy, every source file `<= 800` lines, pure packages `>= 90%` line coverage.
