# Desktop & TV Ergonomics (`#409`, `#408`, `#410`, `#55`)

**Date:** 2026-11-22  
**Status:** Approved for implementation  
**Scope:** `@elv/domain`, `@elv/data`, `@elv/i18n`, `@elv/ui-kit`, `@elv/features`, `apps/desktop`

---

## 1. Goals

Deliver flagship desktop power-user ergonomics and living-room TV safety while upholding **Cinema Quietude v2** (`docs/design/UI_UX_PHILOSOPHY.md`) across all platforms:

1. **Desktop Card Hover Quick-Actions & Series Unplayed Episode Badges (`#409`):**
   - Batched SQLite query `listSeriesUnplayedCounts(db, seriesKeys, profileId)` in `@elv/data` (single indexed aggregation over `episodes` + `watch_progress`, bounded to 200 keys) returning `{ seriesKey, total, unplayed, watched }`.
   - Restrained top-right unplayed count pill (or watched checkmark when complete) on Series `PosterCard`s across all platforms (`tabular-nums`).
   - Pointer-only hover quick-actions (`Play`, `Favorite / My List`, `Mark Watched`) on `PosterCard` strictly gated on `viewport.inputModality === 'pointer' && hovered` (NEVER rendered on touch or TV), stopping click propagation cleanly with immediate optimistic UI updates and rollback on error.
2. **Desktop Audio Output Picker, Persisted Clamped Window Bounds & Always-on-Top (`#408`):**
   - Surface desktop `libmpv` `audio-device-list` / `audio-device` over typed IPC (`setAudioDevice(name)` live without dropping playback) into `PlayerSettingsSheet` (when devices exist) and `PlaybackSettingsPanel`.
   - Persist main Electron window geometry (`{ x, y, width, height, isMaximized }`) in `userData/window-state.json` without overwriting pre-maximized bounds, validating and clamping saved rectangles onto connected `screen.getAllDisplays()` work areas on startup so windows never open off-screen.
   - Add Always-on-Top toggle (`T` shortcut in renderer & `mpv-input.conf` + compact pin button in `DesktopCinemaBar`), keeping native child presenter HWND z-order consistent and resetting cleanly.
3. **Desktop `:focus-visible` Keyboard Rings & Windows Taskbar Controls (`#410`):**
   - Theme-tokenized global web `:focus-visible` stylesheet inside `ThemeProvider` driven by `theme.colors.focusRingColor` and `theme.focus.ringWidth` (live-updating for High Contrast AAA) while suppressing `:focus:not(:focus-visible)` on mouse clicks.
   - Windows-only Electron taskbar controller (`apps/desktop/src/main/taskbar-controls.ts`, strict no-op on non-Windows) driving `BrowserWindow.setProgressBar` (playing vs paused VOD progress, cleared on live/stop/exit) and `BrowserWindow.setThumbarButtons` (Previous, Play/Pause, Next) synced with active playback state.
4. **TV Root Back Exit Confirmation with Setting Toggle (`#55`):**
   - Persisted `confirmExitOnBack: boolean` preference (default `true`), editable in `AppearancePanel`.
   - When enabled on root `'home'` (with no active detail overlay or player), first Back press displays a concise `2 500 ms` `"Press Back again to exit"` toast (`shell-exit-confirm-toast`) and returns `true`; a second Back press within `2 500 ms` clears the toast and returns `false` so Android TV exits cleanly (zero `#425` Back-trap regression). When disabled, first Back returns `false` immediately.

---

## 2. Verification Plan
1. Strict TDD across `@elv/domain`, `@elv/data` (>= 90% coverage), `@elv/i18n`, `@elv/ui-kit`, `@elv/features`, and `apps/desktop`.
2. `pnpm check` (`11 passed, 0 failed`).
3. Desktop Playwright E2E (`e2e/browse-play.spec.ts`, `e2e/app.spec.ts`).
4. Independent `Gemini 4 Neon (High)` whole-branch code review (`VERDICT: PASS`).
