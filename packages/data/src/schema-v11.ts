import type { SqlDriver, SqlValue } from '@elv/domain';
import { parseLiveVariant } from './live-variants';
import { parseVodVersion } from './vod-versions';

const BACKFILL_BATCH_SIZE = 1_000;

/**
 * Migration v11 (`#182`, `#218`, `#404`):
 * - `guide_channels.lcn` + `programmes[_next].{rating_system,rating_value}` (`#182`)
 * - `live[_next].{variant_base_fold,quality_rank}` + `idx_live_variant` (`#218`)
 * - `movies[_next].{version_group_key,version_label}` + `idx_movies_version_group` (`#404`)
 * - `watch_progress.{version_group_key,preferred_item_key}` + `idx_watch_progress_vgroup` (`#404`)
 */
export const MIGRATION_V11 = `
ALTER TABLE guide_channels ADD COLUMN lcn TEXT;
ALTER TABLE programmes ADD COLUMN rating_system TEXT;
ALTER TABLE programmes ADD COLUMN rating_value TEXT;
ALTER TABLE programmes_next ADD COLUMN rating_system TEXT;
ALTER TABLE programmes_next ADD COLUMN rating_value TEXT;

ALTER TABLE live ADD COLUMN variant_base_fold TEXT NOT NULL DEFAULT '';
ALTER TABLE live ADD COLUMN quality_rank INTEGER NOT NULL DEFAULT 0;
ALTER TABLE live_next ADD COLUMN variant_base_fold TEXT NOT NULL DEFAULT '';
ALTER TABLE live_next ADD COLUMN quality_rank INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_live_variant ON live (source_id, is_hidden, variant_base_fold, quality_rank DESC);

ALTER TABLE movies ADD COLUMN version_group_key TEXT NOT NULL DEFAULT '';
ALTER TABLE movies ADD COLUMN version_label TEXT;
ALTER TABLE movies_next ADD COLUMN version_group_key TEXT NOT NULL DEFAULT '';
ALTER TABLE movies_next ADD COLUMN version_label TEXT;
CREATE INDEX IF NOT EXISTS idx_movies_version_group ON movies (source_id, is_hidden, version_group_key);

ALTER TABLE watch_progress ADD COLUMN version_group_key TEXT;
ALTER TABLE watch_progress ADD COLUMN preferred_item_key TEXT;
CREATE INDEX IF NOT EXISTS idx_watch_progress_vgroup ON watch_progress (profile_id, version_group_key);
`;

/**
 * Idempotently backfills `live.{variant_base_fold,quality_rank}`,
 * `movies.{version_group_key,version_label}`, and `watch_progress.{version_group_key,preferred_item_key}`
 * inside an open migration or schema-repair transaction without touching `name_fold` (zero FTS5 churn).
 */
export async function backfillWaveC3Metadata(tx: SqlDriver): Promise<void> {
  let lastLiveId = 0;
  for (;;) {
    const rows = await tx.all<{
      id: number;
      name: string;
      variant_base_fold: string;
      quality_rank: number;
    }>(
      'SELECT id, name, variant_base_fold, quality_rank FROM live WHERE id > ? ORDER BY id ASC LIMIT ?',
      [lastLiveId, BACKFILL_BATCH_SIZE],
    );
    if (rows.length === 0) break;
    const updates: SqlValue[][] = [];
    for (const row of rows) {
      const parsed = parseLiveVariant(row.name);
      if (row.variant_base_fold !== parsed.baseFold || row.quality_rank !== parsed.qualityRank) {
        updates.push([parsed.baseFold, parsed.qualityRank, row.id]);
      }
      lastLiveId = row.id;
    }
    if (updates.length > 0) {
      await tx.batch(
        'UPDATE live SET variant_base_fold = ?, quality_rank = ? WHERE id = ?',
        updates,
      );
    }
    if (rows.length < BACKFILL_BATCH_SIZE) break;
  }

  let lastMovieId = 0;
  for (;;) {
    const rows = await tx.all<{
      id: number;
      name: string;
      year: number | null;
      version_group_key: string;
      version_label: string | null;
    }>(
      'SELECT id, name, year, version_group_key, version_label FROM movies WHERE id > ? ORDER BY id ASC LIMIT ?',
      [lastMovieId, BACKFILL_BATCH_SIZE],
    );
    if (rows.length === 0) break;
    const updates: SqlValue[][] = [];
    for (const row of rows) {
      const parsed = parseVodVersion(row.name, row.year);
      const label = parsed.versionLabel.length > 0 ? parsed.versionLabel : null;
      if (row.version_group_key !== parsed.groupKey || row.version_label !== label) {
        updates.push([parsed.groupKey, label, row.id]);
      }
      lastMovieId = row.id;
    }
    if (updates.length > 0) {
      await tx.batch(
        'UPDATE movies SET version_group_key = ?, version_label = ? WHERE id = ?',
        updates,
      );
    }
    if (rows.length < BACKFILL_BATCH_SIZE) break;
  }

  await tx.run(
    `UPDATE watch_progress
       SET version_group_key = (
             SELECT m.version_group_key
             FROM movies m
             WHERE m.source_id = watch_progress.source_id AND m.key = watch_progress.item_key
           ),
           preferred_item_key = COALESCE(preferred_item_key, item_key)
     WHERE kind = 'movie' AND version_group_key IS NULL`,
  );
}
