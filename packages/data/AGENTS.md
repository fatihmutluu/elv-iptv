# data (`@elv/data`)

Schema, migrations and repositories for catalog, EPG and user data, over the `SqlDriver` port.

## Commands
- `pnpm --filter @elv/data typecheck` / `test`; `pnpm -w check` runs every repository check.

## Rules
- Pure TypeScript: no `react`, `react-native`, `expo*`, `electron` or `node:*` imports.
  Platform access goes through ports defined in `@elv/domain`.
- Source-first: `exports` points at `src/index.ts`, no build step. Allowed workspace dependencies: `@elv/domain`, `@elv/sources`.
- Tests live beside the code as `*.test.ts`; helpers `test-db.ts`, `*-test-helpers.ts` are the only places besides tests that use better-sqlite3 or `node:*`; `@elv/data/testing` (`src/testing.ts`) re-exports `test-db.ts` for tests in other workspaces. Integration and budget tests: `tools/test/import-*.test.ts` run the engine against the simulator (SQLite on disk).
- Inside `transaction(fn)` use only `tx`; every statement is parameterized; a new table with `source_id` joins `TABLES_BY_SOURCE`.

## Public surface (catalog import round)
- `createSyncSqlDriver(db)` (`driver.ts`) adapts a synchronous better-sqlite3-shaped database to `SqlDriver`: one promise queue
  serializes calls; the `tx` of a `transaction` callback bypasses it and rejects nesting; `batch` joins an open transaction.
- `openCatalog(db)` (`migrate.ts`): pragmas (WAL, `synchronous=NORMAL`, `foreign_keys=ON`, `temp_store=MEMORY`, `journal_size_limit` 64 MiB), migration to `SCHEMA_VERSION` with `MIGRATIONS` in `schema.ts` (raw SQL, `PRAGMA user_version`; `storage/schema-too-new`,
  `storage/migration-failed` rolled back), then leftover `running` runs become `failed/interrupted`. After the first release a schema change is a new entry, never an edit of an old one.
- `foldText(text)` (`fold.ts`): Turkish-aware, accent- and punctuation-insensitive folding for `name_fold` columns.
- `templates.ts`: `detectSegmentRules`, `toTemplate`, `resolveTemplate`, `keyTemplate`, `hostOf`. URLs become `{{name}}` templates
  (`user`, `pass`, `userinfo`, `v<N>` segment rules, `q:<param>` credential query values). Known credentials (>= 3 chars) are
  masked raw and percent-encoded at word boundaries; every value at a rule position is templated; rules and whole-segment
  matches skip the last segment; numeric Xtream ids stay literal; bare `/<u>/<p>/<id>` only for the known credentials;
  literal `{{` is `{{(}}`. Keys: `m3uKey(sourceId, keyTemplate(template), name)` (every placeholder becomes `{{*}}`).
- `sources.ts`: `addXtreamSource`, `addM3uSource`, `getSource`, `updateSourceSettings`, `removeSource`, `removeSecrets`, `purgeSourceRows`, `guideSecret`, `secretKey`, `SOURCE_ID`, `TABLES_BY_SOURCE`. Secrets: `source.<id>.xtream|playlist|urlvars`
  (ids only `[A-Za-z0-9._-]`, else `storage/invalid-source-id`); `settings_json` holds no credential. Guide URLs (overrides of
  both kinds, discovered M3U ones) are stored whole as secrets (`{{g:url}}`, `{{g:d<n>}}`). `removeSource` refuses while a run is
  `running` (`storage/import-in-progress`), deletes every table explicitly (no foreign keys), then the secrets
  (`storage/secret-delete-failed`: retry `removeSecrets`). `source-link.ts`: `addSourceFromLink` turns a pasted
  `…/get.php?username=…&password=…` link into an Xtream source (`parseXtreamLink`; `output` sets `xtreamFormat`), unless `keepAsM3u`.
- `stream-resolver.ts`: `createStreamResolver(sourceId, deps)` reads `urlvars` once (`readUrlVars`); `resolve(template)` rebuilds an entry URL, logo, referer or guide URL in memory, `undefined` when a value is missing.
- Runs (`import-run.ts` `performRun`, `runs.ts`; types in `import-types.ts`): one `running` run per source and kind, none for a
  missing source; upserts `ON CONFLICT ... run_id = excluded.run_id` (stable ids); yield after every batch; abort checked per
  batch; `onProgress` exceptions ignored. Success: one cleanup transaction deletes stale rows kind by kind and marks `ok`.
  Nothing at all is `empty-source`; a kind that comes back empty keeps its old rows (`catalog/kind-empty-<kind>`). Failure
  (`failed`) and abort (`cancelled`, `network/aborted`) never delete. A source gone at cleanup loses its rows, the run is
  `cancelled` (`storage/source-removed`). Only category and code reach `import_runs`; summaries carry `warningCodes`.
  `ImportDeps.maxBodyBytes` is the device memory/jank cap of one Xtream response. HTTP failures use `httpStatusError` codes.
- Xtream (`import-xtream.ts`, `writers.ts`): account, categories, live, movies, series; `too-large` falls back to per-category calls, and a category
  (or `get_series_info`) still over `maxBodyBytes` is fetched once more without the cap (one stall beats no catalog); `position` is provider order; items without a category go to `Uncategorized`. `loadSeriesEpisodes` stores episodes on demand
  (`provider_id` + `extension` for playback; refused for a source removed meanwhile); they survive re-imports with their series.
- M3U (`import-m3u.ts`, `m3u-rules.ts`, `m3u-templating.ts`, `writers-m3u.ts`): entry URLs, logos, referers are templates.
  `RuleBook` judges hosts on every import (sample hosts with >= 50 URLs at once, others on up to 50 URLs while entries wait in order); clashing values get `~<n>`. `kindHint` picks the table; episodes sit under a synthetic series per `group-title`;
  groupless entries go to `Ungrouped`; no header and no entries is `not-a-playlist`. Rules, discovered guide URLs and `urlvars`
  commit only with `ok` (settings in the cleanup transaction, the secret right after: `storage/secret-write-failed`).
- Guide (`import-guide.ts`, `guide-match.ts`, `guide-commit.ts`): `importGuide(sourceId, deps, { now })`; URLs: override, then Xtream `guideUrl()` or `discoveredGuideUrls`, first 2xx wins (`guideUrlFallbacks`). A guide id always wins; a folded name maps a
  channel without one only when unique both ways. Programmes stage in `programmes_next`; cleanup swaps those of mapped ids in,
  then `wal_checkpoint(TRUNCATE)`; failure or cancel drops the run's staging rows; a guide with no mapped programme keeps the
  previous one (`guide/empty`). No `stop`: next start, else +30 min. Not XMLTV: `not-a-guide`. Catalog runs drop mappings of vanished channels.
