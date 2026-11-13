# 0005 Data layer: SqlDriver port, SQLite, FTS5

- Status: Accepted
- Date: 2026-11-13

## Context and problem

Catalogs of 100k+ items and large EPGs must stay responsive on 1-2 GB devices, on native, Electron and later web TVs, with credentials kept out of the catalog.

## Decision drivers

- Speed and low memory.
- One data code path across runtimes.
- Playlist refreshes must never wipe user data.

## Considered options

- An ORM everywhere.
- A thin port with raw SQL for the catalog and an ORM only for synced tables.
- Platform-specific storage.

## Decision outcome

SQLite is the source of truth behind a small `SqlDriver` port: op-sqlite on native (expo-sqlite as fallback) and better-sqlite3 in an Electron utility process. Raw SQL with FTS5 over a folded-text column (own TypeScript fold with explicit Turkish dotted and dotless I rules) for catalog and EPG; Drizzle only for synced user tables. Own streaming M3U and XMLTV scanners in TypeScript; a native importer only if budgets are missed. Content keys are stable; user tables carry `profile_id` and are not cascaded by refreshes. Credentials live in secure storage only. The sync server stack is named in spec section 4 and built after the 0.1 release (spec section 10).

### Consequences

- Good: fast imports and search; one driver interface; clean test seams.
- Bad: Hermes has no Wasm or JIT, so large XMLTV imports are a risk to measure; two drivers to maintain.

## Links

- [Foundation spec](../superpowers/specs/2026-11-13-foundation-design.md) sections 4, 5.4, 11.
