# Cinema Quietude v3 — Spotlight UI Redesign & Player Simplification

**Date:** 2026-11-28
**Status:** Approved for autonomous execution (Product Decision #41)
**Scope:** Cross-platform UI/UX evolution across Desktop (Electron), Mobile/Tablet (iOS/Android), and 10-ft TV (Android TV, Fire OS, tvOS).

---

## 1. Goals & Non-Goals

### Goals
1. Streamline global navigation chrome so browsing feels uncluttered and cinematic (4 primary text destinations + 3 right-aligned icon utilities + frosted Profile dropdown).
2. Make catalog search immediate and zero-disruption via a top-anchored frosted Search Popup overlay with 3 live catalog suggestions, 3 single-row rails (`Movies → Series → Live`), and a bare text-only `See all` link into full `SearchScreen`.
3. Elevate the Detail screen into a full-bleed spotlight stage with 6 circular actions fitted precisely to an enlarged Play CTA width, hover tooltip pills, conditional version selector slot below Play, inline `see more...` synopsis popover (only on genuine overflow), circular cast portrait rail below synopsis, and background trailer preload + idle auto-play with persisted top-right Mute/Unmute (muted by default).
4. Replace small bottom-right card hover buttons on Desktop with a portal-hosted Expanded Hover Preview Card adapted to `2:3` vertical posters (full-width Play button + `3×2` action grid including per-profile persistent `"Don't recommend again"`).
5. Simplify and super-size the Video Player OSD (~2× visual prominence), unify all track/settings flows into right-side click-outside-dismissible popups with clean 2-level hierarchy (`Altyazı` → `Altyazı ayarları`, `Ses` → `Ses ayarları`, `Gelişmiş ayarlar`), merge Mini-Player + Popout into one 2-option top-bar popup, merge Programme Info into Stats HUD, replace the floating Mini-Player corner square with OS edge/corner resize cursors, and cleanly remove unused surface complexity (Chapters, X-Ray, Always-on-top, TrackPickerModal, Player Time Display row).

### Non-Goals
- No changes to license, E2EE sync cryptography, credential storage, or stream URL build-at-play-time invariants.
- No introduction of `shell.openExternal` or weakening of Electron Fuses / top-level navigation lockdown.

---

## 2. Detailed Surface Specifications

### Wave R1 — Navigation Shell, Search Popup, Home Hero, Live Empty & Library Bottom Creator
1. **Top Navigation Bar (`AdaptiveNavShell`, `NavBars`, `app-shell-nav`):**
   - Primary destinations (left on Landscape/Desktop/TV, bottom tab bar on Portrait): strictly 4 tabs — `Home | Live | Movies | Series`.
   - Right utility cluster (strictly 3 items on all form factors):
     - `Search` (`search` icon) — opens `SearchPopupOverlay`.
     - `Library` (`bookmark` outline icon, filled/accent when active) — opens `LibraryScreen`.
     - `Profile` (circular avatar badge) — Desktop: hover OR click opens frosted `ProfileDropdownMenu` (Safe-Hover bridge + click-outside + Escape); Portrait/TV: opens adaptive Profile menu sheet/overlay.
   - Standalone Settings gear utility removed from top bar.
   - `ProfileDropdownMenu` entries:
     - `Profiles` section: list of sibling profiles (one-click switch, lock indicator if PIN-gated) + `+ Add new` action.
     - `Edit profiles` → navigates to `Settings -> Profiles`.
     - `Settings` → navigates to `Settings`.
     - `Sign out` styled in danger/red (`theme.colors.liveColor`) → signs out of sync account if signed in, or locks/exits current profile back to profile picker.
2. **Search Popup Overlay (`SearchPopupOverlay`):**
   - Top-anchored frosted overlay (`zIndex: 45`) over the active screen with click-outside backdrop + Escape/Back dismiss.
   - Search input with clear button (`Clear`), auto-focused on open.
   - While query is non-empty:
     - Up to **3 live query suggestions** extracted from matching catalog titles (prefix matches ranked first, deduplicated).
     - Up to **3 single-row horizontally scrollable rails** in strict order: `Movies` → `Series` → `Live` (omitting empty rails).
     - Bottom bare text-only `See all` button (no border, no box/holder) closing the popup and opening full `SearchScreen` with the current query.
3. **Home Hero (`HomeHero`):**
   - Remove the large rectangular secondary `Details` CTA button.
   - Render a circular `IconButton` with `'info'` icon placed **first** among the circular icon buttons right next to the primary Play CTA (`[▶ Play] (i) (+) (✓)`), preserving TV D-pad focus slot `'details'`.
4. **Live Favorites Empty State (`LiveWatchStage`):**
   - Centered vertical stack (`flexDirection: 'column', alignItems: 'center', justifyContent: 'center'`): Title → Description → `Browse channels` CTA positioned strictly beneath the description.
5. **Library Create Collection (`LibraryScreen`, `LibraryEditorialTabs`):**
   - Remove `Create collection` CTA from the top-right header row.
   - Render a quiet, restrained `Create collection` trigger at the very bottom of the `Following` (`Listem`) tab beneath all rails and all existing custom collections (and below the empty state when empty), reachable via TV D-pad from the bottommost rail.

### Wave R2 — Detail Hero Spotlight, Inline Synopsis Popup, Cast Strip & Background Trailer Auto-Play
1. **Detail Hero Geometry & Action Stack (`DetailHero`, `DetailHeroExtras`):**
   - Expanded cinematic hero height (`~74–78%` desktop viewport, bounded responsibly on smaller/portrait viewports).
   - Bottom two-column composition aligned to bottom baseline (`alignItems: 'flex-end'` on Landscape/Desktop).
   - Left column (`width: 338px` on Desktop/Landscape, `100%` on Portrait):
     - Row 1 (above Play): **6 circular icon buttons** (`48×48px`, `10px` gap → `6*48 + 5*10 = 338px`, matching Play CTA width to the exact pixel): `Trailer`, `My List`, `Like`, `Dislike`, `Watched`, `Download`. Each icon carries a crisp high-contrast hover `Tooltip` pill (`placement="top"`).
     - Row 2: Enlarged high-contrast Play CTA (`height: 54px`, `width: 100%` of `338px`).
     - Row 3 (conditional): `DetailVersionDropdown` rendered full-width (`338px`, translucent dark glass) directly below Play **only when `versions.length > 1`**. When `versions.length <= 1`, omitted so Row 1 + Row 2 naturally sit flush at the bottom baseline.
   - Right column: Metadata & Synopsis matching visual scale/hierarchy (`Genres · IMDb score · Year · Runtime · Technical badges` + synopsis).
2. **Inline Overflowing `"see more..."` Synopsis & Floating Popover (`DetailSynopsisBlock`):**
   - Measure/detect true overflow cleanly so short synopses show in full with **zero** truncation or trigger.
   - When genuinely overflowing, render word-boundary clamped prose ending inline with underlined `see more...` (`detail.seeMoreInline`).
   - Clicking `see more...` opens a floating frosted popover anchored directly **above** the synopsis block (click-outside + Escape dismiss; clean `AdaptiveSheet` fallback on Portrait/TV).
3. **Cast Strip (`DetailCastStrip`):**
   - Horizontally scrollable circular-portrait cast rail rendered directly below the synopsis/hero section with left/right scroll arrows on Desktop.
4. **Background Trailer Preload, Idle Auto-Play & Persisted Mute (`DetailHeroTrailerPreview`, `@elv/domain`, `apps/desktop/src/main/security.ts`):**
   - Add `detailTrailerMuted: boolean` (default `true`) to `PlaybackPreferences`.
   - Desktop Electron `security.ts`: keep `will-navigate`, `will-redirect`, and `setWindowOpenHandler` locked strictly to `app://elv`; allow `will-frame-navigate` strictly for canonical `https://www.youtube-nocookie.com/embed/<11-char-id>` subframes (matching existing `app-protocol.ts` CSP `frame-src`).
   - Entering Detail with a valid trailer preloads quietly after `400ms` settle and begins muted/preference-synced backdrop playback after `2500ms` idle dwell:
     - Direct MP4/HLS (`trailerStreamUrl`) on Web/Desktop: HTML5 `<video autoPlay playsInline loop preload="auto" />` layered below Cinema scrims.
     - YouTube ID (`trailerYoutubeId`) on Web/Desktop: sandboxed `youtube-nocookie.com/embed/<id>` iframe with `enablejsapi=1`, muted/unmuted dynamically via YouTube `postMessage` API (`{"event":"command","func":"mute"|"unMute","args":[]}`), `pointerEvents: 'none'`.
     - Mobile/TV: non-intrusive static backdrop fallback for YouTube-only sources and low-memory TV hardware; respects `reduceMotion`.
   - Top-right circular Mute/Unmute button fades in strictly when trailer preview is active, defaults to muted, and persists toggles into `detailTrailerMuted`.
   - Immediately tears down on Play, Trailer Modal open, navigation away, or document hidden.

### Wave R3 — Universal Desktop Hover Preview Card & "Don't Recommend Again"
1. **PosterCard Cleanup (`PosterCard`):**
   - Remove bottom-right hover quick-action buttons across Home, Movies, and Series (`PosterCard`).
2. **Persistent `"Don't recommend again"` (`@elv/data` Schema v27 + IPC + Sync):**
   - Add SQLite migration v27: `recommendation_dismissals (profile_id, item_key, kind, dismissed_at)` (`WITHOUT ROWID`).
   - Expose `dismissRecommendation`, `restoreRecommendation`, `listDismissedRecommendationKeys` on `CatalogService`, desktop IPC, and preload.
   - Filter dismissed `item_key`s from Home/discovery recommendation rails immediately and reactively; also include `"Don't recommend again"` in Mobile/TV long-press context menus.
3. **Desktop Expanded Hover Preview Overlay (`PosterHoverPreviewHost`, `PosterHoverPreviewCard`):**
   - Hosted in root overlay context inside `AppShell` so it floats freely above horizontal rail `overflow: hidden` boundaries without clipping.
   - Activates after `350ms` pointer dwell on Desktop `PosterCard` (cancelled immediately on leave or scroll), clamped cleanly within viewport margins.
   - Adapted cleanly for vertical `2:3` posters (`~272px` wide card):
     - Scaled artwork header with subtle bottom scrim.
     - Title.
     - Full-width horizontal primary **Play** CTA stretching across card width.
     - **`3 + 3` action button grid** underneath Play:
       - Row 1: `Trailer`, `My List`, `Watched`
       - Row 2: `Like`, `Dislike`, `Don't recommend again`
       (Each with crisp hover tooltip.)
     - Metadata row: `Year · IMDb score · Runtime` + 2–3 line synopsis.

### Wave R4 — Player 2× Scale, Right-Side Popups, Simplification, Removals & Mini-Player Edge-Resize
1. **Full Codebase Removals:**
   - Delete **X-Ray** (`PlayerXRayStrip.tsx`, `usePlayerXRay.ts`, `player-xray-model.ts`, tests, props, i18n).
   - Delete **Chapters** from player settings menu, seekbar ticks (`VodProgressBar`, `DesktopPeekStrip`), and transport prev/next chapter buttons.
   - Delete **Always-on-top** (`alwaysOnTop`) across player UI, shortcuts, desktop main/preload/shared IPC (`window-ipc.ts`), renderer bridge, tests, and i18n.
   - Delete **`TrackPickerModal.tsx`**; top-bar Audio & Subtitle icons open right-side `PlayerSettingsSheet` directly to `'audio'` / `'subtitles'`.
   - Remove **`Time display` (`Süre gösterimi`)** row from player `⋮` settings menu.
   - Remove standalone **`Programme info` (`PlayerInfoSheet`)** row/overlay and merge live Now/Next programme + stream quality badges directly into **`PlayerStatsHud`**.
2. **~2× OSD Control Scale & Top-Bar Cleanup (`PlayerOsdButton`, `PlayerOsdTopBar`, `DesktopCinemaBar`, `VodProgressBar`):**
   - Bold, effortless player icons (~1.7–2× scale on Desktop/TV, responsive safe scale on narrow mobile): top-bar icons `52px` (`iconSize: 28`), bottom skip ±10s `68px` (`iconSize: 42`), center Play/Pause `80px` (`iconSize: 40`), larger scrubber track/thumb & timestamps.
   - Top bar keeps dedicated **Audio** (`audio`) and **Subtitles** (`subtitles`) icons; **Multi-View** moves off the top bar into `⋮`; **Mini-Player + Popout** merge into a single top-bar icon opening a 2-option floating popup (`Mini player` / `Separate window`, click-outside dismissible).
3. **Click-Outside Dismiss & Streamlined 2-Level `⋮` Menu (`PlayerSettingsSheet`, `settings-sheet-items`, `settings-menu-nav`):**
   - Desktop right-side popups render inside a full-screen wrapper (`dialogRef` on outer wrapper so `useDesktopDialogTrap` never marks the backdrop `inert`) with a full-screen dismiss `Pressable` backdrop: clicking anywhere outside immediately closes the open popup.
   - `⋮` root keeps strictly essential items: `Subtitles`, `Audio`, `Playback speed` (VOD), `Aspect ratio`, `Multi-View`, `Sleep timer`, `Playback stats`, `Advanced settings` (plus `Video quality` / `Quality variant` only when multiple variants exist).
   - `Subtitles` view lists subtitle tracks + a single bottom **`Subtitle settings`** button opening a unified single-tab `subtitleSettings` view (delay + appearance/style + secondary subtitle + external file/URL) with top-left `←` back arrow returning to `subtitles`.
   - `Audio` view lists audio tracks + **`Audio settings`** button (delay + output device + normalization + pitch lock) with top-left `←` back arrow returning to `audio`.
   - `Advanced settings` (`view: 'advanced'`, top-left `←` back arrow returning to `root`) houses technical toggles: Deinterlace, Video Decoder, Audio Normalization, Pitch Lock, Auto-Play Next Episode, PiP (where supported).
4. **Floating Mini-Player Native OS Edge-Resize (`FloatingMiniPlayerChrome`, `mini-player-geometry`):**
   - Remove the visible corner square resize handle (`mini-player-resize-handle` / `resizeGripDot`).
   - Add 8 invisible edge & corner hit strips (`top`, `bottom`, `left`, `right`, `top-left`, `top-right`, `bottom-left`, `bottom-right`) with OS-native CSS cursors (`ns-resize`, `ew-resize`, `nwse-resize`, `nesw-resize`) performing smooth aspect-locked `16:9` resizing anchored to the opposite edge/corner.

---

## 3. Verification & Quality Gates
- Strict TDD per wave (`RED -> GREEN -> REFACTOR`), keeping all files `<= 800` lines (target `<= 760`).
- Every wave passes full `pnpm check` (`0 failed`), independent whole-branch review, and all 4 GitHub CI checks before squash-merge into `main`.
- Final deliverable: fresh Windows production NSIS installer verified by `tools/src/verify-desktop-package.ts`.
