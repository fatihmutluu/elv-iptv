# Wave 4B — Desktop Shell Polish, Audio Ramp, Readahead & hwdec Profiles Design

**Issues:** `#435`, `#269`, `#254`, `#196`, `#210`  
**Status:** Active  
**Date:** 2026-11-22

## 1. Goals & Invariants
Harden desktop Electron/mpv reliability and polish: synchronize `own-window` follow & fullscreen with notched macOS safe-area support, prevent infinite `'buffering'` display-sleep locks, surface SQLite `catalog-worker` crashes with one-click recovery, drive `MediaSession` strictly from typed playback metadata, cap rolling diagnostic logs at 10 MB with URL redaction, smooth play/pause audio transitions with a 175 ms volume ramp, adapt `demuxer-readahead-secs` to cache health, and expose `hwdec` profiles + `demuxer-lavf-probe-info=yes` + render-context `video-timing-offset=0`.

## 2. Design by Issue

### 2.1 `#435` — Desktop Shell Bugs (5 Sub-Fixes)
1. **`own-window` follow & fullscreen sync (`apps/desktop/src/main/player/presenter/own-window.ts`):**
   - Subscribe to `appWindow` `'move'`, `'resize'`, `'enter-full-screen'`, and `'leave-full-screen'` events (cleaning up all listeners on `dispose()`).
   - Update active mpv window geometry via IPC (`['set_property', 'geometry', ...]`) on host moves/resizes when visible and not minimized/destroyed/transitioning, and synchronize fullscreen bidirectionally with loop prevention.
2. **`PowerBlocker` buffering stall timeout (`apps/desktop/src/main/player/ipc.ts`):**
   - Arm a bounded grace timer (`30_000 ms`, injectable in tests) on `event.state === 'buffering'` that releases `powerBlocker.release(engineId)` on expiry; cancel on `'playing'`/`'paused'`/`'ended'`/`'opening'`/`'error'`/`release`/dispose and re-acquire cleanly when `'playing'` resumes.
3. **`catalog-worker` crash recovery banner (`shared/catalog-ipc.ts`, `preload/catalog-bridge.ts`, `renderer/src/App.tsx`, `packages/i18n`):**
   - Expose `CatalogBridge.onDisconnected(listener)` firing only on unexpected worker exits (never on intentional `close()`).
   - Render a localized Cinema Quietude banner (`CatalogCrashBanner.tsx`) with one-click `Reconnect` calling `bridge.open()` and refreshing shell state.
4. **Typed `MediaSession` metadata & VOD action gating (`video-host.ts`, `PlayerScreen.tsx`, `media-session.ts`, `renderer/src/App.tsx`):**
   - Add `MediaSessionMetadata` and `OpenVideoEngine.setMediaMetadata` so `PlayerScreen` pushes typed `{ title, subtitle, artworkUrl, kind, canStepTrack }` directly (removing DOM scraping from `App.tsx`).
   - Pass `artworkUrl` through `sanitizeMediaArtworkUrl` and register `previoustrack`/`nexttrack` handlers ONLY when `canStepTrack` is `true` (omitting them for single-movie VOD).
5. **Parameterized `--hwdec` (unified with `#210`).**

### 2.2 `#269` — macOS Notch Safe-Area, Linux PulseAudio Floor & 10 MB Log Cap
- **Notch `safeArea`:** Distinguish `safeArea` (`workArea`) vs full `desktopMode` bounds in `own-window.ts` without native modesetting, and probe CSS `env(safe-area-inset-*)` in `packages/ui-kit/src/viewport/ViewportProvider.tsx` on web/Electron resize & fullscreen changes.
- **Linux PulseAudio floor:** Emit `--pulse-buffer=50` in `launchArgs()` (`options.ts`) strictly on `platform === 'linux'`.
- **10 MB desktop log cap:** Add `apps/desktop/src/main/log.ts` running every log line through `redactUrls()`, rotating `elv-desktop.log` -> `elv-desktop.log.1` at 5 MB (10 MB strict total cap), resilient to Windows file-lock errors, wired into `main.ts`.

### 2.3 `#254` — Smooth 175 ms Play/Pause Audio Ramp
- Add cancellable `apps/desktop/src/main/player/mpv/audio-ramp.ts` (175 ms, 7 steps × 25 ms, injectable `timers`).
- Observe `'volume'` and `'mute'` in `live-session.ts` (ignoring self-emitted ramp echoes); ramp down to 0 before `pause=yes` (restoring `savedVolume` cleanly) and ramp up from 0 to `savedVolume` on `play=no`. Cancel immediately and restore `savedVolume` on `load`, `retry`, `stop`, `recreate`, `seek`, `toggleMute`, `setVolume`, `detach`, or `release`.

### 2.4 `#196` — Adaptive mpv Readahead Tiers
- Add `apps/desktop/src/main/player/mpv/readahead.ts` implementing 3 tiers (`fast` 2s / `normal` 8s / `aggressive` 20s) driven by `paused-for-cache` and `demuxer-cache-duration` (ignoring initial opening, seeks, and paused states) with step-up cooldown and sustained-healthy step-down hysteresis.
- Support optional URL-free persistent tier cache keyed strictly by safe non-credential stream keys (never persisting URLs or credentials).

### 2.5 `#210` — `hwdec` Profiles, `demuxer-lavf-probe-info` & Render-Context `video-timing-offset`
- Export `HwdecProfile = 'auto-safe' | 'auto-copy' | 'no' | 'darwin-compat'` in `shared/player-ipc.ts`.
- Emit `--demuxer-lavf-probe-info=yes` in `LAUNCH_OPTIONS`, parameterize `hwdec` (`darwin-compat` adds `--hwdec-image-format=uyvy422` on `darwin`), and emit `--video-timing-offset=0` ONLY when `renderContext === true`.
- Wire live `setHwdec` IPC command across `player-ipc.ts`, `ipc.ts`, `engine-controls.ts`, `engine.ts`, and `desktop-engine.ts`.

## 3. Verification Plan
- Unit & integration tests across `apps/desktop`, `apps/desktop/renderer`, `packages/ui-kit`, `packages/features`, `packages/i18n`.
- Full `pnpm check` (`11 passed, 0 failed`) + independent `Gemini 4 Neon (High)` whole-branch code review.
