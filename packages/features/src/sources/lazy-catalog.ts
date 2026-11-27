import type { CatalogService } from '@elv/data';
import { type ElvError, elvError, err, type Result } from '@elv/domain';

function toElvError(caught: unknown): ElvError {
  if (
    typeof caught === 'object' &&
    caught !== null &&
    'error' in caught &&
    typeof (caught as { error?: unknown }).error === 'object' &&
    (caught as { error?: { category?: unknown; code?: unknown } }).error !== null
  ) {
    const candidate = (caught as { error: ElvError }).error;
    if (typeof candidate.category === 'string' && typeof candidate.code === 'string') {
      return candidate;
    }
  }
  return elvError('storage', 'open-failed');
}

async function wrapResult<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await fn();
  } catch (caught) {
    return err(toElvError(caught));
  }
}

/**
 * Wraps an asynchronous `() => Promise<CatalogService>` opener behind a synchronous
 * {@link CatalogService} facade so UI composition roots can mount `SourcesScreen` on frame 1
 * without blocking render, while converting open failures into typed `storage/*` `Result`s.
 * Memoizes the in-flight/resolved opener promise until rejected or closed.
 */
export function createLazyCatalog(load: () => Promise<CatalogService>): CatalogService {
  let cached: Promise<CatalogService> | undefined;

  const open = (): Promise<CatalogService> => {
    if (cached !== undefined) return cached;
    const pending: Promise<CatalogService> = Promise.resolve()
      .then(() => load())
      .catch((error: unknown) => {
        if (cached === pending) cached = undefined;
        throw error;
      });
    cached = pending;
    return pending;
  };

  return {
    addSource: (input) => wrapResult(async () => (await open()).addSource(input)),
    addSourceFromLink: (input) => wrapResult(async () => (await open()).addSourceFromLink(input)),
    addLocalM3uSource: (input) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.addLocalM3uSource
          ? cat.addLocalM3uSource(input)
          : err(elvError('storage', 'unsupported'));
      }),
    discoverSourceCategories: (sourceId, opts) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.discoverSourceCategories
          ? cat.discoverSourceCategories(sourceId, opts)
          : err(elvError('storage', 'unsupported'));
      }),
    updateSourceSettings: async (sourceId, patch) => {
      await (await open()).updateSourceSettings?.(sourceId, patch);
    },
    renameSource: (sourceId, name) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.renameSource
          ? cat.renameSource(sourceId, name)
          : err(elvError('storage', 'unsupported'));
      }),
    setSourceExcludedProfiles: (sourceId, excludedProfileIds) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.setSourceExcludedProfiles
          ? cat.setSourceExcludedProfiles(sourceId, excludedProfileIds)
          : err(elvError('storage', 'unsupported'));
      }),
    removeSource: (id) => wrapResult(async () => (await open()).removeSource(id)),
    importSource: (id, opts) => wrapResult(async () => (await open()).importSource(id, opts)),
    importGuide: (id, opts) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.importGuide
          ? cat.importGuide(id, opts)
          : err(elvError('storage', 'unsupported'));
      }),
    listSources: async () => (await open()).listSources(),
    latestImportHealth: async (sourceId) => (await open()).latestImportHealth?.(sourceId) ?? [],
    categories: async (sourceId, kind, opts) => (await open()).categories(sourceId, kind, opts),
    items: async (categoryId, offset, limit, opts) =>
      (await open()).items(categoryId, offset, limit, opts),
    liveVariants: async (itemKey, categoryId, opts) =>
      (await open()).liveVariants?.(itemKey, categoryId, opts) ?? [],
    itemVersions: async (itemKey, opts) => (await open()).itemVersions?.(itemKey, opts) ?? [],
    allSourcesItems: async (kind, offset, limit, sourceIds, opts) =>
      (await open()).allSourcesItems?.(kind, offset, limit, sourceIds, opts) ?? [],
    itemDetail: async (itemKey, opts) => {
      const svc = await open();
      return svc.itemDetail ? svc.itemDetail(itemKey, opts) : null;
    },
    search: async (query, opts) =>
      (await open()).search?.(query, opts) ?? {
        live: [],
        epg: [],
        movies: [],
        series: [],
        episodes: [],
      },
    searchSuggestions: async (options) => (await open()).searchSuggestions?.(options) ?? [],
    alphabetIndex: async (input) => (await open()).alphabetIndex?.(input) ?? [],
    nowNext: async (channelKeys, nowMs, opts) =>
      (await open()).nowNext?.(channelKeys, nowMs, opts) ?? [],
    epgWindow: async (channelKeys, fromMs, toMs, opts) =>
      (await open()).epgWindow?.(channelKeys, fromMs, toMs, opts) ?? {},
    epgSlice: async (sourceId, fromMs, toMs, limit, opts) =>
      (await open()).epgSlice?.(sourceId, fromMs, toMs, limit, opts) ?? [],
    channelByNumber: async (num, sourceId, opts) =>
      (await open()).channelByNumber?.(num, sourceId, opts) ?? null,
    seasons: (seriesId, opts) => wrapResult(async () => (await open()).seasons(seriesId, opts)),
    episodes: async (seriesId, season, opts) => (await open()).episodes(seriesId, season, opts),
    queryNextEpisode: async (seriesKey, currentItemKey, profileId, opts) =>
      (await open()).queryNextEpisode?.(seriesKey, currentItemKey, profileId, opts) ?? null,
    resolveStream: (itemKey, opts) =>
      wrapResult(async () => (await open()).resolveStream(itemKey, opts)),
    resolveCatchupStream: (itemKey, programme, opts) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.resolveCatchupStream
          ? cat.resolveCatchupStream(itemKey, programme, opts)
          : err(elvError('storage', 'unsupported'));
      }),
    fetchChannelArchiveEpg: (itemKey, opts) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.fetchChannelArchiveEpg
          ? cat.fetchChannelArchiveEpg(itemKey, opts)
          : err(elvError('storage', 'unsupported'));
      }),
    listGuideSources: async (sourceId) => (await open()).listGuideSources?.(sourceId) ?? [],
    addGuideSource: (input) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.addGuideSource
          ? cat.addGuideSource(input)
          : err(elvError('storage', 'unsupported'));
      }),
    updateGuideSource: (id, patch) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.updateGuideSource
          ? cat.updateGuideSource(id, patch)
          : err(elvError('storage', 'unsupported'));
      }),
    removeGuideSource: (id) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.removeGuideSource
          ? cat.removeGuideSource(id)
          : err(elvError('storage', 'unsupported'));
      }),
    reorderGuideSources: (sourceId, orderedIds) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.reorderGuideSources
          ? cat.reorderGuideSources(sourceId, orderedIds)
          : err(elvError('storage', 'unsupported'));
      }),
    listGuideChannels: async (sourceId, query, limit) =>
      (await open()).listGuideChannels?.(sourceId, query, limit) ?? [],
    listChannelGuideOverrides: async (sourceId) =>
      (await open()).listChannelGuideOverrides?.(sourceId) ?? [],
    setChannelGuideOverride: (input) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.setChannelGuideOverride
          ? cat.setChannelGuideOverride(input)
          : err(elvError('storage', 'unsupported'));
      }),
    clearChannelGuideOverride: (sourceId, channelKey) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.clearChannelGuideOverride
          ? cat.clearChannelGuideOverride(sourceId, channelKey)
          : err(elvError('storage', 'unsupported'));
      }),
    listReminders: async (profileId, opts) => (await open()).listReminders?.(profileId, opts) ?? [],
    upsertReminder: (input) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.upsertReminder
          ? cat.upsertReminder(input)
          : err(elvError('storage', 'unsupported'));
      }),
    removeReminder: (channelKey, programmeStart, profileId) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.removeReminder
          ? cat.removeReminder(channelKey, programmeStart, profileId)
          : err(elvError('storage', 'unsupported'));
      }),
    markReminderFired: (channelKey, programmeStart, profileId) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.markReminderFired
          ? cat.markReminderFired(channelKey, programmeStart, profileId)
          : err(elvError('storage', 'unsupported'));
      }),
    pruneExpiredReminders: async (nowMs) => (await open()).pruneExpiredReminders?.(nowMs) ?? 0,
    saveProgress: (input) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.saveProgress ? cat.saveProgress(input) : err(elvError('storage', 'unsupported'));
      }),
    setWatched: (itemKey, watched, profileId) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.setWatched
          ? cat.setWatched(itemKey, watched, profileId)
          : err(elvError('storage', 'unsupported'));
      }),
    getProgress: async (itemKey, profileId) =>
      (await open()).getProgress?.(itemKey, profileId) ?? null,
    listContinueWatching: async (limit, profileId, opts) =>
      (await open()).listContinueWatching?.(limit, profileId, opts) ?? [],
    listWatched: async (limit, profileId, opts) =>
      (await open()).listWatched?.(limit, profileId, opts) ?? [],
    listProgressByKeys: async (itemKeys, profileId) =>
      (await open()).listProgressByKeys?.(itemKeys, profileId) ?? [],
    listSeriesUnplayedCounts: async (seriesKeys, profileId) =>
      (await open()).listSeriesUnplayedCounts?.(seriesKeys, profileId) ?? [],
    clearProgress: (itemKey, profileId) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.clearProgress
          ? cat.clearProgress(itemKey, profileId)
          : err(elvError('storage', 'unsupported'));
      }),
    toggleFavorite: (input) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.toggleFavorite
          ? cat.toggleFavorite(input)
          : err(elvError('storage', 'unsupported'));
      }),
    setFavorite: (input, active) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.setFavorite
          ? cat.setFavorite(input, active)
          : err(elvError('storage', 'unsupported'));
      }),
    reorderFavorites: (orderedItemKeys, profileId) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.reorderFavorites
          ? cat.reorderFavorites(orderedItemKeys, profileId)
          : err(elvError('storage', 'unsupported'));
      }),
    listFavorites: async (limit, profileId, opts) =>
      (await open()).listFavorites?.(limit, profileId, opts) ?? [],
    listFavoriteKeys: async (profileId) => (await open()).listFavoriteKeys?.(profileId) ?? [],
    setRating: (input, value) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.setRating
          ? cat.setRating(input, value)
          : err(elvError('storage', 'unsupported'));
      }),
    getRating: async (itemKey, profileId) => (await open()).getRating?.(itemKey, profileId) ?? null,
    listRatings: async (opts) => (await open()).listRatings?.(opts) ?? [],
    listRatingMap: async (profileId) => (await open()).listRatingMap?.(profileId) ?? {},
    listMyListNewEpisodes: async (limit, profileId, opts) =>
      (await open()).listMyListNewEpisodes?.(limit, profileId, opts) ?? [],
    dismissMyListNewEpisode: (episodeKey, profileId) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.dismissMyListNewEpisode
          ? cat.dismissMyListNewEpisode(episodeKey, profileId)
          : err(elvError('storage', 'unsupported'));
      }),
    refreshMyListNewEpisodes: (profileId, opts) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.refreshMyListNewEpisodes
          ? cat.refreshMyListNewEpisodes(profileId, opts)
          : err(elvError('storage', 'unsupported'));
      }),
    getTrackPreference: async (scopeKey, profileId) =>
      (await open()).getTrackPreference?.(scopeKey, profileId) ?? null,
    saveTrackPreference: async (input) => {
      await (await open()).saveTrackPreference?.(input);
    },
    clearTrackPreference: async (scopeKey, profileId) => {
      await (await open()).clearTrackPreference?.(scopeKey, profileId);
    },
    recordRecentChannel: async (itemKey, sourceId, profileId) => {
      await (await open()).recordRecentChannel?.(itemKey, sourceId, profileId);
    },
    listRecentChannels: async (limit, profileId, opts) =>
      (await open()).listRecentChannels?.(limit, profileId, opts) ?? [],
    listProfiles: async () => (await open()).listProfiles?.() ?? [],
    createProfile: (input) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.createProfile
          ? cat.createProfile(input)
          : err(elvError('storage', 'unsupported'));
      }),
    updateProfile: (id, patch) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.updateProfile
          ? cat.updateProfile(id, patch)
          : err(elvError('storage', 'unsupported'));
      }),
    deleteProfile: (id) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.deleteProfile ? cat.deleteProfile(id) : err(elvError('storage', 'unsupported'));
      }),
    getParentalSettings: async (profileId) => {
      const cat = await open();
      if (cat.getParentalSettings) return cat.getParentalSettings(profileId);
      return {
        profileId: profileId ?? 'default',
        enabled: false,
        blockAdultKeywords: true,
        maxRatingAge: null,
        unlockTimeoutMin: 30,
        updatedAt: 0,
      };
    },
    updateParentalSettings: (patch, profileId) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.updateParentalSettings
          ? cat.updateParentalSettings(patch, profileId)
          : err(elvError('storage', 'unsupported'));
      }),
    listParentalLocks: async (profileId, filter) =>
      (await open()).listParentalLocks?.(profileId, filter) ?? [],
    setParentalLock: (input, locked) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.setParentalLock
          ? cat.setParentalLock(input, locked)
          : err(elvError('storage', 'unsupported'));
      }),
    hasParentalPin: async (profileId) => (await open()).hasParentalPin?.(profileId) ?? false,
    setParentalPin: (pin, profileId, currentPin) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.setParentalPin
          ? cat.setParentalPin(pin, profileId, currentPin)
          : err(elvError('storage', 'unsupported'));
      }),
    verifyParentalPin: async (pin, profileId) =>
      (await open()).verifyParentalPin?.(pin, profileId) ?? {
        ok: false,
        remainingAttempts: 0,
      },
    clearParentalPin: (currentPin, profileId) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.clearParentalPin
          ? cat.clearParentalPin(currentPin, profileId)
          : err(elvError('storage', 'unsupported'));
      }),
    listChannelOverrides: async (profileId) =>
      (await open()).listChannelOverrides?.(profileId) ?? [],
    setChannelOverride: (input) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.setChannelOverride
          ? cat.setChannelOverride(input)
          : err(elvError('storage', 'unsupported'));
      }),
    clearChannelOverride: (itemKey, profileId) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.clearChannelOverride
          ? cat.clearChannelOverride(itemKey, profileId)
          : err(elvError('storage', 'unsupported'));
      }),
    reorderChannels: (itemKeys, sourceId, profileId) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.reorderChannels
          ? cat.reorderChannels(itemKeys, sourceId, profileId)
          : err(elvError('storage', 'unsupported'));
      }),
    listCustomGroups: async (profileId, opts) =>
      (await open()).listCustomGroups?.(profileId, opts) ?? [],
    createCustomGroup: (input) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.createCustomGroup
          ? cat.createCustomGroup(input)
          : err(elvError('storage', 'unsupported'));
      }),
    updateCustomGroup: (groupId, patch) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.updateCustomGroup
          ? cat.updateCustomGroup(groupId, patch)
          : err(elvError('storage', 'unsupported'));
      }),
    deleteCustomGroup: (groupId) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.deleteCustomGroup
          ? cat.deleteCustomGroup(groupId)
          : err(elvError('storage', 'unsupported'));
      }),
    setCustomGroupItems: (groupId, items) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.setCustomGroupItems
          ? cat.setCustomGroupItems(groupId, items)
          : err(elvError('storage', 'unsupported'));
      }),
    addChannelToCustomGroup: (groupId, itemKey, sourceId) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.addChannelToCustomGroup
          ? cat.addChannelToCustomGroup(groupId, itemKey, sourceId)
          : err(elvError('storage', 'unsupported'));
      }),
    removeChannelFromCustomGroup: (groupId, itemKey) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.removeChannelFromCustomGroup
          ? cat.removeChannelFromCustomGroup(groupId, itemKey)
          : err(elvError('storage', 'unsupported'));
      }),
    getVodEnrichment: async (itemKey, nowMs) =>
      (await open()).getVodEnrichment?.(itemKey, nowMs) ?? null,
    enrichVodItem: async (itemKey, opts) => (await open()).enrichVodItem?.(itemKey, opts) ?? null,
    getElvEnrichmentForKeys: async (itemKeys) =>
      (await open()).getElvEnrichmentForKeys?.(itemKeys) ?? new Map(),
    getElvTitleDetail: async (imdbId, opts) =>
      (await open()).getElvTitleDetail?.(imdbId, opts) ?? null,
    listMergedVodVersions: async (itemKey, opts) =>
      (await open()).listMergedVodVersions?.(itemKey, opts) ?? [],
    enrichElvPriorityKeys: async (itemKeys, opts) =>
      (await open()).enrichElvPriorityKeys?.(itemKeys, opts) ?? {
        scanned: 0,
        layer1Matched: 0,
        remoteMatched: 0,
        skipped: 0,
        aborted: false,
      },
    runElvBackgroundMatching: async (opts) =>
      (await open()).runElvBackgroundMatching?.(opts) ?? {
        scanned: 0,
        layer1Matched: 0,
        remoteMatched: 0,
        skipped: 0,
        aborted: false,
      },
    recordPlaybackQuality: async (input) => (await open()).recordPlaybackQuality?.(input) ?? null,
    recordPlaybackVariantFailure: async (itemKey) =>
      (await open()).recordPlaybackVariantFailure?.(itemKey) ?? null,
    setElvManualMatch: async (itemKey, sourceId, mediaType, imdbId) => {
      await (await open()).setElvManualMatch?.(itemKey, sourceId, mediaType, imdbId);
    },
    wipeElvEnrichment: async () => {
      await (await open()).wipeElvEnrichment?.();
    },
    searchElvItemKeysByAlias: async (query, opts) =>
      (await open()).searchElvItemKeysByAlias?.(query, opts) ?? [],
    listElvImdbGenres: async (kind, opts) => (await open()).listElvImdbGenres?.(kind, opts) ?? [],
    listElvItemsByImdbGenre: async (kind, genre, opts) =>
      (await open()).listElvItemsByImdbGenre?.(kind, genre, opts) ?? [],
    getElvRecommendations: async (opts) => (await open()).getElvRecommendations?.(opts) ?? [],
    refreshElvFeeds: async (opts) => (await open()).refreshElvFeeds?.(opts) ?? false,
    listElvFranchiseItems: async (imdbId, opts) =>
      (await open()).listElvFranchiseItems?.(imdbId, opts) ?? [],
    listElvPersonLibraryItems: async (person, opts) =>
      (await open()).listElvPersonLibraryItems?.(person, opts) ?? [],
    searchElvMatchCandidates: async (query, mediaType, opts) =>
      (await open()).searchElvMatchCandidates?.(query, mediaType, opts) ?? [],
    applyElvFixMatch: async (input) => (await open()).applyElvFixMatch?.(input) ?? null,
    listLiveVariants: async (itemKey, categoryId, opts) =>
      (await open()).listLiveVariants?.(itemKey, categoryId, opts) ?? [],
    findGuideChannelByCleanName: async (sourceId, channelName, opts) =>
      (await open()).findGuideChannelByCleanName?.(sourceId, channelName, opts) ?? null,
    listCollections: async (profileId, opts) =>
      (await open()).listCollections?.(profileId, opts) ?? [],
    createCollection: (input) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.createCollection
          ? cat.createCollection(input)
          : err(elvError('storage', 'unsupported'));
      }),
    renameCollection: (id, name, profileId) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.renameCollection
          ? cat.renameCollection(id, name, profileId)
          : err(elvError('storage', 'unsupported'));
      }),
    reorderCollections: (orderedIds, profileId) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.reorderCollections
          ? cat.reorderCollections(orderedIds, profileId)
          : err(elvError('storage', 'unsupported'));
      }),
    deleteCollection: (id, profileId) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.deleteCollection
          ? cat.deleteCollection(id, profileId)
          : err(elvError('storage', 'unsupported'));
      }),
    listCollectionItems: async (collectionId, opts) =>
      (await open()).listCollectionItems?.(collectionId, opts) ?? [],
    listCollectionsForItem: async (itemKey, profileId) =>
      (await open()).listCollectionsForItem?.(itemKey, profileId) ?? [],
    addItemToCollection: (collectionId, itemKey, kind, profileId) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.addItemToCollection
          ? cat.addItemToCollection(collectionId, itemKey, kind, profileId)
          : err(elvError('storage', 'unsupported'));
      }),
    removeItemFromCollection: (collectionId, itemKey, profileId) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.removeItemFromCollection
          ? cat.removeItemFromCollection(collectionId, itemKey, profileId)
          : err(elvError('storage', 'unsupported'));
      }),
    reorderCollectionItems: (collectionId, orderedItemKeys, profileId) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.reorderCollectionItems
          ? cat.reorderCollectionItems(collectionId, orderedItemKeys, profileId)
          : err(elvError('storage', 'unsupported'));
      }),
    listDownloads: async (opts) => (await open()).listDownloads?.(opts) ?? [],
    getDownload: async (itemKey, profileId) =>
      (await open()).getDownload?.(itemKey, profileId) ?? null,
    upsertDownload: (input) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.upsertDownload
          ? cat.upsertDownload(input)
          : err(elvError('storage', 'unsupported'));
      }),
    deleteDownload: (itemKey, profileId) =>
      wrapResult(async () => {
        const cat = await open();
        return cat.deleteDownload
          ? cat.deleteDownload(itemKey, profileId)
          : err(elvError('storage', 'unsupported'));
      }),
    flushPendingWrites: async () => {
      if (cached === undefined) return;
      const cat = await cached.catch(() => undefined);
      await cat?.flushPendingWrites?.();
    },
    close: async () => {
      const current = cached;
      cached = undefined;
      if (current === undefined) return;
      const cat = await current.catch(() => undefined);
      await cat?.close();
    },
  };
}
