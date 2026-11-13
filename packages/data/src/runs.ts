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

/**
 * Inserts a `running` row into `import_runs` and returns its id, or `storage/import-in-progress` when a run of
 * the same source and kind is already `running` (check and insert share one transaction).
 */
export async function startRun(
  db: SqlDriver,
  sourceId: string,
  kind: 'catalog' | 'guide',
  now: number,
): Promise<Result<number>> {
  return db.transaction(async (tx): Promise<Result<number>> => {
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

/** Marks every `running` run as `failed` / `interrupted`; call it when the catalog is opened. */
export async function recoverRuns(db: SqlDriver, now: number): Promise<number> {
  const r = await db.run(
    "UPDATE import_runs SET status = 'failed', error_category = 'storage', error_code = 'interrupted', finished_at = ? WHERE status = 'running'",
    [now],
  );
  return r.changes;
}
