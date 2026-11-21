# Round 2 Slice 7 — SQLite Scale Performance, Conditional 304 EPG/Playlist Downloads, XMLTV Interval Safety, Series-Grouped Continue Watching & Exact/Prefix FTS5 Ranking

## 1. Objective
Harden `@elv/sources`, `@elv/data`, and the stream simulator (`tools/src/sim`) for 100k+ catalog scale, zero wasted guide/playlist bandwidth, corrupt-provider resilience, cleaner Home screen curation, and instant exact/prefix-prioritized Turkish-aware search (`#66`, `#113`, `#125`, `#149`, `#193`, `#288`).

## 2. Deliverables & Engineering Contracts

### 2.1 Conditional HTTP Downloads (`ETag` / `Last-Modified` -> `304 Not Modified`, `#66`)
- **`SourceSettings.httpCache` (`packages/data/src/sources.ts`):**
  - Store non-secret HTTP cache validators (`{ etag?: string; lastModified?: string }`) in `sources.settings_json` keyed strictly by opaque slot names (`playlist`, `guide:0`, `guide:1`, etc.) — **never** persisting raw URLs or credentials.
- **`import-guide.ts` & `import-m3u.ts`:**
  - Send `If-None-Match` (when `etag` present) and `If-Modified-Since` (when `lastModified` present) alongside source `transportHeaders`.
  - On HTTP `304 Not Modified`: close/discard the empty body cleanly, keep all existing catalog/guide tables untouched, record a completed `import_runs` row with `unchanged: 1` (zero DB rewrite!), and return `ok({ ..., unchanged: true })` (additive optional `unchanged?: boolean` on `ImportSummary`).
  - On HTTP `2xx`: persist response `etag` / `last-modified` validators ONLY after the import transaction commits cleanly. Servers omitting validators continue performing full downloads normally.
- **Stream Simulator (`tools/src/sim/routes-data.ts`):**
  - Emit deterministic weak/strong `ETag` + `Last-Modified` headers on `/xmltv.php`, `/guides/*.xml`, `/guides/*.xml.gz`, `/get.php`, and `/playlists/*.m3u` derived from `(seed, route/profile, variant, guide-day-bucket)`.
  - Answer `304 Not Modified` with `0` body bytes when `If-None-Match` or `If-Modified-Since` matches.

### 2.2 XMLTV `stop <= start` Guard (`#288`)
- **`packages/sources/src/xmltv.ts` (`XmltvScanner.programme`):**
  - Reject and warn `'programme-bad-time'` whenever `stop !== undefined && stop <= start` so zero-length or negative-duration intervals never reach downstream importers.
- **`packages/data/src/import-guide.ts` (`closeOpen`):**
  - Ensure every staged programme row satisfies `stop > start`: when closing an open-ended programme `prev` on the arrival of `p`, if `p.start <= prev.start`, skip closing with an invalid `<= prev.start` boundary and never stage `stop <= start` rows into `programmes_next`.

### 2.3 Cross-Channel EPG Index & Grouped Category Counts (`#113`)
- **SQLite Migration v4 (`packages/data/src/schema.ts`):**
  - Add `CREATE INDEX IF NOT EXISTS idx_programmes_source_start_stop ON programmes (source_id, start, stop);` for fast cross-channel active-window EPG queries.
- **Grouped Category Counts (`packages/data/src/queries.ts`):**
  - Replace the per-row correlated `COUNT(*)` subquery in `queryCategories` with a single grouped `LEFT JOIN (SELECT category_id, COUNT(*) AS n FROM placements WHERE source_id = ? AND kind = ? GROUP BY category_id) p ON p.category_id = c.provider_id`.
  - Benchmark against 50,000+ placements confirming zero correlated subquery and `< 25 ms` execution.

### 2.4 Series-Grouped Continue Watching & Sort Title Key (`#125`)
- **`listContinueWatching` (`packages/data/src/user-state.ts`):**
  - Deduplicate multiple in-progress episodes of the same series in SQL via `ROW_NUMBER() OVER (PARTITION BY COALESCE(series_key, item_key) ORDER BY updated_at DESC, item_key ASC) = 1` so each series shows at most ONE most-recent actionable resume card on Home, while standalone movies (`series_key IS NULL`) remain individual entries.
- **`sortTitleKey(name)` (`packages/data/src/fold.ts`):**
  - Pure helper returning a folded sort key that strips leading articles (`the`, `a`, `an`, `bir`) when followed by remaining words (falling back to the full folded title if the title consists solely of an article).

### 2.5 Exact/Prefix-Ranked FTS5 Search & 8-Token Cap (`#149`, `#193`)
- **`packages/data/src/search.ts`:**
  - Lower `MAX_SEARCH_TOKENS` from `12` to `8` (`#193`) to bound FTS5 scan work on long pasted queries.
  - Rank each section (`live`, `movies`, `series`) by:
    1. Exact folded match (`t.name_fold = ?`) -> tier `0`
    2. Prefix folded match (`substr(t.name_fold, 1, length(?)) = ?`) -> tier `1` (wildcard-safe!)
    3. Token match -> tier `2`
    ordered by `tier ASC, bm25(fts) ASC, t.name ASC`.
  - Verify Turkish (`İstanbul`, `Şampiyon`, `Çınar`) exact > prefix > token ranking and `< 10 ms` latency on 25,000 rows.

## 3. Verification Plan
- Strict TDD across `@elv/sources`, `@elv/data`, and `tools`.
- Full `pnpm check` (`11 passed, 0 failed`), Desktop prod bundle hygiene (`WORKBENCH_HITS=0`), Windows Electron E2E (`browse-play.spec.ts` + `catalog.spec.ts`), and independent `Gemini 4 Neon (High)` whole-branch review (`VERDICT: PASS`).
