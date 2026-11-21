# Round 2 Slice 9 — VOD 0–9 Percentage Seek, TV Focusable Scrubber Seek-Trap, First-Keypress OSD Wake-Up & Rate-Limited Desktop VOD Shortcuts

## 1. Objective
Close three high-priority player ergonomics & input-stability issues (`#296`, `#297`, `#212`) across 10-ft TV (`Android TV`, `Fire OS`, `tvOS`) and Desktop (`Windows`, `macOS`, `Linux`) without introducing IPC flooding, focus deadlocks, or regressions in existing player contracts.

## 2. Deliverables & Contracts

### 2.1 VOD `0–9` Percentage Seek & First-Keypress TV OSD Wake-Up (`#296`)
- **Pure helpers (`packages/features/src/player/scrub-controller.ts`):**
  - Export `digitKeyToRatio(key: Key): number | undefined` mapping `digit0`–`digit9` to `0.0`–`0.9` (`0%`–`90%`).
  - Export `COARSE_SEEK_MS = 30_000`.
  - Export `LONG_HOLD_MS = 350`, `AUTOREPEAT_MS = 160`, and pure `createKeyRepeatThrottle({ now, longHoldMs?, repeatIntervalMs? })` rate-limiting held-key repeats cleanly.
- **VOD `0–9` percentage jump (`packages/features/src/player/usePlayerControls.ts`):**
  - During active unlocked VOD playback (when Tracks and Settings panels are closed), `digit0`–`digit9` invokes `seekToRatio(digit * 0.1)`. Live streams ignore `digit0`–`digit9` here (live numeric channel jump lives on Live TV hub).
- **First-keypress TV OSD wake-up consumption (`usePlayerOverlayState.ts`, `usePlayerControls.ts`, `PlayerScreen.tsx`):**
  - Support TV OSD hidden/woken state (`osdHidden`, optional `autoHideOsdMs?: number` on `PlayerScreen`, and TV `Up` from unfocused video toggling `osdHidden = true` for unobstructed cinema viewing).
  - While `isTv && osdHidden === true`: the first non-`back`, non-`channelUp`, non-`channelDown` keypress is consumed solely to reveal the OSD (`osdHidden = false`) without triggering a blind pause, seek, or track switch. `back` still exits cleanly; live `channelUp`/`channelDown` still zaps immediately.

### 2.2 TV Focusable `VodProgressBar` Scrubber with Horizontal Seek-Trap (`#297`)
- **`usePlayerOverlayState.ts`, `usePlayerControls.ts`, `VodProgressBar.tsx`, `PlayerScreenParts.tsx`, `PlayerScreen.tsx`:**
  - Add `tvScrubberFocused: boolean` orthogonal to `tvOsdFocused`:
    - On TV VOD, pressing `Up` from `tvOsdFocused` moves focus to the timeline scrubber (`tvOsdFocused = false`, `tvScrubberFocused = true`).
    - While `tvScrubberFocused === true`: `Left` / `Right` (press & repeat) traps horizontally into `scrub.step(-1 | +1, kind)` (never leaving the scrubber), `Select` commits pending scrub preview (or toggles Play/Pause), `Down` returns to `tvOsdFocused = true`, and `Up` or `Back` exits `tvScrubberFocused = false` cleanly back to video.
  - Visual treatment in `VodProgressBar.tsx`: optional `tvFocused?: boolean` renders a prominent `theme.colors.focusRingColor` outer focus halo (`testID="player-progress-focus-ring"`) and enlarged scrub thumb (`18px`), compliant with all 6 themes including WCAG AAA `High Contrast`.

### 2.3 Standardized Desktop VOD Keyboard Shortcuts & Held-Key IPC Auto-Repeat Limiting (`#212`)
- **Renderer (`packages/features/src/player/useDesktopPlayerShortcuts.ts`):**
  - Support standardized desktop VOD shortcuts on BOTH web Electron renderer (`window` `keydown`, ignoring `isEditableWebTarget`) and non-web desktop fallback:
    - `0`–`9` -> `seekToRatio(digit * 0.1)` (`0%`–`90%`)
    - `Home` -> `seekToRatio(0)`, `End` -> seek near end (`durationMs > 10_000 ? durationMs - 10_000 : durationMs`, via `seekToEnd()`)
    - `Shift + ArrowLeft` / `Shift + ArrowRight` -> coarse seek `-30s` / `+30s`
    - `j`/`J` -> `-10s`, `k`/`K` -> Play/Pause, `l`/`L` -> `+10s`
  - Gate held `repeat === true` bursts through `createKeyRepeatThrottle` (`LONG_HOLD_MS = 350`, `AUTOREPEAT_MS = 160`) before dispatching seek or channel-zap repeats.
- **Desktop Main Process (`apps/desktop/src/main/player/mpv/input-repeat-gate.ts`, `live-session.ts`, `input-conf` / `engine.ts`):**
  - Add pure `createInputRepeatGate({ now, longHoldMs = 350, repeatIntervalMs = 160 })` rate-limiting repeated `client-message` UI keys (`channel-up`, `channel-down`, etc.) from `mpv`'s native child window so held keys over `mpv` IPC never flood the renderer or freeze Electron.
  - Extend `mpv` `input.conf` (located in `apps/desktop/src/main/player/` — check `input-conf.ts` / `launch.ts` / `presenter`) and `player-ipc.ts` safely if `mpv` owns window focus on macOS/Windows, forwarding standardized keys cleanly without exposing secrets.

## 3. Verification Plan
- Strict TDD across `@elv/features` (Vitest + Jest) and `@elv/desktop` (Vitest).
- Full `pnpm check` (`11 passed, 0 failed`), Desktop prod bundle hygiene (`WORKBENCH_HITS=0`), Windows Electron E2E (`browse-play.spec.ts` `2/2` green), and independent `Gemini 4 Neon (High)` whole-branch review (`VERDICT: PASS`).
