/** Migration v9: per-item persisted audio/subtitle/sync/aspect preferences (`#208`). */
export const MIGRATION_V9 = `
CREATE TABLE track_preferences (
  profile_id TEXT NOT NULL DEFAULT 'default',
  scope_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  audio_lang TEXT,
  audio_label TEXT,
  sub_lang TEXT,
  sub_label TEXT,
  sub_disabled INTEGER NOT NULL DEFAULT 0,
  audio_delay_ms INTEGER NOT NULL DEFAULT 0,
  sub_delay_ms INTEGER NOT NULL DEFAULT 0,
  resize_mode TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_id, scope_key)
) WITHOUT ROWID;
CREATE INDEX idx_track_preferences_source ON track_preferences (source_id);
`;
