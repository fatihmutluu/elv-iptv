import { elvError, err, ok, type Result, xtreamKey } from '@elv/domain';
import {
  createXtreamClient,
  type XtreamCategory,
  type XtreamClient,
  type XtreamClientOptions,
} from '@elv/sources';
import { importM3u } from './import-m3u';
import { checkAbort, notify, performRun, type RunCtx, Stop, unwrap } from './import-run';
import type { ImportDeps, ImportOptions, ImportProgress, ImportSummary } from './import-types';
import { sourceExists } from './runs';
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

/** Category id and name of items the provider lists without a category (like M3U's `Ungrouped`). */
const UNCATEGORIZED = 'Uncategorized';

/**
 * Clients of one source: `client` bounds bodies to `ImportDeps.maxBodyBytes`; `retries` are tried in turn on a body
 * over that cap (the same source without the cap; empty when there is no cap).
 */
interface Clients {
  client: XtreamClient;
  retries: readonly XtreamClient[];
}

type Ctx = RunCtx & Clients;

const isTooLarge = (e: { category: string; code: string }) =>
  e.category === 'source-format' && e.code === 'too-large';

/**
 * Calls `fn` with the capped client and, while the body is over the cap, once more with each retry client: one stall
 * on an oversized category or series beats a missing catalog.
 */
async function withinCap<T>(
  clients: Clients,
  fn: (client: XtreamClient) => Promise<Result<T>>,
): Promise<Result<T>> {
  let result = await fn(clients.client);
  for (const client of clients.retries) {
    if (result.ok || !isTooLarge(result.error)) break;
    result = await fn(client);
  }
  return result;
}

/** Builds the Xtream client of a source from its secret; `storage/secret-missing` when the secret is unusable. */
export async function openClient(
  source: SourceRecord,
  deps: ImportDeps,
): Promise<Result<XtreamClient>> {
  const opened = await openClients(source, deps);
  return opened.ok ? ok(opened.value.client) : opened;
}

async function openClients(source: SourceRecord, deps: ImportDeps): Promise<Result<Clients>> {
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
  if (deps.maxBodyBytes === undefined)
    return ok({ client: createXtreamClient(options), retries: [] });
  return ok({
    client: createXtreamClient({ ...options, maxBodyBytes: deps.maxBodyBytes }),
    retries: [createXtreamClient(options)],
  });
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
  fetch(client: XtreamClient, categoryId?: string): Promise<Result<T[]>>;
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
  let uncategorized = false;

  async function categoriesOf(item: T, only: string | undefined): Promise<readonly string[]> {
    if (only !== undefined) return [only];
    if (item.categoryIds.length > 0) return item.categoryIds;
    if (!uncategorized) {
      uncategorized = true;
      const category = { id: UNCATEGORIZED, name: UNCATEGORIZED };
      await writeCategories(c.db, c.sourceId, spec.kind, c.runId, [category], categories.length);
      c.counts.categories = (c.counts.categories ?? 0) + 1;
    }
    return [UNCATEGORIZED];
  }

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
        for (const category of await categoriesOf(item, only)) {
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
  const whole = await spec.fetch(c.client);
  if (whole.ok) {
    await write(whole.value, undefined, whole.value.length);
  } else if (isTooLarge(whole.error)) {
    for (const category of categories) {
      checkAbort(c);
      await write(
        unwrap(await withinCap(c, (client) => spec.fetch(client, category.id))),
        category.id,
      );
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
      fetch: (client, id) => client.liveStreams(id, call),
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
      fetch: (client, id) => client.vodStreams(id, call),
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
      fetch: (client, id) => client.series(id, call),
    },
    cats.series,
  );
}

const KEEP_EPISODES =
  'UPDATE episodes SET run_id = ? WHERE source_id = ? AND series_key IN (SELECT key FROM series WHERE source_id = ? AND run_id = ?)';

async function importXtream(
  source: SourceRecord,
  deps: ImportDeps,
  opts: ImportOptions,
): Promise<Result<ImportSummary>> {
  const opened = await openClients(source, deps);
  if (!opened.ok) return opened;
  return performRun(source, deps, opts, {
    execute: (base) => execute({ ...base, ...opened.value }),
    beforeCleanup: async (tx, c) => {
      await tx.run(KEEP_EPISODES, [c.runId, c.sourceId, c.sourceId, c.runId]);
    },
  });
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
  if (source.kind === 'm3u') return importM3u(source, deps, opts);
  return err(elvError('source-format', 'unsupported-source'));
}

/**
 * Fetches and stores the episodes of one Xtream series (on demand, when the user opens it), replacing the ones
 * stored before. An info body over `ImportDeps.maxBodyBytes` is fetched once more without the cap. Returns the number of episodes. An unknown series yields `source-format/unknown-series`; a source
 * that is gone (also one removed while the episodes load) yields `storage/source-not-found` and writes nothing.
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
  const opened = await openClients(source, deps);
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
    const id = Number(row.provider_id);
    const info = unwrap(await withinCap(opened.value, (client) => client.seriesInfo(id, call)));
    const entries = info.episodes.map((episode) => ({
      key: xtreamKey(sourceId, 'episode', episode.id),
      episode,
    }));
    const stored = await deps.db.transaction(async (tx) => {
      if (!(await sourceExists(tx, sourceId))) return false;
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
      return true;
    });
    if (!stored) return err(elvError('storage', 'source-not-found'));
    notify(opts, { phase: 'episodes', done: entries.length, total: entries.length });
    await deps.scheduler.yieldNow();
    return ok(entries.length);
  } catch (e) {
    return err(e instanceof Stop ? e.error : elvError('storage', 'import-failed'));
  }
}
