# data (`@elv/data`)

Schema, migrations and repositories for catalog, EPG and user data, over the `SqlDriver` port.

## Commands
- `pnpm --filter @elv/data typecheck` / `test`; `pnpm -w check` runs every repository check.

## Rules
- Pure TypeScript: no `react`, `react-native`, `expo*`, `electron` or `node:*` imports.
  Platform access goes through ports defined in `@elv/domain`.
- Source-first: `exports` points at `src/index.ts`, no build step. Allowed workspace dependencies: `@elv/domain`, `@elv/sources`.
- Tests live beside the code as `*.test.ts`; helpers `test-db.ts`, `*-test-helpers.ts` are the only places besides tests that use better-sqlite3. Integration and budget tests: `tools/test/import-*.test.ts` run the engine against the simulator (SQLite on disk).

## Public surface (catalog import round)
- `createSyncSqlDriver(db)` (`driver.ts`) adapts a synchronous better-sqlite3-shaped database to `SqlDriver`. One promise
  queue serializes calls; the `tx` of a `transaction` callback bypasses it and rejects nesting. Never await the outer
  driver inside a transaction callback. `batch` joins an open transaction.
- `openCatalog(db)` (`migrate.ts`) applies the pragmas (WAL, `synchronous=NORMAL`, `foreign_keys=ON`, `temp_store=MEMORY`) and
  migrates to `SCHEMA_VERSION` with `MIGRATIONS` in `schema.ts` (raw SQL, `PRAGMA user_version`): `storage/schema-too-new`, `storage/migration-failed` (rolled back). Add a schema change as a new entry, never by editing an old one.
- `foldText(text)` (`fold.ts`): Turkish-aware, accent- and punctuation-insensitive folding for `name_fold` columns.
- `templates.ts`: `detectSegmentRules`, `toTemplate`, `resolveTemplate`, `keyTemplate`, `hostOf`. URLs become `{{name}}` templates
  (`user`, `pass`, `userinfo`, `v<N>` segment rules, `q:<param>` credential query values); values go to the secret store. Known
  credentials (>= 3 chars) are masked raw and percent-encoded at word boundaries; every value at a rule position is templated;
  rules and whole-segment matches skip the last segment; numeric Xtream ids stay literal; bare `/<u>/<p>/<id>` only for known credentials; literal `{{` is `{{(}}`. Keys are
  `m3uKey(sourceId, keyTemplate(template), name)` (every placeholder becomes `{{*}}`).
- `source-link.ts`: `addSourceFromLink` adds a pasted `…/get.php?username=…&password=…` link as an Xtream source (`parseXtreamLink`; output sets `xtreamFormat`; a guide override is templated like M3U ones, `vodPlaylist` is ignored), else as M3U; `keepAsM3u` opts out.
- `sources.ts`: `addXtreamSource`, `addM3uSource`, `getSource`, `updateSourceSettings`, `removeSource`, `removeSecrets`, `TABLES_BY_SOURCE`, `secretKey`. `removeSource` refuses while a run is `running` (`storage/import-in-progress`), deletes every table of the source explicitly (no foreign keys; a new table with `source_id` must be added
  to its list) and returns `storage/secret-delete-failed` if a secret survives (retry `removeSecrets`). M3U guide URLs are
  templated against the playlist or kept whole (`{{g:url}}`). Credentials live only in the `SecretStore`
  (`source:<id>:xtream|playlist|urlvars`); `settings_json` holds none.
- `importCatalog` / `loadSeriesEpisodes` (`import-xtream.ts`; types in `import-types.ts`; `runs.ts`, `writers.ts`). A run
  upserts with `ON CONFLICT DO UPDATE ... run_id = excluded.run_id` (stable row ids), yields after every batch, checks
  `signal.aborted` before every batch. Stale rows (`run_id < current`) are deleted and the run marked `ok` in one
  transaction, only after success; failure (`failed`) and abort (`cancelled`, `network/aborted`) never delete. Only
  error category and code reach `import_runs`. `startRun` refuses a second `running` run of the same source and kind
  (`storage/import-in-progress`) and a missing source; a source gone at cleanup loses its rows, the run is `cancelled`
  (`storage/source-removed`), `afterCommit` is skipped. `openCatalog` marks leftover `running` runs `failed/interrupted`. `onProgress`
  exceptions are ignored. Xtream: account check first, then categories, live, movies, series; `source-format/too-large`
  falls back to per-category calls; placement `position` is provider order within the category. Episodes load on
  demand (`loadSeriesEpisodes`) and survive re-imports while their series exists.
- M3U (`import-m3u.ts`, `m3u-rules.ts`, `m3u-templating.ts`, `writers-m3u.ts`; lifecycle `performRun` in `import-run.ts`): entry URLs,
  logos, live referers are templates (`RuleBook` judges hosts every run: sample hosts with >= 50 URLs at once, others on up to 50 URLs while entries wait in order; clashing values `~<n>`); `kindHint` picks the table, episodes sit under a synthetic series per `group-title`;
  `url-tvg` goes to `discoveredGuideUrls`; no header and no entries is `not-a-playlist`; zero items is `empty-source`.
  Rules, guide URLs and `urlvars` are staged and committed only with `ok` (settings in the cleanup transaction, the secret
  right after; failure there is `storage/secret-write-failed`); a failed run changes neither. Groupless entries: `Ungrouped`.
- Guide (`import-guide.ts`, `guide-match.ts`): `importGuide(sourceId, deps, { now })` reuses `performRun` (`kind: 'guide'`,
  `requireItems: false`). URLs: override, then Xtream `guideUrl()` or M3U `discoveredGuideUrls`; first 2xx wins, earlier failures
  are `counts.guideUrlFallbacks` + `warningCodes` (codes only). A guide id always wins; a folded name maps a channel without one only when unique both ways (growing `Set` =
  scanner `programmeChannels`). Programmes go to `programmes_next`; `guide-commit.ts` swaps those of mapped guide ids into `programmes` (with guide channels
  and `channel_guide`) in the cleanup transaction; failure or cancel drops the run's staging rows. No `stop`: next start, else +30 min. Catalog runs drop `channel_guide` rows of vanished channels. Not XMLTV: `not-a-guide`.
