/**
 * Migration v22:
 * - Adds `my_list_series_baselines` table to track per-profile known episode keys and last check
 *   timestamps for favorited series (`#502`).
 * - Adds `my_list_new_episodes` table to record newly arrived episodes for active My List series
 *   with dismissal support and indexed lookups by profile, series, and source (`#502`).
 * - Adds `continue_watching_dismissals` table to persist per-profile Continue Watching Next-Up
 *   dismissals per series without erasing watched episode history (`#502`).
 */
export const MIGRATION_V22 = `
CREATE TABLE my_list_series_baselines (
  profile_id TEXT NOT NULL DEFAULT 'default',
  series_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  baseline_at INTEGER NOT NULL DEFAULT 0,
  last_checked_at INTEGER NOT NULL DEFAULT 0,
  known_keys_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (profile_id, series_key)
) WITHOUT ROWID;
CREATE INDEX idx_my_list_baselines_source ON my_list_series_baselines (source_id);

CREATE TABLE my_list_new_episodes (
  profile_id TEXT NOT NULL DEFAULT 'default',
  episode_key TEXT NOT NULL,
  series_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  series_title TEXT NOT NULL,
  series_logo TEXT,
  season INTEGER,
  episode INTEGER,
  episode_title TEXT NOT NULL,
  detected_at INTEGER NOT NULL DEFAULT 0,
  dismissed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_id, episode_key)
) WITHOUT ROWID;
CREATE INDEX idx_my_list_new_ep_profile ON my_list_new_episodes (profile_id, dismissed, detected_at DESC);
CREATE INDEX idx_my_list_new_ep_series ON my_list_new_episodes (profile_id, series_key);
CREATE INDEX idx_my_list_new_ep_source ON my_list_new_episodes (source_id);

CREATE TABLE IF NOT EXISTS continue_watching_dismissals (
  profile_id TEXT NOT NULL DEFAULT 'default',
  series_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  dismissed_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_id, series_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_cw_dismissals_source ON continue_watching_dismissals (source_id);
`;
