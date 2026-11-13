import { type ElvError, elvError, err, ok, type Result, type SqlDriver } from '@elv/domain';

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

/** Whether the `sources` row still exists; inside a transaction it cannot vanish before the commit. */
export async function sourceExists(db: SqlDriver, sourceId: string): Promise<boolean> {
  return (await db.all('SELECT 1 FROM sources WHERE id = ? LIMIT 1', [sourceId])).length > 0;
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
): Promise<CatalogKind[]> {
  const kinds: CatalogKind[] = [];
  for (const kind of KINDS) {
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

/**
 * Deletes the catalog rows of `sourceId` written by an older run than `runId`, kind by kind (items, categories,
 * placements), except every row of the kinds in `keep`. Call it only after the run succeeded. Returns the number
 * of rows removed per table.
 */
export async function removeStaleCatalog(
  db: SqlDriver,
  sourceId: string,
  runId: number,
  keep: readonly CatalogKind[],
): Promise<Record<string, number>> {
  const removed: Record<string, number> = {};
  const add = (table: string, n: number) => {
    removed[table] = (removed[table] ?? 0) + n;
  };
  for (const kind of KINDS) {
    if (keep.includes(kind)) continue;
    for (const table of KIND_TABLES[kind]) {
      const r = await db.run(`DELETE FROM ${table} WHERE source_id = ? AND run_id < ?`, [
        sourceId,
        runId,
      ]);
      add(table, r.changes);
    }
    for (const table of ['categories', 'placements']) {
      const r = await db.run(
        `DELETE FROM ${table} WHERE source_id = ? AND kind = ? AND run_id < ?`,
        [sourceId, kind, runId],
      );
      add(table, r.changes);
    }
  }
  return removed;
}

/** Marks every `running` run as `failed` / `interrupted`; call it when the catalog is opened. */
export async function recoverRuns(db: SqlDriver, now: number): Promise<number> {
  const r = await db.run(
    "UPDATE import_runs SET status = 'failed', error_category = 'storage', error_code = 'interrupted', finished_at = ? WHERE status = 'running'",
    [now],
  );
  return r.changes;
}
