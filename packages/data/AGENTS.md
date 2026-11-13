# data (`@elv/data`)

Schema, migrations and repositories for catalog, EPG and user data, over the `SqlDriver` port.

## Commands
- `pnpm --filter @elv/data typecheck` and `... test` type-check and test this package.
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
- `test-db.ts`, `import-test-helpers.ts` (test helpers, not exported): `testDb()`, `memorySecrets()`, `setup()`, `setupM3u()`; better-sqlite3 only there and in tests.
- `importCatalog` / `loadSeriesEpisodes` (`import-xtream.ts`; types in `import-types.ts`; `runs.ts`, `writers.ts`). A run
  upserts with `ON CONFLICT DO UPDATE ... run_id = excluded.run_id` (stable row ids), yields after every batch, checks
  `signal.aborted` before every batch. Stale rows (`run_id < current`) are deleted and the run marked `ok` in one
  transaction, only after success; failure (`failed`) and abort (`cancelled`, `network/aborted`) never delete. Only
  error category and code reach `import_runs`. `startRun` refuses a second `running` run of the same source and kind
  (`storage/import-in-progress`); `openCatalog` marks leftover `running` runs `failed/interrupted`. `onProgress`
  exceptions are ignored. Xtream: account check first, then categories, live, movies, series; `source-format/too-large`
  falls back to per-category calls; placement `position` is provider order within the category. Episodes load on
  demand (`loadSeriesEpisodes`) and survive re-imports while their series exists.
- M3U (`import-m3u.ts`, `m3u-templating.ts`, `writers-m3u.ts`; run lifecycle `performRun` in `import-run.ts`): entry URLs, logos
  and live referers are templates (rules from the first 1,000 entries, majority value expected, minority stays
  literal; clashing values get `~<n>`); `kindHint` picks the table, episodes sit under a synthetic series per `group-title`;
  `url-tvg` goes to `settings_json.discoveredGuideUrls`; no header and no entries is `source-format/not-a-playlist`.
