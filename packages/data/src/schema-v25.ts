/**
 * Migration v25:
 * - Adds nullable `backdrop` columns to `movies`, `movies_next`, `series`, and `series_next`
 *   to persist explicit landscape backdrop URLs extracted from provider metadata.
 */
export const MIGRATION_V25 = `
ALTER TABLE movies ADD COLUMN backdrop TEXT;
ALTER TABLE movies_next ADD COLUMN backdrop TEXT;
ALTER TABLE series ADD COLUMN backdrop TEXT;
ALTER TABLE series_next ADD COLUMN backdrop TEXT;
`;
