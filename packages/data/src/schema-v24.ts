/**
 * Migration v24 (`#511` Wave E1):
 * - Adds nullable `provider_imdb_id` and `provider_tmdb_id` columns to `movies`, `movies_next`,
 *   `series`, and `series_next` for Layer 1 (0 ms) provider-supplied ID matching.
 * - Adds partial indexes on `(source_id, provider_imdb_id)` where non-null for zero-scan Layer 1 lookups.
 */
export const MIGRATION_V24 = `
ALTER TABLE movies ADD COLUMN provider_imdb_id TEXT;
ALTER TABLE movies ADD COLUMN provider_tmdb_id TEXT;
ALTER TABLE movies_next ADD COLUMN provider_imdb_id TEXT;
ALTER TABLE movies_next ADD COLUMN provider_tmdb_id TEXT;
ALTER TABLE series ADD COLUMN provider_imdb_id TEXT;
ALTER TABLE series ADD COLUMN provider_tmdb_id TEXT;
ALTER TABLE series_next ADD COLUMN provider_imdb_id TEXT;
ALTER TABLE series_next ADD COLUMN provider_tmdb_id TEXT;
CREATE INDEX IF NOT EXISTS idx_movies_provider_imdb ON movies (source_id, provider_imdb_id) WHERE provider_imdb_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_series_provider_imdb ON series (source_id, provider_imdb_id) WHERE provider_imdb_id IS NOT NULL;
`;
