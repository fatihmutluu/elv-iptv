# storage adapters (`apps/tv-mobile/src/storage/`)

Device implementations of the `@elv/domain` ports used by `@elv/data`. Only these files touch op-sqlite and `expo/fetch`.

## Rules
- `createOpSqliteDriver(name)`: op-sqlite pinned exactly 19.0.5, FTS5 off (`op-sqlite` key in the app's package.json; Android reads only that file).
  A writer and a reader connection, one promise queue each; `all` outside a transaction reads on the reader.
- `tx` of `transaction` bypasses the queue, rejects nesting, and `tx.batch` loops a prepared statement; outside a transaction `batch` is one `executeBatch`.
- `setAbortSignal(signal)` binds an import run: abort calls `interrupt()` on both connections and the failing statement rejects with `AbortError`.
  Other failures reject with `SqlFailedError` (`storage/sql-failed`, SQLite message in `detail`). Errors thrown by a transaction callback pass through unchanged.
- `exec` splits scripts with `splitSqlStatements` (quotes and comments aware; trigger bodies unsupported).
- `createMacrotaskScheduler()` yields a `setTimeout(0)`; `createDeviceHttpClient()` is the domain fetch client over `expo/fetch`,
  reading the whole body as one chunk where a response has no stream.
- Tests (Vitest) mock `@op-engineering/op-sqlite` and `expo/fetch` at the module boundary; `op-sqlite-fake.ts` is the recording fake.
