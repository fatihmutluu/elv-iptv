import { type ElvError, elvError, err, ok, type Result, type SqlDriver } from '@elv/domain';
import {
  DEFAULT_BATCH_SIZE,
  type ImportDeps,
  type ImportOptions,
  type ImportProgress,
  type ImportSummary,
} from './import-types';
import { finishRun, removeStale, startRun } from './runs';
import type { SourceRecord } from './sources';

/** Thrown inside a run to unwind to the failure handler; never leaves the import modules. */
export class Stop extends Error {
  constructor(readonly error: ElvError) {
    super(error.code);
  }
}

/** Calls `onProgress`; a throwing callback is ignored so it can never change the outcome of a run. */
export function notify(opts: ImportOptions, p: ImportProgress): void {
  try {
    opts.onProgress?.(p);
  } catch {
    // progress is advisory
  }
}

/** Unwraps a result or unwinds the run with its error. */
export const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Stop(r.error);
  return r.value;
};

/** State shared by the steps of one catalog run. */
export interface RunCtx {
  deps: ImportDeps;
  db: SqlDriver;
  sourceId: string;
  runId: number;
  signal: AbortSignal | undefined;
  batchSize: number;
  progress(p: ImportProgress): void;
  counts: Record<string, number>;
  warnings: number;
}

/** Unwinds the run with `network/aborted` once the caller's signal fired. */
export function checkAbort(c: Pick<RunCtx, 'signal'>): void {
  if (c.signal?.aborted) throw new Stop(elvError('network', 'aborted'));
}

const ITEM_COUNTS = ['live', 'movies', 'series', 'episodes'];
const CATALOG_TABLES = ['categories', 'live', 'movies', 'series', 'episodes', 'placements'];

/** Source-specific parts of a catalog run. */
export interface RunSteps {
  execute(c: RunCtx): Promise<void>;
  /** Runs inside the cleanup transaction, before stale rows are deleted. */
  beforeCleanup?(tx: SqlDriver, c: RunCtx): Promise<void>;
  /** Runs after the cleanup transaction committed; a throw yields `storage/secret-write-failed` (the run stays `ok`). */
  afterCommit?(c: RunCtx): Promise<void>;
}

/**
 * The lifecycle every catalog import shares: start the run, execute, then delete stale rows and mark `ok` in one
 * transaction. A run that stored no item at all fails with `source-format/empty-source` so a provider glitch can
 * never wipe the catalog. Failure (`failed`) and abort (`cancelled`) never delete anything.
 */
export async function performRun(
  source: SourceRecord,
  deps: ImportDeps,
  opts: ImportOptions,
  steps: RunSteps,
): Promise<Result<ImportSummary>> {
  const started = deps.clock();
  let runId: number;
  try {
    const run = await startRun(deps.db, source.id, 'catalog', started);
    if (!run.ok) return run;
    runId = run.value;
  } catch {
    return err(elvError('storage', 'import-failed'));
  }
  const counts: Record<string, number> = {};
  const c: RunCtx = {
    deps,
    db: deps.db,
    sourceId: source.id,
    runId,
    signal: opts.signal,
    batchSize: Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE),
    progress: (p) => notify(opts, p),
    counts,
    warnings: 0,
  };
  let removed: number;
  try {
    await steps.execute(c);
    checkAbort(c);
    if (ITEM_COUNTS.every((k) => (counts[k] ?? 0) === 0)) {
      throw new Stop(elvError('source-format', 'empty-source'));
    }
    c.progress({ phase: 'cleanup', done: 0 });
    removed = await deps.db.transaction(async (tx) => {
      await steps.beforeCleanup?.(tx, c);
      const stale = await removeStale(tx, source.id, runId, CATALOG_TABLES);
      await finishRun(tx, runId, { status: 'ok', counts }, deps.clock());
      return Object.values(stale).reduce((a, b) => a + b, 0);
    });
  } catch (e) {
    const cancelled = opts.signal?.aborted === true;
    const error = cancelled
      ? elvError('network', 'aborted')
      : e instanceof Stop
        ? e.error
        : elvError('storage', 'import-failed');
    try {
      await finishRun(
        deps.db,
        runId,
        { status: cancelled ? 'cancelled' : 'failed', error, counts },
        deps.clock(),
      );
    } catch {
      // the run row stays 'running'; the original error is what the caller needs
    }
    return err(error);
  }
  try {
    await steps.afterCommit?.(c);
  } catch {
    return err(elvError('storage', 'secret-write-failed'));
  }
  c.progress({ phase: 'cleanup', done: removed });
  return ok({ runId, counts, warnings: c.warnings, durationMs: deps.clock() - started });
}
