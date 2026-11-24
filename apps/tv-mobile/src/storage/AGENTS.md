# storage adapters (`apps/tv-mobile/src/storage/`)

Device implementations of the `@elv/domain` ports used by `@elv/data`. Only these files touch op-sqlite, `expo/fetch` and `Settings`.

## Rules
- `createOpSqliteDriver(name, location?)`: op-sqlite pinned at 19.0.5, FTS5 enabled (`"op-sqlite": { "fts5": true }` in `package.json`). Opens a `writer` and a `reader` connection on the same WAL file (`${IOS_LIBRARY_PATH}/Caches` on Apple platforms, default databases directory on Android) and applies connection-scoped pragmas (`busy_timeout = 5000`, `temp_store = MEMORY`, `foreign_keys = ON`) to both on open.
- `tx` of `transaction` bypasses the writer queue, rejects nesting, and `tx.batch` loops a prepared statement; outside a transaction `batch` is one `executeBatch` and `all` runs on `reader`.
- `setAbortSignal(signal)` binds an import run (one slot per driver): abort calls `writer.interrupt()` (rolling back any open transaction) and writer statements failing while aborted reject with `AbortError`; `reader` queries are never interrupted or abort-guarded because WAL readers never block `writer`. `close()` detaches the signal and closes both connections after queued work.
- `exec` splits scripts with `splitSqlStatements` (quotes, comments, and `CREATE TRIGGER ... BEGIN ... END` bodies aware). Other SQL failures reject with `SqlFailedError` (`storage/sql-failed`).
- `createMacrotaskScheduler()` yields a `setTimeout(0)`; `createDeviceHttpClient()` wraps `expo/fetch`.
- `createSettingsStore(key)` keeps one string in React Native `Settings` (`NSUserDefaults`; Apple only); failures read as `undefined`.
- `createDevicePreferencesStore()` (`preferences.ts`) and `createDeviceKeymapStore()` (`keymap.ts`) share `createDeviceKvBackend()` (`kv-backend.ts`: Apple `Settings`, Android `expo-secure-store`, memory fallback), storing sparse keymap overrides separately under `elv.keymap.v1` / `elv.keymap.v1.<profileId>` (`#33`) so `elv.preferences.v1` stays under Android SecureStore's 2048 B limit.
- `createSecureSecretStore()` wraps `expo-secure-store` (async API, chunks `<= 1,800` UTF-8 bytes under `<key>.<i>` + `<key>.n` last), serializing `get`/`set`/`delete` per key, restoring any valid prior secret on `set` failure (or scrubbing chunks when none existed / restore fails), and probing orphan chunks in `delete` even when `<key>.n` is missing.
- Simulator builds need ad-hoc signing (`CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=YES CODE_SIGNING_ALLOWED=YES`) for Keychain access.
