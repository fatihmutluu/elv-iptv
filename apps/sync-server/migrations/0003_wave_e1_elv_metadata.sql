-- Wave E1 (#511): IMDb-first collective metadata cache, match index, localized synopses, and editorial feeds.
-- Compatible with Cloudflare D1 (SQLite), applied after 0002_wave_p9_pairing_telemetry.sql.

CREATE TABLE IF NOT EXISTS elv_title_cache (
  imdb_id TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  original_title TEXT NOT NULL,
  english_title TEXT,
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
  original_synopsis TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_elv_title_cache_media_type ON elv_title_cache(media_type);
CREATE INDEX IF NOT EXISTS idx_elv_title_cache_franchise_key ON elv_title_cache(franchise_key);
CREATE INDEX IF NOT EXISTS idx_elv_title_cache_updated_at ON elv_title_cache(updated_at);

CREATE TABLE IF NOT EXISTS elv_title_match_index (
  lookup_key TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  year INTEGER,
  imdb_id TEXT NOT NULL,
  confidence REAL NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_elv_title_match_index_imdb_id ON elv_title_match_index(imdb_id);
CREATE INDEX IF NOT EXISTS idx_elv_title_match_index_updated_at ON elv_title_match_index(updated_at);

CREATE TABLE IF NOT EXISTS elv_localized_synopses (
  imdb_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  localized_title TEXT,
  synopsis TEXT NOT NULL,
  source TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (imdb_id, lang)
);

CREATE INDEX IF NOT EXISTS idx_elv_localized_synopses_lang ON elv_localized_synopses(lang);

CREATE TABLE IF NOT EXISTS elv_feeds_cache (
  feed_key TEXT PRIMARY KEY,
  items_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
