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
import { type AlphabetBucket, type AlphabetIndexInput, queryAlphabetIndex } from './alphabet-index';
import { createCatalogChannelOpsMethods } from './catalog-channel-ops';
import {
  type CatalogCollectionsOpsMethods,
  createCatalogCollectionsOpsMethods,
} from './catalog-collections-ops';
import {
  type CatalogDownloadsOpsMethods,
  createCatalogDownloadsOpsMethods,
} from './catalog-downloads-ops';
import { type CatalogEpgOpsMethods, createCatalogEpgOpsMethods } from './catalog-epg-ops';
import {
  type CatalogFailoverOpsMethods,
  createCatalogFailoverOpsMethods,
} from './catalog-failover-ops';
import {
  type CatalogNewEpisodesOpsMethods,
  createCatalogNewEpisodesOpsMethods,
} from './catalog-new-episodes-ops';
import { createCatalogProfileMethods } from './catalog-profiles';
import {
  mapNewSourceRow,
  mergeSourceSettings,
  parseSourceMeta,
  type SourceRow,
} from './catalog-source-meta';
import type { ChannelOverrideRecord, SetChannelOverrideInput } from './channel-overrides-repo';
import {
  type CreateCustomGroupInput,
  type CustomGroupItemInput,
  type CustomGroupRecord,
  parseCustomGroupCategoryId,
  type UpdateCustomGroupPatch,
} from './custom-groups-repo';
import { type DiscoveredCategory, discoverSourceCategories } from './discover-categories';
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
import type { ImportDeps, ImportOptions, ImportSummary, NativeGuideStager } from './import-types';
import { importCatalog, loadSeriesEpisodes } from './import-xtream';
import { type ManifestStore, saveManifest } from './manifest';
import { reconcileMyListNewEpisodesForSource } from './my-list-new-episodes';
import { type NextEpisodeRow, queryNextEpisode } from './next-episode';
import type {
  ParentalLockFilter,
  ParentalLockRecord,
  ParentalQueryOptions,
  ParentalSettings,
  PinVerifyResult,
  SetParentalLockInput,
  UpdateParentalSettingsPatch,
} from './parental-policy';
import { isItemRestricted, loadActiveParentalFilter } from './parental-repo';
import type { CreateProfileInput, ProfileRecord, UpdateProfilePatch } from './profiles-repo';
import {
  type BrowseKind,
  type CategoryQueryOptions,
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
import {
  type LiveVariantOption,
  queryItemVersions,
  queryLiveVariants,
  type VodVersionOption,
} from './queries-variants';
import { listRecentChannels, recordRecentChannel } from './recent-channels-repo';
import { latestImportHealth, type SourceImportHealth } from './runs';
import {
  querySearch,
  querySearchSuggestions,
  type SearchOptions,
  type SearchResults,
  type SearchSuggestion,
  type SearchSuggestionsOptions,
} from './search';
import { addSourceFromLink, type LinkSourceInput } from './source-link';
import {
  addLocalM3uSource,
  addM3uSource,
  addStalkerSource,
  addXtreamSource,
  getSource,
  type LocalM3uSourceInput,
  type LocalPlaylistStore,
  type M3uSourceInput,
  updateSourceSettings as persistSourceSettings,
  removeSource,
  type SourceKind,
  type SourceRecord,
  type SourceSettings,
  type StalkerSourceInput,
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
  listWatched,
  reorderFavorites,
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

export type { SourceRow, StreamRequest };

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
  /** Optional native off-thread XMLTV stager used on mobile/TV for HTTP(S) guides (`#478`). */
  nativeGuideStager?: NativeGuideStager;
  /** Optional sandboxed local M3U byte store for local file imports (`#51`). */
  localPlaylistStore?: LocalPlaylistStore;
  /** Optional hook resolving a completed managed local download URI for offline VOD playback. */
  resolveLocalDownload?: (itemKey: string, profileId?: string) => Promise<string | null>;
}

/** Input of {@link CatalogService.addSource}. */
export type AddSourceInput =
  | ({ kind: 'xtream' } & XtreamSourceInput)
  | ({ kind: 'm3u' } & M3uSourceInput)
  | ({ kind: 'stalker' } & StalkerSourceInput);

/** Local catalog of the user's sources: add, import, browse in pages, resolve a stream, close. */
export interface CatalogService
  extends Partial<CatalogEpgOpsMethods>,
    Partial<CatalogFailoverOpsMethods>,
    Partial<CatalogCollectionsOpsMethods>,
    Partial<CatalogDownloadsOpsMethods>,
    Partial<CatalogNewEpisodesOpsMethods> {
  addSource(input: AddSourceInput): Promise<Result<SourceRow>>;
  addSourceFromLink(input: LinkSourceInput): Promise<Result<SourceRow>>;
  /** Adds a local sandboxed M3U source from raw bytes (`#51`). */
  addLocalM3uSource?(input: LocalM3uSourceInput): Promise<Result<SourceRow>>;
  /** Streams category metadata and item counts for a source without writing to SQLite (`#39`). */
  discoverSourceCategories?(
    sourceId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<Result<readonly DiscoveredCategory[]>>;
  /** Merges a partial settings patch into a source's stored `settings_json`, validating transport settings (`#172`). */
  updateSourceSettings?(
    sourceId: string,
    patch: Partial<SourceSettings>,
  ): Promise<void | Result<void>>;
  /** Stops active playback via `beforeRemoveSource`, aborts imports of `id`, and removes rows + secrets. */
  removeSource(id: string): Promise<Result<void>>;
  importSource(id: string, opts?: DeviceImportOptions): Promise<Result<ImportSummary>>;
  importGuide?(sourceId: string, opts?: ImportOptions): Promise<Result<ImportSummary>>;
  listSources(): Promise<SourceRow[]>;
  latestImportHealth?(sourceId?: string): Promise<SourceImportHealth[]>;
  categories(
    sourceId: string,
    kind: BrowseKind,
    opts?: CategoryQueryOptions,
  ): Promise<CategoryRow[]>;
  items(
    categoryId: string,
    offset: number,
    limit: number,
    opts?: ListItemsOptions,
  ): Promise<ItemRow[]>;
  /** Lists selectable quality variants of a live channel (`#218`). */
  liveVariants?(
    itemKey: string,
    categoryId?: string,
    opts?: ParentalQueryOptions,
  ): Promise<readonly LiveVariantOption[]>;
  /** Lists selectable versions of a multi-version VOD movie (`#404`). */
  itemVersions?(itemKey: string, opts?: ParentalQueryOptions): Promise<readonly VodVersionOption[]>;
  allSourcesItems?(
    kind: BrowseKind,
    offset: number,
    limit: number,
    sourceIds?: readonly string[],
    opts?: ListItemsOptions,
  ): Promise<ItemRow[]>;
  itemDetail?(itemKey: string, opts?: ParentalQueryOptions): Promise<ItemDetailRow | null>;
  search?(query: string, opts?: SearchOptions): Promise<SearchResults>;
  /** Queries bounded on-device idle search suggestions (`#397`). */
  searchSuggestions?(options?: SearchSuggestionsOptions): Promise<readonly SearchSuggestion[]>;
  /** Computes `#`, `A..Z` prefix buckets and cumulative 0-based offsets for `'alpha'` browsing (`#407`). */
  alphabetIndex?(input: AlphabetIndexInput): Promise<readonly AlphabetBucket[]>;
  nowNext?(
    channelKeys: readonly string[],
    nowMs: number,
    opts?: ParentalQueryOptions,
  ): Promise<NowNextEntry[]>;
  epgWindow?(
    channelKeys: readonly string[],
    fromMs: number,
    toMs: number,
    opts?: ParentalQueryOptions,
  ): Promise<Record<string, ProgrammeRow[]>>;
  epgSlice?(
    sourceId: string,
    fromMs: number,
    toMs: number,
    limit?: number,
    opts?: ParentalQueryOptions,
  ): Promise<CrossChannelProgrammeRow[]>;
  channelByNumber?(
    num: number,
    sourceId?: string,
    opts?: ParentalQueryOptions,
  ): Promise<ItemRow | null>;
  seasons(seriesId: number, opts?: ParentalQueryOptions): Promise<Result<SeasonRow[]>>;
  episodes(seriesId: number, season: number, opts?: ParentalQueryOptions): Promise<EpisodeRow[]>;
  queryNextEpisode?(
    seriesKey: string,
    currentItemKey: string,
    profileId?: string,
    opts?: { readonly parentalUnlocked?: boolean },
  ): Promise<NextEpisodeRow | null>;
  resolveStream(itemKey: string, opts?: ParentalQueryOptions): Promise<Result<StreamRequest>>;
  saveProgress?(input: SaveProgressInput): Promise<Result<WatchProgressRow>>;
  setWatched?(itemKey: string, watched: boolean, profileId?: string): Promise<Result<void>>;
  getProgress?(itemKey: string, profileId?: string): Promise<WatchProgressRow | null>;
  listContinueWatching?(
    limit?: number,
    profileId?: string,
    opts?: { readonly parentalUnlocked?: boolean },
  ): Promise<WatchProgressRow[]>;
  listWatched?(
    limit?: number,
    profileId?: string,
    opts?: { readonly kind?: 'movie' | 'series'; readonly parentalUnlocked?: boolean },
  ): Promise<WatchProgressRow[]>;
  listProgressByKeys?(itemKeys: readonly string[], profileId?: string): Promise<WatchProgressRow[]>;
  listSeriesUnplayedCounts?(
    seriesKeys: readonly string[],
    profileId?: string,
  ): Promise<SeriesUnplayedSummary[]>;
  clearProgress?(itemKey: string, profileId?: string): Promise<Result<void>>;
  toggleFavorite?(input: ToggleFavoriteInput): Promise<Result<boolean>>;
  setFavorite?(input: ToggleFavoriteInput, active: boolean): Promise<Result<boolean>>;
  reorderFavorites?(orderedItemKeys: readonly string[], profileId?: string): Promise<Result<void>>;
  listFavorites?(
    limit?: number,
    profileId?: string,
    opts?: { readonly parentalUnlocked?: boolean; readonly includeHidden?: boolean },
  ): Promise<FavoriteRow[]>;
  listFavoriteKeys?(profileId?: string): Promise<string[]>;
  getTrackPreference?(
    scopeKey: string,
    profileId?: string,
  ): Promise<PersistedTrackPreference | null>;
  saveTrackPreference?(input: SaveTrackPreferenceInput): Promise<void>;
  clearTrackPreference?(scopeKey: string, profileId?: string): Promise<void>;
  recordRecentChannel?(itemKey: string, sourceId: string, profileId?: string): Promise<void>;
  listRecentChannels?(
    limit?: number,
    profileId?: string,
    opts?: { readonly parentalUnlocked?: boolean },
  ): Promise<ItemRow[]>;
  listProfiles?(): Promise<ProfileRecord[]>;
  createProfile?(input: CreateProfileInput): Promise<Result<ProfileRecord>>;
  updateProfile?(id: string, patch: UpdateProfilePatch): Promise<Result<ProfileRecord>>;
  deleteProfile?(id: string): Promise<Result<void>>;
  getParentalSettings?(profileId?: string): Promise<ParentalSettings>;
  updateParentalSettings?(
    patch: UpdateParentalSettingsPatch,
    profileId?: string,
  ): Promise<Result<ParentalSettings>>;
  listParentalLocks?(
    profileId?: string,
    filter?: ParentalLockFilter,
  ): Promise<ParentalLockRecord[]>;
  setParentalLock?(input: SetParentalLockInput, locked: boolean): Promise<Result<void>>;
  hasParentalPin?(profileId?: string): Promise<boolean>;
  setParentalPin?(pin: string, profileId?: string, currentPin?: string): Promise<Result<void>>;
  verifyParentalPin?(pin: string, profileId?: string): Promise<PinVerifyResult>;
  clearParentalPin?(currentPin: string, profileId?: string): Promise<Result<void>>;
  listChannelOverrides?(profileId?: string): Promise<ChannelOverrideRecord[]>;
  setChannelOverride?(input: SetChannelOverrideInput): Promise<Result<ChannelOverrideRecord>>;
  clearChannelOverride?(itemKey: string, profileId?: string): Promise<Result<void>>;
  reorderChannels?(
    itemKeys: readonly string[],
    sourceId: string,
    profileId?: string,
  ): Promise<Result<void>>;
  listCustomGroups?(
    profileId?: string,
    opts?: { readonly includeHidden?: boolean; readonly parentalUnlocked?: boolean },
  ): Promise<CustomGroupRecord[]>;
  createCustomGroup?(input: CreateCustomGroupInput): Promise<Result<CustomGroupRecord>>;
  updateCustomGroup?(
    groupId: string,
    patch: UpdateCustomGroupPatch,
  ): Promise<Result<CustomGroupRecord>>;
  deleteCustomGroup?(groupId: string): Promise<Result<void>>;
  setCustomGroupItems?(
    groupId: string,
    items: readonly CustomGroupItemInput[],
  ): Promise<Result<void>>;
  addChannelToCustomGroup?(
    groupId: string,
    itemKey: string,
    sourceId: string,
  ): Promise<Result<void>>;
  removeChannelFromCustomGroup?(groupId: string, itemKey: string): Promise<Result<void>>;
  flushPendingWrites?(): Promise<void>;
  close(): Promise<void>;
}

const LIST_SOURCES = `SELECT s.id, s.kind, s.name, s.created_at, s.settings_json,
  EXISTS (SELECT 1 FROM import_runs r WHERE r.source_id = s.id AND r.kind = 'catalog' AND r.status = 'ok') AS imported,
  (SELECT r.finished_at FROM import_runs r WHERE r.source_id = s.id AND r.kind = 'catalog' AND r.status = 'ok' ORDER BY r.finished_at DESC LIMIT 1) AS last_catalog_sync_at,
  (SELECT r.finished_at FROM import_runs r WHERE r.source_id = s.id AND r.kind = 'guide' AND r.status = 'ok' ORDER BY r.finished_at DESC LIMIT 1) AS last_guide_sync_at
  FROM sources s WHERE s.deleting = 0 ORDER BY s.created_at, s.id`;

const notFound = () => err(elvError('storage', 'item-not-found'));

function defaultNewId(clock: () => number): () => string {
  return () => `s${clock().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** Wires the service over injected ports; it touches no native module itself. */
export function createCatalogService(deps: CatalogDeps): CatalogService {
  const { db, secrets, clock } = deps;
  const newId = deps.newId ?? defaultNewId(clock);
  const addDeps = {
    db,
    secrets,
    clock,
    newId,
    ...(deps.localPlaylistStore === undefined
      ? {}
      : { localPlaylistStore: deps.localPlaylistStore }),
  };
  const importDeps: ImportDeps = {
    db,
    http: deps.http,
    secrets,
    scheduler: deps.scheduler,
    clock,
    maxBodyBytes: deps.maxBodyBytes ?? DEVICE_MAX_BODY_BYTES,
    ...(deps.decompressor === undefined ? {} : { decompressor: deps.decompressor }),
    ...(deps.nativeGuideStager === undefined ? {} : { nativeGuideStager: deps.nativeGuideStager }),
    ...(deps.localPlaylistStore === undefined
      ? {}
      : { localPlaylistStore: deps.localPlaylistStore }),
  };
  const queue = createSerializedImportQueue(db);
  const playtime = createPlaytimeResolverCache({
    db,
    secrets,
    http: deps.http,
    clock,
    ...(deps.resolveLocalDownload === undefined
      ? {}
      : { resolveLocalDownload: deps.resolveLocalDownload }),
  });
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
  const profileMethods = createCatalogProfileMethods({ db, secrets, clock, syncUserData });
  const channelOpsMethods = createCatalogChannelOpsMethods({ db, clock, syncUserData });
  const epgOpsMethods = createCatalogEpgOpsMethods({
    db,
    secrets,
    clock,
    importDeps,
    playtime,
  });
  const failoverOpsMethods = createCatalogFailoverOpsMethods({ db, clock, playtime });
  const collectionsOpsMethods = createCatalogCollectionsOpsMethods({ db, clock, playtime });
  const downloadsOpsMethods = createCatalogDownloadsOpsMethods({ db, clock });
  const newEpisodesOpsMethods = createCatalogNewEpisodesOpsMethods({
    db,
    clock,
    importDeps,
    queue,
    playtime,
  });

  const mapped = async (p: Promise<Result<SourceRecord>>): Promise<Result<SourceRow>> => {
    const r = await p;
    if (!r.ok) return r;
    playtime.evict(r.value.id);
    await syncManifest();
    return ok(mapNewSourceRow(r.value));
  };

  return {
    addSource: (input) =>
      mapped(
        input.kind === 'xtream'
          ? addXtreamSource(input, addDeps)
          : input.kind === 'stalker'
            ? addStalkerSource(input, addDeps)
            : addM3uSource(input, addDeps),
      ),
    addSourceFromLink: (input) => mapped(addSourceFromLink(input, addDeps)),
    addLocalM3uSource: (input) => mapped(addLocalM3uSource(input, addDeps)),
    discoverSourceCategories: (sourceId, opts) =>
      discoverSourceCategories(sourceId, importDeps, opts),
    async updateSourceSettings(sourceId, patch) {
      const existing = await getSource(db, sourceId);
      if (existing === undefined) return ok(undefined);
      const merged = mergeSourceSettings(existing.settings, patch);
      const saved = await persistSourceSettings(db, sourceId, merged);
      if (!saved.ok) return saved;
      playtime.evict(sourceId);
      await syncManifest();
      return ok(undefined);
    },

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
        const removed = await removeSource(id, {
          db,
          secrets,
          scheduler: deps.scheduler,
          ...(deps.localPlaylistStore === undefined
            ? {}
            : { localPlaylistStore: deps.localPlaylistStore }),
        });
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
        async (runSignal) => {
          const { maxBodyBytes, batchSize, ...rest } = opts;
          const runDeps = maxBodyBytes === undefined ? importDeps : { ...importDeps, maxBodyBytes };
          const imported = await importCatalog(id, runDeps, {
            ...rest,
            batchSize: batchSize ?? DEVICE_BATCH_SIZE,
            signal: runSignal,
          });
          if (imported.ok) {
            await reconcileMyListNewEpisodesForSource(db, id, { clock }).catch(() => undefined);
          }
          return imported;
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
        last_catalog_sync_at: number | null;
        last_guide_sync_at: number | null;
      }>(LIST_SOURCES);
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        name: r.name,
        createdAt: r.created_at,
        needsImport: r.imported === 0,
        lastCatalogSyncAt:
          typeof r.last_catalog_sync_at === 'number' && Number.isFinite(r.last_catalog_sync_at)
            ? r.last_catalog_sync_at
            : null,
        lastGuideSyncAt:
          typeof r.last_guide_sync_at === 'number' && Number.isFinite(r.last_guide_sync_at)
            ? r.last_guide_sync_at
            : null,
        ...parseSourceMeta(r.settings_json),
      }));
    },

    latestImportHealth: (sourceId) => latestImportHealth(db, sourceId),

    categories: (sourceId, kind, opts) => queryCategories(db, sourceId, kind, opts),

    async items(categoryId, offset, limit, opts) {
      if (parseCustomGroupCategoryId(categoryId) !== undefined) {
        return playtime.resolveRowLogos(await queryItems(db, categoryId, offset, limit, opts));
      }
      const ref = parseCategoryId(categoryId);
      if (ref === undefined) return [];
      return playtime.resolveLogos(await queryItems(db, ref, offset, limit, opts), ref.sourceId);
    },

    liveVariants: (itemKey, categoryId, opts) => queryLiveVariants(db, itemKey, categoryId, opts),
    itemVersions: (itemKey, opts) => queryItemVersions(db, itemKey, opts),

    allSourcesItems: async (kind, offset, limit, sourceIds, opts) =>
      playtime.resolveRowLogos(
        await queryAllSourcesItems(db, kind, offset, limit, sourceIds, opts),
      ),

    async itemDetail(itemKey, opts) {
      const found = await queryItemDetail(db, itemKey, opts);
      if (found === undefined) return null;
      const [resolved] = await playtime.resolveLogos([found], found.sourceId);
      return resolved ?? null;
    },

    async search(query, opts) {
      const effectiveOpts = opts?.nowMs !== undefined ? opts : { ...opts, nowMs: clock() };
      const res = await querySearch(db, query, effectiveOpts);
      const [live, epgLogos, movies, series, episodePosters] = await Promise.all([
        playtime.resolveRowLogos(res.live),
        playtime.resolveRowLogos(
          res.epg.map((hit) => ({ sourceId: hit.sourceId, logo: hit.channelLogoUrl })),
        ),
        playtime.resolveRowLogos(res.movies),
        playtime.resolveRowLogos(res.series),
        playtime.resolveRowLogos(
          res.episodes.map((hit) => ({ sourceId: hit.sourceId, logo: hit.posterUrl })),
        ),
      ]);
      const epg = res.epg.map((hit, idx) => {
        const resolvedLogo = epgLogos[idx]?.logo ?? hit.channelLogoUrl;
        return resolvedLogo === hit.channelLogoUrl ? hit : { ...hit, channelLogoUrl: resolvedLogo };
      });
      const episodes = res.episodes.map((hit, idx) => {
        const resolvedPoster = episodePosters[idx]?.logo ?? hit.posterUrl;
        return resolvedPoster === hit.posterUrl ? hit : { ...hit, posterUrl: resolvedPoster };
      });
      return { live, epg, movies, series, episodes };
    },
    searchSuggestions: (options) => querySearchSuggestions(db, options),
    alphabetIndex: (input) => queryAlphabetIndex(db, input),

    nowNext: (channelKeys, nowMs, opts) => queryNowNext(db, channelKeys, nowMs, opts),
    epgWindow: (channelKeys, fromMs, toMs, opts) =>
      queryEpgWindow(db, channelKeys, fromMs, toMs, opts),
    epgSlice: (sourceId, fromMs, toMs, limit, opts) =>
      queryCrossChannelEpgSlice(db, sourceId, fromMs, toMs, limit, opts),
    async channelByNumber(num, sourceId, opts) {
      const found = await queryChannelByNumber(db, num, sourceId, opts);
      if (found === undefined) return null;
      const [resolved] = await playtime.resolveLogos([found], found.sourceId);
      return resolved ?? null;
    },

    async seasons(seriesId, opts) {
      const series = await querySeries(db, seriesId);
      if (series === undefined) return notFound();
      const filter = await loadActiveParentalFilter(db, opts?.profileId, opts?.parentalUnlocked);
      if (filter !== null && (await isItemRestricted(db, filter, series.key))) {
        return err(elvError('auth', 'parental-locked'));
      }
      let seasons = await querySeasons(db, series, opts);
      if (seasons.length === 0) {
        const source = await getSource(db, series.sourceId);
        if (source?.kind === 'xtream' || source?.kind === 'stalker') {
          const loaded = await queue.run(
            series.sourceId,
            'series-episodes',
            undefined,
            (runSignal) =>
              loadSeriesEpisodes(series.sourceId, series.key, importDeps, { signal: runSignal }),
            { taskKey: series.key },
          );
          if (!loaded.ok) return loaded;
          await reconcileMyListNewEpisodesForSource(db, series.sourceId, {
            seriesKey: series.key,
            clock,
          }).catch(() => undefined);
          seasons = await querySeasons(db, series, opts);
        }
      }
      return ok(seasons);
    },

    async episodes(seriesId, season, opts) {
      const series = await querySeries(db, seriesId);
      return series === undefined ? [] : queryEpisodes(db, series, season, opts);
    },
    async queryNextEpisode(seriesKey, currentItemKey, profileId, opts) {
      const found = await queryNextEpisode(db, seriesKey, currentItemKey, profileId, opts);
      if (found === null) return null;
      const [resolved] = await playtime.resolveRowLogos([found]);
      return resolved ?? found;
    },
    async resolveStream(itemKey, opts) {
      const filter = await loadActiveParentalFilter(db, opts?.profileId, opts?.parentalUnlocked);
      if (filter !== null && (await isItemRestricted(db, filter, itemKey))) {
        return err(elvError('auth', 'parental-locked'));
      }
      return playtime.resolveStream(itemKey, {
        ...(opts?.profileId === undefined ? {} : { profileId: opts.profileId }),
        ...(filter === null
          ? {}
          : { isAlternateRestricted: (channelKey) => isItemRestricted(db, filter, channelKey) }),
      });
    },

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
    listContinueWatching: async (limit, profileId, opts) =>
      playtime.resolveRowLogos(await listContinueWatching(db, limit, profileId, opts)),
    listWatched: async (limit, profileId, opts) =>
      playtime.resolveRowLogos(await listWatched(db, limit, profileId, opts)),
    listProgressByKeys: async (itemKeys, profileId) =>
      playtime.resolveRowLogos(await listProgressByKeys(db, itemKeys, profileId)),
    listSeriesUnplayedCounts: (seriesKeys, profileId) =>
      listSeriesUnplayedCounts(db, seriesKeys, profileId),
    async clearProgress(itemKey, profileId) {
      const cleared = await clearWatchProgress(db, itemKey, profileId, clock);
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
    async reorderFavorites(orderedItemKeys, profileId) {
      const reordered = await reorderFavorites(db, orderedItemKeys, profileId);
      if (reordered.ok) await syncUserData();
      return reordered;
    },
    listFavorites: async (limit, profileId, opts) =>
      playtime.resolveRowLogos(await listFavorites(db, limit, profileId, opts)),
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
    async recordRecentChannel(itemKey, sourceId, profileId) {
      await recordRecentChannel(db, itemKey, sourceId, profileId, clock());
      await syncUserData();
    },
    listRecentChannels: async (limit, profileId, opts) =>
      playtime.resolveRowLogos(await listRecentChannels(db, limit, profileId, opts)),

    ...profileMethods,
    ...channelOpsMethods,
    ...epgOpsMethods,
    ...failoverOpsMethods,
    ...collectionsOpsMethods,
    ...downloadsOpsMethods,
    ...newEpisodesOpsMethods,

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
