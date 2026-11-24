/**
 * Migration v18 (`#215`, `#403`):
 * - Adds `vod_enrichment` (`WITHOUT ROWID`, `idx_vod_enrichment_source`) storing cached key-free
 *   VOD/series metadata enrichments with TTL expiration.
 * - Adds `vod_collections` (`idx_vod_collections_profile`) storing per-profile custom user VOD
 *   collections.
 * - Adds `vod_collection_items` (`WITHOUT ROWID`, `idx_vod_collection_items_order`,
 *   `idx_vod_collection_items_source`, `idx_vod_collection_items_key`) storing ordered collection
 *   members anchored by stable `item_key`.
 */
export const MIGRATION_V18 = `
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
`;
