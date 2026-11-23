import { type ElvError, elvError, err, ok, type Result, type SqlDriver } from '@elv/domain';
import { finishDeletingSource, purgeStagedCatalog } from './sources';

const RUN_TABLES: ReadonlySet<string> = new Set([
  'categories',
  'live',
  'movies',
  'series',
  'episodes',
  'placements',
  'guide_channels',
  'programmes',
]);

/** Whether the active (`deleting = 0`) `sources` row still exists; inside a transaction it cannot vanish before commit. */
export async function sourceExists(db: SqlDriver, sourceId: string): Promise<boolean> {
  return (
    (await db.all('SELECT 1 FROM sources WHERE id = ? AND deleting = 0 LIMIT 1', [sourceId]))
      .length > 0
  );
}

/**
 * Inserts a `running` row into `import_runs` and returns its id, `storage/import-in-progress` when a run of the same
 * source and kind is already `running`, or `storage/source-not-found` when the source is gone (checks and insert
 * share one transaction).
 */
export async function startRun(
  db: SqlDriver,
  sourceId: string,
  kind: 'catalog' | 'guide',
  now: number,
): Promise<Result<number>> {
  return db.transaction(async (tx): Promise<Result<number>> => {
    if (!(await sourceExists(tx, sourceId))) return err(elvError('storage', 'source-not-found'));
    const busy = await tx.all(
      "SELECT 1 FROM import_runs WHERE source_id = ? AND kind = ? AND status = 'running' LIMIT 1",
      [sourceId, kind],
    );
    if (busy.length > 0) return err(elvError('storage', 'import-in-progress'));
    await tx.run(
      "INSERT INTO import_runs (source_id, kind, started_at, status) VALUES (?, ?, ?, 'running')",
      [sourceId, kind, now],
    );
    const rows = await tx.all<{ id: number }>('SELECT last_insert_rowid() AS id');
    return ok(rows[0]?.id ?? 0);
  });
}

/** Closes a run with its outcome; only the error category and code are stored, never the detail. */
export async function finishRun(
  db: SqlDriver,
  runId: number,
  outcome: {
    status: 'ok' | 'failed' | 'cancelled';
    error?: ElvError;
    counts?: Record<string, number>;
  },
  now: number,
): Promise<void> {
  await db.run(
    `UPDATE import_runs SET finished_at = ?, status = ?, error_category = ?, error_code = ?, counts_json = ?
     WHERE id = ?`,
    [
      now,
      outcome.status,
      outcome.error?.category ?? null,
      outcome.error?.code ?? null,
      outcome.counts === undefined ? null : JSON.stringify(outcome.counts),
      runId,
    ],
  );
}

/**
 * Deletes the rows of `sourceId` in `tables` written by an older run than `runId` (rows of a newer run are left alone). Call it only after the run
 * succeeded. Returns the number of rows removed per table.
 */
export async function removeStale(
  db: SqlDriver,
  sourceId: string,
  runId: number,
  tables: readonly string[],
): Promise<Record<string, number>> {
  const removed: Record<string, number> = {};
  for (const table of tables) {
    if (!RUN_TABLES.has(table)) throw new Error(`Table ${table} has no run_id column.`);
    const r = await db.run(`DELETE FROM ${table} WHERE source_id = ? AND run_id < ?`, [
      sourceId,
      runId,
    ]);
    removed[table] = r.changes;
  }
  return removed;
}

/** A kind of catalog item; categories and placements carry it in their `kind` column. */
export type CatalogKind = 'live' | 'movie' | 'series';

const KINDS: readonly CatalogKind[] = ['live', 'movie', 'series'];
const KIND_TABLES: Readonly<Record<CatalogKind, readonly string[]>> = {
  live: ['live'],
  movie: ['movies'],
  series: ['series', 'episodes'],
};
const KIND_COUNTS: Readonly<Record<CatalogKind, string>> = {
  live: 'live',
  movie: 'movies',
  series: 'series',
};

/**
 * Kinds of which the run counted no item although rows of an older run exist: a provider glitch that empties one
 * list must not wipe that part of the catalog.
 */
export async function emptiedKinds(
  db: SqlDriver,
  sourceId: string,
  runId: number,
  counts: Readonly<Record<string, number>>,
  skipKinds?: ReadonlySet<CatalogKind>,
): Promise<CatalogKind[]> {
  const kinds: CatalogKind[] = [];
  for (const kind of KINDS) {
    if (skipKinds?.has(kind)) continue;
    if ((counts[KIND_COUNTS[kind]] ?? 0) > 0) continue;
    const table = KIND_TABLES[kind][0] as string;
    const older = await db.all(
      `SELECT 1 FROM ${table} WHERE source_id = ? AND run_id < ? LIMIT 1`,
      [sourceId, runId],
    );
    if (older.length > 0) kinds.push(kind);
  }
  return kinds;
}

/** Counts reported by {@link reapOrphanedRuns}. */
export interface ReapOrphanedRunsResult {
  reapedRuns: number;
  purgedProgrammes: number;
  purgedStaged: number;
  completedDeletes: number;
}

/**
 * Marks every `running` run as `failed` (`storage/interrupted`), purges leftover staged rows in
 * `programmes_next` and all 6 catalog `*_next` tables in one transaction, and finishes purging any
 * `sources` left with `deleting = 1` by a mid-delete crash. Call once when the catalog is opened.
 */
export async function reapOrphanedRuns(
  db: SqlDriver,
  now: number,
): Promise<ReapOrphanedRunsResult> {
  const { reapedRuns, purgedProgrammes, purgedStaged, deletingIds } = await db.transaction(
    async (tx) => {
      const runsRes = await tx.run(
        "UPDATE import_runs SET finished_at = ?, status = 'failed', error_category = 'storage', error_code = 'interrupted' WHERE status = 'running'",
        [now],
      );
      const progRes = await tx.run('DELETE FROM programmes_next');
      const stagedCount = await purgeStagedCatalog(tx);
      const deleting = await tx.all<{ id: string }>('SELECT id FROM sources WHERE deleting = 1');
      return {
        reapedRuns: runsRes.changes,
        purgedProgrammes: progRes.changes,
        purgedStaged: stagedCount,
        deletingIds: deleting.map((r) => r.id),
      };
    },
  );
  for (const id of deletingIds) {
    await finishDeletingSource(db, id);
  }
  return {
    reapedRuns,
    purgedProgrammes,
    purgedStaged,
    completedDeletes: deletingIds.length,
  };
}

/** Health snapshot of a source whose latest catalog refresh failed while cached items remain browsable (`#141`). */
export interface SourceImportHealth {
  sourceId: string;
  status: 'failed';
  errorCategory: string | null;
  errorCode: string | null;
  finishedAt: number | null;
  hasCachedItems: boolean;
}

const LATEST_IMPORT_HEALTH_BASE = `SELECT
    s.id AS source_id,
    r.status AS status,
    r.error_category AS error_category,
    r.error_code AS error_code,
    r.finished_at AS finished_at
  FROM sources s
  JOIN import_runs r ON r.id = (
    SELECT r2.id FROM import_runs r2
    WHERE r2.source_id = s.id AND r2.kind = 'catalog'
    ORDER BY r2.id DESC
    LIMIT 1
  )
  WHERE s.deleting = 0
    AND r.status = 'failed'
    AND (
      EXISTS (SELECT 1 FROM live l WHERE l.source_id = s.id)
      OR EXISTS (SELECT 1 FROM movies m WHERE m.source_id = s.id)
      OR EXISTS (SELECT 1 FROM series sr WHERE sr.source_id = s.id)
    )`;

/**
 * Returns health entries for active sources whose latest `catalog` import run failed while cached
 * catalog items remain in SQLite (`#141`). Returns an empty array when healthy or uncached.
 */
export async function latestImportHealth(
  db: SqlDriver,
  sourceId?: string,
): Promise<SourceImportHealth[]> {
  const sql =
    sourceId === undefined
      ? `${LATEST_IMPORT_HEALTH_BASE} ORDER BY s.created_at, s.id`
      : `${LATEST_IMPORT_HEALTH_BASE} AND s.id = ? ORDER BY s.created_at, s.id`;
  const params = sourceId === undefined ? [] : [sourceId];
  const rows = await db.all<{
    source_id: string;
    status: 'failed';
    error_category: string | null;
    error_code: string | null;
    finished_at: number | null;
  }>(sql, params);
  return rows.map((row) => ({
    sourceId: row.source_id,
    status: row.status,
    errorCategory: row.error_category,
    errorCode: row.error_code,
    finishedAt: row.finished_at,
    hasCachedItems: true,
  }));
}
