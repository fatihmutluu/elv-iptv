# Wave F5B — Stalker/MAC Portals, Key-Free VOD Enrichment & Custom VOD Collections

**Date:** 2026-11-24  
**Issues:** `#29`, `#215`, `#403`  
**Workstream:** `cluster:sources-data`, `cluster:ui-browse-search` (Closes Epics `#335` & `#345`)  
**Design Alignment:** Cinema Quietude v2 (`docs/design/UI_UX_PHILOSOPHY.md`), Zero-Blink Prewarm, Zero-Credentials-in-SQLite, [ADR 0015](../../adr/0015-stalker-portal-sources.md).

---

## 1. Goals & Scope

1. **Stalker / Ministra MAC Portal Sources (`#29`, ADR 0015):**
   - Add `'stalker'` as a first-class `SourceKind` with strict MAC validation (`AA:BB:CC:DD:EE:FF`).
   - Build credential-isolated `@elv/sources` Stalker client (`handshake`, automatic single token-expiry re-handshake, `profile`, genres/categories, paginated live/VOD/series, portal EPG, and play-time `create_link` stripping `ffmpeg `/`ffrt ` prefixes and enforcing `http(s)://` allowlist).
   - Wire atomic shadow-swap catalog/guide import and play-time `create_link` resolution into `@elv/data` with zero MAC/portal URL/token persistence in SQLite.
   - Add synthetic Stalker portal routes in `tools/src/sim/` and full live/guide/VOD simulator integration tests.
   - Add `'stalker'` mode (Portal URL + MAC address) to `SourcesScreen` with 2D TV D-pad navigation.
2. **Optional Key-Free VOD/Series Metadata & Local Rating Index Enrichment (`#215`):**
   - Normalize noisy M3U/Xtream/Stalker VOD & series titles (stripping `[4K]`, `(UHD)`, `TR:`, `HEVC`, `DUB/SUB`, etc.) into clean `(cleanTitle, releaseYear, foldedTitle)` preserving sequel numbers.
   - Bundle a compact offline key-free rating & metadata index (`vod-rating-index.ts`) and persist resolved enrichments in SQLite `vod_enrichment` (`SCHEMA_VERSION = 18`) with TTL (`7 days`), pruned on `removeSource`.
   - Gate enrichment behind explicit opt-in user preference `vodEnrichmentEnabled` (`false` by default — zero external network calls when disabled), with an optional pluggable key-free metadata adapter seam.
   - Surface enriched ratings, clean release year, genres, and synopsis gracefully on `DetailScreen` when provider fields are missing and preference is enabled.
3. **Custom User VOD Collections & Personal Playlists (`#403`):**
   - Add per-profile SQLite `v18` tables `vod_collections` and `vod_collection_items` anchored by stable `item_key` so collections survive source refreshes without losing valid movies or series.
   - Implement full CRUD + reordering + parental-filter-aware hydration (`listCollections`, `createCollection`, `renameCollection`, `reorderCollections`, `deleteCollection`, `listCollectionItems`, `listCollectionsForItem`, `addItemToCollection`, `removeItemFromCollection`, `reorderCollectionItems`).
   - Add `"Add to collection"` flow on `DetailScreen` (inline Cinema Quietude overlay — zero RN `<Modal>`, full TV D-pad) and a **Collections** section/manager on `HomeScreen` supporting browse, rename, reorder, item removal, and collection deletion across TV, mobile, tablet, and desktop.

---

## 2. Schema v18 (`packages/data/src/schema-v18.ts`)

```sql
CREATE TABLE IF NOT EXISTS vod_enrichment (
  item_key TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  clean_title TEXT NOT NULL,
  release_year INTEGER,
  rating REAL,
  rating_source TEXT,
  genres_json TEXT,
  synopsis TEXT,
  certification TEXT,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_vod_enrichment_source ON vod_enrichment (source_id);

CREATE TABLE IF NOT EXISTS vod_collections (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  name_fold TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vod_collections_profile ON vod_collections (profile_id, sort_order);

CREATE TABLE IF NOT EXISTS vod_collection_items (
  collection_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  position INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (collection_id, item_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_vod_collection_items_order ON vod_collection_items (collection_id, position);
CREATE INDEX IF NOT EXISTS idx_vod_collection_items_source ON vod_collection_items (source_id);
CREATE INDEX IF NOT EXISTS idx_vod_collection_items_key ON vod_collection_items (item_key);
```

## 3. Clean-Room Security & Invariants

- **Zero credentials in SQLite:** Stalker `{ portalUrl, mac, serialNumber }` stored exclusively in `SecretStore` (`source.<id>.stalker`). Opaque Stalker stream commands stored in `live.provider_id` / `movies.provider_id` / `episodes.provider_id` contain strictly portal numeric/opaque IDs (`ch:<id>`, `vod:<id>`) or templated command placeholders — never raw URLs, MACs, or tokens!
- **Parental safety:** `listCollectionItems` applies the active `ParentalLockFilter` so locked movies/series never leak through custom collections.
- **Desktop IPC:** Every new `CatalogService` method (`addStalkerSource`, `getVodEnrichment`, `enrichVodItem`, and all 10 collection CRUD methods) is exposed across `catalog-ipc*.ts`, `catalog-worker*.ts`, `preload/catalog-bridge.ts`, and `desktop-catalog.ts` with strict runtime guards (`<= 800` lines per file).
- **UI craft:** Cinema Quietude v2, zero hardcoded hex colors, zero RN `<Modal>`, 100% EN/TR `@elv/i18n` parity, full 2D TV D-pad navigation, zero forbidden copy.
