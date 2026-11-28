import type {
  CatalogService,
  DeviceImportOptions,
  ElvItemEnrichment,
  ElvMatchingSummary,
  ParentalQueryOptions,
  QueryLiveVariantsOptions,
} from '@elv/data';
import { type ElvError, elvError, err, originOf } from '@elv/domain';
import type { CatalogBridge } from '../../../src/shared/catalog-ipc.ts';
import type { LiveVariantsIpcOptions } from '../../../src/shared/catalog-ipc-wave-e1-guards.ts';

/** The catalog utility process could not open or migrate SQLite; `error` carries the typed cause (no secrets). */
export class CatalogOpenError extends Error {
  constructor(readonly error: ElvError) {
    super(`catalog open failed: ${error.category}/${error.code}`);
  }
}

let instance: Promise<CatalogService> | undefined;

const MAX_IPC_TEXT_CHARS = 256;
const MAX_ELV_ENRICHMENT_KEYS = 500;
const MAX_CLAIMED_LABEL_CHARS = 128;

function sanitizeDisplayText(text: string): string {
  let out = '';
  let lastSpace = false;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      if (!lastSpace) {
        out += ' ';
        lastSpace = true;
      }
    } else {
      out += text[i];
      lastSpace = code === 0x20;
    }
  }
  return out.trim();
}

function truncateDisplayText(text: string, maxChars: number): string {
  const clean = sanitizeDisplayText(text);
  if (clean.length <= maxChars) return clean;
  let end = maxChars;
  const last = clean.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return clean.slice(0, end).trimEnd();
}

const EMPTY_ELV_MATCHING_SUMMARY: ElvMatchingSummary = {
  scanned: 0,
  layer1Matched: 0,
  remoteMatched: 0,
  skipped: 0,
  aborted: false,
};

function toLiveVariantsIpcOptions(
  opts: QueryLiveVariantsOptions | undefined,
): LiveVariantsIpcOptions | undefined {
  if (opts === undefined) return undefined;
  const clean: {
    profileId?: string;
    parentalUnlocked?: boolean;
    crossCategory?: boolean;
    crossSource?: boolean;
  } = {};
  if (opts.profileId !== undefined) clean.profileId = opts.profileId;
  if (opts.parentalUnlocked !== undefined) clean.parentalUnlocked = opts.parentalUnlocked;
  if (opts.crossCategory !== undefined) clean.crossCategory = opts.crossCategory;
  if (opts.crossSource !== undefined) clean.crossSource = opts.crossSource;
  return Object.keys(clean).length > 0 ? clean : undefined;
}

/**
 * Adapts the preload's {@link CatalogBridge} into `@elv/data`'s {@link CatalogService}, mapping
 * `AbortSignal` cancellations onto `cancelImport(reqId)` and isolating progress callback throws.
 */
export function createDesktopCatalogFromBridge(
  bridge: CatalogBridge,
  onClose?: () => void,
): CatalogService {
  return {
    addSource: (input) => bridge.addSource(input),
    addSourceFromLink: (input) => bridge.addSourceFromLink(input),
    addLocalM3uSource: (input) =>
      bridge.addLocalM3uSource
        ? bridge.addLocalM3uSource(input)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    discoverSourceCategories: (sourceId, opts) => {
      if (opts?.signal?.aborted) {
        return Promise.resolve(err(elvError('network', 'aborted')));
      }
      return bridge.discoverSourceCategories
        ? bridge.discoverSourceCategories(sourceId)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    },
    updateSourceSettings: (sourceId, patch) =>
      bridge.updateSourceSettings
        ? bridge.updateSourceSettings(sourceId, patch)
        : Promise.resolve(),
    renameSource: (sourceId, name) =>
      bridge.renameSource
        ? bridge.renameSource(sourceId, sanitizeDisplayText(name))
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    setSourceExcludedProfiles: (sourceId, excludedProfileIds) =>
      bridge.setSourceExcludedProfiles
        ? bridge.setSourceExcludedProfiles(sourceId, excludedProfileIds)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    removeSource: (id) => bridge.removeSource(id),
    async importSource(id, opts?: DeviceImportOptions) {
      if (opts?.signal?.aborted) {
        return err(elvError('network', 'aborted'));
      }
      const handle = bridge.startImport(id, {
        ...(opts?.batchSize === undefined ? {} : { batchSize: opts.batchSize }),
        ...(opts?.maxBodyBytes === undefined ? {} : { maxBodyBytes: opts.maxBodyBytes }),
        ...(opts?.onProgress === undefined
          ? {}
          : {
              onProgress: (progress) => {
                try {
                  opts.onProgress?.(progress);
                } catch {
                  // isolate caller callback errors
                }
              },
            }),
      });
      if (!opts?.signal) {
        return handle.result;
      }
      const onAbort = (): void => {
        bridge.cancelImport(handle.reqId);
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
      try {
        return await handle.result;
      } finally {
        opts.signal.removeEventListener('abort', onAbort);
      }
    },
    listSources: () => bridge.listSources(),
    importGuide: (id, opts) =>
      opts?.signal?.aborted
        ? Promise.resolve(err(elvError('network', 'aborted')))
        : bridge.importGuide(id),
    categories: (sourceId, kind, opts) => bridge.categories(sourceId, kind, opts),
    items: (categoryId, offset, limit, opts) => bridge.items(categoryId, offset, limit, opts),
    liveVariants: (itemKey, categoryId, opts?: QueryLiveVariantsOptions) =>
      bridge.liveVariants
        ? bridge.liveVariants(itemKey, categoryId, toLiveVariantsIpcOptions(opts))
        : Promise.resolve([]),
    itemVersions: (itemKey, opts?: ParentalQueryOptions) =>
      bridge.itemVersions ? bridge.itemVersions(itemKey, opts) : Promise.resolve([]),
    allSourcesItems: (kind, offset, limit, sourceIds, opts) =>
      bridge.allSourcesItems
        ? bridge.allSourcesItems(kind, offset, limit, sourceIds, opts)
        : Promise.resolve([]),
    itemDetail: (itemKey, opts) => bridge.itemDetail(itemKey, opts),
    search: (query, opts) => bridge.search(sanitizeDisplayText(query).slice(0, 256), opts),
    searchSuggestions: (options) =>
      bridge.searchSuggestions ? bridge.searchSuggestions(options) : Promise.resolve([]),
    alphabetIndex: (input) =>
      bridge.alphabetIndex ? bridge.alphabetIndex(input) : Promise.resolve([]),
    nowNext: (channelKeys, nowMs, opts) => bridge.nowNext(channelKeys, nowMs, opts),
    epgWindow: (channelKeys, fromMs, toMs, opts) =>
      bridge.epgWindow(channelKeys, fromMs, toMs, opts),
    epgSlice: (sourceId, fromMs, toMs, limit, opts) =>
      bridge.epgSlice ? bridge.epgSlice(sourceId, fromMs, toMs, limit, opts) : Promise.resolve([]),
    channelByNumber: (num, sourceId, opts) => bridge.channelByNumber(num, sourceId, opts),
    seasons: (seriesId, opts?: ParentalQueryOptions) => bridge.seasons(seriesId, opts),
    episodes: (seriesId, season, opts?: ParentalQueryOptions) =>
      bridge.episodes(seriesId, season, opts),
    queryNextEpisode: (
      seriesKey,
      currentItemKey,
      profileId,
      opts?: { readonly parentalUnlocked?: boolean },
    ) => bridge.queryNextEpisode(seriesKey, currentItemKey, profileId, opts),
    resolveStream: (itemKey, opts) => bridge.resolveStream(itemKey, opts),
    saveProgress: (input) =>
      bridge.saveProgress({
        ...input,
        title: sanitizeDisplayText(input.title),
        ...(typeof input.subtitle === 'string'
          ? { subtitle: sanitizeDisplayText(input.subtitle) }
          : {}),
      }),
    setWatched: (itemKey, watched, profileId) => bridge.setWatched(itemKey, watched, profileId),
    setSeasonWatched: (seriesKey, season, watched, profileId) =>
      bridge.setSeasonWatched
        ? bridge.setSeasonWatched(seriesKey, season, watched, profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    setSeriesWatched: (seriesKey, watched, profileId) =>
      bridge.setSeriesWatched
        ? bridge.setSeriesWatched(seriesKey, watched, profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    getProgress: (itemKey, profileId) => bridge.getProgress(itemKey, profileId),
    listContinueWatching: (limit, profileId, opts) =>
      bridge.listContinueWatching(limit, profileId, opts),
    listWatched: (limit, profileId, opts) =>
      bridge.listWatched ? bridge.listWatched(limit, profileId, opts) : Promise.resolve([]),
    listProgressByKeys: (itemKeys, profileId) => bridge.listProgressByKeys(itemKeys, profileId),
    listSeriesUnplayedCounts: (seriesKeys, profileId) =>
      bridge.listSeriesUnplayedCounts
        ? bridge.listSeriesUnplayedCounts(seriesKeys, profileId)
        : Promise.resolve([]),
    clearProgress: (itemKey, profileId) => bridge.clearProgress(itemKey, profileId),
    toggleFavorite: (input) =>
      bridge.toggleFavorite({ ...input, title: sanitizeDisplayText(input.title) }),
    setFavorite: (input, active) =>
      bridge.setFavorite({ ...input, title: sanitizeDisplayText(input.title) }, active),
    reorderFavorites: (orderedItemKeys, profileId) =>
      bridge.reorderFavorites
        ? bridge.reorderFavorites(orderedItemKeys, profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    listFavorites: (limit, profileId, opts) => bridge.listFavorites(limit, profileId, opts),
    listFavoriteKeys: (profileId) => bridge.listFavoriteKeys(profileId),
    listMyListNewEpisodes: (limit, profileId, opts) =>
      bridge.listMyListNewEpisodes
        ? bridge.listMyListNewEpisodes(limit, profileId, opts)
        : Promise.resolve([]),
    dismissMyListNewEpisode: (episodeKey, profileId) =>
      bridge.dismissMyListNewEpisode
        ? bridge.dismissMyListNewEpisode(episodeKey, profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    refreshMyListNewEpisodes: (profileId, opts) =>
      bridge.refreshMyListNewEpisodes
        ? bridge.refreshMyListNewEpisodes(profileId, opts)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    getTrackPreference: (scopeKey, profileId) =>
      bridge.getTrackPreference
        ? bridge.getTrackPreference(scopeKey, profileId)
        : Promise.resolve(null),
    saveTrackPreference: (input) =>
      bridge.saveTrackPreference ? bridge.saveTrackPreference(input) : Promise.resolve(),
    clearTrackPreference: (scopeKey, profileId) =>
      bridge.clearTrackPreference
        ? bridge.clearTrackPreference(scopeKey, profileId)
        : Promise.resolve(),
    recordRecentChannel: (itemKey, sourceId, profileId) =>
      bridge.recordRecentChannel
        ? bridge.recordRecentChannel(itemKey, sourceId, profileId)
        : Promise.resolve(),
    listRecentChannels: (limit, profileId, opts) =>
      bridge.listRecentChannels
        ? bridge.listRecentChannels(limit, profileId, opts)
        : Promise.resolve([]),
    listProfiles: () => (bridge.listProfiles ? bridge.listProfiles() : Promise.resolve([])),
    createProfile: (input) =>
      bridge.createProfile
        ? bridge.createProfile({ ...input, name: sanitizeDisplayText(input.name) })
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    updateProfile: (id, patch) =>
      bridge.updateProfile
        ? bridge.updateProfile(id, {
            ...patch,
            ...(patch.name === undefined ? {} : { name: sanitizeDisplayText(patch.name) }),
          })
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    deleteProfile: (id) =>
      bridge.deleteProfile
        ? bridge.deleteProfile(id)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    getParentalSettings: (profileId) =>
      bridge.getParentalSettings
        ? bridge.getParentalSettings(profileId)
        : Promise.resolve({
            profileId: profileId ?? 'default',
            enabled: false,
            blockAdultKeywords: true,
            maxRatingAge: null,
            unlockTimeoutMin: 30,
            updatedAt: 0,
          }),
    updateParentalSettings: (patch, profileId) =>
      bridge.updateParentalSettings
        ? bridge.updateParentalSettings(patch, profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    listParentalLocks: (profileId, filter) =>
      bridge.listParentalLocks ? bridge.listParentalLocks(profileId, filter) : Promise.resolve([]),
    setParentalLock: (input, locked) =>
      bridge.setParentalLock
        ? bridge.setParentalLock(input, locked)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    hasParentalPin: (profileId) =>
      bridge.hasParentalPin ? bridge.hasParentalPin(profileId) : Promise.resolve(false),
    setParentalPin: (pin, profileId, currentPin) =>
      bridge.setParentalPin
        ? bridge.setParentalPin(pin, profileId, currentPin)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    verifyParentalPin: (pin, profileId) =>
      bridge.verifyParentalPin
        ? bridge.verifyParentalPin(pin, profileId)
        : Promise.resolve({ ok: false, remainingAttempts: 0 }),
    clearParentalPin: (currentPin, profileId) =>
      bridge.clearParentalPin
        ? bridge.clearParentalPin(currentPin, profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    listChannelOverrides: (profileId) =>
      bridge.listChannelOverrides ? bridge.listChannelOverrides(profileId) : Promise.resolve([]),
    setChannelOverride: (input) =>
      bridge.setChannelOverride
        ? bridge.setChannelOverride(input)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    clearChannelOverride: (itemKey, profileId) =>
      bridge.clearChannelOverride
        ? bridge.clearChannelOverride(itemKey, profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    reorderChannels: (itemKeys, sourceId, profileId) =>
      bridge.reorderChannels
        ? bridge.reorderChannels(itemKeys, sourceId, profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    listCustomGroups: (profileId, opts) =>
      bridge.listCustomGroups ? bridge.listCustomGroups(profileId, opts) : Promise.resolve([]),
    createCustomGroup: (input) =>
      bridge.createCustomGroup
        ? bridge.createCustomGroup(input)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    updateCustomGroup: (groupId, patch) =>
      bridge.updateCustomGroup
        ? bridge.updateCustomGroup(groupId, patch)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    deleteCustomGroup: (groupId) =>
      bridge.deleteCustomGroup
        ? bridge.deleteCustomGroup(groupId)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    setCustomGroupItems: (groupId, items) =>
      bridge.setCustomGroupItems
        ? bridge.setCustomGroupItems(groupId, items)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    addChannelToCustomGroup: (groupId, itemKey, sourceId) =>
      bridge.addChannelToCustomGroup
        ? bridge.addChannelToCustomGroup(groupId, itemKey, sourceId)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    removeChannelFromCustomGroup: (groupId, itemKey) =>
      bridge.removeChannelFromCustomGroup
        ? bridge.removeChannelFromCustomGroup(groupId, itemKey)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    resolveCatchupStream: (itemKey, programme, opts) =>
      bridge.resolveCatchupStream
        ? bridge.resolveCatchupStream(
            itemKey,
            programme.title === undefined
              ? programme
              : {
                  ...programme,
                  title: truncateDisplayText(programme.title, MAX_IPC_TEXT_CHARS),
                },
            opts,
          )
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    fetchChannelArchiveEpg: (itemKey, opts) =>
      bridge.fetchChannelArchiveEpg
        ? bridge.fetchChannelArchiveEpg(itemKey, opts)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    listGuideSources: (sourceId) =>
      bridge.listGuideSources ? bridge.listGuideSources(sourceId) : Promise.resolve([]),
    addGuideSource: (input) =>
      bridge.addGuideSource
        ? bridge.addGuideSource({ ...input, name: sanitizeDisplayText(input.name) })
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    updateGuideSource: (id, patch) =>
      bridge.updateGuideSource
        ? bridge.updateGuideSource(id, {
            ...patch,
            ...(patch.name === undefined ? {} : { name: sanitizeDisplayText(patch.name) }),
          })
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    removeGuideSource: (id) =>
      bridge.removeGuideSource
        ? bridge.removeGuideSource(id)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    reorderGuideSources: (sourceId, orderedIds) =>
      bridge.reorderGuideSources
        ? bridge.reorderGuideSources(sourceId, orderedIds)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    listGuideChannels: (sourceId, query, limit) =>
      bridge.listGuideChannels
        ? bridge.listGuideChannels(
            sourceId,
            query === undefined ? undefined : sanitizeDisplayText(query).slice(0, 256),
            limit,
          )
        : Promise.resolve([]),
    listChannelGuideOverrides: (sourceId) =>
      bridge.listChannelGuideOverrides
        ? bridge.listChannelGuideOverrides(sourceId)
        : Promise.resolve([]),
    setChannelGuideOverride: (input) =>
      bridge.setChannelGuideOverride
        ? bridge.setChannelGuideOverride(input)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    clearChannelGuideOverride: (sourceId, channelKey) =>
      bridge.clearChannelGuideOverride
        ? bridge.clearChannelGuideOverride(sourceId, channelKey)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    listReminders: (profileId, opts) =>
      bridge.listReminders ? bridge.listReminders(profileId, opts) : Promise.resolve([]),
    upsertReminder: (input) =>
      bridge.upsertReminder
        ? bridge.upsertReminder({
            ...input,
            channelName: truncateDisplayText(input.channelName, MAX_IPC_TEXT_CHARS),
            programmeTitle: truncateDisplayText(input.programmeTitle, MAX_IPC_TEXT_CHARS),
          })
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    removeReminder: (channelKey, programmeStart, profileId) =>
      bridge.removeReminder
        ? bridge.removeReminder(channelKey, programmeStart, profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    markReminderFired: (channelKey, programmeStart, profileId) =>
      bridge.markReminderFired
        ? bridge.markReminderFired(channelKey, programmeStart, profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    pruneExpiredReminders: (nowMs) =>
      bridge.pruneExpiredReminders ? bridge.pruneExpiredReminders(nowMs) : Promise.resolve(0),
    listFailoverGroups: () =>
      bridge.listFailoverGroups ? bridge.listFailoverGroups() : Promise.resolve([]),
    getFailoverGroupByChannel: (channelKey) =>
      bridge.getFailoverGroupByChannel
        ? bridge.getFailoverGroupByChannel(channelKey)
        : Promise.resolve(undefined),
    createFailoverGroup: (input) =>
      bridge.createFailoverGroup
        ? bridge.createFailoverGroup({ ...input, name: sanitizeDisplayText(input.name) })
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    renameFailoverGroup: (groupId, name) =>
      bridge.renameFailoverGroup
        ? bridge.renameFailoverGroup(groupId, sanitizeDisplayText(name))
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    deleteFailoverGroup: (groupId) =>
      bridge.deleteFailoverGroup
        ? bridge.deleteFailoverGroup(groupId)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    addFailoverGroupMember: (groupId, channelKey) =>
      bridge.addFailoverGroupMember
        ? bridge.addFailoverGroupMember(groupId, channelKey)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    removeFailoverGroupMember: (groupId, channelKey) =>
      bridge.removeFailoverGroupMember
        ? bridge.removeFailoverGroupMember(groupId, channelKey)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    reorderFailoverGroupMembers: (groupId, orderedChannelKeys) =>
      bridge.reorderFailoverGroupMembers
        ? bridge.reorderFailoverGroupMembers(groupId, orderedChannelKeys)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    suggestFailoverGroups: () =>
      bridge.suggestFailoverGroups ? bridge.suggestFailoverGroups() : Promise.resolve([]),
    applySuggestedFailoverGroups: (clusters) =>
      bridge.applySuggestedFailoverGroups
        ? bridge.applySuggestedFailoverGroups(
            clusters.map((cluster) => ({
              ...cluster,
              suggestedName: sanitizeDisplayText(cluster.suggestedName),
              members: cluster.members.map((m) => ({
                ...m,
                channelName: sanitizeDisplayText(m.channelName),
                sourceName: sanitizeDisplayText(m.sourceName),
              })),
            })),
          )
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    reportStreamOutcome: (sourceId, serverUrl, succeeded) => {
      const origin = originOf(serverUrl);
      if (origin === undefined) return;
      void bridge.reportStreamOutcome?.(sourceId, origin, succeeded)?.catch(() => undefined);
    },
    getVodEnrichment: (itemKey) =>
      bridge.getVodEnrichment ? bridge.getVodEnrichment(itemKey) : Promise.resolve(null),
    enrichVodItem: (itemKey, opts) => {
      if (!bridge.enrichVodItem) return Promise.resolve(null);
      const cleanOpts: { enabled?: boolean; ttlMs?: number } = {};
      if (opts?.enabled !== undefined) cleanOpts.enabled = opts.enabled;
      if (opts?.ttlMs !== undefined) cleanOpts.ttlMs = opts.ttlMs;
      return bridge.enrichVodItem(
        itemKey,
        Object.keys(cleanOpts).length > 0 ? cleanOpts : undefined,
      );
    },
    listCollections: (profileId, opts) =>
      bridge.listCollections ? bridge.listCollections(profileId, opts) : Promise.resolve([]),
    createCollection: (input) =>
      bridge.createCollection
        ? bridge.createCollection({ ...input, name: sanitizeDisplayText(input.name) })
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    renameCollection: (id, name, profileId) =>
      bridge.renameCollection
        ? bridge.renameCollection(id, sanitizeDisplayText(name), profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    reorderCollections: (orderedIds, profileId) =>
      bridge.reorderCollections
        ? bridge.reorderCollections(orderedIds, profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    deleteCollection: (id, profileId) =>
      bridge.deleteCollection
        ? bridge.deleteCollection(id, profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    listCollectionItems: (collectionId, opts) =>
      bridge.listCollectionItems
        ? bridge.listCollectionItems(collectionId, opts)
        : Promise.resolve([]),
    listCollectionsForItem: (itemKey, profileId) =>
      bridge.listCollectionsForItem
        ? bridge.listCollectionsForItem(itemKey, profileId)
        : Promise.resolve([]),
    addItemToCollection: (collectionId, itemKey, kind, profileId) =>
      bridge.addItemToCollection
        ? bridge.addItemToCollection(collectionId, itemKey, kind, profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    removeItemFromCollection: (collectionId, itemKey, profileId) =>
      bridge.removeItemFromCollection
        ? bridge.removeItemFromCollection(collectionId, itemKey, profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    reorderCollectionItems: (collectionId, orderedItemKeys, profileId) =>
      bridge.reorderCollectionItems
        ? bridge.reorderCollectionItems(collectionId, orderedItemKeys, profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    setRating: (input, value) =>
      bridge.setRating
        ? bridge.setRating({ ...input, title: sanitizeDisplayText(input.title) }, value)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    getRating: (itemKey, profileId) =>
      bridge.getRating ? bridge.getRating(itemKey, profileId) : Promise.resolve(null),
    listRatings: (opts) => (bridge.listRatings ? bridge.listRatings(opts) : Promise.resolve([])),
    listRatingMap: (profileId) =>
      bridge.listRatingMap ? bridge.listRatingMap(profileId) : Promise.resolve({}),
    dismissRecommendation: (itemKey, kind, profileId) =>
      bridge.dismissRecommendation
        ? bridge.dismissRecommendation(itemKey, kind, profileId)
        : Promise.resolve(),
    restoreRecommendation: (itemKey, profileId) =>
      bridge.restoreRecommendation
        ? bridge.restoreRecommendation(itemKey, profileId)
        : Promise.resolve(),
    listDismissedRecommendationKeys: (profileId) =>
      bridge.listDismissedRecommendationKeys
        ? bridge.listDismissedRecommendationKeys(profileId)
        : Promise.resolve([]),
    getElvEnrichmentForKeys: async (itemKeys) => {
      if (!bridge.getElvEnrichmentForKeys || itemKeys.length === 0) {
        return new Map<string, ElvItemEnrichment>();
      }
      const merged = new Map<string, ElvItemEnrichment>();
      for (let i = 0; i < itemKeys.length; i += MAX_ELV_ENRICHMENT_KEYS) {
        const batch = itemKeys.slice(i, i + MAX_ELV_ENRICHMENT_KEYS);
        const raw = await bridge.getElvEnrichmentForKeys(batch);
        if (raw instanceof Map) {
          for (const [k, v] of raw) merged.set(k, v);
        } else {
          for (const [k, v] of Object.entries(raw)) merged.set(k, v);
        }
      }
      return merged;
    },
    getElvTitleDetail: (imdbId, opts) => {
      if (opts?.signal?.aborted || !bridge.getElvTitleDetail) return Promise.resolve(null);
      const cleanOpts: { lang?: string; forceRefresh?: boolean } = {};
      if (opts?.lang !== undefined) cleanOpts.lang = opts.lang;
      if (opts?.forceRefresh !== undefined) cleanOpts.forceRefresh = opts.forceRefresh;
      return bridge.getElvTitleDetail(
        imdbId,
        Object.keys(cleanOpts).length > 0 ? cleanOpts : undefined,
      );
    },
    listMergedVodVersions: (itemKey, opts) =>
      bridge.listMergedVodVersions
        ? bridge.listMergedVodVersions(itemKey, opts)
        : Promise.resolve([]),
    enrichElvPriorityKeys: (itemKeys, opts) => {
      if (opts?.signal?.aborted) {
        return Promise.resolve({ ...EMPTY_ELV_MATCHING_SUMMARY, aborted: true });
      }
      if (!bridge.enrichElvPriorityKeys) return Promise.resolve(EMPTY_ELV_MATCHING_SUMMARY);
      return bridge.enrichElvPriorityKeys(
        itemKeys,
        opts?.lang === undefined ? undefined : { lang: opts.lang },
      );
    },
    runElvBackgroundMatching: (opts) => {
      if (opts?.signal?.aborted) {
        return Promise.resolve({ ...EMPTY_ELV_MATCHING_SUMMARY, aborted: true });
      }
      if (!bridge.runElvBackgroundMatching) return Promise.resolve(EMPTY_ELV_MATCHING_SUMMARY);
      const cleanOpts: { lang?: string; batchSize?: number } = {};
      if (opts?.lang !== undefined) cleanOpts.lang = opts.lang;
      if (opts?.batchSize !== undefined) cleanOpts.batchSize = opts.batchSize;
      return bridge.runElvBackgroundMatching(
        Object.keys(cleanOpts).length > 0 ? cleanOpts : undefined,
      );
    },
    recordPlaybackQuality: (input) =>
      bridge.recordPlaybackQuality
        ? bridge.recordPlaybackQuality({
            ...input,
            ...(typeof input.claimedLabel === 'string'
              ? { claimedLabel: truncateDisplayText(input.claimedLabel, MAX_CLAIMED_LABEL_CHARS) }
              : {}),
          })
        : Promise.resolve(null),
    recordPlaybackVariantFailure: (itemKey) =>
      bridge.recordPlaybackVariantFailure
        ? bridge.recordPlaybackVariantFailure(itemKey)
        : Promise.resolve(null),
    setElvManualMatch: (itemKey, sourceId, mediaType, imdbId) =>
      bridge.setElvManualMatch
        ? bridge.setElvManualMatch(itemKey, sourceId, mediaType, imdbId)
        : Promise.resolve(),
    wipeElvEnrichment: () =>
      bridge.wipeElvEnrichment ? bridge.wipeElvEnrichment() : Promise.resolve(),
    searchElvItemKeysByAlias: (query, opts) =>
      bridge.searchElvItemKeysByAlias
        ? bridge.searchElvItemKeysByAlias(truncateDisplayText(query, MAX_IPC_TEXT_CHARS), opts)
        : Promise.resolve([]),
    listLiveVariants: (itemKey, categoryId, opts) => {
      const cleanOpts = toLiveVariantsIpcOptions(opts);
      if (bridge.listLiveVariants) return bridge.listLiveVariants(itemKey, categoryId, cleanOpts);
      if (bridge.liveVariants) return bridge.liveVariants(itemKey, categoryId, cleanOpts);
      return Promise.resolve([]);
    },
    findGuideChannelByCleanName: (sourceId, channelName, opts) => {
      if (!bridge.findGuideChannelByCleanName) return Promise.resolve(null);
      const cleanName = truncateDisplayText(channelName, MAX_IPC_TEXT_CHARS);
      if (cleanName === '') return Promise.resolve(null);
      return bridge.findGuideChannelByCleanName(sourceId, cleanName, opts);
    },
    listElvImdbGenres: (kind, opts) =>
      bridge.listElvImdbGenres ? bridge.listElvImdbGenres(kind, opts) : Promise.resolve([]),
    listElvItemsByImdbGenre: (kind, genre, opts) => {
      if (!bridge.listElvItemsByImdbGenre) return Promise.resolve([]);
      const cleanGenre = truncateDisplayText(genre, 80);
      if (cleanGenre === '') return Promise.resolve([]);
      return bridge.listElvItemsByImdbGenre(kind, cleanGenre, opts);
    },
    getElvRecommendations: (opts) =>
      bridge.getElvRecommendations ? bridge.getElvRecommendations(opts) : Promise.resolve([]),
    refreshElvFeeds: (opts) => {
      if (opts?.signal?.aborted || !bridge.refreshElvFeeds) return Promise.resolve(false);
      return bridge.refreshElvFeeds(opts?.force === undefined ? undefined : { force: opts.force });
    },
    listElvFranchiseItems: (imdbId, opts) =>
      bridge.listElvFranchiseItems
        ? bridge.listElvFranchiseItems(imdbId, opts)
        : Promise.resolve([]),
    listElvPersonLibraryItems: (person, opts) => {
      if (!bridge.listElvPersonLibraryItems) return Promise.resolve([]);
      const cleanName = truncateDisplayText(person.name, 160);
      const cleanPerson = {
        ...(person.personId !== undefined ? { personId: person.personId.trim() } : {}),
        name: cleanName,
      };
      if (cleanName === '' && (cleanPerson.personId ?? '') === '') return Promise.resolve([]);
      return bridge.listElvPersonLibraryItems(cleanPerson, opts);
    },
    searchElvMatchCandidates: (query, mediaType, opts) => {
      if (opts?.signal?.aborted || !bridge.searchElvMatchCandidates) return Promise.resolve([]);
      const cleanQuery = truncateDisplayText(query, MAX_IPC_TEXT_CHARS);
      if (cleanQuery === '') return Promise.resolve([]);
      return bridge.searchElvMatchCandidates(cleanQuery, mediaType);
    },
    applyElvFixMatch: (input) =>
      bridge.applyElvFixMatch ? bridge.applyElvFixMatch(input) : Promise.resolve(null),
    removeRecentChannel: (itemKey, profileId) =>
      bridge.removeRecentChannel
        ? bridge.removeRecentChannel(itemKey, profileId)
        : Promise.resolve(false),
    clearRecentChannels: (profileId) =>
      bridge.clearRecentChannels ? bridge.clearRecentChannels(profileId) : Promise.resolve(0),
    listLiveFavoriteFolders: (profileId, opts) =>
      bridge.listLiveFavoriteFolders
        ? bridge.listLiveFavoriteFolders(profileId, opts)
        : Promise.resolve([]),
    createLiveFavoriteFolder: (input) =>
      bridge.createLiveFavoriteFolder
        ? bridge.createLiveFavoriteFolder(input)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    renameLiveFavoriteFolder: (id, name, profileId) =>
      bridge.renameLiveFavoriteFolder
        ? bridge.renameLiveFavoriteFolder(id, name, profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    deleteLiveFavoriteFolder: (id, profileId) =>
      bridge.deleteLiveFavoriteFolder
        ? bridge.deleteLiveFavoriteFolder(id, profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    assignLiveFavoriteFolder: (input) =>
      bridge.assignLiveFavoriteFolder
        ? bridge.assignLiveFavoriteFolder(input)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    listLiveFavoriteFolderAssignments: (profileId) =>
      bridge.listLiveFavoriteFolderAssignments
        ? bridge.listLiveFavoriteFolderAssignments(profileId)
        : Promise.resolve([]),
    flushPendingWrites: () =>
      bridge.flushPendingWrites ? bridge.flushPendingWrites() : Promise.resolve(),
    async close() {
      onClose?.();
      await bridge.close();
    },
  };
}

async function open(): Promise<CatalogService> {
  const bridge = typeof window === 'undefined' ? undefined : window.elv?.catalog;
  if (!bridge) {
    throw new CatalogOpenError(elvError('storage', 'bridge-unavailable'));
  }
  const opened = await bridge.open();
  if (!opened.ok) {
    throw new CatalogOpenError(opened.error);
  }
  return createDesktopCatalogFromBridge(bridge, () => {
    instance = undefined;
  });
}

/**
 * The singleton desktop catalog of this renderer window, backed by the Electron catalog
 * `utilityProcess` over `MessagePort`. A failed open is not cached so the next call retries.
 */
export function createDesktopCatalog(): Promise<CatalogService> {
  instance ??= open().catch((e: unknown) => {
    instance = undefined;
    throw e;
  });
  return instance;
}
