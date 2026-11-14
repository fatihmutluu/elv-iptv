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
- An import gate on the Android TV emulator: the `large` simulator account and a synthetic 500k account import within
  budget while key input stays responsive.

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
- `createOpSqliteDriver(name)` opens a writer connection and a reader connection on the same file (WAL) and returns a
  `SqlDriver` whose writes and transactions go to the writer and whose plain reads (`all` outside a transaction) go to
  the reader, so list queries are not queued behind an import batch. The spike confirms each connection has its own
  native thread.
- Calls are serialized per connection with a promise queue, the same contract as `createSyncSqlDriver` (inside
  `transaction(fn)` only `tx` is used; transactions do not nest; `batch` joins an open transaction).
- `exec(sql)` splits the script into statements (outside string literals and comments) and runs them in order.
- `batch` outside a transaction maps to one `executeBatch`; inside a transaction it loops a prepared statement through the
  transaction's connection (op-sqlite's `executeBatch` opens its own transaction).
- Numbers stay JS doubles (ids are below 2^53 by schema); `Uint8Array` maps to blobs.
- `AbortSignal` support: an abort during a long statement calls `interrupt()`, which rolls the open transaction back, in
  line with the import rule "abort never deletes".
- Build config in `apps/tv-mobile/package.json`: op-sqlite pinned exactly (19.0.5); FTS5 off for 0.1 (no search yet);
  `performanceMode` decided by the spike.

### 5.2 `SecretStore`, `Scheduler`, `HttpClient`
- `SecretStore` over expo-secure-store, async calls only. Values over 1,800 bytes are split into numbered chunks with a
  small index entry and joined on read; a failed or partial read (an Android Keystore error, a missing chunk) is "no
  secret" and the source shows a re-enter-credentials error, never a crash.
- `Scheduler.yieldNow()` resolves on a `setTimeout(0)` macrotask, so key events and renders run between import batches.
- `HttpClient`: the domain's `createFetchHttpClient` over a fetch whose response bodies stream. The builder checks Expo
  SDK 58's `expo/fetch` (streaming `ReadableStream` bodies) on Android and tvOS; if a platform cannot stream, that platform
  reads whole bodies within `maxBodyBytes`, which the importer already supports for Xtream JSON.

### 5.3 Catalog service (`apps/tv-mobile/src/catalog/`)
- `createDeviceCatalog()` opens the database with `openCatalog`, wires the adapters into `ImportDeps`, and exposes:
  `addSource(input)` / `addSourceFromLink(link)` (wrapping `@elv/data`), `removeSource(id)`, `importSource(id, { signal,
  onProgress })`, `listSources()`, and paged reads for the menu (`categories(sourceId, kind)`, `items(categoryId, offset,
  limit)`, `seasons(seriesId)`, `episodes(seriesId, season)`), plus `resolveStream(itemKey)` for the player (the data
  package's stream resolver; credentials never leave memory).
- One instance per app process, created lazily; the database file lives in the app's documents directory (not the
  caches directory) on every platform.
- The service is plain TypeScript with the adapters injected, so it is tested in Jest with the Node SQLite test driver and
  in-memory secrets; only the adapters touch native modules.

### 5.4 Spike (first plan task)
- Add op-sqlite to `apps/tv-mobile`, build the Android TV release variant and the tvOS simulator variant (CI or the
  owner's Mac when reachable), run a development route that imports from the simulator (`large`, 25,000 live + 70,000
  VOD + 500 series, and a synthetic 500k M3U) with chunk sizes 1,000, 5,000 and 10,000, and prints one `ELV_GATE_IMPORT
  {json}` line: duration, rows, peak JS heap if available, and the longest JS event-loop stall measured by a 16 ms
  interval timer during the import.
- Pass: builds and runs on both platforms; `large` imports in under 60 s on the Android TV emulator; no stall over 100 ms
  during the import with the chosen chunk size. If tvOS fails, the fallback is expo-sqlite on Apple platforms behind the
  same adapter interface (recorded in §8).

### 5.5 Import gate
- `pnpm gate import [--avd] [--build] [--source large|huge]` runs the route above with the chosen chunk size, starts the
  simulator, and compares with `docs/learned/gates/import-android-tv.json` (duration, max stall). Local only in 0.1.

## 6. Testing
- Adapters: unit tests with op-sqlite and expo-secure-store mocked at the module boundary (statement splitting, batch
  inside and outside transactions, queue serialization, interrupt on abort, secret chunking and partial-read handling).
- Catalog service: Jest tests against the Node SQLite test driver and the simulator fixtures (add, import, re-import keeps
  content keys, remove, paged reads, a database scan proving no credential is stored outside secrets).
- Device: the spike and the import gate.

## 7. Left to the builder
- The SQL statement splitter's exact rules (it only has to handle our migrations and generated statements).
- op-sqlite option names and the reader-connection API; Expo `expo/fetch` usage details.

## 8. Decisions made during design
- op-sqlite primary, expo-sqlite as the Apple fallback if the spike fails; expo-secure-store for secrets.
- Adapters live in the app (layer rule: only apps wire storage drivers).
- Desktop storage is part of the desktop work.
