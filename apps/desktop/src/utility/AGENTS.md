# utility (`apps/desktop/src/utility/`)

Electron `utilityProcess` entrypoints bundled to `dist/utility/` with `--external:better-sqlite3`.

## Modules
- `catalog-worker-runtime.ts`: pure dependency-injected runtime hosting `better-sqlite3` (`createSyncSqlDriver` + `openCatalog` in WAL mode) and `@elv/data`'s `CatalogService`.
- `catalog-worker.ts`: thin process entrypoint binding `process.parentPort`, `better-sqlite3` and global `fetch`.

## Rules
- Keep >= 90 % line coverage on `catalog-worker-runtime.ts`.
- Never import `electron` main-only modules (`safeStorage`, `BrowserWindow`, `app`) here; `SecretStore` bridges over `process.parentPort` (`src/main/catalog/worker-protocol.ts`).
- Validate every client `MessagePort` payload with `isCatalogClientMessage` (`src/shared/catalog-ipc.ts`) and never log payloads (they may carry credentials or stream URLs).
- Run `PRAGMA wal_checkpoint(TRUNCATE)` on the serialized `SqlDriver` queue after `importSource` and `removeSource`, and close `CatalogService` cleanly on `shutdown`.
