# Cinema Quietude v2 Player Redesign & Ergonomics (`#391`, `#58`, `#394`, `#114`, `#57`, `#392`)

**Date:** 2026-11-22  
**Status:** Approved for implementation  
**Scope:** `@elv/domain`, `@elv/i18n`, `@elv/data`, `@elv/playback`, `@elv/features`, `apps/desktop`, `modules/engine-media3`, `modules/engine-aether`

---

## 1. Goals & Visual Direction

Transform the active playback surface across Desktop, TV (Android TV / Fire OS / tvOS), and Mobile/Tablet into a calm, flagship **Cinema Quietude v2** screening room (`docs/design/UI_UX_PHILOSOPHY.md`):

1. **Progressive 3-Tier OSD (`#391`):** Replace the binary hidden/shown OSD flag with explicit tiers:
   - `'hidden'`: Unobstructed picture (cursor hidden on web desktop after idle timeout during playback).
   - `'progress'`: Minimal non-intrusive peek strip (thin seekbar + timecode or live title/badge + volume/seek feedback) with a short **2 000 ms** auto-hide timer triggered by lightweight interactions (`±10s` seek, scroll-wheel volume step, pointer hover/nudge).
   - `'controls'`: Full 3-zone Cinema Quietude OSD (`autoHideOsdMs`, default **3 500 ms**), reachable in one explicit action (tap canvas, `Select`/`OK`, `Menu`, pause, end, error).
   - Modal/supplement sheets (`PlayerSettingsSheet`, `PlayerInfoSheet`, `PlayerChannelDrawer`) pause OSD auto-hide and step down cleanly on `Back`/`Escape` (`supplement -> controls -> hidden -> onExit`).
2. **Cinema Quietude v2 Declutter & Stream Metadata (`#58`):**
   - Hide noisy `"Playing"` status text whenever `status.kind === 'playing'`; surface status text only for meaningful transient states (`tuning`, `paused`, `ended`, `recovering`, `limited`, `failed`).
   - Eliminate duplicate clocks on VOD (remove redundant `OsdClock` when `VodProgressBar` already renders elapsed / total timecode).
   - Replace oversized center text `Prev Channel` / `Next Channel` buttons on Live TV with clean circular icon transport buttons and render a subtle buffering ring inside the primary Play/Pause button when `tuning` or `recovering`.
   - Emit real decoded video metadata (`StreamVideoInfo`: `width`, `height`, `fps`, `codec`, `hdr?: 'hdr10' | 'dv' | 'hlg' | 'sdr'`) from desktop `libmpv`, Android `Media3`, and Apple `AetherEngine` through `PlaybackState.videoInfo`.
   - Render compact outlined `MicroPill` stream badges (e.g. `4K`, `1080p`, `60 fps`, `HDR10`, `DV`, `5.1`) derived solely from real decoded telemetry and active audio track metadata.
   - Surface Live Now & Next programme info with live progress in the player overlay and add a non-blocking `PlayerInfoSheet` (`I` key or Info icon) showing full programme title, broadcast window, synopsis, Next programme, and technical stream summary without interrupting playback (`Shift+I` toggles the monospace `PlayerStatsHud`).
3. **Desktop Cinema Bar Ergonomics (`#394`):**
   - Preserve native-HWND flex-flow safety (never `position: 'absolute'` over the video surface on Windows/macOS HWND).
   - Reorganize `DesktopCinemaBar` into a full-width top thin interactive `VodProgressBar` plus a crisp 3-zone bottom bar:
     - **Left:** Back, transport (`Play/Pause`, `-10s`, `+10s` on VOD; circular prev/next/prev-channel on Live), Mute + sleek inline `64px` horizontal `OsdVolumeSlider` (`3px -> 6px` active/hover, `0–100`, persisted to preferences), timecode / Live badge.
     - **Center:** Decluttered title + `MicroPill` stream badges + Live Now/Next line (never starved on `< 1280px` windows).
     - **Right:** Jump to Live (when lagging MPEG-TS), Channel List (Live), Info, Settings (`⋮`), and dynamic `fullscreen` / `fullscreenExit` toggle.
   - Support mouse scroll-wheel volume adjustment (`±5%` steps, clamped `0–100`) over the player surface/bar while strictly bypassing wheel interception when any sheet/drawer/modal is open.
   - Keep `>= 10px` pointer-travel deadzone (`touch-hover-guard`) and automatic idle cursor hide during active playback.
4. **Playback Speed, Hold-to-2×, Auto-Subtitles on Skip Back & Touch Gestures (`#114`):**
   - Keep VOD speed presets (`0.5×–2.0×`) accessible via `PlayerSettingsSheet` (retiring duplicate legacy `TrackPickerModal` mounting on `PlayerScreen` so all Audio/Subtitle/Speed/Aspect/Deinterlace/Auto-subtitles/Stats live in one unified 2-level sheet, while keyboard `T`/`S` and TV triggers open the matching sub-view directly).
   - Add pure state machine `skip-back-subtitles.ts` controlled by persisted preference `autoSubtitlesOnSkipBack` (default `false`): rewinding while subtitles are off temporarily activates the preferred/first subtitle track for `15 000 ms` (extending on repeat rewinds), then restores subtitles to off automatically (canceling cleanly if the user explicitly changes subtitle selection or stops playback).
   - Add `PlayerTouchGestures` for phone/tablet with `24px` system edge exclusion:
     - Left-half vertical swipe adjusts screen brightness (with clean dim overlay fallback when native brightness hook is absent).
     - Right-half vertical swipe adjusts volume (`0–100`).
     - Horizontal swipe previews VOD scrub delta with centered feedback HUD and commits on release.
     - Double-tap left/right jumps `±10s` with `'progress'` peek.
     - `500ms` long-press on VOD temporarily holds `2.0×` speed with a quiet `2×` pill indicator, restoring prior speed on release.
     - Single tap toggles `'hidden' <-> 'controls'`; OSD Lock hides all chrome except a centered `Unlock controls` pill.
5. **In-Player Channel & Schedule Drawer (`#57`):**
   - Add `PlayerChannelDrawer` reusing `LiveZapDrawer` patterns (in-tree flex `docked` left column on desktop so Windows/macOS native HWND resizes cleanly without z-order occlusion; translucent glass overlay on TV/landscape mobile; bottom sheet on portrait).
   - Opens with one key (`G` / `L` on desktop, `Left` / Channel List button on Live TV/mobile) and closes cleanly with `Back`/`Escape`.
   - Starts focus on the currently playing channel, displays the focused channel's Now/Next schedule beside/under the list, and zaps immediately on `Select`/`OK` using existing single-connection-safe handoff.
6. **Cross-Season Next Up Engine & Countdown Card (`#392`):**
   - Add deterministic pure SQLite query `queryNextEpisode(db, seriesKey, currentItemKey, profileId)` in `@elv/data` (exposed on `CatalogService`) resolving the next unplayed `(season, episode)` across season boundaries (`S01E10 -> S02E01`), respecting watched state and skipping seasons/episodes already completed unless explicitly requested.
   - Resolve cross-season next episode automatically in `PlayerScreen` when `target.nextEpisodes` is empty on a series episode, and keep single-connection handoff (`stopAndRelease` before starting next episode).
   - Upgrade `NextEpisodeBanner` into a Cinema Quietude v2 bottom-right countdown card (`10s` progress fill gated by persisted `autoPlayNextEpisode`, default `true`, pausing auto-advance while focused/hovered or when `reduceMotion` snaps bar updates cleanly, with `Play next` and `Dismiss` actions).

---

## 2. Architecture & Contracts

### 2.1 `@elv/playback` — Decoded `StreamVideoInfo`
```ts
export type StreamHdrKind = 'sdr' | 'hdr10' | 'hlg' | 'dv';

export interface StreamVideoInfo {
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number;
  readonly codec?: string;
  readonly hdr?: StreamHdrKind;
}
```
- `EngineEvent` gains `{ type: 'mediaInfo'; token: number; info: StreamVideoInfo }`.
- `PlaybackState` gains `readonly videoInfo?: StreamVideoInfo`, cleared on every new `tune()` / `stop()`.
- Native/desktop emitters:
  - **Desktop mpv:** derive `width`/`height` (`video-params.w`/`h`), `fps` (`estimated-vf-fps` or `container-fps`), `codec` (`video-format` / `video-codec`), `hdr` (`video-params.primaries` / `gamma`: `pq` -> `'hdr10'`, `hlg` -> `'hlg'`, `dolbyvision` -> `'dv'`, else `'sdr'`).
  - **Android Media3:** emit from `Player.Listener.onVideoSizeChanged` / `onTracksChanged` (`Format.width`, `Format.height`, `Format.frameRate`, `Format.sampleMimeType`, `ColorInfo.colorTransfer` -> `ST2084` `'hdr10'`, `HLG` `'hlg'`, Dolby Vision MIME `'dv'`).
  - **Apple AetherEngine:** add `StreamVideoInfo` + `.mediaInfo(token:info:)` in `EngineTypes.swift` / `EngineCore.swift` / `EngineCore+Playback.swift`, populated from track naturalSize / nominalFrameRate / codec / HDR transfer when reported, forwarded over Expo module events.

### 2.2 `@elv/data` — Cross-Season `queryNextEpisode`
- Given `(seriesKey, currentItemKey, profileId)`:
  1. Look up current episode's `(season, episode)` in `items` (falling back to season `0`, episode `0` if omitted).
  2. Query candidate episodes in `items` for `series_key = ? AND kind = 'episode'` ordered by `(COALESCE(season, 0) ASC, COALESCE(episode, 0) ASC, sort_order ASC, key ASC)` strictly after the current episode.
  3. Left-join `watch_progress` for `profile_id` and return the first unplayed episode (`completed IS NULL OR completed = 0`); if every later episode is marked completed, return the immediate sequential next episode so rewatching still works smoothly.

### 2.3 `@elv/domain` — Preferences Additions (Within 4 KB Budget)
- `autoSubtitlesOnSkipBack: boolean` (default `false`)
- `autoPlayNextEpisode: boolean` (default `true`)
- `playerVolume: number` (default `100`, integer clamped `[0, 100]`)

### 2.4 `@elv/features` — Ports & State
- `OpenVideoEngine` adds optional `setVolume?: (volume: number) => void`, `initialVolume?: number`, `isFullscreen?: () => boolean`, `setBrightness?: (level: number) => void`.
- `PlayerScreenProps.catalog` optionally accepts `queryNextEpisode`, `epgNowNext`, `listItems` (all already present on `CatalogService`).
- `OsdTier = 'hidden' | 'progress' | 'controls'` replaces boolean `osdHidden` inside `usePlayerOverlayState` (keeping derived `osdHidden = osdTier === 'hidden'` for backwards compatibility with existing callers/tests).
- `PlayerScreen` coordinates:
  - `usePlayerNowNext` (subscribes to Live Now/Next for current channel and focused channel in `PlayerChannelDrawer`).
  - `skip-back-subtitles` controller (runs inside `usePlayerControls` on backward VOD seeks).
  - Unified `PlayerSettingsSheet` (invoked by both `⋮` Settings and `CC` / `T` Tracks buttons, opening directly to `'subtitles'` or `'audio'` view instead of mounting legacy `TrackPickerModal`).

---

## 3. Non-Goals & Invariants
- Never overlap Windows/macOS native HWND surfaces with `position: 'absolute'` overlays: desktop uses flex-flow docked `DesktopCinemaBar`, docked `PlayerChannelDrawer`, docked `PlayerSettingsSheet`, and docked `PlayerInfoSheet`.
- Never use hardcoded hex colors; derive all pills, bars, scrims, and focus rings from `useTheme()` (verified in default + High Contrast AAA).
- Never regress single-connection safety (`stopAndRelease` before starting next episode or zapping channel).
- Never leak third-party names or forbidden copy anywhere in tracked files.

---

## 4. Verification Plan
1. Strict TDD unit tests across `@elv/domain`, `@elv/data` (>= 90% coverage), `@elv/playback`, `@elv/features`, `apps/desktop`.
2. `pnpm check` (`11 passed, 0 failed`).
3. Android Gradle `:elv-engine-media3:testDebugUnitTest` (`BUILD SUCCESSFUL`).
4. Apple `elv-mac` Swift 6 `swift test --package-path modules/engine-aether/ios`.
5. Desktop Playwright E2E (`e2e/player.spec.ts`, `e2e/browse-play.spec.ts`).
6. Independent `Gemini 4 Neon (High)` whole-branch code review (`VERDICT: PASS`).
