/**
 * Migration v19 (`#272`):
 * - Adds `item_drm_meta` (`WITHOUT ROWID`, `idx_item_drm_meta_source`) recording ONLY non-secret
 *   DRM presence metadata `(source_id, item_key, scheme)`. All license URLs, license headers, and
 *   ClearKey `kid:key` pairs live strictly in `SecretStore` (`source.<id>.drm_specs`), never SQLite.
 */
export const MIGRATION_V19 = `
CREATE TABLE IF NOT EXISTS item_drm_meta (
  source_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  scheme TEXT NOT NULL,
  PRIMARY KEY (source_id, item_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_item_drm_meta_source ON item_drm_meta (source_id);
`;
