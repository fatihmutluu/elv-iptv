# Round 2 Slice 6 — Cinema Quietude Player OSD, 2-Level Settings Popover, Mobile Touch Lock & Single-Connection Next Episode

## 1. Objective
Upgrade `PlayerScreen`, `PlayerOsd`, `VodProgressBar`, and `TrackPickerModal` into the locked **Cinema Quietude** visual language (`docs/design/UI_UX_PHILOSOPHY.md` §1, §2.2, §3, §4, §5), ship the adaptive **2-level Player Settings popover / Portrait bottom sheet** with a real-telemetry **Stats HUD**, add touch-only **Mobile Touch Lock**, and implement single-connection-safe **Next Episode / Up Next** progression (`#353`) across all target form factors (`Android TV`, `Fire OS`, `tvOS`, `iOS`, `Android`, `Windows`, `macOS`, `Linux`).

## 2. Core Engineering & Design Invariants
1. **Zero-jank video canvas:** Clock-driven UI (`OsdClock`, `VodProgressBar`, `PlayerStatsHud`, `NextEpisodeBanner`) MUST live in isolated leaf components subscribed to `usePlaybackTicker` with strict equality comparators so `PlayerScreen` itself performs **0 re-renders per playback frame or second**.
2. **100% live theme tokens (WCAG AAA safe):** Zero hardcoded hex colors or dark-blue scrims anywhere in `packages/features/src/player/`. Every surface, scrim, seekbar fill (`theme.colors.accent`), primary play button (`theme.colors.ctaBg` / `theme.colors.ctaFg`), focus ring (`theme.colors.focusRing`), live badge (`theme.colors.live`), and error banner derives dynamically from `useTheme()`, verified under both `obsidianCrimson` and `highContrast` (AAA).
3. **Desktop native HWND safety (`formFactor === 'desktop'`):** Until `#95` renders desktop video in-canvas, `player-tracks-panel`, `player-settings-panel`, and `player-osd` MUST remain in normal flex flow below `player-surface-layer` (`flex: 1`) so the native `libmpv` child window never paints over player chrome (`areaBox.y + areaBox.height <= panelBox.y + 1`). On `phone`, `tablet`, and `tv`, the OSD overlays the video canvas with dynamic `Scrim`s and `AdaptiveSheet`.
4. **Honest capability gating:** Never ship placebo buttons for unsupported engine features. Every control in the 2-level Settings menu (`Subtitles`, `Audio`, `Stats HUD`) is 100% backed by live `PlaybackService` state and commands.
5. **Single-connection safety (`#353`):** Next Episode progression NEVER opens a speculative background connection or pre-resolves streams while the current episode plays. Activating Next Episode flushes current watch progress, stops the active stream first, and then tunes the next episode cleanly.
6. **Backward compatibility:** Preserve all existing player `testID`s (`player-screen`, `player-osd`, `osd-title`, `osd-status`, `osd-clock`, `player-back`, `player-play-pause`, `player-seek-back`, `player-seek-forward`, `player-prev`, `player-next`, `player-progress-bar`, `player-progress-time`, `player-tracks-button`, `player-tracks-panel`, `player-audio-track-*`, `player-subtitle-off`, `player-subtitle-track-*`, `player-retry`) and `TvOsdAction` / `TrackPickerModal` navigation contracts so existing unit suites and Desktop Electron E2E remain green.

## 3. Architecture & Component Breakdown

### 3.1 Ports & Detail Integration
- `packages/features/src/ports/play-target.ts`:
  - Extend `PlayTarget` with optional `readonly nextEpisodes?: readonly PlayableEntry[];` (remaining ordered episodes in the season) and optional `readonly previousChannel?: PlayableEntry;`.
- `packages/features/src/detail/detail-model.ts` & `DetailScreen.tsx`:
  - Populate `nextEpisodes` in `buildEpisodePlayTarget` / `buildPrimaryPlayAction` from `episodes.slice(index + 1)` (capped at 50 entries, `startPositionMs: 0`) whenever playing a series episode.
- `packages/features/src/live/useLiveCatalog.ts`:
  - Attach `previousChannel` (when available) to `buildPlayTarget` so Live fullscreen playback can jump straight back to the previous channel.

### 3.2 Pure Models (Vitest >= 95% coverage)
- `packages/features/src/player/player-overlay-model.ts`:
  - `NEXT_EPISODE_RATIO_THRESHOLD = 0.9`, `NEXT_EPISODE_REMAINING_MS = 45_000`, `NEXT_EPISODE_MIN_DURATION_MS = 120_000`.
  - `shouldShowNextEpisodePrompt({ positionMs, durationMs, statusKind, hasNextEpisode, dismissed }): boolean`.
  - `buildNextEpisodeTarget(current: PlayTarget): PlayTarget | null` — pops `nextEpisodes[0]`, sets `startPositionMs: 0`, carries `nextEpisodes: rest`.
  - `formatStatsHudLines(state: PlaybackState, nowMs: number, i18n: AppI18n): readonly string[]` — formats real playback telemetry (status, position/duration, active audio codec/channels/lang, active subtitle, first-frame latency, attempt, stale events dropped).
- `packages/features/src/player/settings-menu-nav.ts`:
  - Pure 2-level Settings menu state machine (`view: 'root' | 'subtitles' | 'audio'`, focused index, `moveSettingsCursor`, `activateSettingsItem`, `backSettingsMenu`) for seamless 10-ft TV D-pad and keyboard navigation.
- `packages/features/src/player/tv-osd-nav.ts`:
  - Extend `TvOsdAction` with `'settings' | 'nextEpisode'` gated by optional `hasSettings?: boolean` and `hasNextEpisode?: boolean` on `TvOsdAvailability` (defaulting to `false` when omitted so existing tests remain 100% compatible).

### 3.3 Cinema Quietude Player UI (`packages/features/src/player/`)
- **`VodProgressBar.tsx`:** Tokenized with `useTheme()`, `theme.colors.accent` progress fill, circular scrub thumb, `TABULAR_NUMS_STYLE` elapsed/total clock (`player-progress-time`), and optional `dimmed` prop (fades quietly on Portrait while a bottom sheet is open per §3).
- **`TrackPickerModal.tsx`:** Tokenized with `useTheme()` (`glassBg`, `glassBorder`, `focusRing`, `accent`, `textPrimary`, `textSecondary`), Cinema Quietude radio indicators, `>= 40px` touch rows, preserved `testID`s and cursor auto-scroll.
- **`PlayerSettingsSheet.tsx`:** Adaptive 2-level Settings menu (`testID="player-settings-panel"`):
  - Root view: `Subtitles` row (current label + chevron), `Audio` row (current label + chevron), `Stats HUD` toggle (`testID="player-stats-toggle"`).
  - Sub-views (`subtitles`, `audio`): header with Back button (`testID="player-settings-back"`) returning to Root, scrollable radio list calling real `onSelectSubtitle` / `onSelectAudio`.
  - Uses `AdaptiveSheet` (right-anchored `300px` popover on Landscape, inset bottom sheet with grab handle on Portrait) on non-desktop viewports, and flex-docked glass panel below `player-surface-layer` on `desktop`.
- **`PlayerStatsHud.tsx` & `NextEpisodeBanner.tsx`:**
  - `PlayerStatsHud`: leaf `usePlaybackTicker` (`mode: 'second'`) monospace pill (`testID="player-stats-hud"`).
  - `NextEpisodeBanner`: leaf `usePlaybackTicker` (`mode: 'second'`, boolean `isEqual`) floating high-contrast `CtaButton` (`testID="player-next-episode"`) + dismiss button (`testID="player-next-episode-dismiss"`) anchored bottom-right above the seekbar.
- **`PlayerScreenParts.tsx` & `PlayerScreen.tsx`:**
  - Cinema Quietude top bar (`Back`, Title + optional Subtitle + `LIVE` `MicroPill` on live streams, top-right utility cluster: `Audio & Subtitles` quick button, touch-only `Lock` button on phone/tablet, `⋮ Settings` button — Portrait caps top-right at 3 compact buttons per §3).
  - Center/inline VOD transport (`-10s`, neutral-white `Play/Pause` with icon + label, `+10s`) and clean error recovery banner (`osd-error-hint` + `Retry`).
  - Mobile Touch Lock overlay (`testID="player-unlock-button"`) hiding all other OSD elements until unlocked.
  - Full single-connection `handleNextEpisode` handler (`flushProgress -> cancelPendingResume -> service.stop() -> tuneEntry(next)`).

### 3.4 Localization (`@elv/i18n`)
Add EN + TR parity keys in `en.ts`, `tr.ts`, `en/messages.po`, `tr/messages.po`:
- `player.settings`, `player.settingsBack`, `player.statsHud`, `player.stats.on`, `player.stats.off`, `player.stats.audioNone`, `player.stats.latencyMs`, `player.lockControls`, `player.unlockControls`, `player.nextEpisode`, `player.nextEpisodeWithLabel`, `player.dismissNextEpisode`, `player.jumpPreviousChannel`.

## 4. Verification Plan
1. **Strict TDD:** Failing unit tests first for `player-overlay-model.test.ts`, `settings-menu-nav.test.ts`, `tv-osd-nav.test.ts`, `detail-model.test.ts`, `TrackPickerModal.test.tsx`, `PlayerSettingsAndNextEpisode.test.tsx`, and `PlayerScreen.test.tsx`.
2. **Full quality gates:** `pnpm check` (`11 passed, 0 failed`), Desktop prod bundle hygiene (`WORKBENCH_HITS=0`), Windows Electron E2E (`browse-play.spec.ts` `2/2` green).
3. **Independent whole-branch `Gemini 4 Neon (High)` review** (`VERDICT: PASS`).
