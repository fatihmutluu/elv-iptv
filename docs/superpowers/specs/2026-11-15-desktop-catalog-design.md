# Desktop catalog storage in an Electron utility process — Design

- Status: approved (owner delegated all development decisions on 2026-11-14)
- Date: 2026-11-15
- Issue: #75 (version 0.1). Builds on the device catalog spec (`2026-11-14-device-catalog-design.md`), the catalog import
  spec (`2026-11-13-catalog-import-design.md`), the desktop player spec (`2026-11-14-desktop-player-design.md`), the
  foundation spec §3, §5.4, §6.2, ADR 0002 (desktop) and ADR 0005 (data layer).

## 1. Why
The phone, tablet and TV apps already run `@elv/data`'s `CatalogService` on device (#72). Version 0.1 needs the same
on-device catalog in `@elv/desktop` so the source setup (#71), development seeder (#10), menu (#13) and desktop player
(#8) share one `CatalogService` contract on Windows and macOS. Playlist fetching, M3U/Xtream scanning and SQLite batch
writes of 100k+ entries must run outside both the renderer and the Electron main thread so window input and animation
frames never stall.

## 2. Goals
- Run `better-sqlite3` (`SqlDriver`) and `@elv/data`'s `CatalogService` inside a dedicated Electron `utilityProcess`
  (`apps/desktop/src/utility/`), keeping network streaming, parsing and SQLite writes off the renderer and main threads.
- Connect each renderer window to the utility process over a direct `MessagePort` (`MessageChannelMain`), held inside
  the isolated preload closure and exposed through `contextBridge` as a frozen `window.elv.catalog` (`CatalogBridge`).
- Provide `createDesktopCatalog(): Promise<CatalogService>` in `apps/desktop/renderer/src/catalog/` with the exact
  `CatalogService` surface and `CatalogOpenError` semantics of `apps/tv-mobile/src/catalog/createDeviceCatalog()`.
- Implement `SecretStore` in the Electron `main` process over `safeStorage` (`isAsyncEncryptionAvailable`,
  `encryptStringAsync`, `decryptStringAsync`: DPAPI on Windows, Keychain on macOS), bridged only over the private
  `main <-> utilityProcess` `parentPort` and stored atomically as encrypted blobs in `userData/secrets.json` (`0o600`),
  failing closed when OS encryption is unavailable or falls back to Linux `basic_text`.
- Fence per-`webContents` ports on navigation, renderer crash and window close; recover cleanly from unexpected utility
  process exits; checkpoint the WAL after imports and removals; and close SQLite cleanly on `before-quit`.
- Prove via automated Playwright end-to-end tests on Windows and macOS that the `large` simulator account imports
  without blocking the renderer, that raw `.db`, `-wal`, `-shm` and `secrets.json` bytes contain zero plaintext
  credentials or secret `urlvars`, and that the packaged `app.asar` opens the utility process and queries SQLite.

## 3. Non-goals
- Guide UI (#25, Round 2), FTS5 search UI (Round 2), and synced user tables (Round 2).
- Database-level encryption (`catalog.db` holds zero credentials; all secrets live in `secrets.json` encrypted by
  `safeStorage`).
- An Apple `NSUserDefaults` source manifest (`userData` on Windows, macOS and Linux is persistent application data, not
  purgeable `Library/Caches` storage).

## 4. Existing solutions and empirical checks
Checks performed in the workspace on 2026-11-15 against Electron `45.3.1` and Node `26.13.1`:
- **`better-sqlite3` 13.0.3 (MIT):** uses Node-API (`node-addon-api ^8.0.0`, `"gypfile": false`) and ships ABI-stable
  `prebuilds/{darwin-arm64,darwin-x64,linux-arm64,linux-x64,win32-arm64,win32-x64}.node` binaries (SQLite `3.53.4` with
  FTS5). Verified live inside `utilityProcess.fork` under Electron `45.3.1` (Node `24.22.2`, `modules: 150`, `napi: 10`)
  and under host Vitest on Node `26.13.1` (`modules: 147`) from the same pnpm store entry without `@electron/rebuild` or
  `node-gyp`. Setting `npmRebuild: false` and `asarUnpack` for `prebuilds/**` in `electron-builder.yml` avoids native
  recompilation in CI and preserves the host Node binary for `pnpm check`.
- **Electron 45 `safeStorage`:** synchronous `isEncryptionAvailable`, `encryptString` and `decryptString` emit runtime
  deprecation warnings in Electron 45. `isAsyncEncryptionAvailable()`, `encryptStringAsync(plainText)` and
  `decryptStringAsync(encrypted)` (`{ shouldReEncrypt, result }`) run asynchronously via Chromium `os_crypt_async` with
  zero deprecation warnings and zero main-thread stalls. Over non-interactive macOS SSH (`elv-mac`),
  `isAsyncEncryptionAvailable()` resolves `true` while `encryptStringAsync` rejects immediately (`errSecInteractionNotAllowed`
  on a locked login Keychain), which maps cleanly to `storage/secret-store-failed` without writing `secrets.json`;
  headless macOS E2E passes `--use-mock-keychain` unless `ELV_REAL_KEYCHAIN=1` is set.
- **`contextBridge` boundary:** neither `MessagePort` nor DOM `AbortSignal` can cross `contextBridge.exposeInMainWorld`.
  The preload owns the `MessagePort` privately and exposes plain typed async methods plus an import `cancel()` handle;
  the renderer adapter maps `DeviceImportOptions.signal` onto `cancel()`.

## 5. Design

### 5.1 Process topology
1. **Main process (`apps/desktop/src/main/catalog/`):**
   - Owns `createEncryptedFileSecretStore` over `createSafeStorageCipher(safeStorage, process.platform)` and
     `join(app.getPath('userData'), 'secrets.json')`.
   - Lazily spawns `dist/utility/catalog-worker.js` via `utilityProcess.fork` on first client connection, passes
     `{ type: 'init', dbPath: join(app.getPath('userData'), 'catalog.db') }` over `child.postMessage`, and serves
     `secret-request` messages (`get`, `set`, `delete`) over that private `parentPort`.
   - On `catalog:connect` from a renderer's preload, watches `sender` (`destroyed`, main-frame `did-start-navigation`,
     `render-process-gone`), allocates a `MessageChannelMain`, transfers `port2` to the utility process with a monotonic
     `clientId`, and transfers `port1` back to `sender.postMessage('catalog:port', { connectId }, [port1])`.
   - When a watched `webContents` navigates, crashes or closes, sends `{ type: 'client-disconnect', clientId }` to the
     utility process so its port closes and any in-flight import started by that client aborts cleanly.
   - When the utility process exits unexpectedly, notifies connected `webContents` on `catalog:disconnected` and clears
     the worker handle so the next `catalog:connect` respawns it cleanly.
   - On `app.on('before-quit')`, sends `{ type: 'shutdown' }` to a running worker and waits (bounded by 2 s before
     `child.kill()`) for `{ type: 'shutdown-complete' }` so SQLite closes cleanly.
2. **Utility process (`apps/desktop/src/utility/`):**
   - Loads `better-sqlite3`, wraps `new Database(dbPath)` in `@elv/data`'s `createSyncSqlDriver`, runs `openCatalog(db)`
     (applying `WAL`, `busy_timeout = 5000`, `synchronous = NORMAL`, `foreign_keys = ON`, `temp_store = MEMORY`,
     `journal_size_limit = 64 MiB`, schema migrations, and `recoverRuns`), and constructs `@elv/data`'s
     `createCatalogService` with `createFetchHttpClient(fetch)`, a `setImmediate` macrotask `Scheduler`, and a
     `SecretStore` proxy over `process.parentPort`.
   - Runs `PRAGMA wal_checkpoint(TRUNCATE)` through the serialized `SqlDriver` queue after every settled `importSource`
     and `removeSource` so the WAL file does not accumulate unbounded pages after 100k-row imports.
   - Tracks active per-client `AbortController`s by `(clientId, reqId)` so `{ type: 'cancel', reqId }` or
     `{ type: 'client-disconnect', clientId }` aborts only the matching request.
3. **Preload (`apps/desktop/src/preload/catalog-bridge.ts`):**
   - Lazily requests a `MessagePort` via `catalog:connect` / `catalog:port`, keeping the port inside the preload module
     closure and exposing frozen `window.elv.catalog` methods (`open`, `addSource`, `addSourceFromLink`, `removeSource`,
     `startImport` returning `{ result, cancel }`, `listSources`, `categories`, `items`, `seasons`, `episodes`,
     `resolveStream`, `close`).
   - On `catalog:disconnected`, settles all pending requests with `{ category: 'storage', code: 'worker-exited' }` and
     reconnects transparently on the next call.
4. **Renderer (`apps/desktop/renderer/src/catalog/`):**
   - `createDesktopCatalog()` calls `window.elv.catalog.open()` (throwing `CatalogOpenError` on open/migration failure
     and clearing the cached singleton promise so a later call retries) and returns a `CatalogService` implementation
     whose method signatures, types and re-exports match `apps/tv-mobile/src/catalog/` one-for-one.

### 5.2 IPC contracts and runtime validation
- `src/shared/catalog-ipc.ts` defines `CATALOG_CHANNELS`, `CatalogBridge`, `CatalogClientMessage`,
  `CatalogWorkerMessage`, `isCatalogConnectMessage`, `isCatalogClientMessage` and `isCatalogWorkerMessage`.
- Every message crossing `ipcMain` (`catalog:connect`) or a client `MessagePort` (`preload <-> utilityProcess`) is
  validated before dispatch: string bounds, `SOURCE_ID` format, HTTP header token/control-character rules, finite page
  bounds and enum discriminants. Invalid messages are dropped and logged by channel/method name only — never with the
  payload, which can carry credentials or stream URLs.
- `src/main/catalog/worker-protocol.ts` defines and validates the private `MainToWorkerMessage` and
  `WorkerToMainMessage` unions over `process.parentPort`. Raw `SecretStore` operations exist only on this private parent
  channel and never on `ipcMain` or client `MessagePort`s.

### 5.3 `SecretStore` over `safeStorage` (`src/main/catalog/secret-store.ts`)
- `CipherPort` (`isAvailable()`, `encrypt(plainText)`, `decrypt(cipherText)`) decouples file persistence from Electron's
  `safeStorage` so unit tests and headless Linux CI exercise every code path deterministically.
- `createSafeStorageCipher(safeStorage, platform)` checks `await safeStorage.isAsyncEncryptionAvailable()` and, on
  `linux`, rejects `'basic_text'` and `'unknown'` from `safeStorage.getSelectedStorageBackend()` so plaintext fallback
  storage is refused closed (`SecretStoreUnavailableError`, mapped by `@elv/data` to `storage/secret-store-failed` on
  writes and `storage/secret-missing` on reads).
- `createEncryptedFileSecretStore({ filePath, cipher })` validates keys against `/^[A-Za-z0-9._-]+$/`, serializes all
  reads and writes through one promise queue, stores `{ version: 1, entries: Record<string, string> }` (base64 of
  ciphertext bytes), and writes via `${filePath}.<hex>.tmp` with mode `0o600`, `fsync` and atomic `rename`.
- In unpackaged test launches only (`!app.isPackaged` with `--elv-test-cipher`), `main.ts` substitutes a random
  per-process AES-256-GCM `CipherPort` so headless Linux CI (`xvfb-run` without a desktop keyring) can still execute
  end-to-end import tests while a separate e2e test without the flag verifies fail-closed behavior on `basic_text`.
  Packaged builds ignore `--elv-test-cipher` unconditionally.

### 5.4 Packaging (`apps/desktop/package.json`, `electron-builder.yml`)
- `apps/desktop/package.json` adds `@elv/domain`, `@elv/data` and `better-sqlite3` (`13.0.3`) to `dependencies`, and
  bundles `src/utility/catalog-worker.ts` with `esbuild --external:better-sqlite3 --outfile=dist/utility/catalog-worker.js`.
- `apps/desktop/renderer/package.json` adds `@elv/domain` and `@elv/data` (pure TypeScript) to `dependencies`.
- `electron-builder.yml` sets `npmRebuild: false`, includes `dist/utility/**` and `better-sqlite3`'s runtime files
  (`package.json`, `lib/**`, `prebuilds/**`, excluding `deps/**` and `src/**`), and sets `asarUnpack` on
  `**/node_modules/better-sqlite3/prebuilds/**` so `dist/utility/catalog-worker.js` loads from `app.asar` (satisfying
  `onlyLoadAppFromAsar: true`) while `process.dlopen` loads the unpacked `.node` N-API addon from `app.asar.unpacked`.

## 6. Testing
- **Unit tests (Vitest, `>= 90%` line coverage):**
  - `src/shared/catalog-ipc.test.ts`: valid/invalid client, connect and worker messages, header control-char rejection,
    payload-free error paths.
  - `src/main/catalog/secret-store.test.ts`: `CipherPort` encryption/decryption round-trip, atomic persistence across
    re-instantiation, `0o600` permissions, corrupt JSON recovery, concurrent queue serialization, fail-closed behavior
    when `isAvailable()` is `false` or Linux backend is `basic_text`/`unknown`, zero-plaintext scan of `secrets.json`.
  - `src/main/catalog/coordinator.test.ts` & `src/main/catalog/ipc.test.ts`: lazy spawn, `parentPort` secret bridging,
    per-`webContents` fencing (`did-start-navigation`, `render-process-gone`, `destroyed`), unexpected worker exit +
    `catalog:disconnected` notification + clean respawn, `before-quit` graceful shutdown and timeout kill fallback.
  - `src/utility/catalog-worker-runtime.test.ts`: real `better-sqlite3` file DB in WAL mode + in-process stream
    simulator (`demo` Xtream + M3U with secret tokens/headers), `PRAGMA wal_checkpoint(TRUNCATE)` verification, raw
    `.db` / `-wal` / `-shm` zero-credential byte scan, request cancellation, `client-disconnect` cancellation, and
    `CatalogOpenError` propagation on `schema-too-new`.
  - `src/preload/catalog-bridge.test.ts` & `renderer/src/catalog/desktop-catalog.test.ts`: `MessagePort` lifecycle,
    progress callbacks, `AbortSignal` cancellation mapping, crash recovery (`storage/worker-exited` then transparent
    reconnect on next call), and `CatalogService` contract parity with `tv-mobile`.
- **End-to-end tests (Playwright, Windows + macOS + Linux CI):**
  - `e2e/catalog.spec.ts`: imports the `large` simulator account (25,000 live, 70,000 movies, 500 series) plus a
    tokenized M3U playlist in real Electron while measuring renderer event-loop/frame lag (`maxStallMs < 250 ms` CI
    ceiling; measured `6.6 ms` on Windows and `4.1 ms` on macOS),
    queries paged categories/items/seasons/episodes and `resolveStream`, and scans every byte of `catalog.db`,
    `catalog.db-wal`, `catalog.db-shm` and `secrets.json` in `userData` for zero plaintext credentials or tokens.
  - `e2e/packaged.spec.ts`: verifies over CDP that the fused `app.asar` build spawns the catalog `utilityProcess`, runs
    migrations with unpacked `better-sqlite3`, and answers catalog queries cleanly.

## 7. Decisions made during design
- Both `SqlDriver` and `CatalogService` live in the `utilityProcess` rather than bridging raw SQL over IPC: streaming
  100k+ M3U/Xtream rows across IPC would serialize megabytes through the renderer, whereas running `CatalogService` in
  the `utilityProcess` keeps network, parsing and batch transactions in one background V8 isolate.
- `SecretStore` stays in `main` over `process.parentPort` (`safeStorage` is main-only) and is never reachable from
  `ipcMain` or client `MessagePort`s.
- `better-sqlite3` 13.0.3's N-API prebuilds are used as-is (`npmRebuild: false`) so Electron 45 and Node 26 share one
  binary cleanly.
- `safeStorage` uses Electron 45's async API (`isAsyncEncryptionAvailable`, `encryptStringAsync`, `decryptStringAsync`)
  and fails closed on `basic_text`.
