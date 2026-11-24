/**
 * Migration v15 (`#60`):
 * - Adds `channel_overrides` (`WITHOUT ROWID`) keyed by `(profile_id, item_key)` storing per-profile
 *   custom channel display names, hide flags, and manual sort order, with `idx_channel_overrides_source`
 *   for source-removal cleanup.
 * - Adds `custom_groups` storing per-profile user-defined live channel groups, indexed by
 *   `(profile_id, sort_order)`.
 * - Adds `custom_group_items` (`WITHOUT ROWID`) keyed by `(group_id, item_key)` storing ordered
 *   live channel memberships across one or more sources, indexed by `(group_id, position)` and `(source_id)`.
 */
export const MIGRATION_V15 = `
CREATE TABLE IF NOT EXISTS channel_overrides (
  profile_id TEXT NOT NULL DEFAULT 'default',
  item_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  custom_name TEXT,
  is_hidden INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, item_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_channel_overrides_source ON channel_overrides (source_id);

CREATE TABLE IF NOT EXISTS custom_groups (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_hidden INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_custom_groups_profile ON custom_groups (profile_id, sort_order);

CREATE TABLE IF NOT EXISTS custom_group_items (
  group_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, item_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_custom_group_items_group ON custom_group_items (group_id, position);
CREATE INDEX IF NOT EXISTS idx_custom_group_items_source ON custom_group_items (source_id);
`;
