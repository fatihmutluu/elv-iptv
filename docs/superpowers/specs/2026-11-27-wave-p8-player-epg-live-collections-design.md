# Wave P8 Design Spec — VOD Seek Bar, EPG Live Clock, Live Favorites Split Player & Folder Collections

> **Issues:** `#507` (VOD seek bar, EPG now-line clock, Live Favorites split player), `#508` (Folder-style collections, minimalist Detail action row, Movies/Series sub-tabs, Home My List & layout defaults)
> **Design Contract:** `docs/design/UI_UX_PHILOSOPHY.md` (Cinema Quietude v2 — zero hardcoded hex, zero RN `<Modal>` on TV, desktop HWND-safe docked overlays, `max_connections = 1` single-connection live handoff, zero DVR/competitor copy)
> **Date:** 2026-11-27

## 1. Goals & Scope

Wave P8 polishes daily playback, EPG orientation, live favorites watching, and VOD curation across Desktop (Windows/macOS/Linux), Mobile/Tablet (Android/iOS), and 10-ft TV (Android TV/Fire OS/tvOS):

1. **Standardized VOD Seek Bar (`#507`, `[1.15]`):**
   - Remove `osdTimeDisplayMode` from Playback Settings, `DEFAULT_PREFERENCES`, `SYNCABLE_PREFERENCE_KEYS`, and `PlayerScreen` persistence props (while keeping legacy persisted JSON keys safely ignored in `parsePreferences` / `sanitizeInitialPreferencesPatch`).
   - Standardize VOD seek bars across Desktop (floating + docked), Mobile, and TV to show **elapsed time on the left** and **remaining time on the right** by default (`20:09 [===] 24:49`), with tabular numerals and descriptive screen-reader labels.
   - Clicking/pressing the right timestamp silently toggles local display between **remaining** and **total duration** (2-mode toggle, zero toast or Settings entry).

2. **EPG Time-Ruler Live Clock Pill (`#507`, `[1.26]`):**
   - Remove the standalone top-left `epg-live-clock` from `EpgTimeRuler`'s navigation header to reclaim vertical grid space.
   - Anchor the live clock badge directly on `epg-ruler-track` centered horizontally over the vertical `epg-now-line` (`nowLineRatio`, edge-clamped so it never clips off `0%` / `100%`), respecting `epgShowClock`, `fontScale`, and `direction: 'ltr'`.
   - Automatically hide any underlying half-hour ruler tick label (`epg-tick-*`) whose horizontal bounding box collides with the live clock pill.

3. **Live -> Favorites Full Split Player (`#507`, `[1.31]`):**
   - Remove the top `actionBar` (`[≡]`, `[★]`, white `▶ Watch Live`) from `LiveWatchStage` so the embedded live video fills upward cleanly.
   - Move the `★` favorite toggle onto the right edge of every channel row in `LiveZapDrawer` (`LiveZapRow`), stopping event propagation so toggling `★` never tunes the channel.
   - Equip the embedded live player pane with full player controls (Play/Pause, Mute + Volume slider, Fullscreen toggle button + double-click on video surface to enter fullscreen, Aspect ratio, Audio/Subtitles track picker, Multi-View, Popout/PiP, `⋮` overflow settings, desktop keyboard shortcuts) while preserving `max_connections = 1` single-connection release/handoff and desktop child-HWND docked layout safety.

4. **Minimalist Detail Action Row, Folder Collections, Movies/Series Sub-Tabs & Home My List (`#508`, `[1.48]`, `[1.49]`):**
   - **Detail Hero:** Remove collection buttons and `CollectionPickerOverlay` from `DetailHero` / `DetailScreen`. Render strictly minimalist circular icon buttons (`★`, `👍`, `👎`, `✓` on movies, `↓` when supported) above the full-width Play CTA.
   - **Library -> Following Folder Collections:**
     - Enforce **max 1 collection per item per profile** in SQLite (`vod-collections-repo.ts`: `addItemToCollection` atomically removes `itemKey` from any sibling collection in the same profile and bumps `updated_at` on both collections).
     - Add top-right **Create collection** CTA in `Library -> Following`.
     - Render empty custom collections as visible folder sections (with empty hint, Rename, and Delete actions); hide general `Live` / `Movies` / `Series` rails when empty.
     - Exclude collected items from general `Movies` / `Series` rails (`partitionFavoritesForLibrary`); deleting a collection leaves `favorites` intact so starred items reappear in general rails.
     - Support moving items into/between/out of collections via both **context menu** and **pointer drag-and-drop** (including onto empty collection sections).
   - **Movies & Series Sub-Tabs:** Remove `Watched` filter (`catalog-filter-watched`); keep `All | My List` plus an opt-in `ELV Picks` slot gated cleanly for ELV Mode (hidden when ELV Mode is off).
   - **Home Screen:** Exclude Live TV channels from Home `My List` (`kind === 'movie' || kind === 'series'`), set `DEFAULT_HOME_LAYOUT` to `['continue', 'newEpisodes', 'live', 'movies', 'series', 'mylist', 'collections']`, and remove the Home "Manage collections" button (`CollectionManagerOverlay` removed if unreferenced).

## 2. Architecture & Verification

- Pure-package coverage remains `>= 90%`; file hard limit `<= 800` lines; zero circular dependencies; zero unused Knip exports; EN/TR i18n parity across TS and `.po` catalogs.
- Full verification via `pnpm check` (`11 passed, 0 failed`) plus independent whole-branch `Gemini 4 Neon (High)` code review before merge.
