# Wave C4A Design Spec — Expanded FTS5 Search & A–Z Alphabetical Jump Rail (`#397`, `#407`)

## Scope
Implements the catalog-scale search and navigation batch of Wave C4 on top of `MIGRATION_V11`:
1. **`#397` — Expanded FTS5 Search & Idle Suggestions:** Extend SQLite FTS5 indexing and queries to EPG programmes, series episodes, and movie/series cast & director metadata with Turkish diacritic folding, grouped result sections (`Channels`, `On Now & Guide`, `Movies`, `Series`, `Episodes`), and on-device idle search suggestions.
2. **`#407` — A–Z Alphabetical Jump Rail:** Fast SQLite prefix-bucket offset index (`#`, `A–Z`) with Turkish folding and an unobtrusive, TV D-pad and pointer/touch-friendly alphabetical jump rail for Movies, Series, and Live Channels when sorted alphabetically and `total >= 40`.

## Architecture & Schema (`MIGRATION_V12`)

### 1. Sources (`@elv/sources`)
- Extend Xtream VOD (`get_vod_streams`, `get_vod_info`) and Series (`get_series`, `get_series_info`) parsers to extract optional `cast?: string` (accepting `cast` or `actors`, trimmed, bounded `<= 512` chars) and `director?: string` (`<= 256` chars).

### 2. Data & SQLite (`@elv/data`, `SCHEMA_VERSION = 12`)
- **Cast & Director columns:** Add `cast_text TEXT`, `director_text TEXT`, `cast_fold TEXT`, `director_fold TEXT` to `movies`, `movies_next`, `series`, `series_next`. Populate folded columns via `foldText()` during Xtream import and detail refresh; hydrate `cast` & `director` in `ItemDetailRow`.
- **Upgraded `movies_fts` & `series_fts`:** Drop & recreate external-content FTS5 tables indexing `(name_fold, cast_fold, director_fold)` (`content='movies'`/`'series'`, `content_rowid='id'`, `tokenize='unicode61'`) with updated `_ai`/`_ad`/`_au` triggers and `'rebuild'`. Rank via `bm25(..., 4.0, 1.5, 1.5)` so title hits outrank cast/director hits.
- **Episodes FTS5 (`episodes_fts`):** Add `title_fold TEXT NOT NULL DEFAULT ''` to `episodes` & `episodes_next`, backfill existing rows via JS `foldText()` (Turkish-accurate), and create external-content `episodes_fts(title_fold, content='episodes', content_rowid='id', tokenize='unicode61')` with `_ai`/`_ad`/`_au` triggers.
- **Standalone EPG FTS5 (`programmes_fts`):** Because `programmes` is `WITHOUT ROWID`, external-content FTS5 is invalid. Create standalone:
  ```sql
  CREATE VIRTUAL TABLE IF NOT EXISTS programmes_fts USING fts5(
    source_id UNINDEXED,
    guide_id UNINDEXED,
    start UNINDEXED,
    stop UNINDEXED,
    title_fold,
    description_fold,
    tokenize='unicode61'
  );
  ```
  - Maintained atomically inside `guide-commit.ts` (`DELETE FROM programmes_fts WHERE source_id = ?` + bulk insert alongside `programmes`).
  - Purged in `sources.ts` (`finishDeletingSource` / `purgeSourceRows`) so deleted sources leave zero orphan FTS rows.
  - Guarded in `schema-expected.ts` (`verifyAndHealSchema`): **never** issue `VALUES('rebuild')` on standalone `programmes_fts`; verify existence and repopulate from `programmes` via JS `foldText()` if empty while `programmes` has rows.
- **Expanded `CatalogService.search` & `searchSuggestions`:**
  - `SearchScope`: `'all' | 'live' | 'epg' | 'movie' | 'series' | 'episode'`.
  - Grouped result sets (`live`, `epg`, `movies`, `series`, `episodes`) with bounded per-group limits, active/upcoming EPG hits (`stop >= nowMs`) ranked ahead of past programmes and joined to non-hidden `live` channels.
  - `searchSuggestions(opts?)`: bounded on-device picks from favorites, continue watching / recent channels, and top non-hidden categories (zero network calls).
- **A–Z Alphabet Index (`CatalogService.alphabetIndex`):**
  - Single SQLite `GROUP BY` query over `substr(t.sort_title, 1, 1)` mapped to `'#'` vs `'A'..'Z'` with cumulative offsets matching exact `ORDER BY t.sort_title ASC, t.key ASC`, category `placements`, `is_hidden = 0`, and Wave C3 `collapseVariants` / `groupVersions` filters. Supports both single-source and all-sources scopes.

### 3. Desktop IPC (`apps/desktop`)
- Forward expanded `SearchScope`, `SearchResult` (`epg`, `episodes`), `searchSuggestions`, and `alphabetIndex` cleanly across `catalog-ipc.ts`, `catalog-ipc-guards.ts`, `catalog-bridge.ts`, `catalog-worker-runtime.ts`, `workbench-rpc.ts`, `desktop-catalog.ts`, `mock-catalog.ts`, and `remote-catalog.ts`.

### 4. UI Kit, Features & i18n (`@elv/ui-kit`, `@elv/features`, `@elv/i18n`)
- **Cinema Quietude v2 compliance:** Zero hardcoded hex colors, zero RN `<Modal>` on TV, tabular numerals, 100% EN/TR Lingui parity.
- **`SearchScreen` (`#397`):**
  - Scope tabs (`All`, `Channels`, `On Now & Guide`, `Movies`, `Series`, `Episodes`) and scannable grouped result sections.
  - Idle state shows recent searches (with one-click Clear History) + on-device quick suggestions (TV D-pad reachable).
  - Pressing an airing EPG hit tunes the channel; pressing an upcoming EPG hit opens programme info (with Tune Channel action); pressing an episode hit launches/navigates directly to that episode.
- **`AlphabetJumpRail` (`#407`):**
  - Compact `#`, `A–Z` jump rail in `@elv/ui-kit` rendered on Movies, Series (`CategoryGridView`), and Live Channels (`LiveChannelsGrid`, adding `Default | A–Z` sort toggle) ONLY when `sortBy === 'alpha'` AND `total >= 40`.
  - Touch/pointer scrub + click jump directly to target row offset without loading intermediate pages; TV D-pad enters/exits predictably without trapping focus.

## Verification
- Pure packages (`@elv/sources`, `@elv/data`) maintain `>= 90%` line coverage with Turkish diacritic folding, `WITHOUT ROWID` `programmes_fts` commit/purge/heal tests, cast/director/episode ranking tests, and alphabet offset alignment tests (including deduplicated variants/versions).
- `pnpm check` passes `11 passed, 0 failed`.
- Independent whole-branch review (`VERDICT: PASS`) and green GitHub CI.
