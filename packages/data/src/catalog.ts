import {
  type Decompressor,
  elvError,
  err,
  type HttpClient,
  ok,
  type Result,
  type Scheduler,
  type SecretStore,
  type SqlDriver,
} from '@elv/domain';
import { isCredentialFingerprint } from './credential-fingerprint';
import {
  type CrossChannelProgrammeRow,
  type NowNextEntry,
  type ProgrammeRow,
  queryChannelByNumber,
  queryCrossChannelEpgSlice,
  queryEpgWindow,
  queryNowNext,
} from './guide-queries';
import { importGuide } from './import-guide';
import { createSerializedImportQueue } from './import-queue';
import type { ImportDeps, ImportOptions, ImportSummary } from './import-types';
import { importCatalog, loadSeriesEpisodes } from './import-xtream';
import { type ManifestStore, saveManifest } from './manifest';
import { type NextEpisodeRow, queryNextEpisode } from './next-episode';
import {
  type BrowseKind,
  type CategoryRow,
  type EpisodeRow,
  type ItemDetailRow,
  type ItemRow,
  type ListItemsOptions,
  parseCategoryId,
  queryAllSourcesItems,
  queryCategories,
  queryEpisodes,
  queryItemDetail,
  queryItems,
  querySeasons,
  querySeries,
  type SeasonRow,
} from './queries';
import { latestImportHealth, type SourceImportHealth } from './runs';
import { querySearch, type SearchOptions, type SearchResults } from './search';
import { addSourceFromLink, type LinkSourceInput } from './source-link';
import {
  addM3uSource,
  addXtreamSource,
  getSource,
  type M3uSourceInput,
  normalizeActiveConnections,
  normalizeMaxConnections,
  removeSource,
  type SourceAccountMeta,
  type SourceKind,
  type SourceRecord,
  type SourceSettings,
  type XtreamSourceInput,
} from './sources';
import { createPlaytimeResolverCache, type StreamRequest } from './stream-resolver';
import {
  clearTrackPreference,
  getTrackPreference,
  type PersistedTrackPreference,
  type SaveTrackPreferenceInput,
  saveTrackPreference,
} from './track-preferences-repo';
import {
  clearWatchProgress,
  type FavoriteRow,
  getWatchProgress,
  listContinueWatching,
  listFavoriteKeys,
  listFavorites,
  listProgressByKeys,
  listSeriesUnplayedCounts,
  type SaveProgressInput,
  type SeriesUnplayedSummary,
  saveWatchProgress,
  setFavorite,
  setItemWatched,
  type ToggleFavoriteInput,
  toggleFavorite,
  type WatchProgressRow,
} from './user-state';
import { saveUserDataSnapshot, type UserDataStore } from './user-state-backup';

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
  /** Default per-response body cap for Xtream imports; defaults to {@link DEVICE_MAX_BODY_BYTES}. */
  maxBodyBytes?: number;
  /** Epoch milliseconds. */
  clock: () => number;
  /** A new source id of letters, digits, `.`, `-` and `_`; defaults to clock plus random digits. */
  newId?: () => string;
  /** Apple platforms: rewritten after every add, remove and import (see `reconcileManifest`). */
  manifest?: ManifestStore;
  /** Apple platforms: mirrored after user-state mutations (see `reconcileUserData`, `#79`). */
  userData?: UserDataStore;
  /** Invoked synchronously at the start of `removeSource(id)` before deleting rows or secrets (`#67`). */
  beforeRemoveSource?: (sourceId: string) => void | Promise<void>;
  /** Platform gzip decompressor used for compressed guides and playlists. */
  decompressor?: Decompressor;
}

/** A source as the menu shows it. */
export interface SourceRow {
  id: string;
  kind: SourceKind;
  name: string;
  createdAt: number;
  needsImport: boolean;
  accountMeta?: SourceAccountMeta;
  credentialFingerprint?: string;
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
  importGuide?(sourceId: string, opts?: ImportOptions): Promise<Result<ImportSummary>>;
  listSources(): Promise<SourceRow[]>;
  latestImportHealth?(sourceId?: string): Promise<SourceImportHealth[]>;
  categories(sourceId: string, kind: BrowseKind): Promise<CategoryRow[]>;
  items(
    categoryId: string,
    offset: number,
    limit: number,
    opts?: ListItemsOptions,
  ): Promise<ItemRow[]>;
  allSourcesItems?(
    kind: BrowseKind,
    offset: number,
    limit: number,
    sourceIds?: readonly string[],
    opts?: ListItemsOptions,
  ): Promise<ItemRow[]>;
  itemDetail?(itemKey: string): Promise<ItemDetailRow | null>;
  search?(query: string, opts?: SearchOptions): Promise<SearchResults>;
  nowNext?(channelKeys: readonly string[], nowMs: number): Promise<NowNextEntry[]>;
  epgWindow?(
    channelKeys: readonly string[],
    fromMs: number,
    toMs: number,
  ): Promise<Record<string, ProgrammeRow[]>>;
  epgSlice?(
    sourceId: string,
    fromMs: number,
    toMs: number,
    limit?: number,
  ): Promise<CrossChannelProgrammeRow[]>;
  channelByNumber?(num: number, sourceId?: string): Promise<ItemRow | null>;
  seasons(seriesId: number): Promise<Result<SeasonRow[]>>;
  episodes(seriesId: number, season: number): Promise<EpisodeRow[]>;
  queryNextEpisode?(
    seriesKey: string,
    currentItemKey: string,
    profileId?: string,
  ): Promise<NextEpisodeRow | null>;
  resolveStream(itemKey: string): Promise<Result<StreamRequest>>;
  saveProgress?(input: SaveProgressInput): Promise<Result<WatchProgressRow>>;
  setWatched?(itemKey: string, watched: boolean, profileId?: string): Promise<Result<void>>;
  getProgress?(itemKey: string, profileId?: string): Promise<WatchProgressRow | null>;
  listContinueWatching?(limit?: number, profileId?: string): Promise<WatchProgressRow[]>;
  listProgressByKeys?(itemKeys: readonly string[], profileId?: string): Promise<WatchProgressRow[]>;
  listSeriesUnplayedCounts?(
    seriesKeys: readonly string[],
    profileId?: string,
  ): Promise<SeriesUnplayedSummary[]>;
  clearProgress?(itemKey: string, profileId?: string): Promise<Result<void>>;
  toggleFavorite?(input: ToggleFavoriteInput): Promise<Result<boolean>>;
  setFavorite?(input: ToggleFavoriteInput, active: boolean): Promise<Result<boolean>>;
  listFavorites?(limit?: number, profileId?: string): Promise<FavoriteRow[]>;
  listFavoriteKeys?(profileId?: string): Promise<string[]>;
  getTrackPreference?(
    scopeKey: string,
    profileId?: string,
  ): Promise<PersistedTrackPreference | null>;
  saveTrackPreference?(input: SaveTrackPreferenceInput): Promise<void>;
  clearTrackPreference?(scopeKey: string, profileId?: string): Promise<void>;
  flushPendingWrites?(): Promise<void>;
  close(): Promise<void>;
}

function parseSourceMeta(
  settingsJson: string,
): Pick<SourceRow, 'accountMeta' | 'credentialFingerprint'> {
  try {
    const parsed = JSON.parse(settingsJson) as Partial<SourceSettings> | null;
    if (parsed === null || typeof parsed !== 'object') return {};
    const out: Pick<SourceRow, 'accountMeta' | 'credentialFingerprint'> = {};
    if (isCredentialFingerprint(parsed.credentialFingerprint)) {
      out.credentialFingerprint = parsed.credentialFingerprint;
    }
    const meta = parsed.accountMeta;
    if (meta !== null && typeof meta === 'object') {
      const accountMeta: SourceAccountMeta = {};
      if (typeof meta.isTrial === 'boolean') accountMeta.isTrial = meta.isTrial;
      if (typeof meta.expiresAt === 'number' && Number.isFinite(meta.expiresAt)) {
        accountMeta.expiresAt = meta.expiresAt;
      }
      if ('maxConnections' in meta && meta.maxConnections !== undefined) {
        accountMeta.maxConnections = normalizeMaxConnections(meta.maxConnections);
      }
      if ('activeConnections' in meta && meta.activeConnections !== undefined) {
        const active = normalizeActiveConnections(meta.activeConnections);
        if (active !== undefined) accountMeta.activeConnections = active;
      }
      if (
        accountMeta.isTrial !== undefined ||
        accountMeta.expiresAt !== undefined ||
        accountMeta.maxConnections !== undefined ||
        accountMeta.activeConnections !== undefined
      ) {
        out.accountMeta = accountMeta;
      }
    }
    return out;
  } catch {
    return {};
  }
}

const row = (r: SourceRecord): SourceRow => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  createdAt: r.createdAt,
  needsImport: true,
  ...(r.settings.accountMeta === undefined ? {} : { accountMeta: r.settings.accountMeta }),
  ...(isCredentialFingerprint(r.settings.credentialFingerprint)
    ? { credentialFingerprint: r.settings.credentialFingerprint }
    : {}),
});

const LIST_SOURCES = `SELECT s.id, s.kind, s.name, s.created_at, s.settings_json,
  EXISTS (SELECT 1 FROM import_runs r WHERE r.source_id = s.id AND r.kind = 'catalog' AND r.status = 'ok') AS imported
  FROM sources s WHERE s.deleting = 0 ORDER BY s.created_at, s.id`;

const notFound = () => err(elvError('storage', 'item-not-found'));

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
    maxBodyBytes: deps.maxBodyBytes ?? DEVICE_MAX_BODY_BYTES,
    ...(deps.decompressor === undefined ? {} : { decompressor: deps.decompressor }),
  };
  const queue = createSerializedImportQueue(db);
  const playtime = createPlaytimeResolverCache({ db, secrets, http: deps.http });
  let closePromise: Promise<void> | undefined;
  const { manifest, userData } = deps;
  const syncManifest = () => (manifest === undefined ? undefined : saveManifest(db, manifest));
  let userDataTail: Promise<void> = Promise.resolve();
  const syncUserData = (): Promise<void> | undefined => {
    if (userData === undefined) return undefined;
    const next = userDataTail.then(() => saveUserDataSnapshot(db, userData));
    userDataTail = next.catch(() => undefined);
    return next;
  };

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
      queue.markRemoving(id);
      try {
        try {
          await deps.beforeRemoveSource?.(id);
        } catch {
          // Best-effort playback stop so source removal still proceeds cleanly.
        }
        await queue.abortForSource(id);
        playtime.evict(id);
        const removed = await removeSource(id, { db, secrets, scheduler: deps.scheduler });
        playtime.evict(id);
        await syncManifest();
        await syncUserData();
        return removed;
      } finally {
        queue.unmarkRemoving(id);
      }
    },

    importSource(id, opts = {}) {
      return queue.run(
        id,
        'catalog',
        opts.signal,
        (runSignal) => {
          const { maxBodyBytes, batchSize, ...rest } = opts;
          const runDeps = maxBodyBytes === undefined ? importDeps : { ...importDeps, maxBodyBytes };
          return importCatalog(id, runDeps, {
            ...rest,
            batchSize: batchSize ?? DEVICE_BATCH_SIZE,
            signal: runSignal,
          });
        },
        {
          onStart: () => playtime.evict(id),
          onFinally: () => playtime.evict(id),
          onSettled: syncManifest,
        },
      );
    },

    importGuide(sourceId, opts = {}) {
      return queue.run(sourceId, 'guide', opts.signal, (runSignal) =>
        importGuide(sourceId, importDeps, {
          ...opts,
          batchSize: opts.batchSize ?? DEVICE_BATCH_SIZE,
          signal: runSignal,
        }),
      );
    },

    async listSources() {
      const rows = await db.all<{
        id: string;
        kind: SourceKind;
        name: string;
        created_at: number;
        settings_json: string;
        imported: number;
      }>(LIST_SOURCES);
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        name: r.name,
        createdAt: r.created_at,
        needsImport: r.imported === 0,
        ...parseSourceMeta(r.settings_json),
      }));
    },

    latestImportHealth: (sourceId) => latestImportHealth(db, sourceId),

    categories: (sourceId, kind) => queryCategories(db, sourceId, kind),

    async items(categoryId, offset, limit, opts) {
      const ref = parseCategoryId(categoryId);
      if (ref === undefined) return [];
      return playtime.resolveLogos(await queryItems(db, ref, offset, limit, opts), ref.sourceId);
    },

    allSourcesItems: async (kind, offset, limit, sourceIds, opts) =>
      playtime.resolveRowLogos(
        await queryAllSourcesItems(db, kind, offset, limit, sourceIds, opts),
      ),

    async itemDetail(itemKey) {
      const found = await queryItemDetail(db, itemKey);
      if (found === undefined) return null;
      const [resolved] = await playtime.resolveLogos([found], found.sourceId);
      return resolved ?? null;
    },

    async search(query, opts) {
      const res = await querySearch(db, query, opts);
      const [live, movies, series] = await Promise.all([
        playtime.resolveRowLogos(res.live),
        playtime.resolveRowLogos(res.movies),
        playtime.resolveRowLogos(res.series),
      ]);
      return { live, movies, series };
    },

    nowNext: (channelKeys, nowMs) => queryNowNext(db, channelKeys, nowMs),
    epgWindow: (channelKeys, fromMs, toMs) => queryEpgWindow(db, channelKeys, fromMs, toMs),
    epgSlice: (sourceId, fromMs, toMs, limit) =>
      queryCrossChannelEpgSlice(db, sourceId, fromMs, toMs, limit),
    async channelByNumber(num, sourceId) {
      const found = await queryChannelByNumber(db, num, sourceId);
      if (found === undefined) return null;
      const [resolved] = await playtime.resolveLogos([found], found.sourceId);
      return resolved ?? null;
    },

    async seasons(seriesId) {
      const series = await querySeries(db, seriesId);
      if (series === undefined) return notFound();
      let seasons = await querySeasons(db, series);
      if (seasons.length === 0) {
        const source = await getSource(db, series.sourceId);
        if (source?.kind === 'xtream') {
          const loaded = await queue.run(
            series.sourceId,
            'series-episodes',
            undefined,
            (runSignal) =>
              loadSeriesEpisodes(series.sourceId, series.key, importDeps, { signal: runSignal }),
            { taskKey: series.key },
          );
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
    async queryNextEpisode(seriesKey, currentItemKey, profileId) {
      const found = await queryNextEpisode(db, seriesKey, currentItemKey, profileId);
      if (found === null) return null;
      const [resolved] = await playtime.resolveRowLogos([found]);
      return resolved ?? found;
    },
    resolveStream: (itemKey) => playtime.resolveStream(itemKey),

    async saveProgress(input) {
      const saved = await saveWatchProgress(db, input, clock);
      if (!saved.ok) return saved;
      await syncUserData();
      const [resolved] = await playtime.resolveRowLogos([saved.value]);
      return ok(resolved ?? saved.value);
    },
    async setWatched(itemKey, watched, profileId) {
      const updated = await setItemWatched(db, itemKey, watched, clock, profileId);
      if (updated.ok) await syncUserData();
      return updated;
    },
    async getProgress(itemKey, profileId) {
      const found = await getWatchProgress(db, itemKey, profileId);
      if (found === null) return null;
      const [resolved] = await playtime.resolveRowLogos([found]);
      return resolved ?? found;
    },
    listContinueWatching: async (limit, profileId) =>
      playtime.resolveRowLogos(await listContinueWatching(db, limit, profileId)),
    listProgressByKeys: async (itemKeys, profileId) =>
      playtime.resolveRowLogos(await listProgressByKeys(db, itemKeys, profileId)),
    listSeriesUnplayedCounts: (seriesKeys, profileId) =>
      listSeriesUnplayedCounts(db, seriesKeys, profileId),
    async clearProgress(itemKey, profileId) {
      const cleared = await clearWatchProgress(db, itemKey, profileId);
      if (cleared.ok) await syncUserData();
      return cleared;
    },
    async toggleFavorite(input) {
      const toggled = await toggleFavorite(db, input, clock);
      if (toggled.ok) await syncUserData();
      return toggled;
    },
    async setFavorite(input, active) {
      const updated = await setFavorite(db, input, active, clock);
      if (updated.ok) await syncUserData();
      return updated;
    },
    listFavorites: async (limit, profileId) =>
      playtime.resolveRowLogos(await listFavorites(db, limit, profileId)),
    listFavoriteKeys: (profileId) => listFavoriteKeys(db, profileId),
    getTrackPreference: (scopeKey, profileId) => getTrackPreference(db, scopeKey, profileId),
    async saveTrackPreference(input) {
      await saveTrackPreference(db, input, clock);
      await syncUserData();
    },
    async clearTrackPreference(scopeKey, profileId) {
      await clearTrackPreference(db, scopeKey, profileId);
      await syncUserData();
    },

    close() {
      if (closePromise !== undefined) return closePromise;
      closePromise = (async () => {
        await queue.close();
        playtime.clear();
        await db.close?.();
      })();
      return closePromise;
    },
  };
}
