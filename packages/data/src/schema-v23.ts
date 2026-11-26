/**
 * Migration v23:
 * - Adds `ratings` table storing per-profile Like/Dislike (`'like' | 'dislike'`) ratings
 *   strictly for Movies & Series (`kind IN ('movie', 'series')`, never Live TV).
 */
export const MIGRATION_V23 = `
CREATE TABLE IF NOT EXISTS ratings (
  profile_id TEXT NOT NULL DEFAULT 'default',
  source_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('movie', 'series')),
  value TEXT NOT NULL CHECK(value IN ('like', 'dislike')),
  title TEXT NOT NULL,
  logo TEXT,
  year INTEGER,
  rating REAL,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_id, item_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_ratings_profile_value ON ratings (profile_id, value, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ratings_source ON ratings (source_id);
`;
