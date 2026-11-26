# Issue #502 — Remove Series Unplayed Count Badge & Surface Newly Arrived My List Episodes on Home

Date: 2026-11-26
Issue: #502 (Epic #335)
Status: Approved (autonomous execution)

## Scope

### Part A — Remove Top-Right Series Episode Count Badge
- Remove the numeric unplayed episode count pill (`unplayedCount` / `unplayedLabel`) from top-right of `PosterCard` across Home, Movies/Series Catalog rails & grids, Quick Filter grids, and Detail Related rails.
- Preserve the clean `allWatched` success checkmark badge (`-watched-badge`) when a movie or series is completely watched.
- Update `resolveSeriesBadgeProps` (`packages/features/src/shared/useSeriesUnplayedCounts.ts`), `PosterCard.tsx`, feature callers, and tests cleanly (zero unused exports).

### Part B — Newly Arrived Episodes for My List Series (`#502`)
1. **SQLite Migration v22 (`packages/data/src/schema-v22.ts`, `schema.ts`, `schema-expected.ts`):**
   - `my_list_series_baselines(profile_id, series_key, source_id, baseline_at, last_checked_at, known_keys_json)` — stores per-profile baseline episode keys for favorited series.
   - `my_list_new_episodes(profile_id, episode_key, series_key, source_id, series_title, series_logo, season, episode, episode_title, detected_at, dismissed)` — stores detected newly arrived episodes for active My List series.
   - Cleanup hooks on `removeSource` and `setFavorite(..., false)` / `toggleFavorite` removal.
2. **Baseline Capture, Detection & Provider-Polite Refresh (`packages/data/src/my-list-new-episodes.ts`, `catalog.ts`, `import-xtream.ts`):**
   - Adding a series to My List captures existing cached episode keys as baseline (`baseline_at = now` if cached episodes exist, or `baseline_at = 0` pending first refresh so old episodes are never flagged as new).
   - `reconcileMyListNewEpisodes(db, profileId, seriesKey?, clock)` diffs current `episodes` against baseline `known_keys_json`:
     - If `baseline_at === 0` and episodes now exist, establishes baseline cleanly without false positives.
     - Otherwise, any newly discovered episode key not already `watched = 1` in `watch_progress` is inserted into `my_list_new_episodes` and added to `known_keys_json`.
     - Prunes entries whose episodes no longer exist in `episodes` or whose series is no longer in `favorites`.
   - `refreshMyListNewEpisodes(profileId?, opts?: { cooldownMs?, maxSeries?, force? })` on `CatalogService`:
     - Bounded per-pass refresh (default max `10` stale favorited series, default `30m` cooldown) for Xtream/Stalker sources via `loadSeriesEpisodes` (`get_series_info`), followed by `reconcileMyListNewEpisodes` (which also picks up newly imported M3U episodes!).
   - `listMyListNewEpisodes(limit?, profileId?, opts?: { parentalUnlocked? })`:
     - Returns active, undismissed, unwatched (`COALESCE(wp.watched, 0) = 0`) new episodes for current My List series, respecting parental locks, ordered newest first (`detected_at DESC, season DESC, episode DESC`).
     - Automatically excludes any episode as soon as it is finished during playback or marked as watched!
   - `dismissMyListNewEpisode(episodeKey, profileId?)`: marks `dismissed = 1`.
   - Wired through `createProfileScopedCatalog`, `createObservedCatalog`, and Desktop Catalog IPC (`catalog-ipc*.ts`, `catalog-worker-user-state.ts`, `catalog-bridge.ts`, `desktop-catalog.ts`).
3. **Home Screen Rail & `homeLayout` Integration (`@elv/domain`, `@elv/features`):**
   - Add `'newEpisodes'` to `HOME_LAYOUT_SECTION_IDS` (`packages/domain/src/home-layout.ts`) directly after `'continue'`, preserving `MAX_PREFERENCES_BYTES = 4096`.
   - Render **`New episodes` / `Yeni bölümler`** (`16:9` wide rail with `NEW` / `YENİ` micro-pill, series title + `S#E# — Episode Title`) on `HomeScreen` when >= 1 unwatched new episode exists.
   - Trigger bounded background `refreshMyListNewEpisodes` from `useHomeData` ONLY when playback is NOT active (`!isPlaybackActive`) so `max_connections = 1` is never disrupted.
   - Right-click / long-press `ContextMenu` actions: **Play**, **Go to details**, **Mark as watched** (optimistically removes card + calls `setWatched`), **Dismiss** (optimistically removes card + calls `dismissMyListNewEpisode`).
   - Add `New episodes` row to Settings -> Appearance -> `HomeLayoutEditor` (wireframe preview, toggle, reorder, TV D-pad).

## Verification
- Strict TDD unit & component tests across `@elv/domain`, `@elv/data`, `@elv/ui-kit`, `@elv/i18n`, `@elv/features`, `@elv/desktop`.
- `pnpm.cmd check`: `11 passed, 0 failed`.
- Independent `Gemini 4 Neon (High)` whole-branch code review before PR merge.
