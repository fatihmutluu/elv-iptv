/** Migration v7: deterministic content hashes on catalog tables for zero-write re-sync diffing (`#192`). */
export const MIGRATION_V7 = `
ALTER TABLE categories ADD COLUMN content_hash TEXT;
ALTER TABLE categories_next ADD COLUMN content_hash TEXT;
ALTER TABLE live ADD COLUMN content_hash TEXT;
ALTER TABLE live_next ADD COLUMN content_hash TEXT;
ALTER TABLE movies ADD COLUMN content_hash TEXT;
ALTER TABLE movies_next ADD COLUMN content_hash TEXT;
ALTER TABLE series ADD COLUMN content_hash TEXT;
ALTER TABLE series_next ADD COLUMN content_hash TEXT;
`;
