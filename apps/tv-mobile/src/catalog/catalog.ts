import {
  addM3uSource,
  addSourceFromLink,
  addXtreamSource,
  createStreamResolver,
  getSource,
  type ImportDeps,
  type ImportOptions,
  type ImportSummary,
  importCatalog,
  type LinkSourceInput,
  loadSeriesEpisodes,
  type M3uSourceInput,
  removeSource,
  type SourceKind,
  type SourceRecord,
  secretKey,
  type XtreamSourceInput,
} from '@elv/data';
import {
  elvError,
  err,
  type HttpClient,
  ok,
  type Result,
  type Scheduler,
  type SecretStore,
  type SqlDriver,
  transportHeaders,
} from '@elv/domain';
import { createXtreamClient } from '@elv/sources';
import {
  type BrowseKind,
  type CategoryRow,
  type EpisodeRow,
  type ItemRow,
  parseCategoryId,
  queryCategories,
  queryEpisodes,
  queryItems,
  queryPlayable,
  querySeasons,
  querySeries,
  type SeasonRow,
} from './queries';

export type { BrowseKind, CategoryRow, EpisodeRow, ItemRow, SeasonRow } from './queries';

/**
 * Default largest Xtream response body (4 MiB): bigger lists load per category, which bounds memory and the longest
 * JS task of an import on small devices.
 */
export const DEVICE_MAX_BODY_BYTES = 4 * 1024 * 1024;

/** {@link ImportOptions} plus the body limit the gate varies. */
export interface DeviceImportOptions extends ImportOptions {
  /** Overrides {@link DEVICE_MAX_BODY_BYTES} for this run. */
  maxBodyBytes?: number;
}

/** Everything the service needs from the platform. */
export interface CatalogDeps {
  /** A driver with `setAbortSignal` (the op-sqlite one) gets the signal of each import run. */
  db: SqlDriver;
  secrets: SecretStore;
  scheduler: Scheduler;
  http: HttpClient;
  /** Epoch milliseconds. */
  clock: () => number;
  /** A new source id of letters, digits, `.`, `-` and `_`; defaults to clock plus random digits. */
  newId?: () => string;
}

/** A source as the menu shows it. */
export interface SourceRow {
  id: string;
  kind: SourceKind;
  name: string;
  createdAt: number;
}

/** Input of {@link CatalogService.addSource}. */
export type AddSourceInput =
  | ({ kind: 'xtream' } & XtreamSourceInput)
  | ({ kind: 'm3u' } & M3uSourceInput);

/** What a player needs to open an item. Never log or store it. */
export interface StreamRequest {
  url: string;
  /** Lower-case header names. */
  headers: Record<string, string>;
}

/** Local catalog of the user's sources: add, import, browse in pages, resolve a stream. */
export interface CatalogService {
  addSource(input: AddSourceInput): Promise<Result<SourceRow>>;
  addSourceFromLink(input: LinkSourceInput): Promise<Result<SourceRow>>;
  /** Refused with `storage/import-in-progress` while an import of the source runs. */
  removeSource(id: string): Promise<Result<void>>;
  /**
   * Imports run one at a time in call order; a later call waits for its turn. A call for a source whose import runs
   * or waits is refused with `storage/import-in-progress` at once. Cancelling through `signal` keeps the previous
   * catalog; a call cancelled while it waits ends with `network/aborted` without starting a run.
   */
  importSource(id: string, opts?: DeviceImportOptions): Promise<Result<ImportSummary>>;
  listSources(): Promise<SourceRow[]>;
  categories(sourceId: string, kind: BrowseKind): Promise<CategoryRow[]>;
  /** A page in provider order; `limit` is capped at 500; an unknown category is an empty page. */
  items(categoryId: string, offset: number, limit: number): Promise<ItemRow[]>;
  /** Xtream episodes are fetched on first use. `seriesId` is {@link ItemRow.id} of a series. */
  seasons(seriesId: number): Promise<Result<SeasonRow[]>>;
  episodes(seriesId: number, season: number): Promise<EpisodeRow[]>;
  /** `itemKey` is the `key` of a live channel, movie or episode. */
  resolveStream(itemKey: string): Promise<Result<StreamRequest>>;
}

interface AbortBindable {
  setAbortSignal?: (signal: AbortSignal | undefined) => void;
}

const row = (r: SourceRecord): SourceRow => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  createdAt: r.createdAt,
});

const notFound = () => err(elvError('storage', 'item-not-found'));

/** Resolves `true` once `previous` settled, or `false` as soon as `signal` aborts (also before). */
function turnOrAbort(previous: Promise<void>, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal === undefined) return previous.then(() => true);
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => resolve(false);
    signal.addEventListener('abort', onAbort, { once: true });
    void previous.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(!signal.aborted);
    });
  });
}

function defaultNewId(clock: () => number): () => string {
  return () => `s${clock().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** Wires the service over injected ports; it touches no native module itself. */
export function createCatalogService(deps: CatalogDeps): CatalogService {
  const { db, secrets, clock } = deps;
  const newId = deps.newId ?? defaultNewId(clock);
  const addDeps = { db, secrets, clock, newId };
  const importDeps: ImportDeps = {
    db,
    http: deps.http,
    secrets,
    scheduler: deps.scheduler,
    clock,
    maxBodyBytes: DEVICE_MAX_BODY_BYTES,
  };
  const abortable = db as SqlDriver & AbortBindable;
  const importing = new Set<string>();
  let lastImport: Promise<void> = Promise.resolve();

  const mapped = async (p: Promise<Result<SourceRecord>>): Promise<Result<SourceRow>> => {
    const r = await p;
    return r.ok ? ok(row(r.value)) : r;
  };

  async function logoOf(items: ItemRow[], sourceId: string): Promise<ItemRow[]> {
    if (!items.some((i) => i.logo?.includes('{{'))) return items;
    const resolver = await createStreamResolver(sourceId, { secrets });
    return items.map((i) =>
      i.logo === null ? i : { ...i, logo: resolver.resolve(i.logo) ?? null },
    );
  }

  async function xtreamUrl(
    sourceId: string,
    p: {
      streamKind: 'live' | 'movie' | 'series';
      providerId: string | null;
      extension: string | null;
    },
    transport: SourceRecord['settings']['transport'],
  ): Promise<Result<string>> {
    const raw = await secrets.get(secretKey(sourceId, 'xtream')).catch(() => undefined);
    let parsed: { server?: unknown; username?: unknown; password?: unknown } = {};
    try {
      parsed = raw === undefined ? {} : (JSON.parse(raw) as typeof parsed);
    } catch {
      parsed = {};
    }
    const { server, username, password } = parsed;
    const id = Number(p.providerId);
    if (
      typeof server !== 'string' ||
      typeof username !== 'string' ||
      typeof password !== 'string'
    ) {
      return err(elvError('storage', 'secret-missing'));
    }
    if (p.providerId === null || !Number.isFinite(id)) return notFound();
    const client = createXtreamClient({
      http: deps.http,
      server,
      username,
      password,
      ...(transport === undefined ? {} : { transport }),
    });
    return ok(client.streamUrl(p.streamKind, id, p.extension ?? undefined));
  }

  return {
    addSource: (input) =>
      mapped(
        input.kind === 'xtream' ? addXtreamSource(input, addDeps) : addM3uSource(input, addDeps),
      ),
    addSourceFromLink: (input) => mapped(addSourceFromLink(input, addDeps)),
    removeSource: (id) => removeSource(id, { db, secrets }),

    async importSource(id, opts = {}) {
      if (importing.has(id)) return err(elvError('storage', 'import-in-progress'));
      importing.add(id);
      const previous = lastImport;
      let finished!: () => void;
      const mine = new Promise<void>((resolve) => {
        finished = resolve;
      });
      lastImport = previous.then(() => mine);
      try {
        if (!(await turnOrAbort(previous, opts.signal))) return err(elvError('network', 'aborted'));
        abortable.setAbortSignal?.(opts.signal);
        try {
          const { maxBodyBytes, ...rest } = opts;
          const runDeps = maxBodyBytes === undefined ? importDeps : { ...importDeps, maxBodyBytes };
          return await importCatalog(id, runDeps, rest);
        } finally {
          abortable.setAbortSignal?.(undefined);
        }
      } finally {
        importing.delete(id);
        finished();
      }
    },

    async listSources() {
      const rows = await db.all<{ id: string; kind: SourceKind; name: string; created_at: number }>(
        'SELECT id, kind, name, created_at FROM sources ORDER BY created_at, id',
      );
      return rows.map((r) => ({ id: r.id, kind: r.kind, name: r.name, createdAt: r.created_at }));
    },

    categories: (sourceId, kind) => queryCategories(db, sourceId, kind),

    async items(categoryId, offset, limit) {
      const ref = parseCategoryId(categoryId);
      if (ref === undefined) return [];
      return logoOf(await queryItems(db, ref, offset, limit), ref.sourceId);
    },

    async seasons(seriesId) {
      const series = await querySeries(db, seriesId);
      if (series === undefined) return notFound();
      let seasons = await querySeasons(db, series);
      if (seasons.length === 0) {
        const source = await getSource(db, series.sourceId);
        if (source?.kind === 'xtream') {
          const loaded = await loadSeriesEpisodes(series.sourceId, series.key, importDeps);
          if (!loaded.ok) return loaded;
          seasons = await querySeasons(db, series);
        }
      }
      return ok(seasons);
    },

    async episodes(seriesId, season) {
      const series = await querySeries(db, seriesId);
      return series === undefined ? [] : queryEpisodes(db, series, season);
    },

    async resolveStream(itemKey) {
      const play = await queryPlayable(db, itemKey);
      if (play === undefined) return notFound();
      const source = await getSource(db, play.sourceId);
      if (source === undefined) return notFound();
      const headers = transportHeaders(source.settings.transport);
      if (play.urlTemplate === null) {
        const url = await xtreamUrl(play.sourceId, play, source.settings.transport);
        return url.ok ? ok({ url: url.value, headers }) : url;
      }
      const resolver = await createStreamResolver(play.sourceId, { secrets });
      const url = resolver.resolve(play.urlTemplate);
      if (url === undefined) return err(elvError('storage', 'secret-missing'));
      if (play.headersJson !== null) {
        const extra = JSON.parse(play.headersJson) as { userAgent?: string; referer?: string };
        if (extra.userAgent !== undefined) headers['user-agent'] = extra.userAgent;
        if (extra.referer !== undefined) {
          const referer = resolver.resolve(extra.referer);
          if (referer !== undefined) headers.referer = referer;
        }
      }
      return ok({ url, headers });
    },
  };
}
