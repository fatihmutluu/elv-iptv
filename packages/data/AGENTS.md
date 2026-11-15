# data (`@elv/data`)

Schema, migrations, importers and `CatalogService` for catalog, EPG and user data, over `@elv/domain` ports.

## Commands
- `pnpm --filter @elv/data typecheck` / `test`; `pnpm -w check` runs every repository check.

## Rules
- Pure TypeScript: no `react`, `react-native`, `expo*`, `electron` or `node:*` imports. Allowed workspace deps: `@elv/domain`, `@elv/sources`.
- Source-first (`src/index.ts`), `>= 90%` line coverage. Only `test-db.ts` and `*-test-helpers.ts` besides tests touch `better-sqlite3` or `node:*`; `@elv/data/testing` re-exports `test-db.ts`. Disk/simulator gates live in `tools/test/import-*.test.ts`.
- Inside `transaction(fn)` use only `tx`; parameterize every statement; add any new `source_id` table to `TABLES_BY_SOURCE`.

## Public surface
- `createSyncSqlDriver(db)` (`driver.ts`): serialized promise queue + `close()`, `tx` bypasses queue and rejects nesting, `ROLLBACK` guarded against SQLite auto-rollback (`SQLITE_FULL` / `SQLITE_IOERR`).
- `openCatalog(db)` (`migrate.ts`, `schema.ts`): pragmas (`WAL`, `busy_timeout=5000`, `synchronous=NORMAL`, `foreign_keys=ON`, `temp_store=MEMORY`, `journal_size_limit` 64 MiB), `MIGRATIONS` to `SCHEMA_VERSION` (`idx_import_runs_source`, `idx_placements_browse`, `idx_live_num`, `idx_episodes_series`), leftover `running` runs marked `failed/interrupted`.
- `CatalogService`, `queries.ts`, `manifest.ts` (`catalog.ts`): `createCatalogService(deps)` (`DEVICE_MAX_BODY_BYTES` 4 MiB, `DEVICE_BATCH_SIZE` 5,000), serialized `importSource` queue, `removeSource(id)` aborts queued/in-flight imports of `id` and awaits settlement before deleting rows + secrets, `close()` aborts active imports and closes `db`, `queryItems` subquery-limits `placements` before joining item tables, `resolveStream` resolves Xtream URLs or M3U templates + `headers_json` (`userAgent`, `referer`, `other`) on live/movies/episodes using a cached per-source `StreamResolver`. `reconcileManifest` restores purged cache rows on Apple platforms.
- `foldText(text)` (`fold.ts`): Turkish-aware, accent- and punctuation-insensitive folding for `name_fold`.
- `templates.ts`: `detectSegmentRules`, `toTemplate`, `resolveTemplate`, `keyTemplate`, `hostOf` (strips default `:80`/`:443`). Templates `userinfo`, credential query params, independent Xtream `/<u>/<p>/<id>` segments, high-share (`>= 99%`) token positions, mixed-account low-cardinality positions, single-URL host tokens, and bare `/<u>/<p>/<num>` pairs; literal `{{` is `{{(}}`.
- `sources.ts` & `source-link.ts`: `addXtreamSource`, `addM3uSource`, `addSourceFromLink`, `getSource`, `updateSourceSettings`, `removeSource`, `removeSecrets`, `purgeSourceRows`, `SOURCE_ID`, `TABLES_BY_SOURCE`. Credentials and guide URLs live only in `SecretStore` (`source.<id>.xtream|playlist|urlvars`).
- `stream-resolver.ts`: `createStreamResolver(sourceId, deps)` reads `urlvars` once; `resolve(template)` returns `undefined` if any placeholder is missing.
- Runs (`import-run.ts`, `runs.ts`, `import-types.ts`): one `running` run per source/kind; `beforeCommit` stages secrets prior to SQLite cleanup commit (`onAbortOrFail` rolls back); empty source fails with `empty-source`, empty kind warns `catalog/kind-empty-<kind>`.
- Xtream (`import-xtream.ts`, `writers.ts`): per-category fallback + uncapped retry on `too-large`; `loadSeriesEpisodes` re-verifies series existence and `run_id` inside the write transaction (`unknown-series` / `source-not-found`).
- M3U (`import-m3u.ts`, `m3u-rules.ts`, `m3u-templating.ts`, `writers-m3u.ts`): O(1) `VarBook` capped at `MAX_URLVARS_BYTES` (64 KiB, `source-format/urlvars-too-large`); `RuleBook` judges stream/logo/referer/header hosts separately; `headers_json` persisted on live, movies and episodes; `timeshiftDays` fallback on `live.catchup_days`; counts computed via SQL in `beforeCleanup`.
- Guide (`import-guide.ts`, `guide-match.ts`, `guide-commit.ts`): streams XMLTV into `programmes_next`, swaps mapped channels in cleanup, and runs `PRAGMA wal_checkpoint(TRUNCATE)` via `db.exec`.
