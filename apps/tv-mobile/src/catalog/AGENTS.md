# catalog adapter (`apps/tv-mobile/src/catalog/`)

Device wiring for `@elv/data`'s `CatalogService`, re-exporting the catalog, query and manifest types from `@elv/data`.

## Rules
- `CatalogService`, `createCatalogService`, `queries` and `manifest` (`reconcileManifest`, `encodeManifest`, `decodeManifest`) live in `@elv/data` and are re-exported from `src/catalog/index.ts`.
- `createDeviceCatalog()` (`device.ts`) opens `catalog.db` once per process over `createOpSqliteDriver`, runs `openCatalog(db)` (closing `db` and throwing `CatalogOpenError` if migration fails), reconciles the Apple `Settings` manifest (`elv.catalog.sources`) on `ios`/tvOS, and returns the singleton `CatalogService`.
- Location: `Library/Caches` on iOS, iPadOS and tvOS (tvOS hardware allows only purgeable storage; iOS `Library` is backed up to iCloud), default op-sqlite databases directory on Android. A failing manifest reconcile logs `catalog: storage/manifest-failed` (no values) without blocking open.
- Device defaults from `@elv/data`: `DEVICE_MAX_BODY_BYTES` (4 MiB; larger Xtream lists fall back to per-category calls to bound JS stalls) and `DEVICE_BATCH_SIZE` (5,000 rows per batch).
- Integration tests in `src/catalog/*.test.ts` run `@elv/data`'s `CatalogService` and `reconcileManifest` against `@elv/data/testing` and the in-process simulator (`tools/src/sim/`).
