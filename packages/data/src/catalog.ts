import {
  elvError,
  err,
  type HttpClient,
  ok,
  type Result,
  type Scheduler,
  type SecretStore,
  type SqlDriver,
} from '@elv/domain';
import type { ImportDeps, ImportOptions, ImportSummary } from './import-types';
import { importCatalog, loadSeriesEpisodes } from './import-xtream';
import { type ManifestStore, saveManifest } from './manifest';
import {
  type BrowseKind,
  type CategoryRow,
  type EpisodeRow,
  type ItemRow,
  parseCategoryId,
  queryCategories,
  queryEpisodes,
  queryItems,
  querySeasons,
  querySeries,
  type SeasonRow,
} from './queries';
import { addSourceFromLink, type LinkSourceInput } from './source-link';
import {
  addM3uSource,
  addXtreamSource,
  getSource,
  type M3uSourceInput,
  removeSource,
  type SourceKind,
  type SourceRecord,
  type XtreamSourceInput,
} from './sources';
import { createPlaytimeResolverCache, type StreamRequest } from './stream-resolver';

export type { StreamRequest };

/** Default largest Xtream response body (4 MiB): bigger lists load per category. */
export const DEVICE_MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Default batch size (5,000 rows per transaction) for `CatalogService.importSource`. */
export const DEVICE_BATCH_SIZE = 5_000;

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
  /** Apple platforms: rewritten after every add, remove and import (see `reconcileManifest`). */
  manifest?: ManifestStore;
  /** Invoked synchronously at the start of `removeSource(id)` before deleting rows or secrets (`#67`). */
  beforeRemoveSource?: (sourceId: string) => void | Promise<void>;
}

/** A source as the menu shows it. */
export interface SourceRow {
  id: string;
  kind: SourceKind;
  name: string;
  createdAt: number;
  needsImport: boolean;
}

/** Input of {@link CatalogService.addSource}. */
export type AddSourceInput =
  | ({ kind: 'xtream' } & XtreamSourceInput)
  | ({ kind: 'm3u' } & M3uSourceInput);

/** Local catalog of the user's sources: add, import, browse in pages, resolve a stream, close. */
export interface CatalogService {
  addSource(input: AddSourceInput): Promise<Result<SourceRow>>;
  addSourceFromLink(input: LinkSourceInput): Promise<Result<SourceRow>>;
  /** Stops active playback via `beforeRemoveSource`, aborts imports of `id`, and removes rows + secrets. */
  removeSource(id: string): Promise<Result<void>>;
  importSource(id: string, opts?: DeviceImportOptions): Promise<Result<ImportSummary>>;
  listSources(): Promise<SourceRow[]>;
  categories(sourceId: string, kind: BrowseKind): Promise<CategoryRow[]>;
  items(categoryId: string, offset: number, limit: number): Promise<ItemRow[]>;
  seasons(seriesId: number): Promise<Result<SeasonRow[]>>;
  episodes(seriesId: number, season: number): Promise<EpisodeRow[]>;
  resolveStream(itemKey: string): Promise<Result<StreamRequest>>;
  close(): Promise<void>;
}

interface AbortBindable {
  setAbortSignal?: (signal: AbortSignal | undefined) => void;
}

interface ActiveImport {
  abort: () => void;
  settled: Promise<void>;
}

const row = (r: SourceRecord): SourceRow => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  createdAt: r.createdAt,
  needsImport: true,
});

const LIST_SOURCES = `SELECT s.id, s.kind, s.name, s.created_at,
  EXISTS (SELECT 1 FROM import_runs r WHERE r.source_id = s.id AND r.kind = 'catalog' AND r.status = 'ok') AS imported
  FROM sources s ORDER BY s.created_at, s.id`;

const notFound = () => err(elvError('storage', 'item-not-found'));

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
  const activeImports = new Map<string, ActiveImport>();
  const removing = new Set<string>();
  const playtime = createPlaytimeResolverCache({ db, secrets, http: deps.http });
  let lastImport: Promise<void> = Promise.resolve();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const { manifest } = deps;
  const syncManifest = () => (manifest === undefined ? undefined : saveManifest(db, manifest));

  const mapped = async (p: Promise<Result<SourceRecord>>): Promise<Result<SourceRow>> => {
    const r = await p;
    if (!r.ok) return r;
    playtime.evict(r.value.id);
    await syncManifest();
    return ok(row(r.value));
  };

  return {
    addSource: (input) =>
      mapped(
        input.kind === 'xtream' ? addXtreamSource(input, addDeps) : addM3uSource(input, addDeps),
      ),
    addSourceFromLink: (input) => mapped(addSourceFromLink(input, addDeps)),

    async removeSource(id) {
      removing.add(id);
      try {
        try {
          await deps.beforeRemoveSource?.(id);
        } catch {
          // Best-effort playback stop so source removal still proceeds cleanly.
        }
        const active = activeImports.get(id);
        if (active !== undefined) {
          active.abort();
          await active.settled;
        }
        playtime.evict(id);
        const removed = await removeSource(id, { db, secrets });
        playtime.evict(id);
        await syncManifest();
        return removed;
      } finally {
        removing.delete(id);
      }
    },

    async importSource(id, opts = {}) {
      if (closed) return err(elvError('network', 'aborted'));
      if (removing.has(id)) return err(elvError('storage', 'source-not-found'));
      if (activeImports.has(id)) return err(elvError('storage', 'import-in-progress'));

      const runCtl = new AbortController();
      const onCallerAbort = () => runCtl.abort();
      if (opts.signal?.aborted) runCtl.abort();
      else opts.signal?.addEventListener('abort', onCallerAbort, { once: true });

      let running = false;
      const previous = lastImport;
      let finished!: () => void;
      const mine = new Promise<void>((resolve) => {
        finished = resolve;
      });
      lastImport = previous.then(() => mine);

      let internallyAborted = false;
      activeImports.set(id, {
        abort: () => {
          if (internallyAborted) return;
          internallyAborted = true;
          runCtl.abort();
          if (running) abortable.setAbortSignal?.(runCtl.signal);
        },
        settled: mine,
      });

      try {
        if (!(await turnOrAbort(previous, runCtl.signal))) {
          return err(elvError('network', 'aborted'));
        }
        playtime.evict(id);
        running = true;
        abortable.setAbortSignal?.(internallyAborted ? runCtl.signal : opts.signal);
        try {
          const { maxBodyBytes, batchSize, ...rest } = opts;
          const runDeps = maxBodyBytes === undefined ? importDeps : { ...importDeps, maxBodyBytes };
          return await importCatalog(id, runDeps, {
            ...rest,
            batchSize: batchSize ?? DEVICE_BATCH_SIZE,
            signal: runCtl.signal,
          });
        } finally {
          running = false;
          playtime.evict(id);
          abortable.setAbortSignal?.(undefined);
        }
      } finally {
        opts.signal?.removeEventListener('abort', onCallerAbort);
        activeImports.delete(id);
        if (!closed) await syncManifest();
        finished();
      }
    },

    async listSources() {
      const rows = await db.all<{
        id: string;
        kind: SourceKind;
        name: string;
        created_at: number;
        imported: number;
      }>(LIST_SOURCES);
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        name: r.name,
        createdAt: r.created_at,
        needsImport: r.imported === 0,
      }));
    },

    categories: (sourceId, kind) => queryCategories(db, sourceId, kind),

    async items(categoryId, offset, limit) {
      const ref = parseCategoryId(categoryId);
      if (ref === undefined) return [];
      return playtime.resolveLogos(await queryItems(db, ref, offset, limit), ref.sourceId);
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

    resolveStream: (itemKey) => playtime.resolveStream(itemKey),

    close() {
      if (closePromise !== undefined) return closePromise;
      closed = true;
      closePromise = (async () => {
        for (const active of activeImports.values()) active.abort();
        await lastImport;
        playtime.clear();
        await db.close?.();
      })();
      return closePromise;
    },
  };
}
