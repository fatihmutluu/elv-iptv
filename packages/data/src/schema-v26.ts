/**
 * Migration v26 (`Wave Q7-B`, `F-11`): cross-source per-profile Live TV favorite folders.
 *
 * - `live_favorite_folders`: named folders per profile with deterministic `sort_order`.
 * - `live_favorite_folder_items`: 1-folder-per-favorite-channel assignment (`PRIMARY KEY (profile_id, item_key)`),
 *   storing only `source_id` + `item_key` (never stream URLs or credentials), with `ON DELETE CASCADE`
 *   so deleting a folder atomically unfiles its channels while preserving their `favorites` rows.
 */
export const MIGRATION_V26 = `
CREATE TABLE IF NOT EXISTS live_favorite_folders (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  name_fold TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_fav_folders_profile
  ON live_favorite_folders (profile_id, sort_order, created_at, id);

CREATE TABLE IF NOT EXISTS live_favorite_folder_items (
  folder_id TEXT NOT NULL REFERENCES live_favorite_folders(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, item_key)
);
CREATE INDEX IF NOT EXISTS idx_live_fav_folder_items_folder
  ON live_favorite_folder_items (folder_id, position);
CREATE INDEX IF NOT EXISTS idx_live_fav_folder_items_source
  ON live_favorite_folder_items (source_id);
`;
