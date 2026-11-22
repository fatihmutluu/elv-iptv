# Wave 4A — Desktop mpv Critical Hardening Design

**Issues:** `#419`, `#420`, `#434`, `#207`, `#131`  
**Status:** Active  
**Date:** 2026-11-22

## 1. Goals & Invariants
Eliminate mpv OSC/OSD key-stealing conflicts, child video window focus theft, unwired speed/audio/subtitle/deinterlace IPC commands, noisy audio hotplug drops, transient HTTP disconnect tears, and per-item mpv property bleed across persistent `--idle=yes` reuse on Windows, macOS, and Linux.

## 2. Design by Issue

### 2.1 `#419` — Disable Built-In mpv OSC, OSD & Default Keybindings
- In `apps/desktop/native/mpv-host/elv-mpv.c`: set `input-default-bindings=no`, `input-vo-keyboard=no`, `osc=no`, and `osd-level=0`.
- In `apps/desktop/src/main/player/mpv/options.ts` (`LAUNCH_OPTIONS`): add `--osc=no`, `--osd-level=0`, `--input-default-bindings=no`, `--input-vo-keyboard=no`, and remove obsolete `--script-opts=osc-idlescreen=no`.
- Explicit `mpv-input.conf` bindings (`script-message elv-key ...`) remain active as the sole native fallback bridge.

### 2.2 `#420` — Prevent Transparent Child mpv `BrowserWindow` Focus Theft
- `apps/desktop/src/main/player/presenter/video-window-options.ts`: set `focusable: false` in `buildVideoWindowOptions`.
- `apps/desktop/src/main/player/presenter/child-window.ts` + `types.ts`: subscribe to child window `'focus'` events and bounce focus back to `appWindow.focus?.()` when `!appWindow.isDestroyed()`, cleaning up listener on `dispose()`.
- Defense-in-depth for native `--wid` HWND / `own-window` focus: expand `apps/desktop/resources/mpv-input.conf`, `PlayerUiEvent['key']`, `live-session.ts` `UI_KEYS`, `host-keys.ts`, `OpenVideoEngine['onHostKey']`, and `usePlayerSession`/`PlayerScreen` to forward `play-pause` (`SPACE`/`k`), `seek-back` (`LEFT`/`j`), `seek-forward` (`RIGHT`/`l`), `seek-coarse-back`/`seek-coarse-forward` (`Shift+LEFT`/`Shift+RIGHT`), `mute` (`m`), `tracks` (`c`), and `prev-channel` (`p`) directly into React's single player control state.

### 2.3 `#434` — Wire Speed/Audio/Subtitle IPC, Expand `--reset-on-next-file` & Guard `ao-reload` Hotplugs
- Extend `BridgeCommand` / `isBridgeCommand` (`apps/desktop/src/shared/player-ipc.ts`), `apps/desktop/src/main/player/ipc.ts`, `MpvEngine` (`engine.ts`), and `createDesktopEngine` (`desktop-engine.ts`) with validated commands:
  - `setSpeed` (`attempt`, finite `0.25 <= rate <= 4`), wired directly to `PlayerEngine.setSpeed`.
  - `setVolume` (`0 <= volume <= 100`), `setAudioDelay` (`-30 <= delaySec <= 30`), `setSubtitleDelay` (`-30 <= delaySec <= 30`), `setAudioDevice` (non-empty `<= 256` chars without control chars), and `setDeinterlace` (`boolean`).
- Expand `--reset-on-next-file` in `options.ts` to reset `aid,sid,vid,sub-visibility,audio-delay,sub-delay,video-aspect-override,deinterlace,speed,panscan,keepaspect,video-unscaled,gamma,brightness,contrast,saturation`.
- Observe `'audio-device'` alongside `'audio-device-list'` in `live-session.ts`. Update `audio-hotplug.ts` so:
  - When `activeDevice !== 'auto'`, `onReinit` fires ONLY when `activeDevice` is removed from or reappears in `audio-device-list`.
  - When `activeDevice === 'auto'`, `onReinit` fires ONLY when the primary default concrete output device (first non-`'auto'` entry) changes or disappears — ignoring unrelated secondary devices.

### 2.4 `#207` — Demuxer-Level Reconnect & Render-Update Callback Coalescing
- Update `LAUNCH_OPTIONS` in `options.ts` to `--stream-lavf-o=icy=0,reconnect=1,reconnect_streamed=1,reconnect_on_network_error=1,reconnect_delay_max=5`.
- Add a pure coalescing scheduler primitive `apps/desktop/src/main/player/mpv/render-coalescer.ts` (`createRenderCoalescer`) with an atomic `scheduled` guard so bursts of render wakeups coalesce to one render pass (ready for in-canvas `#95`).

### 2.5 `#131` — Per-File mpv Property Reset & Opt-In Deinterlace OSD Toggle
- Guard `own-window.ts` against sending non-essential geometry IPC during macOS fullscreen transitions.
- Wire `setDeinterlace(enabled: boolean)` from `PlayerSettingsSheet` (inline switch row gated on `onToggleDeinterlace !== undefined`, resetting to `false` on `activeTarget.itemKey` change to stay synced with `--reset-on-next-file=...,deinterlace`) -> `OpenVideoEngine.setDeinterlace` -> `desktop-engine.ts` -> `MpvEngine` -> `['set_property', 'deinterlace', 'yes' | 'no']`.
- Localize `player.deinterlace` in `packages/i18n` (`en` + `tr` `.ts` and `.po`).

## 3. Verification Plan
- Unit & contract tests across `apps/desktop`, `packages/features`, and `packages/i18n`.
- Full `pnpm check` (`11 passed, 0 failed`) + independent `Gemini 4 Neon (High)` whole-branch code review.
