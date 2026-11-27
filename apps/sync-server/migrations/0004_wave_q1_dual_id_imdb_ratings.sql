-- Wave Q1 Track A: Dual IMDb + TMDB indexing and official IMDb dataset ratings cache.
-- Compatible with Cloudflare D1 (SQLite), applied after 0003_wave_e1_elv_metadata.sql.

ALTER TABLE elv_title_cache ADD COLUMN tmdb_id TEXT;
CREATE INDEX IF NOT EXISTS idx_elv_title_cache_tmdb_id ON elv_title_cache(tmdb_id);

ALTER TABLE elv_title_match_index ADD COLUMN tmdb_id TEXT;
CREATE INDEX IF NOT EXISTS idx_elv_title_match_index_tmdb_id ON elv_title_match_index(tmdb_id);

CREATE TABLE IF NOT EXISTS elv_imdb_ratings (
  imdb_id TEXT PRIMARY KEY,
  rating REAL NOT NULL,
  votes INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_elv_imdb_ratings_votes ON elv_imdb_ratings(votes DESC);
