import { MIGRATION_V5 } from './schema-v5';
import { MIGRATION_V6 } from './schema-v6';
import { MIGRATION_V7 } from './schema-v7';
import { MIGRATION_V8 } from './schema-v8';
import { MIGRATION_V9 } from './schema-v9';
import { MIGRATION_V10 } from './schema-v10';
import { MIGRATION_V11 } from './schema-v11';
import { MIGRATION_V12 } from './schema-v12';
import { MIGRATION_V13 } from './schema-v13';
import { MIGRATION_V14 } from './schema-v14';
import { MIGRATION_V15 } from './schema-v15';
import { MIGRATION_V16 } from './schema-v16';
import { MIGRATION_V17 } from './schema-v17';
import { MIGRATION_V18 } from './schema-v18';
import { MIGRATION_V19 } from './schema-v19';
import { MIGRATION_V20 } from './schema-v20';
import { MIGRATION_V21 } from './schema-v21';
import { MIGRATION_V22 } from './schema-v22';
import { MIGRATION_V23 } from './schema-v23';
import { MIGRATION_V24 } from './schema-v24';
import { MIGRATION_V25 } from './schema-v25';
import { MIGRATION_V26 } from './schema-v26';

export {
  EXPECTED_FTS_TABLES,
  EXPECTED_TABLE_COLUMNS,
  type ExpectedColumn,
} from './schema-expected';

/** Bytes a write-ahead log is truncated back to after a checkpoint (64 MiB). */
const JOURNAL_SIZE_LIMIT = 67_108_864;
/** SQLite page cache budget per connection (~64 MiB; negative values are KiB). */
const CACHE_SIZE_KIB = -64_000;
/** Row-sampling ceiling per index for bounded `ANALYZE` / `PRAGMA optimize`. */
const ANALYSIS_LIMIT = 400;

/** Pragmas applied on every open, before migrations. `journal_mode` reports `memory` for in-memory databases. */
export const OPEN_PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA temp_store = MEMORY',
  `PRAGMA journal_size_limit = ${JOURNAL_SIZE_LIMIT}`,
  `PRAGMA cache_size = ${CACHE_SIZE_KIB}`,
  `PRAGMA analysis_limit = ${ANALYSIS_LIMIT}`,
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
CREATE INDEX idx_import_runs_source ON import_runs (source_id);

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
  headers_json TEXT,
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
  headers_json TEXT,
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
  `
CREATE TABLE watch_progress (
  profile_id TEXT NOT NULL DEFAULT 'default',
  source_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  logo TEXT,
  series_key TEXT,
  season INTEGER,
  episode INTEGER,
  position_ms INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  watched INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_id, item_key)
) WITHOUT ROWID;
CREATE INDEX idx_watch_progress_recent ON watch_progress (profile_id, watched, updated_at DESC);
CREATE INDEX idx_watch_progress_source ON watch_progress (source_id);

CREATE TABLE favorites (
  profile_id TEXT NOT NULL DEFAULT 'default',
  source_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  logo TEXT,
  year INTEGER,
  rating REAL,
  added_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_id, item_key)
) WITHOUT ROWID;
CREATE INDEX idx_favorites_recent ON favorites (profile_id, added_at DESC);
CREATE INDEX idx_favorites_source ON favorites (source_id);
`,
  `
CREATE VIRTUAL TABLE live_fts USING fts5(
  name_fold,
  content='live',
  content_rowid='id',
  tokenize='unicode61'
);
CREATE TRIGGER live_ai AFTER INSERT ON live BEGIN
  INSERT INTO live_fts(rowid, name_fold) VALUES (new.id, new.name_fold);
END;
CREATE TRIGGER live_ad AFTER DELETE ON live BEGIN
  INSERT INTO live_fts(live_fts, rowid, name_fold) VALUES ('delete', old.id, old.name_fold);
END;
CREATE TRIGGER live_au AFTER UPDATE OF name_fold ON live WHEN old.name_fold IS NOT new.name_fold BEGIN
  INSERT INTO live_fts(live_fts, rowid, name_fold) VALUES ('delete', old.id, old.name_fold);
  INSERT INTO live_fts(rowid, name_fold) VALUES (new.id, new.name_fold);
END;
INSERT INTO live_fts(live_fts) VALUES ('rebuild');

CREATE VIRTUAL TABLE movies_fts USING fts5(
  name_fold,
  content='movies',
  content_rowid='id',
  tokenize='unicode61'
);
CREATE TRIGGER movies_ai AFTER INSERT ON movies BEGIN
  INSERT INTO movies_fts(rowid, name_fold) VALUES (new.id, new.name_fold);
END;
CREATE TRIGGER movies_ad AFTER DELETE ON movies BEGIN
  INSERT INTO movies_fts(movies_fts, rowid, name_fold) VALUES ('delete', old.id, old.name_fold);
END;
CREATE TRIGGER movies_au AFTER UPDATE OF name_fold ON movies WHEN old.name_fold IS NOT new.name_fold BEGIN
  INSERT INTO movies_fts(movies_fts, rowid, name_fold) VALUES ('delete', old.id, old.name_fold);
  INSERT INTO movies_fts(rowid, name_fold) VALUES (new.id, new.name_fold);
END;
INSERT INTO movies_fts(movies_fts) VALUES ('rebuild');

CREATE VIRTUAL TABLE series_fts USING fts5(
  name_fold,
  content='series',
  content_rowid='id',
  tokenize='unicode61'
);
CREATE TRIGGER series_ai AFTER INSERT ON series BEGIN
  INSERT INTO series_fts(rowid, name_fold) VALUES (new.id, new.name_fold);
END;
CREATE TRIGGER series_ad AFTER DELETE ON series BEGIN
  INSERT INTO series_fts(series_fts, rowid, name_fold) VALUES ('delete', old.id, old.name_fold);
END;
CREATE TRIGGER series_au AFTER UPDATE OF name_fold ON series WHEN old.name_fold IS NOT new.name_fold BEGIN
  INSERT INTO series_fts(series_fts, rowid, name_fold) VALUES ('delete', old.id, old.name_fold);
  INSERT INTO series_fts(rowid, name_fold) VALUES (new.id, new.name_fold);
END;
INSERT INTO series_fts(series_fts) VALUES ('rebuild');
`,
  `
CREATE INDEX IF NOT EXISTS idx_programmes_source_start_stop ON programmes (source_id, start, stop);
`,
  MIGRATION_V5,
  MIGRATION_V6,
  MIGRATION_V7,
  MIGRATION_V8,
  MIGRATION_V9,
  MIGRATION_V10,
  MIGRATION_V11,
  MIGRATION_V12,
  MIGRATION_V13,
  MIGRATION_V14,
  MIGRATION_V15,
  MIGRATION_V16,
  MIGRATION_V17,
  MIGRATION_V18,
  MIGRATION_V19,
  MIGRATION_V20,
  MIGRATION_V21,
  MIGRATION_V22,
  MIGRATION_V23,
  MIGRATION_V24,
  MIGRATION_V25,
  MIGRATION_V26,
];
