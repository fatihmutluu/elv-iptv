/**
 * Migration v20:
 * - Adds `sort_order INTEGER NOT NULL DEFAULT 0` to `favorites` so users can reorder
 *   favorites with deterministic `1..N` ordering while preserving legacy `0` rows by `added_at DESC`.
 */
export const MIGRATION_V20 = `
ALTER TABLE favorites ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
`;
