# Sources, Atomic Import, SQLite Lifecycle & Search Hardening Design

- Date: 2026-11-22
- Issues: `#417`, `#418`, `#138`, `#432`, `#201`, `#149`, `#193`, `#113`
- Scope: `@elv/domain`, `@elv/data`, `apps/tv-mobile`, `apps/desktop`

## 1. Problem Statement
1. **Redirect security & base URL loss (`#417`):** `createFetchHttpClient` only enables manual hop-by-hop redirects when credential headers exist, allowing URL-credential requests (`?token=`, `?password=`, `user:pass@host`) to fall back to `redirect: 'follow'` (leaking custom headers cross-origin) and dropping the post-redirect `finalUrl` needed to resolve relative playlist URLs.
2. **Non-atomic catalog imports (`#418`):** `importM3u` and `importXtream` write directly into live catalog tables (`categories`, `live`, `movies`, `series`, `episodes`, `placements`). Mid-run failures, aborts, or secret errors leave live tables half-mutated and fire FTS5 triggers prematurely.
3. **SQLite open fragility, delete ordering & iOS prewarm (`#138`):** `createOpSqliteDriver` leaks the `writer` handle if `reader` or pragma init throws, lacks transient busy/locked open retries, opens SQLite immediately during iOS background prewarm (`0xdead10cc` hazard), and `removeSource` deletes all rows in one unchunked tx without aborting in-flight `loadSeriesEpisodes`.
4. **SQLite state, search & stable identity bugs (`#432`, `#201`, `#149`, `#193`, `#113`):**
   - `loadSeriesEpisodes` runs outside `SerializedImportQueue`.
   - `setItemWatched` uses plain `UPDATE` (no-op on unplayed items); `saveWatchProgress` resets `watched = 1` back to `0` on rewatch; `listContinueWatching` leaks `duration_ms = 0` entries.
   - `m3uKey` embeds the stream URL and raw title, breaking favorites and progress across provider URL/token rotations.
   - Catalog/search SQL queries lack `is_hidden = 0` filtering, bounded `LIKE` fallback when strict FTS5 `AND`-prefix finds 0 rows, per-source multi-source browse quotas, and a benchmarked cross-channel EPG time-slice query over `idx_programmes_source_start_stop`.

## 2. Schema Migration v5 (`MIGRATIONS[4]`)
- **Staging tables (`#418`):** `categories_next`, `live_next`, `movies_next`, `series_next`, `episodes_next`, `placements_next` (mirroring live columns plus optional `legacy_key TEXT` on `live_next`/`movies_next`/`episodes_next` for atomic M3U key remapping; purged in `onAbortOrFail`, `reapOrphanedRuns`, and `TABLES_BY_SOURCE`).
- **Ordered deletion flag (`#138`):** `ALTER TABLE sources ADD COLUMN deleting INTEGER NOT NULL DEFAULT 0` (filtered out of `listSources`/`sourceExists`; finished automatically by `reapOrphanedRuns` on reopen after crash).
- **SQL hidden filtering (`#149`):** `ALTER TABLE <categories|live|movies|series|placements> ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0` + covering visible browse index `idx_placements_visible ON placements (source_id, kind, category_id, is_hidden, position)`. All `ON CONFLICT DO UPDATE` upserts preserve existing `is_hidden`.

## 3. Component Contracts

### 3.1 HTTP Redirect Hardening (`#417`, `@elv/domain` + `@elv/data`)
- `createFetchHttpClient` uses manual hop-by-hop redirect resolution (`redirect: 'manual'`, max 10 hops) unconditionally for default/follow requests: rejects non-HTTP(S) redirect targets, discards intermediate bodies, strips credential headers (`Authorization`, `Proxy-Authorization`, `Cookie`) cross-origin, and returns `finalUrl: string` on `HttpResponse`.
- `openPlaylist` (`import-m3u.ts`) passes `response.finalUrl` into `scanM3u(..., { baseUrl })`.

### 3.2 Deterministic URL-Free M3U Keys (`#201`, `#432`, `@elv/domain` + `@elv/data`)
- `m3uStableKey({ sourceId, kind, tvgId, name, group, occurrence })` in `packages/domain/src/content-key.ts`:
  - Non-empty trimmed `tvgId` -> `m:${sourceId}:${kind}:t:${tvgId.trim().toLowerCase()}`
  - Otherwise folded `name` + `group` -> `m:${sourceId}:${kind}:n:${foldedName}|${foldedGroup}`
  - Duplicate occurrence `> 1` -> suffix `#${occurrence}`
  - Keeps `m:<sourceId>:...` prefix so `sourceOfKey()` remains fully compatible.
- Legacy `m3uKey` stays exported for automatic atomic remap during M3U staged commit (`watch_progress`, `favorites`, `channel_guide`) so existing user favorites/progress migrate cleanly with zero loss.

### 3.3 Atomic Staged Shadow Swap (`#418`, `@elv/data`)
- `importM3u` and `importXtream` stage rows exclusively into `*_next` tables during `execute()`.
- `performRun`'s final commit transaction atomically: (1) remaps legacy M3U user-state keys if present, (2) upserts staged rows into live tables preserving existing `id` (FTS5 `content_rowid='id'` & `seasons(seriesId)`) and `is_hidden`, (3) removes stale live rows (`run_id < ?`) honoring `emptiedKinds`, and (4) purges `*_next` for `sourceId`.
- `onAbortOrFail` and `reapOrphanedRuns` purge all `*_next` tables cleanly; zero live mutations occur on failed/aborted runs.

### 3.4 SQLite Open Retry, Budgeted Source Delete & iOS Prewarm Deferral (`#138`)
- `createOpSqliteDriver` (`apps/tv-mobile/src/storage/sql-driver.ts`): `try/catch` closes partial `writer`/`reader` handles on pragma/open failure + bounded retry (`3` attempts with backoff) on transient busy/locked errors.
- `apps/desktop/src/utility/catalog-worker-runtime.ts`: bounded retry/backoff on transient SQLite open failure with handle cleanup.
- `apps/tv-mobile/src/App.tsx`: on `Platform.OS === 'ios'`, defers `openSharedCatalog()` until `AppState.currentState === 'active'` (`0xdead10cc` safety).
- `removeSource` (`packages/data/src/sources.ts` + `catalog.ts`): marks `sources.deleting = 1`, aborts active imports and in-flight `loadSeriesEpisodes`, deletes catalog/EPG/staging tables in budgeted batches, and commits user state (`watch_progress`, `favorites`) + `sources` row deletion atomically last. `reapOrphanedRuns` resumes purging any `deleting = 1` source after crash.

### 3.5 SQLite State, FTS5 Search, Multi-Source Quotas & Cross-Channel EPG (`#432`, `#149`, `#193`, `#113`)
- `SerializedImportQueue` (`import-queue.ts`): supports `'series-episodes'` lane so `CatalogService.seasons()` serializes `loadSeriesEpisodes` and aborts cleanly on `removeSource`.
- `user-state.ts`: `setItemWatched` performs UPSERT (hydrating catalog metadata when unplayed, safe no-op when unmarking nonexistent row or unknown item); `UPSERT_PROGRESS` keeps `watched = MAX(watch_progress.watched, excluded.watched)` and returns persisted `watched`; `listContinueWatching` filters `AND duration_ms > 0`.
- `search.ts`: filters `is_hidden = 0` in SQL before `LIMIT/OFFSET`; adds bounded `LIKE '%tok%'` fallback on `name_fold` when FTS5 strict `AND`-prefix returns 0 hits (obeying `MAX_SEARCH_TOKENS = 8`); verified at 100k-row scale.
- `queries.ts`: filters `is_hidden = 0` in `queryItems` and `queryCategories` grouped counts; adds `queryAllSourcesItems` (`floor(limit / sourceCount)` quota with remainder redistribution when smaller sources exhaust early).
- `guide-queries.ts`: adds `queryCrossChannelEpgSlice` backed by `idx_programmes_source_start_stop` verified via `EXPLAIN QUERY PLAN`.

## 4. Verification Plan
- Strict TDD tests for every issue (`>= 90%` pure-package coverage), `EXPLAIN QUERY PLAN` check on `idx_programmes_source_start_stop`, 100k-row search token-cap test, full `pnpm check` (`11 passed, 0 failed`), independent `Gemini 4 Neon (High)` whole-branch review, and CI green.
