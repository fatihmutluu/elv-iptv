/** Schema version recorded in `elv_meta.schema_version` for isolated `elv-enrichment.db`. */
export const ELV_ENRICHMENT_SCHEMA_VERSION = '1';

/** SQLite pragmas applied when opening `elv-enrichment.db` on its own isolated `SqlDriver`. */
export const ELV_ENRICHMENT_OPEN_PRAGMAS: readonly string[] = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA temp_store = MEMORY',
];

/** Idempotent DDL creating all isolated ELV Mode enrichment tables and indexes (`#511`). */
export const ELV_ENRICHMENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS elv_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS elv_item_matches (
  item_key TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  media_type TEXT NOT NULL,
  imdb_id TEXT NOT NULL,
  confidence REAL NOT NULL,
  manual_lock INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_elv_matches_imdb_type ON elv_item_matches (imdb_id, media_type);
CREATE INDEX IF NOT EXISTS idx_elv_matches_source ON elv_item_matches (source_id);

CREATE TABLE IF NOT EXISTS elv_titles (
  imdb_id TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  original_title TEXT NOT NULL,
  english_title TEXT,
  localized_titles_json TEXT NOT NULL DEFAULT '{}',
  year INTEGER,
  rating REAL,
  votes INTEGER,
  runtime_min INTEGER,
  genres_json TEXT NOT NULL DEFAULT '[]',
  poster_url TEXT,
  backdrop_url TEXT,
  trailer_stream_url TEXT,
  trailer_youtube_id TEXT,
  director TEXT,
  cast_json TEXT NOT NULL DEFAULT '[]',
  mlt_imdb_ids_json TEXT NOT NULL DEFAULT '[]',
  franchise_key TEXT,
  franchise_name TEXT,
  franchise_order INTEGER,
  synopses_json TEXT NOT NULL DEFAULT '{}',
  detail_fetched_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_elv_titles_franchise ON elv_titles (franchise_key);
CREATE INDEX IF NOT EXISTS idx_elv_titles_type_rating ON elv_titles (media_type, rating DESC, votes DESC);

CREATE TABLE IF NOT EXISTS elv_feeds (
  feed_key TEXT PRIMARY KEY,
  items_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS elv_quality_memory (
  item_key TEXT PRIMARY KEY,
  actual_width INTEGER,
  actual_height INTEGER,
  actual_video_codec TEXT,
  actual_audio_codec TEXT,
  actual_audio_channels INTEGER,
  actual_hdr TEXT,
  claimed_label TEXT,
  is_fake_4k INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  last_success_at INTEGER,
  last_fail_at INTEGER,
  updated_at INTEGER NOT NULL
);
`;
