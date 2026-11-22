/**
 * Migration v10: EPG genre & broadcast flag columns (`#396`), recently watched channels (`#53`),
 * and composite `import_runs` index for O(1) last-sync lookups (`#68`).
 */
export const MIGRATION_V10 = `
ALTER TABLE programmes ADD COLUMN genre TEXT;
ALTER TABLE programmes ADD COLUMN flags INTEGER NOT NULL DEFAULT 0;
ALTER TABLE programmes_next ADD COLUMN genre TEXT;
ALTER TABLE programmes_next ADD COLUMN flags INTEGER NOT NULL DEFAULT 0;

CREATE TABLE recent_channels (
  profile_id TEXT NOT NULL DEFAULT 'default',
  source_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  watched_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_id, item_key)
) WITHOUT ROWID;
CREATE INDEX idx_recent_channels_order ON recent_channels (profile_id, watched_at DESC);
CREATE INDEX idx_recent_channels_source ON recent_channels (source_id);

CREATE INDEX idx_import_runs_source_kind_status ON import_runs (source_id, kind, status, finished_at DESC);
`;
