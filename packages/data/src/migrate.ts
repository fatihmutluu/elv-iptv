import { elvError, err, ok, type Result, type SqlDriver } from '@elv/domain';
import { reapOrphanedRuns } from './runs';
import { EXPECTED_FTS_TABLES, EXPECTED_TABLE_COLUMNS, MIGRATIONS, OPEN_PRAGMAS } from './schema';
import { backfillSortTitles, type SortTitleTable } from './schema-v8';
import { backfillWaveC3Metadata } from './schema-v11';
import { backfillProgrammesFtsIfEmpty, backfillWaveC4aMetadata } from './schema-v12';

/** Schema version this build writes and understands (`PRAGMA user_version`). */
export const SCHEMA_VERSION = MIGRATIONS.length;

const SORT_TITLE_SET = new Set<string>(['live', 'movies', 'series']);

async function verifyAndHealSchema(db: SqlDriver): Promise<Result<void>> {
  const repairs: string[] = [];
  const repairedSortTables: SortTitleTable[] = [];
  let needsWaveC3Backfill = false;
  let needsWaveC4aBackfill = false;
  for (const [table, expected] of Object.entries(EXPECTED_TABLE_COLUMNS)) {
    const cols = await db.all<{ name: string }>(`PRAGMA table_info(${table})`);
    if (cols.length === 0) {
      return err(elvError('storage', 'schema-corrupt', `missing table ${table}`));
    }
    const existing = new Set(cols.map((c) => c.name));
    for (const column of expected) {
      if (!existing.has(column.name)) {
        repairs.push(`ALTER TABLE ${table} ADD COLUMN ${column.name} ${column.alterDefinition}`);
        if (column.name === 'sort_title' && SORT_TITLE_SET.has(table)) {
          repairedSortTables.push(table as SortTitleTable);
        }
        if (
          (table === 'live' && column.name === 'variant_base_fold') ||
          (table === 'movies' && column.name === 'version_group_key') ||
          (table === 'watch_progress' && column.name === 'version_group_key')
        ) {
          needsWaveC3Backfill = true;
        }
        if (
          (table === 'episodes' && column.name === 'title_fold') ||
          ((table === 'movies' || table === 'series') &&
            (column.name === 'cast_fold' || column.name === 'director_fold'))
        ) {
          needsWaveC4aBackfill = true;
        }
      }
    }
  }
  for (const fts of EXPECTED_FTS_TABLES) {
    const found = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [fts],
    );
    if (found.length === 0) {
      return err(elvError('storage', 'schema-corrupt', `missing table ${fts}`));
    }
  }
  const hasProgs = await db.all<{ one: number }>('SELECT 1 AS one FROM programmes LIMIT 1');
  let needsProgrammesFtsRepopulate = false;
  if (hasProgs.length > 0) {
    const hasProgsFts = await db.all<{ one: number }>(
      'SELECT 1 AS one FROM programmes_fts LIMIT 1',
    );
    needsProgrammesFtsRepopulate = hasProgsFts.length === 0;
  }
  if (repairs.length > 0 || needsProgrammesFtsRepopulate) {
    await db.transaction(async (tx) => {
      for (const sql of repairs) await tx.exec(sql);
      if (repairedSortTables.length > 0) {
        for (const table of repairedSortTables) {
          await tx.exec(
            `CREATE INDEX IF NOT EXISTS idx_${table}_sort_title ON ${table} (source_id, is_hidden, sort_title, key)`,
          );
        }
        await backfillSortTitles(tx, repairedSortTables);
      }
      if (needsWaveC3Backfill) {
        await tx.exec(
          'CREATE INDEX IF NOT EXISTS idx_live_variant ON live (source_id, is_hidden, variant_base_fold, quality_rank DESC)',
        );
        await tx.exec(
          'CREATE INDEX IF NOT EXISTS idx_movies_version_group ON movies (source_id, is_hidden, version_group_key)',
        );
        await tx.exec(
          'CREATE INDEX IF NOT EXISTS idx_watch_progress_vgroup ON watch_progress (profile_id, version_group_key)',
        );
        await backfillWaveC3Metadata(tx);
      }
      if (needsWaveC4aBackfill) {
        await backfillWaveC4aMetadata(tx);
      } else if (needsProgrammesFtsRepopulate) {
        await backfillProgrammesFtsIfEmpty(tx, true);
      }
    });
  }
  return ok(undefined);
}

/**
 * Applies the open pragmas and brings the database to {@link SCHEMA_VERSION} in one transaction, then verifies
 * expected table columns via `PRAGMA table_info` and self-heals any missing columns in a single transaction.
 * Returns `storage/schema-too-new` for a database written by a newer build, `storage/schema-corrupt` if a required
 * table is missing at `SCHEMA_VERSION`, and `storage/migration-failed` (rolled back, `user_version` unchanged) when
 * a migration throws. Runs left `running` by a crashed process are marked `failed` / `interrupted`, leftover
 * staged rows in `programmes_next` and the six catalog `*_next` tables are purged, and any sources left
 * `deleting = 1` by a mid-delete crash finish purging inside `reapOrphanedRuns` (no import can be running while the catalog opens).
 */
export async function openCatalog(
  db: SqlDriver,
  clock: () => number = Date.now,
): Promise<Result<void>> {
  try {
    const rows = await db.all<{ user_version: number }>('PRAGMA user_version');
    const current = rows[0]?.user_version ?? 0;
    if (current > SCHEMA_VERSION) {
      return err(elvError('storage', 'schema-too-new', `database version ${current}`));
    }
    for (const pragma of OPEN_PRAGMAS) await db.exec(pragma);
    if (current < SCHEMA_VERSION) {
      await db.transaction(async (tx) => {
        for (let v = current; v < SCHEMA_VERSION; v++) {
          await tx.exec(MIGRATIONS[v] ?? '');
          if (v === 7) await backfillSortTitles(tx);
          if (v === 10) await backfillWaveC3Metadata(tx);
          if (v === 11) await backfillWaveC4aMetadata(tx);
          await tx.exec(`PRAGMA user_version = ${v + 1}`);
        }
      });
    }
    const verified = await verifyAndHealSchema(db);
    if (!verified.ok) return verified;
    await reapOrphanedRuns(db, clock());
    return ok(undefined);
  } catch (error) {
    return err(
      elvError('storage', 'migration-failed', error instanceof Error ? error.message : 'unknown'),
    );
  }
}
