# Catalog import — Design

- Status: approved (owner delegated Round 1 decisions on 2026-11-13)
- Date: 2026-11-13
- Issues: #9 (import half) and #25 (import half). Builds on `2026-11-13-source-scanners-design.md` and ADR 0011.
- Foundation spec: §4 (Data), §5.3, §5.4, §6.1, §6.2. ADR 0005 (data layer).

## 1. Why
The scanners and the Xtream client turn a provider into records; nothing stores them yet. The app needs a local catalog
that a 1 GB TV stick can fill from a 115k-entry provider in under a minute without freezing the UI, that survives a failed
or cancelled refresh without losing what it had, that keeps favorites and progress attached to the same item when a
provider changes passwords or tokens, and that never writes credentials into the database (spec §5.4). A real panel probe
showed why the last two need care: its playlist URLs carry a per-account token segment that is constant across every entry.

## 2. Goals
- Store live channels, movies, series, episodes, categories and guide data per source in SQLite, through a `SqlDriver` port
  that op-sqlite (native) and better-sqlite3 (Electron, tests) both implement.
- Import incrementally: every run upserts with a run id and removes stale rows only after it succeeds; a failed or
  cancelled run leaves the previous catalog usable.
- Keep credentials out of the database: Xtream items store provider ids; M3U items store URL templates whose secret parts
  (credentials, token parameters, per-source constant segments) live in a `SecretStore`, and are rebuilt at play time.
- Stable content keys across refreshes and credential changes (ADR 0011, refined in §5.5).
- Guide import with channel matching by guide id, then by folded name, inside a configurable window.
- Yield to the host between batches so the UI thread stays responsive, report progress, and honour cancellation.

## 3. Non-goals
- App wiring: the op-sqlite driver, the Electron utility process, the two-connection reader/writer setup, secure-storage
  adapters and the dev seeder are the next spec (catalog on devices, with #10).
- Search (FTS5) and sorting UIs: Round 2. This spec stores a folded name column so search needs no re-import.
- User tables (favorites, progress, profiles): added by their features with `profile_id` (spec §5.4).
- Category selection before the first import, catch-up, Stalker: later issues.

## 4. Approaches considered
1. **Run-id upserts into the live tables, stale-row delete on success (chosen).** Research 13's recommendation; no copy of
   the catalog, small transactions, readers keep working, failure leaves old rows plus already-upserted fresh rows (both
   valid).
2. Staging tables swapped in at the end. Rejected: doubles storage for 100k+ rows on small devices and needs a long
   exclusive swap.
3. One transaction per import. Rejected: a multi-minute write lock and a huge WAL on TV sticks; cancellation discards
   everything.

## 5. Design

### 5.1 Ports (`packages/domain`)
- `SqlDriver`: `exec(sql)` (DDL, multi-statement), `run(sql, params?) → { changes }`, `all<T>(sql, params?)`,
  `batch(sql, rows: SqlValue[][])` (one prepared statement, many parameter rows, one transaction), and
  `transaction(fn)`. All return promises; `SqlValue` is `string | number | null | Uint8Array`.
- `SecretStore`: `get(key)`, `set(key, value)`, `delete(key)`, all async; values are strings.
- `Scheduler`: `yieldNow(): Promise<void>` — lets the host run UI work between batches.
- Existing ports reused: `HttpClient`, `Decompressor`, `Result`/`ElvError`.

### 5.2 Drivers (`packages/data`)
- `createSyncSqlDriver(db)` adapts a synchronous better-sqlite3-shaped database (duck-typed: `prepare`, `exec`,
  `transaction`) to `SqlDriver`; it is the Electron and test driver. better-sqlite3 is a dev dependency of `data` for tests
  only (the Electron app adds it as a runtime dependency in the next spec). The op-sqlite adapter comes with the app wiring.
- Pragmas applied on open by `openCatalog(driver)`: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`,
  `temp_store=MEMORY`, then migrations.

### 5.3 Schema (version 1, raw SQL, `PRAGMA user_version`)
- `sources(id TEXT PK, kind, name, created_at, settings_json)` — non-secret settings: transport (User-Agent, Referer,
  Xtream format), user guide URL override, `vodPlaylist` flag for M3U, URL-template rules.
- `import_runs(id INTEGER PK, source_id, kind 'catalog'|'guide', started_at, finished_at, status
  'running'|'ok'|'failed'|'cancelled', error_category, error_code, counts_json)`.
- `categories(source_id, kind 'live'|'movie'|'series', provider_id, name, name_fold, position, run_id)`, PK
  `(source_id, kind, provider_id)`.
- `live(id INTEGER PK, source_id, key, provider_id, num, name, name_fold, logo, guide_id, catchup_days, url_template,
  headers_json, run_id)`, unique `(source_id, key)`.
- `movies(id INTEGER PK, source_id, key, provider_id, name, name_fold, logo, rating, year, extension, added, url_template,
  run_id)`, unique `(source_id, key)`.
- `series(id INTEGER PK, source_id, key, provider_id, name, name_fold, cover, plot, rating, year, last_modified, run_id)`,
  unique `(source_id, key)`.
- `episodes(id INTEGER PK, source_id, key, series_key, season, episode, title, extension, duration_sec, url_template,
  run_id)`, unique `(source_id, key)`.
- `placements(source_id, kind, item_key, category_id, position, run_id)`, PK `(source_id, kind, category_id, item_key)`
  — many-to-many membership (`category_ids`), provider order kept in `position`.
- `guide_channels(source_id, guide_id, name, name_fold, icon, run_id)`, PK `(source_id, guide_id)`.
- `channel_guide(source_id, channel_key, guide_id)`, PK `(source_id, channel_key)` — computed mapping.
- `programmes(source_id, guide_id, start, stop, title, sub_title, description, categories_json, episode_num, icon, run_id)`,
  PK `(source_id, guide_id, start)` `WITHOUT ROWID`.
- Indexes only for the access paths Round 1 uses: category browse `(source_id, kind, category_id, position)`, live by
  `num`, programmes by `(source_id, guide_id, start)`. Each index has an `EXPLAIN QUERY PLAN` test.
- Deleting a source deletes its rows in every table and its secrets.

### 5.4 Text folding
`foldText(s)`: lower-cases with explicit Turkish rules (`İ`→`i`, `I`→`ı`, then `ı`→`i` for matching), strips combining
marks after NFD, maps `ß`→`ss`, collapses whitespace and punctuation to single spaces, trims. Pure, tested, no `Intl`.
Used for `name_fold` and guide name matching.

### 5.5 Credentials and content keys
- **Xtream sources:** server, username and password go to the `SecretStore` (`source:<id>:xtream`). Items store
  `provider_id` and `extension`; URLs are built at play time by the Xtream client (`streamUrl`). Keys: `xtreamKey`.
- **M3U sources:** the playlist URL is a secret (`source:<id>:playlist`). Entry URLs are stored as templates:
  1. Known credential query parameters (ADR 0011 list) and Xtream-shaped `/<kind>/<u>/<p>/` segments become placeholders.
  2. URL-template rule detection on the first 1,000 entries of the first import: a path position whose value is identical
     for at least 99 % of entries on the same host and at least 8 characters long is a source secret (the real panel's
     per-account token). Detected rules are stored in `settings_json`, their values in the `SecretStore`
     (`source:<id>:urlvars`), and reapplied on later imports; a changed value updates the secret, not the keys.
  3. Templates look like `https://host/{{v0}}/<stream token>`; `resolveStreamUrl(source, template)` rebuilds the URL.
  Keys: `m3uKey(sourceId, template, name)` — stable across password and token changes. This refines ADR 0011 (update it).
- Logos and guide URLs that carry credentials are templated the same way.
- **Pasted links (owner decision 17):** an M3U link of the Xtream form (`…/get.php?username=…&password=…`) is added as an Xtream source (`addSourceFromLink`), because on a real panel the M3U cannot tell movies from live channels while the Xtream API gives categories, movies, series and the guide. The server is normalized like the Xtream client does, `output` sets `xtreamFormat`, a user guide override is kept (templated, tried before the panel guide), `vodPlaylist` is ignored, credentials go only to the `SecretStore`, and the user can choose to keep the link as an M3U source.

### 5.6 Import engine (`packages/data`)
- `importCatalog(sourceId, deps, opts?: { signal?, onProgress?, batchSize? })` and `importGuide(…)` return
  `Promise<Result<ImportSummary>>`; `deps = { db, http, secrets, scheduler, clock, decompressor? }`.
- A run: insert `import_runs` row → stream records → upsert in batches (default 500 rows, one `batch` per table per
  batch) → `scheduler.yieldNow()` after each batch → on success delete rows of this source with another `run_id` in every
  catalog table (guide: programmes outside the window and of other runs), mark `ok` with counts → on error mark `failed`
  with the `ElvError` category/code, on abort `cancelled`; never delete on failure.
- **Xtream catalog:** account check, categories (3 calls), then live, VOD and series lists; per-category calls when a
  whole-list response would exceed the client's size cap (fall back automatically on `source-format/too-large`).
  Episodes: Xtream episodes are fetched lazily by `loadSeriesEpisodes(sourceId, seriesKey, deps)` when a series is opened
  and stored then (4,000+ `get_series_info` calls at import time would be abusive).
- **M3U catalog:** `scanM3u` over the playlist (`baseUrl` = playlist URL); `kindHint` decides live/movie/episode unless the
  source is flagged `vodPlaylist` (then everything is a movie); episodes get a synthetic series per `group-title`; groups
  become categories in first-seen order.
- **Guide:** URL from Xtream `guideUrl()`, M3U header `url-tvg`/`x-tvg-url` (first that answers), or the user override.
  Channels arrive before programmes in XMLTV: the engine maps each guide channel (exact `guide_id` match first, else a
  unique folded-name match against live channels; ambiguous names are skipped) and grows the scanner's `channels` set
  so unmatched programmes are never decoded (the scanner consults the set per programme). Window default 1 day back and
  7 days forward (`settings_json` override).
- Progress events: `{ phase, done, total? }` at most every batch; summaries carry counts per table and warning counts.

### 5.7 Budgets
- Node with better-sqlite3 (CI, integration through the simulator): `large` catalog (100k entries) imported end to end in
  ≤ 20 s; `large` guide (7 days × 5,000 channels) in ≤ 60 s; heap growth reported. Device budgets (spec §6.2) are measured
  by the gates on TV emulators.
- No single synchronous step longer than one batch; `yieldNow` between batches.

## 6. Testing
- Unit tests in `packages/data` with better-sqlite3 in-memory databases: migrations, folding, template rules, key
  stability under credential/token changes, upsert/stale-delete semantics, failure and cancel keep old rows, guide
  matching (id, folded name, ambiguous), window pruning, `EXPLAIN QUERY PLAN` for each index.
- Integration tests in `tools/test/` against `startSim()`: demo, quirks (dedupe, `category_ids`, null guide ids, token-like
  per-account segments), compat, expired and failing sources; a second import after the simulator changes its catalog
  removes stale rows; cancellation mid-import leaves the previous catalog intact.
- Budget tests as in §5.7; the opt-in `SIM_HUGE=1` benchmark imports the `huge` catalog and reports time and heap.
- Coverage ≥ 90 % lines for `data` and the new `domain` modules.

## 7. Constraints
- `data` stays pure (no `node:*`, `react*`, `expo*`, `electron`); better-sqlite3 is imported only by tests (dev dependency;
  `pnpm-workspace.yaml` `allowBuilds` must allow it).
- Raw SQL only (Drizzle is for synced user tables later, ADR 0005); every statement parameterized.
- No credentials, tokens or playlist URLs in the database, logs or error details.
- Files ≤ 400 lines; exported APIs documented; `packages/data/AGENTS.md` and ADR 0011 updated.

## 8. Left to the builder
Exact column types and nullability beyond the listed columns, batch sizes per table, progress event cadence, migration
file layout, and the placeholder syntax, as long as §6 holds.
