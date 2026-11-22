/** Migration v6: backup stream URLs on playable catalog tables and per-channel EPG time shift on live channels. */
export const MIGRATION_V6 = `
ALTER TABLE live ADD COLUMN backup_urls_json TEXT;
ALTER TABLE live_next ADD COLUMN backup_urls_json TEXT;
ALTER TABLE movies ADD COLUMN backup_urls_json TEXT;
ALTER TABLE movies_next ADD COLUMN backup_urls_json TEXT;
ALTER TABLE episodes ADD COLUMN backup_urls_json TEXT;
ALTER TABLE episodes_next ADD COLUMN backup_urls_json TEXT;
ALTER TABLE live ADD COLUMN epg_shift_ms INTEGER;
ALTER TABLE live_next ADD COLUMN epg_shift_ms INTEGER;
`;
