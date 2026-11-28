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
import {
  type CatalogChannelOpsMethods,
  createCatalogChannelOpsMethods,
} from './catalog-channel-ops';
import {
  type CatalogCollectionsOpsMethods,
  createCatalogCollectionsOpsMethods,
} from './catalog-collections-ops';
import {
  type CatalogDownloadsOpsMethods,
  createCatalogDownloadsOpsMethods,
} from './catalog-downloads-ops';
import {
  type CatalogElvOpsMethods,
  createCatalogElvOpsMethods,
  type ElvEnrichmentStore,
  type ElvMetadataClient,
} from './catalog-elv-ops';
import { type CatalogEpgOpsMethods, createCatalogEpgOpsMethods } from './catalog-epg-ops';
import {
  type CatalogFailoverOpsMethods,
  createCatalogFailoverOpsMethods,
} from './catalog-failover-ops';
import {
  type CatalogLiveFoldersOpsMethods,
  createCatalogLiveFoldersOpsMethods,
} from './catalog-live-folders-ops';
import {
  type CatalogNewEpisodesOpsMethods,
  createCatalogNewEpisodesOpsMethods,
} from './catalog-new-episodes-ops';
import { createCatalogProfileMethods } from './catalog-profiles';
import {
  mapNewSourceRow,
  mergeSourceSettings,
  querySourcesList,
  type SourceRow,
} from './catalog-source-meta';
import { parseCustomGroupCategoryId } from './custom-groups-repo';
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
  type QueryLiveVariantsOptions,
  queryItemVersions,
  type VodVersionOption,
} from './queries-variants';
import { type CatalogRatingsOpsMethods, createCatalogRatingsOpsMethods } from './ratings-repo';
import { listRecentChannels, recordRecentChannel } from './recent-channels-repo';
import {
  type CatalogRecommendationDismissalsOpsMethods,
  createCatalogRecommendationDismissalsOpsMethods,
} from './recommendation-dismissals-repo';
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
  type CatalogSourceMutationMethods,
  createCatalogSourceMutationMethods,
} from './source-mutations';
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
  type SourceRecord,
  type SourceSettings,
  type StalkerSourceInput,
  type XtreamSourceInput,
} from './sources';
import { createPlaytimeResolverCache, type StreamRequest } from './stream-resolver';
import {
  type CatalogSyncStateOpsMethods,
  createCatalogSyncStateOpsMethods,
} from './sync-state-repo';
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
import { createCatalogSeriesWatchedOpsMethods } from './user-state-series';

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
  /** Optional isolated local `elv-enrichment.db` store for ELV Mode (`#511`). */
  enrichmentStore?: ElvEnrichmentStore;
  /** Optional metadata worker client (`/v1/elv/*`) for ELV Mode (`#511`). */
  elvClient?: ElvMetadataClient;
}

/** Input of {@link CatalogService.addSource}. */
export type AddSourceInput =
  | ({ kind: 'xtream' } & XtreamSourceInput)
  | ({ kind: 'm3u' } & M3uSourceInput)
  | ({ kind: 'stalker' } & StalkerSourceInput);

/** Local catalog of the user's sources: add, import, browse in pages, resolve a stream, close. */
export interface CatalogService
  extends Partial<CatalogChannelOpsMethods>,
    Partial<CatalogEpgOpsMethods>,
    Partial<CatalogFailoverOpsMethods>,
    Partial<CatalogCollectionsOpsMethods>,
    Partial<CatalogDownloadsOpsMethods>,
    Partial<CatalogElvOpsMethods>,
    Partial<CatalogNewEpisodesOpsMethods>,
    Partial<CatalogRatingsOpsMethods>,
    Partial<CatalogSourceMutationMethods>,
    Partial<CatalogSyncStateOpsMethods>,
    Partial<CatalogLiveFoldersOpsMethods>,
    Partial<CatalogRecommendationDismissalsOpsMethods> {
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
  /** Lists selectable quality variants of a live channel (`#218`, `#511`). */
  liveVariants?(
    itemKey: string,
    categoryId?: string,
    opts?: QueryLiveVariantsOptions,
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
  /** Transactionally marks every episode in a season watched or unwatched (hydrating lazy sources first). */
  setSeasonWatched?(
    seriesKey: string,
    season: number,
    watched: boolean,
    profileId?: string,
  ): Promise<Result<number>>;
  /** Transactionally marks an entire series and all of its episodes watched or unwatched (hydrating lazy sources first). */
  setSeriesWatched?(
    seriesKey: string,
    watched: boolean,
    profileId?: string,
  ): Promise<Result<number>>;
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
  flushPendingWrites?(): Promise<void>;
  close(): Promise<void>;
}

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
    ...(deps.localPlaylistStore ? { localPlaylistStore: deps.localPlaylistStore } : {}),
  };
  const importDeps: ImportDeps = {
    db,
    http: deps.http,
    secrets,
    scheduler: deps.scheduler,
    clock,
    maxBodyBytes: deps.maxBodyBytes ?? DEVICE_MAX_BODY_BYTES,
    ...(deps.decompressor ? { decompressor: deps.decompressor } : {}),
    ...(deps.nativeGuideStager ? { nativeGuideStager: deps.nativeGuideStager } : {}),
    ...(deps.localPlaylistStore ? { localPlaylistStore: deps.localPlaylistStore } : {}),
  };
  const queue = createSerializedImportQueue(db);
  const playtime = createPlaytimeResolverCache({
    db,
    secrets,
    http: deps.http,
    clock,
    ...(deps.resolveLocalDownload ? { resolveLocalDownload: deps.resolveLocalDownload } : {}),
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
  const withUserSync = async <T extends Result<unknown>>(p: Promise<T>): Promise<T> => {
    const r = await p;
    if (r.ok) await syncUserData();
    return r;
  };
  const voidUserSync = async (p: Promise<void>): Promise<void> => {
    await p;
    await syncUserData();
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
  const elvOpsMethods = createCatalogElvOpsMethods({
    db,
    clock,
    scheduler: deps.scheduler,
    enrichmentStore: deps.enrichmentStore,
    elvClient: deps.elvClient,
    resolveRowLogos: (rows) => playtime.resolveRowLogos(rows),
  });
  const newEpisodesOpsMethods = createCatalogNewEpisodesOpsMethods({
    db,
    clock,
    importDeps,
    queue,
    playtime,
  });
  const ratingsOpsMethods = createCatalogRatingsOpsMethods({ db, clock, playtime, syncUserData });
  const recommendationDismissalsOpsMethods = createCatalogRecommendationDismissalsOpsMethods({
    db,
    clock,
    syncUserData,
  });
  const liveFoldersOpsMethods = createCatalogLiveFoldersOpsMethods({ db, clock, syncUserData });
  const syncStateOpsMethods = createCatalogSyncStateOpsMethods({ db, playtime, syncUserData });
  const seriesWatchedOpsMethods = createCatalogSeriesWatchedOpsMethods({
    db,
    clock,
    importDeps,
    queue,
    syncUserData,
  });

  const listSources = () => querySourcesList(db);
  const sourceMutationMethods = createCatalogSourceMutationMethods({
    db,
    evictPlaytime: (id) => playtime.evict(id),
    syncManifest,
    listSources,
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
        await deps.enrichmentStore?.clearSourceMatches(id);
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

    listSources,

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

    liveVariants: (itemKey, categoryId, opts) =>
      elvOpsMethods.listLiveVariants(itemKey, categoryId, opts),
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
    setWatched: (itemKey, watched, profileId) =>
      withUserSync(setItemWatched(db, itemKey, watched, clock, profileId)),
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
    clearProgress: (itemKey, profileId) =>
      withUserSync(clearWatchProgress(db, itemKey, profileId, clock)),
    toggleFavorite: (input) => withUserSync(toggleFavorite(db, input, clock)),
    setFavorite: (input, active) => withUserSync(setFavorite(db, input, active, clock)),
    reorderFavorites: (orderedItemKeys, profileId) =>
      withUserSync(reorderFavorites(db, orderedItemKeys, profileId)),
    listFavorites: async (limit, profileId, opts) =>
      playtime.resolveRowLogos(await listFavorites(db, limit, profileId, opts)),
    listFavoriteKeys: (profileId) => listFavoriteKeys(db, profileId),
    getTrackPreference: (scopeKey, profileId) => getTrackPreference(db, scopeKey, profileId),
    saveTrackPreference: (input) => voidUserSync(saveTrackPreference(db, input, clock)),
    clearTrackPreference: (scopeKey, profileId) =>
      voidUserSync(clearTrackPreference(db, scopeKey, profileId)),
    recordRecentChannel: (itemKey, sourceId, profileId) =>
      voidUserSync(recordRecentChannel(db, itemKey, sourceId, profileId, clock())),
    listRecentChannels: async (limit, profileId, opts) =>
      playtime.resolveRowLogos(await listRecentChannels(db, limit, profileId, opts)),

    ...profileMethods,
    ...channelOpsMethods,
    ...epgOpsMethods,
    ...failoverOpsMethods,
    ...collectionsOpsMethods,
    ...downloadsOpsMethods,
    ...elvOpsMethods,
    ...newEpisodesOpsMethods,
    ...ratingsOpsMethods,
    ...recommendationDismissalsOpsMethods,
    ...liveFoldersOpsMethods,
    ...sourceMutationMethods,
    ...syncStateOpsMethods,
    ...seriesWatchedOpsMethods,

    close() {
      if (closePromise !== undefined) return closePromise;
      closePromise = (async () => {
        await queue.close();
        playtime.clear();
        await db.exec('PRAGMA optimize').catch(() => undefined);
        await db.close?.();
      })();
      return closePromise;
    },
  };
}
