/** Bytes a write-ahead log is truncated back to after a checkpoint (64 MiB). */
export const JOURNAL_SIZE_LIMIT = 67_108_864;

/** Pragmas applied on every open, before migrations. `journal_mode` reports `memory` for in-memory databases. */
export const OPEN_PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA temp_store = MEMORY',
  `PRAGMA journal_size_limit = ${JOURNAL_SIZE_LIMIT}`,
];

/** Ordered migrations; entry `i` upgrades a database from `user_version` `i` to `i + 1`. */
export const MIGRATIONS: readonly string[] = [
  `
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  settings_json TEXT NOT NULL
);

CREATE TABLE import_runs (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  error_category TEXT,
  error_code TEXT,
  counts_json TEXT
);

CREATE TABLE categories (
  source_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  name TEXT NOT NULL,
  name_fold TEXT NOT NULL,
  position INTEGER NOT NULL,
  run_id INTEGER NOT NULL,
  PRIMARY KEY (source_id, kind, provider_id)
) WITHOUT ROWID;

CREATE TABLE live (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL,
  key TEXT NOT NULL,
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
  UNIQUE (source_id, key)
);
CREATE INDEX idx_live_num ON live (source_id, num);

CREATE TABLE movies (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL,
  key TEXT NOT NULL,
  provider_id TEXT,
  name TEXT NOT NULL,
  name_fold TEXT NOT NULL,
  logo TEXT,
  rating REAL,
  year INTEGER,
  extension TEXT,
  added INTEGER,
  url_template TEXT,
  run_id INTEGER NOT NULL,
  UNIQUE (source_id, key)
);

CREATE TABLE series (
  id INTEGER PRIMARY KEY,
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
  UNIQUE (source_id, key)
);

CREATE TABLE episodes (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL,
  key TEXT NOT NULL,
  provider_id TEXT,
  series_key TEXT NOT NULL,
  season INTEGER,
  episode INTEGER,
  title TEXT,
  extension TEXT,
  duration_sec INTEGER,
  url_template TEXT,
  run_id INTEGER NOT NULL,
  UNIQUE (source_id, key)
);
CREATE INDEX idx_episodes_series ON episodes (source_id, series_key, season, episode);

CREATE TABLE placements (
  source_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  item_key TEXT NOT NULL,
  category_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  run_id INTEGER NOT NULL,
  PRIMARY KEY (source_id, kind, category_id, item_key)
) WITHOUT ROWID;
CREATE INDEX idx_placements_browse ON placements (source_id, kind, category_id, position);

CREATE TABLE guide_channels (
  source_id TEXT NOT NULL,
  guide_id TEXT NOT NULL,
  name TEXT NOT NULL,
  name_fold TEXT NOT NULL,
  icon TEXT,
  run_id INTEGER NOT NULL,
  PRIMARY KEY (source_id, guide_id)
) WITHOUT ROWID;

CREATE TABLE channel_guide (
  source_id TEXT NOT NULL,
  channel_key TEXT NOT NULL,
  guide_id TEXT NOT NULL,
  PRIMARY KEY (source_id, channel_key)
) WITHOUT ROWID;

CREATE TABLE programmes (
  source_id TEXT NOT NULL,
  guide_id TEXT NOT NULL,
  start INTEGER NOT NULL,
  stop INTEGER NOT NULL,
  title TEXT NOT NULL,
  sub_title TEXT,
  description TEXT,
  categories_json TEXT,
  episode_num TEXT,
  icon TEXT,
  run_id INTEGER NOT NULL,
  PRIMARY KEY (source_id, guide_id, start)
) WITHOUT ROWID;

CREATE TABLE programmes_next (
  source_id TEXT NOT NULL,
  guide_id TEXT NOT NULL,
  start INTEGER NOT NULL,
  stop INTEGER NOT NULL,
  title TEXT NOT NULL,
  sub_title TEXT,
  description TEXT,
  categories_json TEXT,
  episode_num TEXT,
  icon TEXT,
  run_id INTEGER NOT NULL,
  PRIMARY KEY (source_id, guide_id, start)
) WITHOUT ROWID;
`,
];
