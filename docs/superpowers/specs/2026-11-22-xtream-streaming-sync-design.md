# Streaming Xtream Parser, Content-Hash Re-Sync Diffing, Key-Cursor Pagination & ABR Hysteresis Spec

**Date:** 2026-11-22  
**Issues:** `#76`, `#192`, `#176`, `#197`  
**Packages:** `@elv/sources`, `@elv/data`, `@elv/playback`, `@elv/desktop` (IPC guard)  
**Status:** Accepted

## 1. Goals

Eliminate JS main-thread stalls and redundant SQLite write amplification on large IPTV catalogs while making concurrent import progress strictly monotonic, browse pagination drift-free, and adaptive quality switching oscillation-free:

1. **Incremental streaming Xtream JSON parser (`#76`):**
   - Implement `streamXtreamRecords(body, opts)` in `packages/sources/src/xtream-stream.ts` to incrementally parse top-level JSON arrays (`[ {...}, ... ]`) and numeric-keyed PHP object maps (`{ "0": {...}, "1": {...} }`) directly from streaming `Uint8Array` chunks (with `normalizeBomChunks` UTF-16/UTF-32 BOM transcoding) in `O(batchSize)` memory without buffering an entire 70+ MB catalog body into one contiguous string.
   - Preserve every compatibility hardening rule from `xtream.ts` / `xtream-json.ts`: early `<` HTML captive-portal rejection (`source-format/invalid-json`), `maxBodyBytes` enforcement when configured (`source-format/too-large`), `null`/`false`/`{}` empty handling, `{ user_info: ... }` auth failure extraction, Windows-1254/CP1252 fallback decoding, PHP `\'` and control-character/lone-surrogate repairs, trailing commas, and truncated trailing array recovery.
   - Expose `streamLiveStreams`, `streamVodStreams`, and `streamSeries` on `XtreamClient` (sharing mirror failover, 429 cooldown, and per-host token bucket pacing before the first batch is yielded).
   - Consume streaming batches in `packages/data/src/import-xtream.ts` with cooperative `scheduler.yieldNow()` per batch and first-wins duplicate-ID / placement deduplication matching `mergeById`.

2. **Monotonic parallel Xtream catalog import progress (`#197`):**
   - Add optional `fraction?: number` (`[0, 1]`) to `ImportProgress` (and accept it in Desktop's `isImportProgress` IPC guard).
   - Implement `createMonotonicProgressMeter()` (`packages/data/src/import-progress.ts`) tracking weighted progress across concurrent stages (`categories`, `live`, `movies`, `series`, `cleanup`), clamping overall `fraction` with a monotonic high-water mark and per-phase `done` monotonically regardless of completion order or unknown streaming totals.
   - Parallelize Xtream category fetches (`live`/`movie`/`series`) and catalog list streams (`live`/`movie`/`series`) using a linked `AbortController` so any failure or caller abort immediately cancels sibling requests with zero socket leaks.

3. **Content-hash diffing during catalog re-sync (`#192`):**
   - **Schema Migration v7 (`schema-v7.ts`):** Add `content_hash TEXT` to `categories`, `categories_next`, `live`, `live_next`, `movies`, `movies_next`, `series`, and `series_next` (updating `EXPECTED_TABLE_COLUMNS`).
   - Compute deterministic 64-bit FNV-1a hex hashes (`packages/data/src/content-hash.ts`, pure JS with zero `node:*` imports) over all persisted fields in `writers.ts` and `writers-m3u.ts`.
   - In `catalog-commit.ts`:
     - Guard `ON CONFLICT DO UPDATE` with `WHERE <tbl>.content_hash IS NULL OR excluded.content_hash IS NULL OR <tbl>.content_hash != excluded.content_hash` (and `WHERE placements.position != excluded.position` for `placements`) so unchanged rows incur **zero SQLite `UPDATE`s**, zero FTS5 trigger evaluations, and minimal WAL/flash wear while preserving `id`, `is_hidden`, and original `run_id`.
     - Delete stale removed rows before `purgeStagedCatalog` via indexed `NOT EXISTS (SELECT 1 FROM <tbl>_next ... WHERE run_id = ?)` lookups (and prune orphaned `episodes` whose `series_key` no longer exists when `episodes_next` is not staged), eliminating unnecessary `run_id` writes on unchanged rows while keeping `emptiedKinds` and `keepKinds` semantics intact.

4. **Key-cursor pagination & anti-oscillation ABR hysteresis (`#176`):**
   - **Data (`packages/data/src/queries.ts`, `queries-all-sources.ts`):** Add drift-free key-cursor pagination APIs alongside existing `(offset, limit)` callers:
     - `queryItemsByCursor(db, categoryId, cursor, limit)` keyed by `(position, itemKey)` backed by `idx_placements_visible`.
     - `queryCatalogByIdCursor(db, sourceId, kind, afterId, limit)` keyed by `id > afterId` backed by PK `id`.
     - `queryAllSourcesItemsByCursor(db, kind, cursors, limit, sourceIds)` keyed per-source by `(nameFold, id)`.
   - **Playback (`packages/playback/src/abr-hysteresis.ts`):** Add a pure, clock-injected `createAbrHysteresisController` enforcing conservative step-down (`downgradeSafetyFactor`, `stepDownCooldownMs`, immediate severe-rebuffer step-down), sustained-recovery step-up (`upgradeSafetyFactor`, `sustainedRecoverySamples`, `sustainedRecoveryWindowMs`, `stepUpCooldownMs`, single-step ascent), and full sample-window / cooldown reset on `reset()`, `onPause()`, `onBackground()`, and `onTune()`.

## 2. Invariants & Verification

- Pure packages (`@elv/sources`, `@elv/data`, `@elv/playback`) keep zero forbidden imports and `>= 90%` line coverage.
- Re-importing an unchanged catalog executes zero `UPDATE`s against unchanged live `categories`/`live`/`movies`/`series`/`placements` rows while still updating modified rows and deleting removed rows.
- `pnpm check` passes (`0 failed`).
