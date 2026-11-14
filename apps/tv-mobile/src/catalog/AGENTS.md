# catalog service (`apps/tv-mobile/src/catalog/`)

The device catalog: `@elv/data` over the storage adapters, behind one `CatalogService` the menu and player call.

## Rules
- `createCatalogService(deps)` (`catalog.ts`) is plain TypeScript with `db`, `secrets`, `scheduler`, `http`, `clock` (and optional `newId`) injected;
  it imports no native module. `createDeviceCatalog()` (`device.ts`) wires the real adapters, opens `catalog.db` once per process
  (a failed open rejects with `CatalogOpenError` and is retried by the next call) and is only smoke-tested with mocked adapters.
- `importSource` calls `setAbortSignal(opts.signal)` on the driver before the run and `setAbortSignal(undefined)` in `finally`, when the driver has it.
- Paged reads (`queries.ts`): provider `position` order, `limit` capped at 500 (`MAX_PAGE`), `categories` carry `itemCount`.
  A category `id` is opaque (`<source>|<kind>|<provider id>`); an unknown one gives an empty page.
- `seasons(seriesId)` loads Xtream episodes on first use (`loadSeriesEpisodes`); `seriesId` is the `id` of an item row.
- `resolveStream(itemKey)` finds the source from the key (`x:`/`m:` prefix), rebuilds an Xtream URL from the secret with `@elv/sources`
  or an M3U URL from its template with `createStreamResolver`, and adds the source's transport headers. Never log or store the result.
- Tests (Vitest, Node) run against `@elv/data/testing` and the in-process simulator imported from `tools/src/sim/`.
