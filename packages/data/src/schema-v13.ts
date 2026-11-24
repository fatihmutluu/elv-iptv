/**
 * Migration v13 (`#6`, `#25`, `#268`):
 * - Adds `idx_programmes_source_stop` on `programmes (source_id, stop)` to accelerate
 *   EPG time-window overlap and catch-up retention queries.
 */
export const MIGRATION_V13 = `
CREATE INDEX IF NOT EXISTS idx_programmes_source_stop ON programmes (source_id, stop);
`;
