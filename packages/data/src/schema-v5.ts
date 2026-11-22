/** Migration v5: source deletion flag, SQL hidden-item filtering, visible browse index, and atomic import staging tables. */
export const MIGRATION_V5 = `
ALTER TABLE sources ADD COLUMN deleting INTEGER NOT NULL DEFAULT 0;
ALTER TABLE categories ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE live ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE movies ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE series ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE placements ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_placements_visible ON placements (source_id, kind, category_id, is_hidden, position);
CREATE INDEX IF NOT EXISTS idx_live_visible_key ON live (source_id, key, is_hidden);
CREATE INDEX IF NOT EXISTS idx_movies_visible_key ON movies (source_id, key, is_hidden);
CREATE INDEX IF NOT EXISTS idx_series_visible_key ON series (source_id, key, is_hidden);

CREATE TABLE categories_next (
  source_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  name TEXT NOT NULL,
  name_fold TEXT NOT NULL,
  position INTEGER NOT NULL,
  run_id INTEGER NOT NULL,
  PRIMARY KEY (source_id, kind, provider_id)
) WITHOUT ROWID;

CREATE TABLE live_next (
  source_id TEXT NOT NULL,
  key TEXT NOT NULL,
  legacy_key TEXT,
  provider_id TEXT,
  num INTEGER,
  name TEXT NOT NULL,
  name_fold TEXT NOT NULL,
  logo TEXT,
  guide_id TEXT,
  catchup_days INTEGER,
  url_template TEXT,
  headers_json TEXT,
  run_id INTEGER NOT NULL,
  PRIMARY KEY (source_id, key)
) WITHOUT ROWID;

CREATE TABLE movies_next (
  source_id TEXT NOT NULL,
  key TEXT NOT NULL,
  legacy_key TEXT,
  provider_id TEXT,
  name TEXT NOT NULL,
  name_fold TEXT NOT NULL,
  logo TEXT,
  rating REAL,
  year INTEGER,
  extension TEXT,
  added INTEGER,
  url_template TEXT,
  headers_json TEXT,
  run_id INTEGER NOT NULL,
  PRIMARY KEY (source_id, key)
) WITHOUT ROWID;

CREATE TABLE series_next (
  source_id TEXT NOT NULL,
  key TEXT NOT NULL,
  provider_id TEXT,
  name TEXT NOT NULL,
  name_fold TEXT NOT NULL,
  cover TEXT,
  plot TEXT,
  rating REAL,
  year INTEGER,
  last_modified INTEGER,
  run_id INTEGER NOT NULL,
  PRIMARY KEY (source_id, key)
) WITHOUT ROWID;

CREATE TABLE episodes_next (
  source_id TEXT NOT NULL,
  key TEXT NOT NULL,
  legacy_key TEXT,
  provider_id TEXT,
  series_key TEXT NOT NULL,
  season INTEGER,
  episode INTEGER,
  title TEXT,
  extension TEXT,
  duration_sec INTEGER,
  url_template TEXT,
  headers_json TEXT,
  run_id INTEGER NOT NULL,
  PRIMARY KEY (source_id, key)
) WITHOUT ROWID;

CREATE TABLE placements_next (
  source_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  item_key TEXT NOT NULL,
  category_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  run_id INTEGER NOT NULL,
  PRIMARY KEY (source_id, kind, category_id, item_key)
) WITHOUT ROWID;
`;
