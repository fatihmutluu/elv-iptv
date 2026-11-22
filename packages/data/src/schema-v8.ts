import type { SqlDriver, SqlValue } from '@elv/domain';
import { sortTitleKey } from './fold';

/** Tables storing article-stripped `sort_title` keys for alphabetical browse ordering (`#125`). */
export type SortTitleTable = 'live' | 'movies' | 'series';

const SORT_TITLE_TABLES: readonly SortTitleTable[] = ['live', 'movies', 'series'];
const BACKFILL_BATCH_SIZE = 1_000;

/** Migration v8: article-stripped `sort_title` columns and indexes on catalog item tables (`#125`). */
export const MIGRATION_V8 = `
ALTER TABLE live ADD COLUMN sort_title TEXT NOT NULL DEFAULT '';
ALTER TABLE live_next ADD COLUMN sort_title TEXT NOT NULL DEFAULT '';
ALTER TABLE movies ADD COLUMN sort_title TEXT NOT NULL DEFAULT '';
ALTER TABLE movies_next ADD COLUMN sort_title TEXT NOT NULL DEFAULT '';
ALTER TABLE series ADD COLUMN sort_title TEXT NOT NULL DEFAULT '';
ALTER TABLE series_next ADD COLUMN sort_title TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_live_sort_title ON live (source_id, is_hidden, sort_title, key);
CREATE INDEX IF NOT EXISTS idx_movies_sort_title ON movies (source_id, is_hidden, sort_title, key);
CREATE INDEX IF NOT EXISTS idx_series_sort_title ON series (source_id, is_hidden, sort_title, key);
`;

/**
 * Deterministically backfills `sort_title = sortTitleKey(name)` for existing rows inside an open
 * migration or schema-repair transaction without touching `name_fold` (zero FTS5 churn).
 */
export async function backfillSortTitles(
  tx: SqlDriver,
  tables: readonly SortTitleTable[] = SORT_TITLE_TABLES,
): Promise<void> {
  for (const table of tables) {
    let lastId = 0;
    for (;;) {
      const rows = await tx.all<{ id: number; name: string; sort_title: string }>(
        `SELECT id, name, sort_title FROM ${table} WHERE id > ? ORDER BY id ASC LIMIT ?`,
        [lastId, BACKFILL_BATCH_SIZE],
      );
      if (rows.length === 0) break;
      const updates: SqlValue[][] = [];
      for (const row of rows) {
        const expected = sortTitleKey(row.name);
        if (row.sort_title !== expected) {
          updates.push([expected, row.id]);
        }
        lastId = row.id;
      }
      if (updates.length > 0) {
        await tx.batch(`UPDATE ${table} SET sort_title = ? WHERE id = ?`, updates);
      }
      if (rows.length < BACKFILL_BATCH_SIZE) break;
    }
  }
}
