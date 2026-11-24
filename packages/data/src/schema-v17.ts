/**
 * Migration v17 (`#157`):
 * - Adds `failover_groups` storing user-created and auto-matched multi-source live failover groups.
 * - Adds `failover_group_members` (`WITHOUT ROWID`, `idx_failover_members_group`,
 *   `idx_failover_members_channel`, `idx_failover_members_source`) storing prioritized member channels
 *   across sources.
 */
export const MIGRATION_V17 = `
CREATE TABLE IF NOT EXISTS failover_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_fold TEXT NOT NULL,
  auto_matched INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS failover_group_members (
  group_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  channel_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (group_id, channel_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_failover_members_group ON failover_group_members (group_id, position);
CREATE INDEX IF NOT EXISTS idx_failover_members_channel ON failover_group_members (channel_key);
CREATE INDEX IF NOT EXISTS idx_failover_members_source ON failover_group_members (source_id);
`;
