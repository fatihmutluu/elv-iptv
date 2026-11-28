/**
 * Migration v27 (`Wave R3`): per-profile persistent recommendation dismissals (`Don't recommend again`).
 */
export const MIGRATION_V27 = `
CREATE TABLE IF NOT EXISTS recommendation_dismissals (
  profile_id TEXT NOT NULL DEFAULT 'default',
  item_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  dismissed_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_id, item_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_recommendation_dismissals_profile
  ON recommendation_dismissals (profile_id, dismissed_at DESC);
`;
