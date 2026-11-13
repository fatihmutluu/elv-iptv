import {
  type ElvError,
  elvError,
  err,
  ok,
  type Result,
  type SqlDriver,
  xtreamKey,
} from '@elv/domain';
import {
  createXtreamClient,
  type XtreamCategory,
  type XtreamClient,
  type XtreamClientOptions,
} from '@elv/sources';
import {
  DEFAULT_BATCH_SIZE,
  type ImportDeps,
  type ImportOptions,
  type ImportProgress,
  type ImportSummary,
} from './import-types';
import { finishRun, removeStale, startRun } from './runs';
import { getSource, type SourceRecord, secretKey } from './sources';
import {
  type ItemWriter,
  type Listed,
  liveWriter,
  movieWriter,
  seriesWriter,
  writeCategories,
  writeEpisodes,
  writeItems,
  writePlacements,
} from './writers';

type ItemKind = 'live' | 'movie' | 'series';

/** Thrown inside a run to unwind to the failure handler; never leaves this module. */
class Stop extends Error {
  constructor(readonly error: ElvError) {
    super(error.code);
  }
}

const aborted = () => new Stop(elvError('network', 'aborted'));
const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Stop(r.error);
  return r.value;
};

interface Ctx {
  deps: ImportDeps;
  db: SqlDriver;
  sourceId: string;
  runId: number;
  client: XtreamClient;
  signal: AbortSignal | undefined;
  batchSize: number;
  progress(p: ImportProgress): void;
  counts: Record<string, number>;
}

function checkAbort(c: Pick<Ctx, 'signal'>): void {
  if (c.signal?.aborted) throw aborted();
}

async function openClient(source: SourceRecord, deps: ImportDeps): Promise<Result<XtreamClient>> {
  const raw = await deps.secrets.get(secretKey(source.id, 'xtream')).catch(() => undefined);
  let parsed: { server?: unknown; username?: unknown; password?: unknown } = {};
  try {
    parsed = raw === undefined ? {} : (JSON.parse(raw) as typeof parsed);
  } catch {
    parsed = {};
  }
  const { server, username, password } = parsed;
  if (typeof server !== 'string' || typeof username !== 'string' || typeof password !== 'string') {
    return err(elvError('storage', 'secret-missing'));
  }
  const options: XtreamClientOptions = { http: deps.http, server, username, password };
  if (source.settings.transport !== undefined) options.transport = source.settings.transport;
  if (deps.maxBodyBytes !== undefined) options.maxBodyBytes = deps.maxBodyBytes;
  return ok(createXtreamClient(options));
}

async function importCategories(c: Ctx): Promise<Record<ItemKind, XtreamCategory[]>> {
  const call = c.signal === undefined ? undefined : { signal: c.signal };
  const lists = {} as Record<ItemKind, XtreamCategory[]>;
  for (const kind of ['live', 'movie', 'series'] as const) {
    checkAbort(c);
    lists[kind] = unwrap(await c.client.categories(kind, call));
  }
  const total = lists.live.length + lists.movie.length + lists.series.length;
  let done = 0;
  for (const kind of ['live', 'movie', 'series'] as const) {
    const list = lists[kind];
    for (let i = 0; i < list.length; i += c.batchSize) {
      checkAbort(c);
      const slice = list.slice(i, i + c.batchSize);
      await writeCategories(c.db, c.sourceId, kind, c.runId, slice, i);
      done += slice.length;
      c.progress({ phase: 'categories', done, total });
      await c.deps.scheduler.yieldNow();
    }
  }
  c.counts.categories = total;
  return lists;
}

interface ListSpec<T extends Listed> {
  kind: ItemKind;
  phase: ImportProgress['phase'];
  countKey: string;
  writer: ItemWriter<T>;
  fetch(categoryId?: string): Promise<Result<T[]>>;
}

async function importList<T extends Listed>(
  c: Ctx,
  spec: ListSpec<T>,
  categories: readonly XtreamCategory[],
): Promise<void> {
  const seen = new Set<number>();
  const positions = new Map<string, number>();
  let done = 0;
  let placements = 0;

  async function write(items: readonly T[], only: string | undefined, total?: number) {
    for (let i = 0; i < items.length; i += c.batchSize) {
      checkAbort(c);
      const slice = items.slice(i, i + c.batchSize);
      const entries = slice.map((item) => ({
        key: xtreamKey(c.sourceId, spec.kind, item.id),
        item,
      }));
      await writeItems(c.db, spec.writer, c.sourceId, c.runId, entries);
      const links: [string, string, number][] = [];
      for (const { key, item } of entries) {
        seen.add(item.id);
        for (const category of only === undefined ? item.categoryIds : [only]) {
          const position = positions.get(category) ?? 0;
          positions.set(category, position + 1);
          links.push([key, category, position]);
        }
      }
      await writePlacements(c.db, c.sourceId, spec.kind, c.runId, links);
      placements += links.length;
      done += slice.length;
      c.progress(
        total === undefined ? { phase: spec.phase, done } : { phase: spec.phase, done, total },
      );
      await c.deps.scheduler.yieldNow();
    }
  }

  checkAbort(c);
  const whole = await spec.fetch();
  if (whole.ok) {
    await write(whole.value, undefined, whole.value.length);
  } else if (whole.error.category === 'source-format' && whole.error.code === 'too-large') {
    for (const category of categories) {
      checkAbort(c);
      await write(unwrap(await spec.fetch(category.id)), category.id);
    }
  } else {
    throw new Stop(whole.error);
  }
  c.counts[spec.countKey] = seen.size;
  c.counts.placements = (c.counts.placements ?? 0) + placements;
}

async function execute(c: Ctx): Promise<void> {
  const call = c.signal === undefined ? undefined : { signal: c.signal };
  unwrap(await c.client.account(call));
  const cats = await importCategories(c);
  await importList(
    c,
    {
      kind: 'live',
      phase: 'live',
      countKey: 'live',
      writer: liveWriter,
      fetch: (id) => c.client.liveStreams(id, call),
    },
    cats.live,
  );
  await importList(
    c,
    {
      kind: 'movie',
      phase: 'movies',
      countKey: 'movies',
      writer: movieWriter,
      fetch: (id) => c.client.vodStreams(id, call),
    },
    cats.movie,
  );
  await importList(
    c,
    {
      kind: 'series',
      phase: 'series',
      countKey: 'series',
      writer: seriesWriter,
      fetch: (id) => c.client.series(id, call),
    },
    cats.series,
  );
}

const KEEP_EPISODES =
  'UPDATE episodes SET run_id = ? WHERE source_id = ? AND series_key IN (SELECT key FROM series WHERE source_id = ? AND run_id = ?)';
const CATALOG_TABLES = ['categories', 'live', 'movies', 'series', 'episodes', 'placements'];

async function importXtream(
  source: SourceRecord,
  deps: ImportDeps,
  opts: ImportOptions,
): Promise<Result<ImportSummary>> {
  const opened = await openClient(source, deps);
  if (!opened.ok) return opened;
  const started = deps.clock();
  let runId: number;
  try {
    runId = await startRun(deps.db, source.id, 'catalog', started);
  } catch {
    return err(elvError('storage', 'import-failed'));
  }
  const counts: Record<string, number> = {};
  const c: Ctx = {
    deps,
    db: deps.db,
    sourceId: source.id,
    runId,
    client: opened.value,
    signal: opts.signal,
    batchSize: Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE),
    progress: (p) => opts.onProgress?.(p),
    counts,
  };
  try {
    await execute(c);
    checkAbort(c);
    c.progress({ phase: 'cleanup', done: 0 });
    const removed = await deps.db.transaction(async (tx) => {
      await tx.run(KEEP_EPISODES, [runId, source.id, source.id, runId]);
      const stale = await removeStale(tx, source.id, runId, CATALOG_TABLES);
      await finishRun(tx, runId, { status: 'ok', counts }, deps.clock());
      return Object.values(stale).reduce((a, b) => a + b, 0);
    });
    c.progress({ phase: 'cleanup', done: removed });
    return ok({ runId, counts, warnings: 0, durationMs: deps.clock() - started });
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
}

/**
 * Imports the catalog of a source. Rows are upserted with the run id so ids stay stable; stale rows are deleted
 * only after the whole run succeeded, so a failed or cancelled run never loses the previous catalog.
 * Xtream episodes are not fetched here; see {@link loadSeriesEpisodes}.
 */
export async function importCatalog(
  sourceId: string,
  deps: ImportDeps,
  opts: ImportOptions = {},
): Promise<Result<ImportSummary>> {
  const source = await getSource(deps.db, sourceId);
  if (source === undefined) return err(elvError('storage', 'source-not-found'));
  if (source.kind === 'xtream') return importXtream(source, deps, opts);
  return err(elvError('source-format', 'unsupported-source'));
}

/**
 * Fetches and stores the episodes of one Xtream series (on demand, when the user opens it), replacing the ones
 * stored before. Returns the number of episodes. An unknown series yields `source-format/unknown-series`.
 */
export async function loadSeriesEpisodes(
  sourceId: string,
  seriesKey: string,
  deps: ImportDeps,
  opts: ImportOptions = {},
): Promise<Result<number>> {
  const source = await getSource(deps.db, sourceId);
  if (source === undefined || source.kind !== 'xtream') {
    return err(elvError('storage', 'source-not-found'));
  }
  const opened = await openClient(source, deps);
  if (!opened.ok) return opened;
  try {
    const row = (
      await deps.db.all<{ provider_id: string | null; run_id: number }>(
        'SELECT provider_id, run_id FROM series WHERE source_id = ? AND key = ?',
        [sourceId, seriesKey],
      )
    )[0];
    if (row?.provider_id == null) return err(elvError('source-format', 'unknown-series'));
    checkAbort({ signal: opts.signal });
    const call = opts.signal === undefined ? undefined : { signal: opts.signal };
    const info = unwrap(await opened.value.seriesInfo(Number(row.provider_id), call));
    const entries = info.episodes.map((episode) => ({
      key: xtreamKey(sourceId, 'episode', episode.id),
      episode,
    }));
    await deps.db.transaction(async (tx) => {
      const previous = await tx.all<{ key: string }>(
        'SELECT key FROM episodes WHERE source_id = ? AND series_key = ?',
        [sourceId, seriesKey],
      );
      await writeEpisodes(tx, sourceId, seriesKey, row.run_id, entries);
      const keep = new Set(entries.map((e) => e.key));
      await tx.batch(
        'DELETE FROM episodes WHERE source_id = ? AND key = ?',
        previous.filter((p) => !keep.has(p.key)).map((p) => [sourceId, p.key]),
      );
    });
    opts.onProgress?.({ phase: 'episodes', done: entries.length, total: entries.length });
    await deps.scheduler.yieldNow();
    return ok(entries.length);
  } catch (e) {
    return err(e instanceof Stop ? e.error : elvError('storage', 'import-failed'));
  }
}
