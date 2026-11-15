# Desktop Renderer Catalog (`renderer/src/catalog/`)

Renderer-side `@elv/data` `CatalogService` proxy backed by the Electron catalog `utilityProcess`.

- `desktop-catalog.ts`: `createDesktopCatalog()` singleton and `CatalogOpenError`, matching `apps/tv-mobile/src/catalog/device.ts` one-for-one so `@elv/features` consumes one `CatalogService` contract on every target.
- `index.ts`: public barrel re-exporting `@elv/data` catalog types alongside `createDesktopCatalog`.
- Only `import type` may reference `../../../src/shared/catalog-ipc.ts` so Metro never bundles files outside `renderer/` and workspace packages.
