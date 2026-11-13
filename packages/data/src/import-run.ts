import { type ElvError, elvError, err, ok, type Result, type SqlDriver } from '@elv/domain';
import {
  DEFAULT_BATCH_SIZE,
  type ImportDeps,
  type ImportOptions,
  type ImportProgress,
  type ImportSummary,
} from './import-types';
import {
  emptiedKinds,
  finishRun,
  removeStale,
  removeStaleCatalog,
  sourceExists,
  startRun,
} from './runs';
import { purgeSourceRows, type SourceRecord } from './sources';

const SOURCE_REMOVED = elvError('storage', 'source-removed');

/** Thrown inside a run to unwind to the failure handler; never leaves the import modules. */
export class Stop extends Error {
  readonly error: ElvError;
  constructor(error: ElvError) {
    super(error.code);
    this.error = error;
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
  warningCodes: string[];
  /** Tables whose stale rows a guide run keeps; `beforeCleanup` adds to it when it keeps the previous guide. */
  keepTables: Set<string>;
}

/** Adds a code-only warning to the run summary. */
export function warn(c: RunCtx, code: string): void {
  c.warningCodes.push(code);
  c.warnings += 1;
}

/** Unwinds the run with `network/aborted` once the caller's signal fired. */
export function checkAbort(c: Pick<RunCtx, 'signal'>): void {
  if (c.signal?.aborted) throw new Stop(elvError('network', 'aborted'));
}

const ITEM_COUNTS = ['live', 'movies', 'series', 'episodes'];

const DROP_STALE_MAPPINGS =
  'DELETE FROM channel_guide WHERE source_id = ? AND channel_key NOT IN (SELECT key FROM live WHERE source_id = ?)';

/** Source-specific parts of a catalog run. */
export interface RunSteps {
  execute(c: RunCtx): Promise<void>;
  /** Runs inside the cleanup transaction, before stale rows are deleted. */
  beforeCleanup?(tx: SqlDriver, c: RunCtx): Promise<void>;
  /** Runs after the cleanup transaction committed; a throw yields `storage/secret-write-failed` (the run stays `ok`). */
  afterCommit?(c: RunCtx): Promise<void>;
  /** Run kind recorded in `import_runs` (default `catalog`). */
  kind?: 'catalog' | 'guide';
  /** Tables whose stale rows a guide run deletes at cleanup; catalog runs delete per kind instead. */
  staleTables?: readonly string[];
  /** A catalog that stored no item fails with `empty-source`; guides opt out (default true). */
  requireItems?: boolean;
}

/**
 * The lifecycle every catalog import shares: start the run, execute, then delete stale rows and mark `ok` in one
 * transaction. A run that stored no item at all fails with `source-format/empty-source` so a provider glitch can
 * never wipe the catalog, and a kind (live, movie, series) that comes back empty while older rows of it exist keeps
 * them (warning `catalog/kind-empty-<kind>`). Failure (`failed`) and abort (`cancelled`) never delete anything. When the source row is
 * gone at cleanup, the source's rows are deleted, the run is `cancelled` with `storage/source-removed` and
 * `afterCommit` is skipped.
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
    const run = await startRun(deps.db, source.id, steps.kind ?? 'catalog', started);
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
    warningCodes: [],
    keepTables: new Set(),
  };
  let removed: number;
  let gone = false;
  try {
    await steps.execute(c);
    checkAbort(c);
    if (steps.requireItems !== false && ITEM_COUNTS.every((k) => (counts[k] ?? 0) === 0)) {
      throw new Stop(elvError('source-format', 'empty-source'));
    }
    c.progress({ phase: 'cleanup', done: 0 });
    removed = await deps.db.transaction(async (tx) => {
      if (!(await sourceExists(tx, source.id))) {
        gone = true;
        await purgeSourceRows(tx, source.id, ['import_runs']);
        await finishRun(
          tx,
          runId,
          { status: 'cancelled', error: SOURCE_REMOVED, counts },
          deps.clock(),
        );
        return 0;
      }
      await steps.beforeCleanup?.(tx, c);
      let stale: Record<string, number>;
      if ((steps.kind ?? 'catalog') === 'catalog') {
        const keep = await emptiedKinds(tx, source.id, runId, counts);
        for (const kind of keep) warn(c, `catalog/kind-empty-${kind}`);
        stale = await removeStaleCatalog(tx, source.id, runId, keep);
        await tx.run(DROP_STALE_MAPPINGS, [source.id, source.id]);
      } else {
        const tables = (steps.staleTables ?? []).filter((t) => !c.keepTables.has(t));
        stale = await removeStale(tx, source.id, runId, tables);
      }
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
  if (gone) return err(SOURCE_REMOVED);
  try {
    await steps.afterCommit?.(c);
  } catch {
    return err(elvError('storage', 'secret-write-failed'));
  }
  c.progress({ phase: 'cleanup', done: removed });
  return ok({
    runId,
    counts,
    warnings: c.warnings,
    warningCodes: c.warningCodes,
    durationMs: deps.clock() - started,
  });
}
