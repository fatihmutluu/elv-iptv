# Wave C1 — Minimalist Cinema Player OSD Overhaul & Core Playback Polish

> **Issues:** Minimalist Cinema Player UI Overhaul (`Product Decision #40`), `#124`, `#208`, `#393`, `#160`, `#118`, `#355`, `#310`
> **Parent Epics Advanced:** Closes `#337` (Playback Core, Recovery & Controls), advances `#333` & `#347`
> **Design Contract:** `docs/design/UI_UX_PHILOSOPHY.md` (Cinema Quietude v2 + Minimalist Cinema Player OSD)

---

## 1. Visual Architecture — Minimalist Cinema Player OSD

### 1.1 Unified Layout Across All Form Factors (`Desktop`, `TV`, `Tablet`, `Phone`)
The player overlay recedes completely behind the frame when hidden and floats transparently over soft top/bottom scrims when active:
- **Top Bar (`player-osd-top`, transparent over `Scrim direction="top"`, zero outer box/border):**
  - **Left:** Bare `close` (`×`) icon (`variant="bare"`, zero resting box/border, subtle translucent hover/focus wash) + stacked title column: bold high-contrast primary title (`osd-title`, `24–28px` desktop/TV, `20px` phone) and clean secondary subtitle directly beneath (`osd-subtitle` for VOD episode/year or `osd-now-programme` for Live TV). Quiet live indicator pill only for Live TV.
  - **Right:** Bare horizontal icon action strip (`variant="bare"` — crisp icons with zero resting borders/boxes, soft translucent circle on hover/active/TV-focus):
    - `subtitles` (`player-tracks-button`, opens audio/subtitle track picker)
    - `audio` / `volumeMute` (`player-mute-button` + sleek inline hover/click volume popover slider on desktop)
    - `aspect` (`player-aspect-button`, cycles `Fit` / `Fill` / `Stretch` on all platforms including desktop)
    - `fullscreen` / `fullscreenExit` (`player-fullscreen-button`, desktop)
    - Bare tabular speed badge (`1x` / `1.25x` etc., `player-speed-button`, VOD)
    - `dots` (`⋮`, `player-settings-button`, opens 2-level Settings popover / portrait bottom sheet hosting Subtitles, Audio, Speed, Aspect, Sleep Timer, Ends At mode, Stats HUD, Always-on-Top, Touch Lock, Stream Info)
    - On Portrait Phone: cap top-right bare strip to `Subtitles`, `Lock`, `⋮` so the title never truncates awkwardly; everything else lives cleanly in the bottom sheet.
- **Center Canvas (`flex: 1`):**
  - **Completely unobstructed video (~70% open frame).** Zero center Play/Pause cluster covering the scene! Only renders a subtle buffering spinner when buffering or compact error recovery card when failed.
- **Bottom Bar (`player-osd-bottom`, transparent over `Scrim direction="bottom"`, zero outer box/border):**
  - **Row 1 — Full-Width Hairline Timeline (`VodProgressBar`):**
    - Left tabular timestamp (`00:31`, `player-progress-time-current`, `tabular-nums`)
    - Full-width thin hairline track (`flex: 1`, `3px` resting -> `5px` active/hover/TV-focus, high-contrast crisp white fill via `theme.colors.textPrimary` over translucent white track, subtle circular **chapter marker dots** along the track `#118`, hover/scrub floating timecode + chapter title pill, touch fine-scrubbing zoom `#355`)
    - Right tabular timestamp (`20:52`, `player-progress-time-end`, interactive press/toggle cycling `Total` -> `-Remaining` -> `Ends at HH:MM` `#160`; also retains `player-progress-time` accessibility summary)
    - On Live TV: hairline programme progress bar + start/end or `Ends at HH:MM` + quiet `Jump to live` action when lagging behind live TS edge.
  - **Row 2 — Transport Row (directly beneath scrubber):**
    - Left balance flex slot (`flex: 1`, optional quiet `Prev Channel` / `Jump to live` button on Live TV, or Prev/Next Chapter trigger when chapters exist)
    - Center transport trio (`player-bottom-transport`, centered):
      - Bare **`skipBack10`** (`⟲ 10` vector icon, `player-seek-back`)
      - **Circular translucent dark-glass `||` / `▶` Play/Pause button** (`variant="glass-primary"`, `48px` desktop/mobile, `54px` TV, subtle `theme.colors.actionGlassBg` translucent circle + crisp white `play`/`pause` icon, TV focus ring without garish solid white fill)
      - Bare **`skipForward10`** (`⟳ 10` vector icon, `player-seek-forward`)
      - *(Live TV: `player-prev`, circular Play/Pause or Reload, `player-next`)*
    - Right CTA anchor (`flex: 1`, `alignItems: 'flex-end'`):
      - VOD Series with next episode: sleek dark-glass pill (`variant="pill-cta"`, `borderRadius: 6`, `actionGlassBg` + hairline `actionGlassBorder`): **`Next Episode` / `Sonraki Bölüm`** (plus countdown indicator when in end-of-episode Next Up window).
      - Live TV: sleek dark-glass pill **`Channels` / `Kanallar`** (opens slide-out Channel + EPG drawer).
- **Desktop Presentation Mode (`overlayMode: 'floating' | 'docked'`):**
  - `OpenVideoEngine` exposes optional `overlayMode?: 'floating' | 'docked'` and `onOverlayModeChange?: (cb: (mode: 'floating' | 'docked') => void) => () => void`.
  - When desktop uses in-canvas rendering (`presenter.kind === 'canvas'` / `coversArea === false` — default on Windows D3D11, macOS IOSurface, and Web Workbench): `overlayMode === 'floating'` renders the full-bleed transparent scrim cinema overlay directly over `<PlayerCanvas>`.
  - When desktop falls back to a legacy child HWND (`coversArea === true`): `overlayMode === 'docked'` splits the exact same minimalist top bar and bottom bar cleanly above and below `player-desktop-stage` in flex layout (never `position: 'absolute'`) so native child HWND is never occluded.

---

## 2. Shared Type Contracts (Pinned for Parallel Workers)

### 2.1 `@elv/domain` Preferences (`packages/domain/src/preferences*.ts`)
```ts
export type SubtitleModePref = 'default' | 'smart' | 'onlyForced' | 'always' | 'off';
export type OsdTimeDisplayMode = 'total' | 'remaining' | 'endsAt';
export type SleepTimerAction = 'stop' | 'pause';

// Added to ExtendedPreferencesFields & PreferencesSnapshot (all with safe defaults):
preferredAudioLanguages: readonly string[];     // default: [] (max 5 normalized ISO-639 codes; syncs [0] <-> preferredAudioLang)
preferredSubtitleLanguages: readonly string[];  // default: [] (max 5 normalized ISO-639 codes; syncs [0] <-> preferredSubtitleLang)
preferDefaultAudioTrack: boolean;               // default: true
preferHevcOverDolbyVision: boolean;             // default: false
filterSdhSubtitles: boolean;                    // default: false
osdTimeDisplayMode: OsdTimeDisplayMode;         // default: 'total'
oledScreensaverTimeoutMin: number;              // default: 0 (0 = off; presets: 0, 5, 10, 15, 30)
stillWatchingTimeoutMin: number;                // default: 0 (0 = off; presets: 0, 60, 120, 180, 240)
sleepTimerDefaultAction: SleepTimerAction;      // default: 'stop'
```
*(Backward compatibility: legacy `'auto'` parses as `'smart'`, `'none'` parses as `'off'`; non-empty legacy `preferredAudioLang` / `preferredSubtitleLang` seeds the 1-element array when the array field is absent.)*

### 2.2 `@elv/data` SQLite Migration v9 (`track_preferences`, `#208`)
- `MIGRATION_V9` (`PRAGMA user_version = 9`):
```sql
CREATE TABLE track_preferences (
  profile_id TEXT NOT NULL DEFAULT 'default',
  scope_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  audio_lang TEXT,
  audio_label TEXT,
  sub_lang TEXT,
  sub_label TEXT,
  sub_disabled INTEGER NOT NULL DEFAULT 0,
  audio_delay_ms INTEGER NOT NULL DEFAULT 0,
  sub_delay_ms INTEGER NOT NULL DEFAULT 0,
  resize_mode TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_id, scope_key)
) WITHOUT ROWID;
CREATE INDEX idx_track_preferences_source ON track_preferences (source_id);
```
- Exported types & `CatalogService` methods:
```ts
export interface PersistedTrackPreference {
  readonly profileId: string;
  readonly scopeKey: string;
  readonly sourceId: string;
  readonly audioLang: string | null;
  readonly audioLabel: string | null;
  readonly subLang: string | null;
  readonly subLabel: string | null;
  readonly subDisabled: boolean;
  readonly audioDelayMs: number;
  readonly subDelayMs: number;
  readonly resizeMode: 'fit' | 'fill' | 'stretch' | null;
  readonly updatedAt: number;
}
export interface SaveTrackPreferenceInput {
  readonly scopeKey: string;
  readonly sourceId: string;
  readonly profileId?: string;
  readonly audioLang?: string | null;
  readonly audioLabel?: string | null;
  readonly subLang?: string | null;
  readonly subLabel?: string | null;
  readonly subDisabled?: boolean;
  readonly audioDelayMs?: number;
  readonly subDelayMs?: number;
  readonly resizeMode?: 'fit' | 'fill' | 'stretch' | null;
}
// On CatalogService:
getTrackPreference(scopeKey: string, profileId?: string): Promise<PersistedTrackPreference | null>;
saveTrackPreference(input: SaveTrackPreferenceInput): Promise<void>;
clearTrackPreference(scopeKey: string, profileId?: string): Promise<void>;
```
- Wire `track_preferences` into `schema-expected.ts`, `sources.ts` (`TABLES_BY_SOURCE` + `finishDeletingSource`), `user-state-backup.ts`, and Electron `catalog-ipc` + `catalog-worker` + `desktop-catalog`.

### 2.3 `@elv/playback` Additions (`#118`, `#124`, `#160`, `#208`, `#310`, `#393`)
- **Chapters (`#118`):**
  - `export interface ChapterInfo { readonly id: string; readonly title?: string; readonly startMs: number; readonly endMs?: number; }`
  - `EngineEvent` union adds `{ readonly attempt: AttemptToken; readonly type: 'chapters'; readonly chapters: readonly ChapterInfo[]; }`
  - `PlaybackState` adds `readonly chapters?: readonly ChapterInfo[]`
- **Diagnostic Telemetry (`#160`):**
  - `StreamVideoInfo` adds optional `readonly droppedFrames?: number`
  - `EngineEvent` union adds `{ readonly attempt: AttemptToken; readonly type: 'telemetry'; readonly droppedFrames?: number }` (or merges into `mediaInfo` / `StreamVideoInfo` cleanly)
- **Load Options (`#124`, `#310`):**
  - `LoadOptions` adds optional `readonly filterSdhSubtitles?: boolean` (alongside existing `preferHevcOverDolbyVision?: boolean`).
  - `TuneRequest` adds optional `readonly preferHevcOverDolbyVision?: boolean`, `readonly filterSdhSubtitles?: boolean`.
  - `ladder.ts`: decoder errors (`budget.lastError?.code === 'decoder'`) enable `preferHevcOverDolbyVision: true` on Rung 2+ recovery reloads as well as Rung 4.
- **Deterministic Track-Selection Resolver (`#393` + `#208`):**
  - Export `resolveInitialTrackSelection(tracks: MediaTracks, rules: TrackSelectionRules): InitialTrackSelection` in `packages/playback/src/track-selection.ts`:
    - Precedence: `sessionOverride` -> `targetOverride` -> `persistedItemPref` (`#208`, audio and subtitle modalities evaluated independently) -> `profileRules` (`#393`: `preferredAudioLanguages`, `preferDefaultAudioTrack`, `preferredSubtitleLanguages`, `subtitleMode: 'default' | 'smart' | 'onlyForced' | 'always' | 'off'`).
    - Language normalization uses `@elv/domain`'s `normalizeLanguageCode` + `extractLanguageCodeFromLabel`.
    - `smart` mode compares against the **effective chosen audio language** (step 1 result, never stale `tracks.selectedAudioId`).
    - Returns `{ audioId?: string; subtitleId?: string | null }` where explicit `null` disables text subtitles (avoiding Media3 `CaptioningManager` fallthrough).
- **Pure SDH Filter (`#310`):**
  - Export `stripSdhAnnotations(text: string): string` in `packages/playback/src/sdh-filter.ts`:
    - Strips balanced `[...]` and `(...)` annotations across single/multi-line cues while preserving purely numeric/year expressions like `(2024)`, `(1999)`, `(1–2)`.
    - Strips Unicode uppercase speaker labels (`\p{Lu}` with zero `\p{Ll}`, Turkish `İ/Ş/Ğ/Ü/Ö/Ç` safe, preserving RTL uncased text, timestamps `10:30`, prose `Note:`) after optional dialogue dashes (`- `, `– `, `— `) and bidi isolates.
    - Preserves `- ` multi-line dialogue dashes, drops lines reduced to whitespace/lone dashes/lone music symbols (`♪`/`♫`), returns `''` when entire cue becomes empty so renderers suppress empty cue boxes.

### 2.4 Native Engine Touchpoints (`#124`, `#160`, `#118`, `#310`)
- **Android Media3 (`modules/engine-media3`):**
  - Forward `filterSdhSubtitles` on `LoadRequest` -> `Media3Engine` -> `SubtitleSanitizer.stripSdhAnnotations()` applied inside `sanitizeCues()` *after* ASS/HTML stripping & mojibake cleanup, dropping cues that become empty.
  - Emit dropped video frame counts from `PolicyVideoRenderer` / `EventReporter` onto `mediaInfo` / `telemetry` events (`#160`).
- **Apple AetherEngine (`modules/engine-aether`):**
  - Forward `filterSdhSubtitles` on `LoadRequest` -> `EngineCore` -> `SubtitlePresentation.stripSdhAnnotations()` applied to `.text` / `.richText` cues (never `.image`), omitting blank cues.
  - Report dropped frame count from player access log / playback metrics when available (`#160`), and chapter markers when exposed (`#118`).
- **Desktop `mpv` & Canvas (`apps/desktop`):**
  - Fix `PlayerCanvas.tsx` container DAR rendering using `frame.displayWidth ?? frame.codedWidth` and `frame.displayHeight ?? frame.codedHeight` (`#124`).
  - Add `setResizeMode('fit' | 'fill' | 'stretch')` and `setFilterSdh(enabled)` over `mpv` IPC (`keepaspect`/`panscan`/`video-aspect-override`, `sub-filter-sdh=yes|no`) plus `preferHevcOverDolbyVision` load option handling (`#124`, `#310`).
  - Observe `chapter-list` (`#118`) and `frame-drop-count` (`#160`) in `mpv` telemetry/track snapshot and forward `chapters` / `droppedFrames` events to renderer.
  - Wire `overlayMode: 'floating' | 'docked'` from presenter events in `apps/desktop/renderer/src/App.tsx`, and upgrade `mock-video-host.tsx` with chapters, speed, mute/volume, fullscreen, mediaInfo, and `'floating'` overlay mode for real visual verification!

---

## 3. Verification Gates
1. Strict TDD across every package (unit + component tests covering all acceptance criteria and edge cases).
2. `pnpm check` (`11 passed, 0 failed`).
3. Android Gradle `:elv-engine-media3:testDebugUnitTest`.
4. `elv-mac` Swift 6 `swift test` + Xcode 26.4.1 iOS & tvOS compile check.
5. **Browser visual verification** of the redesigned Minimalist Cinema Player OSD on `pnpm dev:ui` (`PC`, `TV`, `Phone Portrait`) via `browser` subagent screenshot inspection!
6. Independent whole-branch review by `Gemini 4 Neon (XHigh)` (`VERDICT: PASS`) + all GitHub Actions CI checks green before squash-merge and closing `#124`, `#208`, `#393`, `#160`, `#118`, `#355`, `#310` + parent Epic `#337`!
