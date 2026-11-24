import type { SqlDriver, SqlValue } from '@elv/domain';
import { foldText } from './fold';

const BACKFILL_BATCH_SIZE = 1_000;

/**
 * Migration v13 (`#6`, `#25`, `#268`):
 * - Adds `title_fold` and `description_fold` columns to `programmes` and `programmes_next` so
 *   guide commit populates `programmes_fts` in a single native SQLite `INSERT ... SELECT` without
 *   JS/JSI row round-trips (`#25` 5,000 ch × 7d `< 60 s` budget).
 * - Adds `idx_programmes_source_stop` on `programmes (source_id, stop)` to accelerate
 *   EPG time-window overlap and catch-up retention queries.
 */
export const MIGRATION_V13 = `
ALTER TABLE programmes ADD COLUMN title_fold TEXT NOT NULL DEFAULT '';
ALTER TABLE programmes ADD COLUMN description_fold TEXT NOT NULL DEFAULT '';
ALTER TABLE programmes_next ADD COLUMN title_fold TEXT NOT NULL DEFAULT '';
ALTER TABLE programmes_next ADD COLUMN description_fold TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_programmes_source_stop ON programmes (source_id, stop);
`;

/**
 * Idempotently backfills `programmes.title_fold` and `programmes.description_fold` for rows
 * created before `MIGRATION_V13` inside an open migration or schema-repair transaction.
 */
export async function backfillProgrammesFoldColumns(tx: SqlDriver): Promise<void> {
  const hasUnfolded = await tx.all<{ one: number }>(
    "SELECT 1 AS one FROM programmes WHERE title != '' AND title_fold = '' LIMIT 1",
  );
  if (hasUnfolded.length === 0) return;

  let lastSourceId = '';
  let lastGuideId = '';
  let lastStart = Number.MIN_SAFE_INTEGER;
  for (;;) {
    const rows = await tx.all<{
      source_id: string;
      guide_id: string;
      start: number;
      title: string;
      description: string | null;
      title_fold: string;
      description_fold: string;
    }>(
      `SELECT source_id, guide_id, start, title, description, title_fold, description_fold
         FROM programmes
        WHERE source_id > ?
           OR (source_id = ? AND guide_id > ?)
           OR (source_id = ? AND guide_id = ? AND start > ?)
        ORDER BY source_id ASC, guide_id ASC, start ASC
        LIMIT ?`,
      [
        lastSourceId,
        lastSourceId,
        lastGuideId,
        lastSourceId,
        lastGuideId,
        lastStart,
        BACKFILL_BATCH_SIZE,
      ],
    );
    if (rows.length === 0) break;
    const updates: SqlValue[][] = [];
    for (const row of rows) {
      const titleFold = foldText(row.title);
      const descriptionFold = row.description !== null ? foldText(row.description) : '';
      if (row.title_fold !== titleFold || row.description_fold !== descriptionFold) {
        updates.push([titleFold, descriptionFold, row.source_id, row.guide_id, row.start]);
      }
      lastSourceId = row.source_id;
      lastGuideId = row.guide_id;
      lastStart = row.start;
    }
    if (updates.length > 0) {
      await tx.batch(
        'UPDATE programmes SET title_fold = ?, description_fold = ? WHERE source_id = ? AND guide_id = ? AND start = ?',
        updates,
      );
    }
    if (rows.length < BACKFILL_BATCH_SIZE) break;
  }
}
