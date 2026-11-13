# data (`@elv/data`)

Schema, migrations and repositories for catalog, EPG and user data, over the `SqlDriver` port.

## Commands
- `pnpm --filter @elv/data typecheck` type-checks this package.
- `pnpm --filter @elv/data test` runs its Vitest tests.
- `pnpm -w check` runs every repository check.

## Rules
- Pure TypeScript: no `react`, `react-native`, `expo*`, `electron` or `node:*` imports.
  Platform access goes through ports defined in `@elv/domain`.
- Source-first: `exports` points at `src/index.ts`; there is no build step.
- Allowed workspace dependencies: `@elv/domain` and `@elv/sources`.
- Tests live beside the code as `*.test.ts`.

## Public surface (catalog import round)
- `createSyncSqlDriver(db)` in `driver.ts` adapts a synchronous better-sqlite3-shaped database to `SqlDriver`.
  Every call goes through one promise queue, so a `transaction` never interleaves with other statements; the `tx`
  passed to its callback bypasses the queue and rejects nested `transaction` calls. Do not await the outer driver
  inside a transaction callback (it would wait for itself). `batch` joins an open transaction.
- `openCatalog(db)` in `migrate.ts` applies the open pragmas (`journal_mode=WAL`, `synchronous=NORMAL`,
  `foreign_keys=ON`, `temp_store=MEMORY`) and migrates to `SCHEMA_VERSION` using `MIGRATIONS` in `schema.ts` (raw SQL,
  `PRAGMA user_version`). A newer database yields `storage/schema-too-new`; a failed migration rolls back and yields
  `storage/migration-failed`. Add a schema change as a new `MIGRATIONS` entry, never by editing an old one.
- `foldText(text)` in `fold.ts`: Turkish-aware, accent- and punctuation-insensitive folding for `name_fold` columns.
- `templates.ts`: `detectSegmentRules`, `toTemplate`, `resolveTemplate`. URLs become `{{name}}` templates (`user`, `pass`,
  `userinfo`, `v<N>` segment rules, `q:<param>` credential query values); the values go to the secret store. Known
  credentials (>= 3 chars) are masked raw and percent-encoded wherever they occur; rules and whole-segment matches skip
  the last path segment; literal `{{` is escaped as `{{(}}`. Keys are
  `m3uKey(sourceId, template, name)`.
- `sources.ts`: `addXtreamSource`, `addM3uSource`, `getSource`, `updateSourceSettings`, `removeSource`, `removeSecrets`, `TABLES_BY_SOURCE`, `secretKey`.
  `removeSource` returns `storage/secret-delete-failed` when a secret could not be deleted (rows are already gone; retry
  `removeSecrets`). M3U guide URLs are templated against the playlist or kept whole as a secret (`{{g:url}}`).
  Credentials live only in the `SecretStore` (`source:<id>:xtream|playlist|urlvars`); `settings_json` holds none.
  There are no foreign keys, so `removeSource` deletes from every table of the source explicitly; a new table with
  `source_id` must be added to its list.
- `src/test-db.ts` (test helper, not exported): `testDb()`, `memorySecrets()`, `countingScheduler()`. better-sqlite3 is a
  dev dependency imported only by this helper and tests.
- `importCatalog(sourceId, deps, opts?)` and `loadSeriesEpisodes(sourceId, seriesKey, deps)` in `import-xtream.ts`
  (`import-types.ts` holds `ImportDeps`, `ImportOptions`, `ImportProgress`, `ImportSummary`). A run (`runs.ts`:
  `startRun`, `finishRun`, `removeStale`) upserts with `INSERT ... ON CONFLICT DO UPDATE ... run_id = excluded.run_id`
  (`writers.ts`), so row ids stay stable; `scheduler.yieldNow()` follows every batch and `signal.aborted` is checked
  before every batch. Stale rows of every catalog table are deleted, and the run is marked `ok`, in one transaction
  only after success; failure (`failed`) and abort (`cancelled`, error `network/aborted`) never delete. Only the error
  category and code reach `import_runs`. Xtream: account check first (before any catalog write), then categories, live,
  movies, series; on `source-format/too-large` a list falls back to per-category calls. Placement `position` is the
  provider order within its category. Episodes are not fetched at import: `loadSeriesEpisodes` stores one series on
  demand (keeping row ids) and the next successful import keeps the episodes of series that still exist. M3U sources
  return `source-format/unsupported-source` until the M3U importer lands.
