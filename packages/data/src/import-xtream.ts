import { elvError, err, ok, type Result, xtreamKey } from '@elv/domain';
import {
  createXtreamClient,
  type XtreamAccount,
  type XtreamCategory,
  type XtreamClient,
  type XtreamClientOptions,
  type XtreamStreamOptions,
} from '@elv/sources';
import { fingerprintXtreamCredentials } from './credential-fingerprint';
import { importM3u } from './import-m3u';
import {
  createMonotonicProgressMeter,
  createStreamBatchDeduper,
  type MonotonicProgressMeter,
  runParallelFailFast,
  wrapCleanupProgress,
} from './import-progress';
import { checkAbort, notify, performRun, type RunCtx, Stop, unwrap } from './import-run';
import {
  DEFAULT_BATCH_SIZE,
  type ImportDeps,
  type ImportOptions,
  type ImportSummary,
} from './import-types';
import { isPlaceholderLiveChannel } from './placeholder-filter';
import { sourceExists } from './runs';
import {
  getSource,
  type SourceRecord,
  type SourceSettings,
  secretKey,
  updateSourceSettings,
} from './sources';
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

const UNCATEGORIZED = 'Uncategorized';
const KIND_META: Readonly<Record<ItemKind, readonly [string, 'live' | 'movies' | 'series']>> = {
  live: ['live_next', 'live'],
  movie: ['movies_next', 'movies'],
  series: ['series_next', 'series'],
};

interface Clients {
  client: XtreamClient;
  retries: readonly XtreamClient[];
  credentialFingerprint: string | undefined;
}

type Ctx = RunCtx & Clients & { meter: MonotonicProgressMeter };

const isTooLarge = (e: { category: string; code: string }) =>
  e.category === 'source-format' && e.code === 'too-large';

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
  const credentialFingerprint = fingerprintXtreamCredentials(server, username, password);
  const options: XtreamClientOptions = { http: deps.http, server, username, password };
  if (source.settings.transport !== undefined) options.transport = source.settings.transport;
  const capped =
    deps.maxBodyBytes === undefined ? options : { ...options, maxBodyBytes: deps.maxBodyBytes };
  const retries = deps.maxBodyBytes === undefined ? [] : [createXtreamClient(options)];
  return ok({ client: createXtreamClient(capped), retries, credentialFingerprint });
}

async function importCategories(c: Ctx): Promise<Record<ItemKind, XtreamCategory[]>> {
  checkAbort(c);
  const [live, movie, series] = await runParallelFailFast(c.signal, [
    async (signal) => unwrap(await c.client.categories('live', { signal })),
    async (signal) => unwrap(await c.client.categories('movie', { signal })),
    async (signal) => unwrap(await c.client.categories('series', { signal })),
  ]);
  const lists: Record<ItemKind, XtreamCategory[]> = { live, movie, series };
  const total = live.length + movie.length + series.length;
  let done = 0;
  for (const kind of ['live', 'movie', 'series'] as const) {
    const list = lists[kind];
    for (let i = 0; i < list.length; i += c.batchSize) {
      checkAbort(c);
      const slice = list.slice(i, i + c.batchSize);
      await writeCategories(c.db, c.sourceId, kind, c.runId, slice, i);
      done += slice.length;
      c.progress(c.meter.report('categories', done, total));
      await c.deps.scheduler.yieldNow();
    }
  }
  c.meter.markComplete('categories');
  c.counts.categories = total;
  return lists;
}

interface ListSpec<T extends Listed> {
  kind: ItemKind;
  writer: ItemWriter<T>;
  stream(
    client: XtreamClient,
    categoryId?: string,
    options?: XtreamStreamOptions,
  ): AsyncGenerator<T[], Result<void>>;
  skip?: ((item: T) => boolean) | undefined;
}

async function clearStagedKind(c: Ctx, kind: ItemKind, dropUncat: boolean): Promise<void> {
  await c.db.transaction(async (tx) => {
    await tx.run(`DELETE FROM ${KIND_META[kind][0]} WHERE source_id = ? AND run_id = ?`, [
      c.sourceId,
      c.runId,
    ]);
    await tx.run('DELETE FROM placements_next WHERE source_id = ? AND kind = ? AND run_id = ?', [
      c.sourceId,
      kind,
      c.runId,
    ]);
    if (dropUncat) {
      await tx.run(
        'DELETE FROM categories_next WHERE source_id = ? AND kind = ? AND provider_id = ? AND run_id = ?',
        [c.sourceId, kind, UNCATEGORIZED, c.runId],
      );
    }
  });
}

async function importList<T extends Listed>(
  c: Ctx,
  spec: ListSpec<T>,
  categories: readonly XtreamCategory[],
  signal: AbortSignal,
): Promise<void> {
  const phase = KIND_META[spec.kind][1];
  const dedup = createStreamBatchDeduper<T>();
  const keyOf = (id: number) => xtreamKey(c.sourceId, spec.kind, id);

  async function writeBatch(items: readonly T[], only: string | undefined): Promise<void> {
    checkAbort({ signal });
    const { entries, links, createdUncategorized } = dedup.consume(
      items,
      only,
      keyOf,
      UNCATEGORIZED,
      spec.skip,
    );
    if (createdUncategorized) {
      await writeCategories(
        c.db,
        c.sourceId,
        spec.kind,
        c.runId,
        [{ id: UNCATEGORIZED, name: UNCATEGORIZED }],
        categories.length,
      );
      c.counts.categories = (c.counts.categories ?? 0) + 1;
    }
    if (entries.length > 0) {
      await writeItems(c.db, spec.writer, c.sourceId, c.runId, entries);
      dedup.wroteAny = true;
    }
    if (links.length > 0) {
      await writePlacements(c.db, c.sourceId, spec.kind, c.runId, links);
      dedup.wroteAny = true;
    }
    if (entries.length > 0 || links.length > 0) {
      c.progress(c.meter.report(phase, dedup.uniqueCount));
    }
    await c.deps.scheduler.yieldNow();
  }

  async function consumeStream(client: XtreamClient, categoryId?: string): Promise<Result<void>> {
    const gen = spec.stream(client, categoryId, { signal, batchSize: c.batchSize });
    try {
      for (;;) {
        checkAbort({ signal });
        const step = await gen.next();
        if (step.done) return step.value;
        await writeBatch(step.value, categoryId);
      }
    } finally {
      await gen.return(ok(undefined));
    }
  }

  checkAbort({ signal });
  const whole = await consumeStream(c.client);
  if (!whole.ok) {
    if (!isTooLarge(whole.error)) throw new Stop(whole.error);
    if (dedup.wroteAny) {
      await clearStagedKind(c, spec.kind, dedup.uncategorized);
      if (dedup.uncategorized) c.counts.categories = Math.max(0, (c.counts.categories ?? 0) - 1);
      dedup.reset();
    }
    for (const category of categories) {
      checkAbort({ signal });
      unwrap(await withinCap(c, (client) => consumeStream(client, category.id)));
    }
  }

  if (dedup.uniqueCount > 0) c.progress(c.meter.complete(phase, dedup.uniqueCount));
  else c.meter.markComplete(phase);
  c.counts[phase] = dedup.uniqueCount;
  c.counts.placements = (c.counts.placements ?? 0) + dedup.placements;
  if (dedup.skippedPlaceholders > 0) {
    c.counts.skippedPlaceholders = (c.counts.skippedPlaceholders ?? 0) + dedup.skippedPlaceholders;
  }
}

async function execute(c: Ctx, includePlaceholders: boolean): Promise<XtreamAccount> {
  const account = unwrap(await c.client.account(c.signal ? { signal: c.signal } : undefined));
  const cats = await importCategories(c);
  const skip = includePlaceholders
    ? undefined
    : (i: { name: string; id: number }) =>
        isPlaceholderLiveChannel({ name: i.name, streamId: i.id });
  const run =
    <T extends Listed>(
      kind: ItemKind,
      writer: ItemWriter<T>,
      stream: ListSpec<T>['stream'],
      list: readonly XtreamCategory[],
      filter?: (item: T) => boolean,
    ) =>
    (signal: AbortSignal) =>
      importList(c, { kind, writer, stream, skip: filter }, list, signal);
  await runParallelFailFast(c.signal, [
    run('live', liveWriter, (cl, id, o) => cl.streamLiveStreams(id, o), cats.live, skip),
    run('movie', movieWriter, (cl, id, o) => cl.streamVodStreams(id, o), cats.movie),
    run('series', seriesWriter, (cl, id, o) => cl.streamSeries(id, o), cats.series),
  ]);
  return account;
}

async function importXtream(
  source: SourceRecord,
  deps: ImportDeps,
  opts: ImportOptions,
): Promise<Result<ImportSummary>> {
  const opened = await openClients(source, deps);
  if (!opened.ok) return opened;
  const meter = createMonotonicProgressMeter();
  let account: XtreamAccount | undefined;
  return performRun(source, deps, wrapCleanupProgress(opts, meter, notify), {
    execute: async (base) => {
      account = await execute(
        { ...base, ...opened.value, meter },
        source.settings.includePlaceholderChannels === true,
      );
    },
    beforeCleanup: async (tx) => {
      const current = (await getSource(tx, source.id))?.settings ?? source.settings;
      const settings: SourceSettings = { ...current };
      if (account !== undefined) {
        if (account.outputFormats.length > 0) settings.outputFormats = account.outputFormats;
        else delete settings.outputFormats;
        settings.accountMeta = {
          isTrial: account.isTrial,
          ...(account.expiresAt !== undefined ? { expiresAt: account.expiresAt } : {}),
        };
      }
      if (opened.value.credentialFingerprint !== undefined)
        settings.credentialFingerprint = opened.value.credentialFingerprint;
      else delete settings.credentialFingerprint;
      await updateSourceSettings(tx, source.id, settings);
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
 * stored before. An info body over `ImportDeps.maxBodyBytes` is fetched once more without the cap. Returns the
 * number of episodes. An unknown series yields `source-format/unknown-series`; a source that is gone (also one
 * removed while the episodes load) yields `storage/source-not-found` and writes nothing.
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
    const query = 'SELECT provider_id, run_id FROM series WHERE source_id = ? AND key = ?';
    const lookup = (db: ImportDeps['db']) =>
      db.all<{ provider_id: string | null; run_id: number }>(query, [sourceId, seriesKey]);
    const row = (await lookup(deps.db))[0];
    if (row?.provider_id == null) return err(elvError('source-format', 'unknown-series'));
    checkAbort({ signal: opts.signal });
    const call = opts.signal === undefined ? undefined : { signal: opts.signal };
    const info = unwrap(
      await withinCap(opened.value, (client) => client.seriesInfo(Number(row.provider_id), call)),
    );
    const entries = info.episodes.map((episode) => ({
      key: xtreamKey(sourceId, 'episode', episode.id),
      episode,
    }));
    const stored = await deps.db.transaction<'ok' | 'no-source' | 'no-series'>(async (tx) => {
      if (!(await sourceExists(tx, sourceId))) return 'no-source';
      const current = (await lookup(tx))[0];
      if (current?.provider_id == null) return 'no-series';
      const previous = await tx.all<{ key: string }>(
        'SELECT key FROM episodes WHERE source_id = ? AND series_key = ?',
        [sourceId, seriesKey],
      );
      const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);
      for (let i = 0; i < entries.length; i += batchSize) {
        checkAbort({ signal: opts.signal });
        await writeEpisodes(
          tx,
          sourceId,
          seriesKey,
          current.run_id,
          entries.slice(i, i + batchSize),
        );
      }
      const keep = new Set(entries.map((e) => e.key));
      const stale = previous.filter((p) => !keep.has(p.key)).map((p) => [sourceId, p.key]);
      for (let i = 0; i < stale.length; i += batchSize) {
        checkAbort({ signal: opts.signal });
        await tx.batch(
          'DELETE FROM episodes WHERE source_id = ? AND key = ?',
          stale.slice(i, i + batchSize),
        );
      }
      return 'ok';
    });
    if (stored === 'no-source') return err(elvError('storage', 'source-not-found'));
    if (stored === 'no-series') return err(elvError('source-format', 'unknown-series'));
    notify(opts, { phase: 'episodes', done: entries.length, total: entries.length });
    await deps.scheduler.yieldNow();
    return ok(entries.length);
  } catch (e) {
    return err(e instanceof Stop ? e.error : elvError('storage', 'import-failed'));
  }
}
