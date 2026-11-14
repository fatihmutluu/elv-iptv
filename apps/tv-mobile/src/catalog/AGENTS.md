# catalog service (`apps/tv-mobile/src/catalog/`)

The device catalog: `@elv/data` over the storage adapters, behind one `CatalogService` the menu and player call.

## Rules
- `createCatalogService(deps)` (`catalog.ts`) is plain TypeScript with `db`, `secrets`, `scheduler`, `http`, `clock` (and optional `newId`) injected;
  it imports no native module. `createDeviceCatalog()` (`device.ts`) wires the real adapters, opens `catalog.db` once per process
  (a failed open rejects with `CatalogOpenError` and is retried by the next call) and is only smoke-tested with mocked adapters.
- Xtream bodies are capped at `DEVICE_MAX_BODY_BYTES` (4 MiB; `importSource` option `maxBodyBytes` overrides): longer lists load per category,
  and a category or series info still over the cap is fetched once more without it (`@elv/data`). Trade-off (spec 5.3): per-category calls roughly double the large import (about 9 s whole, 19 s capped) but keep the longest JS stall near 45 ms; raising the cap brings back the ~1.2 s
  whole-list `JSON.parse` stall (16 MiB: 1267 ms). Streaming parsing would remove the cap; #76 tracks it (and the 190 ms stall of the `huge` account).
- `importSource` runs imports one at a time through a promise queue (the op-sqlite driver has one abort slot): a later call waits; a call for a source
  that is importing or waiting gets `storage/import-in-progress` at once and never touches the slot; one cancelled while waiting ends `network/aborted`
  without a run. Only on its turn does it call `setAbortSignal(opts.signal)`, and `setAbortSignal(undefined)` in `finally`, when the driver has it.
- Paged reads (`queries.ts`): provider `position` order, `limit` capped at 500 (`MAX_PAGE`), `categories` carry `itemCount`.
  A category `id` is opaque (`<source>|<kind>|<provider id>`); an unknown one gives an empty page.
- `seasons(seriesId)` loads Xtream episodes on first use (`loadSeriesEpisodes`); `seriesId` is the `id` of an item row.
- `resolveStream(itemKey)` finds the source from the key (`x:`/`m:` prefix), rebuilds an Xtream URL from the secret with `@elv/sources`
  or an M3U URL from its template with `createStreamResolver`, and adds the source's transport headers. Never log or store the result.
- Tests (Vitest, Node) run against `@elv/data/testing` and the in-process simulator imported from `tools/src/sim/`.
