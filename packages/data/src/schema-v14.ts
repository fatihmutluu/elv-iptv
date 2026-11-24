/**
 * Migration v14 (`#15`, `#31`):
 * - Adds `profiles` (`WITHOUT ROWID`) and seeds the permanent `'default'` profile.
 * - Adds `parental_settings` (`WITHOUT ROWID`) storing non-secret per-profile parental policy
 *   (PIN hashes live exclusively in `SecretStore` under `profile.<profileId>.pin`).
 * - Adds `parental_locks` (`WITHOUT ROWID`) keyed by `(profile_id, source_id, target_kind, item_kind, target_key)`
 *   independently of `import_runs` and `*_next` staging tables so catalog refreshes preserve all locks
 *   while source removal cleans them up via `TABLES_BY_SOURCE`.
 */
export const MIGRATION_V14 = `
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar_token TEXT NOT NULL DEFAULT 'crimson',
  is_kids INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

INSERT OR IGNORE INTO profiles (id, name, avatar_token, is_kids, is_default, created_at, updated_at)
VALUES ('default', 'Default', 'crimson', 0, 1, 0, 0);

CREATE TABLE IF NOT EXISTS parental_settings (
  profile_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  block_adult_keywords INTEGER NOT NULL DEFAULT 1,
  max_rating_age INTEGER,
  unlock_timeout_min INTEGER NOT NULL DEFAULT 30,
  updated_at INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS parental_locks (
  profile_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  item_kind TEXT NOT NULL,
  target_key TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_id, source_id, target_kind, item_kind, target_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_parental_locks_source ON parental_locks (source_id);
CREATE INDEX IF NOT EXISTS idx_parental_locks_profile ON parental_locks (profile_id, target_kind, item_kind);
`;
