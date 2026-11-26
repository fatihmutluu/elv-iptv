/**
 * Migration v21:
 * - Adds `downloads` table for offline VOD Movies and Series Episodes (`kind IN ('movie', 'episode')`),
 *   keyed by `(profile_id, item_key)` with status, progress byte counters, managed `local_file_name`,
 *   playback-pause coordination flag, metadata, timestamps, and lookup indexes.
 */
export const MIGRATION_V21 = `
CREATE TABLE downloads (
  id TEXT NOT NULL,
  profile_id TEXT NOT NULL DEFAULT 'default',
  source_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('movie', 'episode')),
  title TEXT NOT NULL,
  series_title TEXT,
  season INTEGER,
  episode_num INTEGER,
  poster TEXT,
  local_file_name TEXT NOT NULL,
  local_uri TEXT,
  bytes_downloaded INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER,
  status TEXT NOT NULL DEFAULT 'queued',
  paused_for_playback INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER,
  PRIMARY KEY (profile_id, item_key)
) WITHOUT ROWID;
CREATE INDEX idx_downloads_profile_status ON downloads (profile_id, status, updated_at DESC);
CREATE INDEX idx_downloads_source ON downloads (source_id);
`;
