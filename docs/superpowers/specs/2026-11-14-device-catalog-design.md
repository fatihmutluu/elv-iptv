# Device catalog storage and on-device import — Design

- Status: approved (owner delegated all development decisions on 2026-11-14)
- Date: 2026-11-14
- Issue: #72 (version 0.1). Builds on the catalog import spec (`2026-11-13-catalog-import-design.md`), the foundation spec
  §3 (stack), §5.4 (data), §6.2 (budgets) and ADR 0011 (content keys).

## 1. Why
`packages/data` already imports M3U and Xtream catalogs into SQLite through the `SqlDriver`, `SecretStore` and `Scheduler`
ports and is tested on Node with better-sqlite3. Version 0.1 needs the same engine on the phone, tablet and TV apps: a
source added on the device imports there, the plain menu (#13) lists it, the player resolves stream URLs from it. A
500,000-entry account must import on a 1 GB TV stick without freezing remote input.

## 2. Goals
- Adapters in `apps/tv-mobile/src/storage/` that implement the ports on device: `SqlDriver` over op-sqlite, `SecretStore`
  over expo-secure-store, `Scheduler` over a macrotask, and the `HttpClient` port with streaming response bodies.
- A catalog service in `apps/tv-mobile/src/catalog/` that opens the database (`openCatalog`), adds and removes sources,
  runs imports with progress and cancellation, and answers the paged list queries the menu needs.
- A spike first that proves op-sqlite on the Android TV emulator and the Apple TV simulator and fixes the chunk size.
- An import gate on the Android TV emulator: the `large` simulator account (25,000 live, 70,000 VOD, 500 series) and the
  `huge` account (500,000 entries) import within budget without long JavaScript stalls.

## 3. Non-goals
- Desktop storage (Electron utility process with better-sqlite3): part of the desktop work (#8), same ports.
- Guide import (#25, Round 2), search and FTS queries (Round 2), user data tables (favorites, progress: Round 2).
- Encryption of the catalog database (it holds no credentials; secrets live in the secure store).

## 4. Existing solutions
Scan of 2026-11-14 (private report `.superpowers/research/reports/device-sqlite-scan-2026-11.md`):
- **op-sqlite 19.0.5 (MIT):** JSI, async calls on a dedicated native thread per connection, `executeBatch` with native
  BEGIN/COMMIT, prepared statements, opt-in FTS5 and SQLCipher, `interrupt()`. Its podspec declares tvOS 13 but its docs
  do not mention tvOS or Android TV, and nobody publicly ships it on TV: the spike decides. Native `execute()` runs only
  the first statement of a string. Release pace is high (pin exactly, read every changelog). Its build config is read
  from the app's own `package.json` on Android (monorepo gotcha).
- **expo-sqlite 58 (MIT):** documented on tvOS (database in the caches directory there), no batch API, async threading
  undocumented, open issues around closing many statements. The fallback if op-sqlite fails the spike.
- **expo-secure-store 58 (MIT):** documented on Android, iOS and tvOS (Keychain, Android Keystore). Async API only here;
  values of a few KB may exceed old iOS limits.
- **MMKV 4:** a Nitro module without documented tvOS or Android TV support; not needed by this work (the stack table
  entry is revisited when a key-value need appears).

## 5. Design

### 5.1 `SqlDriver` over op-sqlite (`apps/tv-mobile/src/storage/sql-driver.ts`)
- `createOpSqliteDriver(name, location)` opens a writer connection and a reader connection on the same file (WAL) in an
  explicit op-sqlite `location` (`databaseLocation(Platform.OS)`: `Library/Caches` on iOS, iPadOS and tvOS, op-sqlite's
  databases directory on Android; §5.3) and returns a `SqlDriver` whose writes and transactions go to the writer and
  whose plain reads (`all` outside a transaction) go to the reader, so list queries are not queued behind an import
  batch. The import gate's `probeReads=1` run measures those reads during an import on the device (§5.4).
- Calls are serialized per connection with a promise queue, the same contract as `createSyncSqlDriver` (inside
  `transaction(fn)` only `tx` is used; transactions do not nest; `batch` joins an open transaction).
- `exec(sql)` splits the script into statements (outside string literals and comments) and runs them in order.
- `batch` outside a transaction maps to one `executeBatch`; inside a transaction it loops a prepared statement through the
  transaction's connection (op-sqlite's `executeBatch` opens its own transaction). `loadSeriesEpisodes` takes that path;
  the gate's `series=1` run proves it on the device (§5.4).
- Numbers stay JS doubles (ids are below 2^53 by schema); `Uint8Array` maps to blobs.
- `AbortSignal` support: an abort during a long statement calls `interrupt()`, which rolls the open transaction back, in
  line with the import rule "abort never deletes". A statement that fails while its signal is aborted rejects with an
  `AbortError`-named error, so the import engine records the run as `cancelled`; any other SQL failure rejects with
  `storage/sql-failed` and the SQLite message in `detail`. The driver has one abort slot (`setAbortSignal`; `undefined`
  detaches), and `interrupt()` also stops a reader query running at that moment, so the catalog service binds one import
  at a time (§5.3).
- Reads outside a transaction go to the reader connection. Each statement there is its own read transaction, so a write
  committed on the writer is visible to the next read; reads never see a writer's open transaction.
- Build config in `apps/tv-mobile/package.json`: op-sqlite pinned exactly (19.0.5); FTS5 off for 0.1 (no search yet);
  `performanceMode` not enabled: the spike met the Android TV and tvOS budgets without it.

### 5.2 `SecretStore`, `Scheduler`, `HttpClient`
- `SecretStore` over expo-secure-store, async calls only. Values over 1,800 bytes are split into numbered chunks with a
  small index entry and joined on read; a failed or partial read (an Android Keystore error, a missing chunk) is "no
  secret" and the source shows a re-enter-credentials error, never a crash.
- `Scheduler.yieldNow()` resolves on a `setTimeout(0)` macrotask, so key events and renders run between import batches.
- `HttpClient`: the domain's `createFetchHttpClient` over a fetch whose response bodies stream. The builder checks Expo
  SDK 58's `expo/fetch` (streaming `ReadableStream` bodies) on Android and tvOS; where a response has no stream, the
  adapter reads it whole with `arrayBuffer()`. `maxBodyBytes` rejects such a body only after it is in memory; it cannot
  bound that read. Xtream JSON is parsed from one buffer either way, which is why devices cap it (§5.3).
- No `Decompressor` in 0.1: native fetch decodes `Content-Encoding: gzip`; a playlist served as a `.gz` file without
  that header fails with the importer's `gzip-unsupported` code (guides, where gzip files are common, come in Round 2).
- Cleartext HTTP: development builds allow it to the simulator hosts only (`10.0.2.2`, `127.0.0.1`, `localhost`) through
  the app config (Android network security config, iOS/tvOS ATS local networking); user sources over `http` are #12.

### 5.3 Catalog service (`apps/tv-mobile/src/catalog/`)
- `createDeviceCatalog()` opens the database with `openCatalog`, wires the adapters into `ImportDeps`, and exposes:
  `addSource(input)` / `addSourceFromLink(link)` (wrapping `@elv/data`), `removeSource(id)`, `importSource(id, { signal,
  onProgress })`, `listSources()`, and paged reads for the menu (`categories(sourceId, kind)`, `items(categoryId, offset,
  limit)`, `seasons(seriesId)`, `episodes(seriesId, season)`), plus `resolveStream(itemKey)` for the player (the data
  package's stream resolver; credentials never leave memory).
- One instance per app process, created lazily. Location: `catalog.db` lives in `Library/Caches` on iOS, iPadOS and tvOS
  (tvOS hardware gives apps only purgeable storage, about 500 KB of `NSUserDefaults` aside; iOS backs `Library` up to
  iCloud, which a rebuildable catalog should not use) and in op-sqlite's databases directory on Android.
- Source manifest (Apple platforms): because the OS may purge the caches, a small non-secret manifest of the sources
  (`id`, `kind`, `name`, `createdAt`, `settings_json`; never credentials, which stay in the Keychain) is kept in
  `NSUserDefaults` through React Native `Settings` (key `elv.catalog.sources`) and rewritten after every add, remove and
  import. After `openCatalog`, `reconcileManifest` gives an empty database the manifest's sources back with the same ids,
  so content keys and secret keys match again; `SourceRow.needsImport` (no successful catalog run yet) tells the menu to
  import them. User data that cannot be rebuilt (favorites, progress) needs another home on tvOS: #79.
- Imports run one at a time through a promise queue in the service: a later call waits for its turn; a call for a source
  that is importing or waiting is refused with `storage/import-in-progress` at once without touching the driver's abort
  slot; a call cancelled while it waits ends with `network/aborted` without starting a run. Only the running import's
  signal is bound.
- Xtream bodies are capped at `DEVICE_MAX_BODY_BYTES` = 4 MiB (`ImportDeps.maxBodyBytes`; `importSource` option
  `maxBodyBytes` overrides it): a whole list above it loads per category, and a single category or `get_series_info`
  still above it is fetched once more without the cap (one stall beats a missing catalog). Trade-off from the spike: the
  per-category path roughly doubles the `large` import (about 9 s whole, 19 s capped on the Android TV emulator) but keeps
  the longest JS stall near 45 ms; a 16 MiB cap loads the lists whole again and brings back the ~1.2 s whole-list
  `JSON.parse` stall. The `huge` account's ~190 ms stall is accepted for 0.1; streaming JSON parsing (#76) removes it and
  the cap.
- Known limit for 0.1 (#76): on the per-category path, items the provider lists without a category (they appear only in
  the whole list) are not imported, and a re-import on that path deletes such items an earlier whole-list import stored.
- The service is plain TypeScript with the adapters injected, so it is tested in Vitest (the app's `test` script, Node
  environment) against `@elv/data`'s Node SQLite test database, which `@elv/data` exports under a `./testing` subpath,
  with in-memory secrets; only the adapters touch native modules (they are mocked at the module boundary in their tests).

### 5.4 Spike (first plan task)
- Add op-sqlite to `apps/tv-mobile`, build the Android TV release variant of the development build, and run a
  development route (`elviptv://gate/import?host=…&account=large|huge&batch=…&maxBody=…`, reachable only with
  `extra.gate`, like the list gate) that imports the simulator account with `ImportOptions.batchSize` 1,000, 5,000 and
  10,000 (the importer's default is 500) and prints one `ELV_GATE_IMPORT {json}` line: duration, rows, and the longest JS
  event-loop stall measured with `performance.now()` by a 16 ms interval timer during the import (no key injection).
  `maxBody` is the body cap in KiB (256 to 131,072, default 4096). Two opt-in probes: `probeReads=1` times the live
  categories query every 50 ms during the import (`maxReadMs`, `reads`, `readErrors`); `series=1` opens the first series
  afterwards (`seasons`, `episodes`, `seriesMs`, or `seriesError`).
- tvOS: the required `tvos` CI job proves the build with op-sqlite; the report-only `tvos-gate` job also runs the import
  route on the Apple TV simulator (host `127.0.0.1`); the owner's Mac is used instead when reachable. Simulator builds
  are signed ad hoc (`CODE_SIGN_IDENTITY=-`): unsigned, the app has no Keychain access and imports fail with
  `storage/secret-store-failed`.
- If the stall budget is missed at every size, the builder tries smaller batches (down to 250), records the numbers and
  stops for a ruling; if the tvOS build or run fails, the plan's fallback task implements the Apple adapter on expo-sqlite
  behind the same interface.
- Pass: builds and runs on both platforms; `large` imports in under 60 s on the Android TV emulator; no stall over 100 ms
  during the import with the chosen chunk size. If tvOS fails, the fallback is expo-sqlite on Apple platforms behind the
  same adapter interface (recorded in §8).
- Results (2026-11-14): every batch size missed the stall budget at ~1.2 s with whole lists (the stall was the whole-list
  `JSON.parse`, not SQL); with the 4 MiB cap and batch 5,000, `large` imported 95,500 rows in 18.8 s with a 45.5 ms stall
  (gate baseline 17.8 s, 44 ms) and `huge` 356,000 rows in 146 s with a 188.7 ms stall (#76). Batch 5,000 is the device
  default (10,000 is no faster per stall). On the Apple TV simulator (owner's Mac, ad hoc signed) `large` imported in
  9.8 s with a 17.9 ms stall, so the expo-sqlite fallback was not needed.
- Device probes (2026-11-14, Android TV emulator, `large`, batch 5,000, 4 MiB, `series=1&probeReads=1`, five runs): the
  first series opened with 2 seasons and 10 episodes in 30–44 ms, so `tx.batch` (a prepared statement inside an op-sqlite
  transaction) works on the device; the slowest reader query of a run took 8.9–41 ms over 256–378 reads with no failure,
  so reads do not queue behind import batches. Warm runs imported in 17.8–17.9 s. The probe's own reads raise the max
  stall (39–121 ms, against 40–50 ms without them), so stall numbers come from runs without probes. The first run after
  the install stalled once for 7.5 s and took 24.7 s; the four later runs did not repeat it.

### 5.5 Import gate
- `pnpm gate import [--avd elv_tv] [--build] [--account large|huge] [--batch 5000] [--max-body 4096] [--runs 3]
  [--baseline file] [--budgets warn|fail] [--out file] [--write-baseline]` runs the route above, starts the simulator on
  `127.0.0.1:7878` (or reuses a running one), and compares the median of the runs (default 3: the first run of a session
  is often slower on the emulator) with `docs/learned/gates/import-android-tv.json`: rows equal,
  duration at most +10 % (+2 s slack), stall under 100 ms. `huge` is report-only (#76); only `large` becomes a baseline.
  Local only in 0.1.

## 6. Testing
- Adapters: Vitest unit tests with op-sqlite, expo-secure-store, `expo/fetch` and React Native `Settings` mocked at the
  module boundary (statement splitting, batch inside and outside transactions, queue serialization, interrupt on abort,
  abort inside a transaction, detach, location, secret chunking and partial-read handling).
- Catalog service: Vitest tests (Node) against `@elv/data/testing` and the in-process simulator (add, import, re-import
  keeps content keys, remove, paged reads, a database scan proving no credential is stored outside secrets, the import
  queue, the body cap with its per-category retry, the source manifest and its restore).
- Device: the spike and the import gate.

## 7. Left to the builder
- The SQL statement splitter's exact rules (it only has to handle our migrations and generated statements).
- op-sqlite option names and the reader-connection API; Expo `expo/fetch` usage details.

## 8. Decisions made during design
- op-sqlite primary, expo-sqlite as the Apple fallback if the spike fails; expo-secure-store for secrets.
- After the builder check: host parameter and simulator accounts (`large`, `huge`), dev-only cleartext to simulator
  hosts, Vitest with a `@elv/data/testing` export, chunk = `batchSize`, tvOS through the CI jobs, stall measured by a timer
  only, `AbortError` on interrupt during cancel, no decompressor, reads on the reader connection.
- Adapters live in the app (layer rule: only apps wire storage drivers).
- Desktop storage is part of the desktop work.
- During implementation (2026-11-14): device batch 5,000 and Xtream body cap 4 MiB; a category or series info over the
  cap is retried once without it; the `huge` stall (~190 ms) is accepted for 0.1 and uncategorized Xtream items on the
  per-category path are a known limit, both fixed by streaming JSON parsing (#76); imports are serialized by a queue in
  the catalog service (one abort slot per driver); the Apple catalog lives in `Library/Caches` with a non-secret source
  manifest in `NSUserDefaults` that restores sources after a purge (user data on tvOS: #79); `performanceMode` stays off;
  the `tvos-gate` simulator build is signed ad hoc for the Keychain; the gate flag is `--account` (not `--source`); tests
  run in Vitest, not Jest.
