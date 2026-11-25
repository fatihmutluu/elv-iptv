# Wave P3 — Zero-Reload Detached Full Player (Popout) & Seamless Multi-View Handoff

**Date:** 2026-11-26  
**Branch:** `feat/wave-p3-seamless-popout-multiview`  
**Status:** Design Approved (Autonomous Maintainer Flow)

## 1. Goals & Scope
1. **Zero-Reload Detached Full Player (Desktop Popout <-> Main Window):**
   - Transfer the live out-of-process `elv-mpv` instance (`CanvasPresenter.retargetWindow(nextWindow)` + `player:park` / `player:adopt` main IPC) between `mainWindow` and `popoutWindow` without closing `elv-mpv` or reopening the HTTP connection (`max_connections = 1` safe, zero reload stutter).
   - Native OS window chrome for Popout (`frame: true`, `maximizable: true`, standard minimize/maximize/close + double-click titlebar maximize; `alwaysOnTop: false` default).
   - Mount the **full `<PlayerScreen>`** inside `PopoutApp` (with `<ProfileProvider>`, `<KeymapProvider>`, volume slider, timeshift/cache seek, tracks, `⋮` menu including Always-on-Top with tooltip, aspect fade, channel drawer, etc.) — swapping only Detach <-> Dock-back and removing the unlabeled top-right Pin icon.
2. **Seamless Multi-View Handoff, Audio Preservation & Tile Controls:**
   - Entering Multi-View from `PlayerScreen` adopts the already-running `{ opened, service, target, muted, volume }` directly into Tile 1 with zero HTTP reconnect or reload.
   - Preserve and allow adjusting user volume, mute, audio device, normalization, pitch lock, and deinterlace settings inside Multi-View (with an interactive header volume/mute control reusing `OsdVolumeSlider` + `useSafeHoverBridge`).
   - Add crisp top-right tile controls on every `MultiViewTileCard`: **Swap/Change Channel** (rotation/swap icon) + **Close (`×`)** with hover tooltips; closing a tile when 1 tile remains (or exiting Multi-View) seamlessly hands the remaining live stream directly back to fullscreen `PlayerScreen` without reloading.
   - Hide the redundant top-right "Add Channel" header button whenever the empty `+` slot card is visible in the grid.
