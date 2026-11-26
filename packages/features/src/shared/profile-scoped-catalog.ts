import type { CatalogService, ParentalQueryOptions } from '@elv/data';

/** Dynamic active profile and parental-unlock context read at query time. */
export interface ProfileCatalogScope {
  readonly profileId: string;
  readonly parentalUnlocked: boolean;
}

function mergeParentalOpts<T extends ParentalQueryOptions | undefined>(
  opts: T,
  scope: ProfileCatalogScope,
): T extends undefined ? ParentalQueryOptions : T & ParentalQueryOptions {
  return {
    ...opts,
    profileId: opts?.profileId ?? scope.profileId,
    parentalUnlocked: opts?.parentalUnlocked ?? scope.parentalUnlocked,
  } as T extends undefined ? ParentalQueryOptions : T & ParentalQueryOptions;
}

/**
 * Wraps a {@link CatalogService} so every catalog read, stream resolution, and user-state
 * read/write automatically inherits the active profile ID and temporary parental-unlock state
 * unless explicitly overridden by the caller (e.g. Settings category lock listing).
 */
export function createProfileScopedCatalog(
  catalog: CatalogService,
  getScope: () => ProfileCatalogScope,
): CatalogService {
  const c = catalog;
  const liveVariants = c.liveVariants?.bind(c);
  const itemVersions = c.itemVersions?.bind(c);
  const allSourcesItems = c.allSourcesItems?.bind(c);
  const itemDetail = c.itemDetail?.bind(c);
  const search = c.search?.bind(c);
  const searchSuggestions = c.searchSuggestions?.bind(c);
  const alphabetIndex = c.alphabetIndex?.bind(c);
  const nowNext = c.nowNext?.bind(c);
  const epgWindow = c.epgWindow?.bind(c);
  const epgSlice = c.epgSlice?.bind(c);
  const channelByNumber = c.channelByNumber?.bind(c);
  const queryNextEpisode = c.queryNextEpisode?.bind(c);
  const saveProgress = c.saveProgress?.bind(c);
  const setWatched = c.setWatched?.bind(c);
  const getProgress = c.getProgress?.bind(c);
  const listContinueWatching = c.listContinueWatching?.bind(c);
  const listWatched = c.listWatched?.bind(c);
  const listProgressByKeys = c.listProgressByKeys?.bind(c);
  const listSeriesUnplayedCounts = c.listSeriesUnplayedCounts?.bind(c);
  const clearProgress = c.clearProgress?.bind(c);
  const toggleFavorite = c.toggleFavorite?.bind(c);
  const setFavorite = c.setFavorite?.bind(c);
  const reorderFavorites = c.reorderFavorites?.bind(c);
  const listFavorites = c.listFavorites?.bind(c);
  const listFavoriteKeys = c.listFavoriteKeys?.bind(c);
  const getTrackPreference = c.getTrackPreference?.bind(c);
  const saveTrackPreference = c.saveTrackPreference?.bind(c);
  const clearTrackPreference = c.clearTrackPreference?.bind(c);
  const recordRecentChannel = c.recordRecentChannel?.bind(c);
  const listRecentChannels = c.listRecentChannels?.bind(c);
  const listChannelOverrides = c.listChannelOverrides?.bind(c);
  const setChannelOverride = c.setChannelOverride?.bind(c);
  const clearChannelOverride = c.clearChannelOverride?.bind(c);
  const reorderChannels = c.reorderChannels?.bind(c);
  const listCustomGroups = c.listCustomGroups?.bind(c);
  const createCustomGroup = c.createCustomGroup?.bind(c);
  const resolveCatchupStream = c.resolveCatchupStream?.bind(c);
  const fetchChannelArchiveEpg = c.fetchChannelArchiveEpg?.bind(c);
  const listReminders = c.listReminders?.bind(c);
  const upsertReminder = c.upsertReminder?.bind(c);
  const removeReminder = c.removeReminder?.bind(c);
  const markReminderFired = c.markReminderFired?.bind(c);
  const listCollections = c.listCollections?.bind(c);
  const createCollection = c.createCollection?.bind(c);
  const renameCollection = c.renameCollection?.bind(c);
  const reorderCollections = c.reorderCollections?.bind(c);
  const deleteCollection = c.deleteCollection?.bind(c);
  const listCollectionItems = c.listCollectionItems?.bind(c);
  const listCollectionsForItem = c.listCollectionsForItem?.bind(c);
  const addItemToCollection = c.addItemToCollection?.bind(c);
  const removeItemFromCollection = c.removeItemFromCollection?.bind(c);
  const reorderCollectionItems = c.reorderCollectionItems?.bind(c);
  const listDownloads = c.listDownloads?.bind(c);
  const getDownload = c.getDownload?.bind(c);
  const upsertDownload = c.upsertDownload?.bind(c);
  const deleteDownload = c.deleteDownload?.bind(c);

  return {
    addSource: (input) => c.addSource(input),
    addSourceFromLink: (input) => c.addSourceFromLink(input),
    ...(c.addLocalM3uSource ? { addLocalM3uSource: c.addLocalM3uSource.bind(c) } : {}),
    ...(c.discoverSourceCategories
      ? { discoverSourceCategories: c.discoverSourceCategories.bind(c) }
      : {}),
    ...(c.updateSourceSettings ? { updateSourceSettings: c.updateSourceSettings.bind(c) } : {}),
    removeSource: (id) => c.removeSource(id),
    importSource: (id, opts) => c.importSource(id, opts),
    ...(c.importGuide ? { importGuide: c.importGuide.bind(c) } : {}),
    listSources: () => c.listSources(),
    ...(c.latestImportHealth ? { latestImportHealth: c.latestImportHealth.bind(c) } : {}),
    categories: (sourceId, kind, opts) =>
      c.categories(sourceId, kind, mergeParentalOpts(opts, getScope())),
    items: (categoryId, offset, limit, opts) =>
      c.items(categoryId, offset, limit, mergeParentalOpts(opts, getScope())),
    ...(liveVariants
      ? {
          liveVariants: (itemKey, categoryId, opts) =>
            liveVariants(itemKey, categoryId, mergeParentalOpts(opts, getScope())),
        }
      : {}),
    ...(itemVersions
      ? {
          itemVersions: (itemKey, opts) =>
            itemVersions(itemKey, mergeParentalOpts(opts, getScope())),
        }
      : {}),
    ...(allSourcesItems
      ? {
          allSourcesItems: (kind, offset, limit, sourceIds, opts) =>
            allSourcesItems(kind, offset, limit, sourceIds, mergeParentalOpts(opts, getScope())),
        }
      : {}),
    ...(itemDetail
      ? {
          itemDetail: (itemKey, opts) => itemDetail(itemKey, mergeParentalOpts(opts, getScope())),
        }
      : {}),
    ...(search
      ? {
          search: (query, opts) => search(query, mergeParentalOpts(opts, getScope())),
        }
      : {}),
    ...(searchSuggestions
      ? {
          searchSuggestions: (options) => searchSuggestions(mergeParentalOpts(options, getScope())),
        }
      : {}),
    ...(alphabetIndex
      ? {
          alphabetIndex: (input) => alphabetIndex(mergeParentalOpts(input, getScope())),
        }
      : {}),
    ...(nowNext
      ? {
          nowNext: (channelKeys, nowMs, opts) =>
            nowNext(channelKeys, nowMs, mergeParentalOpts(opts, getScope())),
        }
      : {}),
    ...(epgWindow
      ? {
          epgWindow: (channelKeys, fromMs, toMs, opts) =>
            epgWindow(channelKeys, fromMs, toMs, mergeParentalOpts(opts, getScope())),
        }
      : {}),
    ...(epgSlice
      ? {
          epgSlice: (sourceId, fromMs, toMs, limit, opts) =>
            epgSlice(sourceId, fromMs, toMs, limit, mergeParentalOpts(opts, getScope())),
        }
      : {}),
    ...(channelByNumber
      ? {
          channelByNumber: (num, sourceId, opts) =>
            channelByNumber(num, sourceId, mergeParentalOpts(opts, getScope())),
        }
      : {}),
    seasons: (seriesId, opts) => c.seasons(seriesId, mergeParentalOpts(opts, getScope())),
    episodes: (seriesId, season, opts) =>
      c.episodes(seriesId, season, mergeParentalOpts(opts, getScope())),
    ...(queryNextEpisode
      ? {
          queryNextEpisode: (seriesKey, currentItemKey, profileId, opts) => {
            const scope = getScope();
            return queryNextEpisode(seriesKey, currentItemKey, profileId ?? scope.profileId, {
              ...opts,
              parentalUnlocked: opts?.parentalUnlocked ?? scope.parentalUnlocked,
            });
          },
        }
      : {}),
    resolveStream: (itemKey, opts) => c.resolveStream(itemKey, mergeParentalOpts(opts, getScope())),
    ...(resolveCatchupStream
      ? {
          resolveCatchupStream: (itemKey, programme, opts) =>
            resolveCatchupStream(itemKey, programme, mergeParentalOpts(opts, getScope())),
        }
      : {}),
    ...(fetchChannelArchiveEpg
      ? {
          fetchChannelArchiveEpg: (itemKey, opts) =>
            fetchChannelArchiveEpg(itemKey, mergeParentalOpts(opts, getScope())),
        }
      : {}),
    ...(c.listGuideSources ? { listGuideSources: c.listGuideSources.bind(c) } : {}),
    ...(c.addGuideSource ? { addGuideSource: c.addGuideSource.bind(c) } : {}),
    ...(c.updateGuideSource ? { updateGuideSource: c.updateGuideSource.bind(c) } : {}),
    ...(c.removeGuideSource ? { removeGuideSource: c.removeGuideSource.bind(c) } : {}),
    ...(c.reorderGuideSources ? { reorderGuideSources: c.reorderGuideSources.bind(c) } : {}),
    ...(c.listGuideChannels ? { listGuideChannels: c.listGuideChannels.bind(c) } : {}),
    ...(c.listChannelGuideOverrides
      ? { listChannelGuideOverrides: c.listChannelGuideOverrides.bind(c) }
      : {}),
    ...(c.setChannelGuideOverride
      ? { setChannelGuideOverride: c.setChannelGuideOverride.bind(c) }
      : {}),
    ...(c.clearChannelGuideOverride
      ? { clearChannelGuideOverride: c.clearChannelGuideOverride.bind(c) }
      : {}),
    ...(listReminders
      ? {
          listReminders: (profileId, opts) => {
            const scope = getScope();
            return listReminders(profileId ?? scope.profileId, {
              ...opts,
              parentalUnlocked: opts?.parentalUnlocked ?? scope.parentalUnlocked,
            });
          },
        }
      : {}),
    ...(upsertReminder
      ? {
          upsertReminder: (input) => {
            const scope = getScope();
            return upsertReminder({
              ...input,
              profileId: input.profileId ?? scope.profileId,
              parentalUnlocked: input.parentalUnlocked ?? scope.parentalUnlocked,
            });
          },
        }
      : {}),
    ...(removeReminder
      ? {
          removeReminder: (channelKey, programmeStart, profileId) =>
            removeReminder(channelKey, programmeStart, profileId ?? getScope().profileId),
        }
      : {}),
    ...(markReminderFired
      ? {
          markReminderFired: (channelKey, programmeStart, profileId) =>
            markReminderFired(channelKey, programmeStart, profileId ?? getScope().profileId),
        }
      : {}),
    ...(c.pruneExpiredReminders ? { pruneExpiredReminders: c.pruneExpiredReminders.bind(c) } : {}),
    ...(saveProgress
      ? {
          saveProgress: (input) =>
            saveProgress({
              ...input,
              profileId: input.profileId ?? getScope().profileId,
            }),
        }
      : {}),
    ...(setWatched
      ? {
          setWatched: (itemKey, watched, profileId) =>
            setWatched(itemKey, watched, profileId ?? getScope().profileId),
        }
      : {}),
    ...(getProgress
      ? {
          getProgress: (itemKey, profileId) =>
            getProgress(itemKey, profileId ?? getScope().profileId),
        }
      : {}),
    ...(listContinueWatching
      ? {
          listContinueWatching: (limit, profileId, opts) => {
            const scope = getScope();
            return listContinueWatching(limit, profileId ?? scope.profileId, {
              ...opts,
              parentalUnlocked: opts?.parentalUnlocked ?? scope.parentalUnlocked,
            });
          },
        }
      : {}),
    ...(listWatched
      ? {
          listWatched: (limit, profileId, opts) => {
            const scope = getScope();
            return listWatched(limit, profileId ?? scope.profileId, {
              ...opts,
              parentalUnlocked: opts?.parentalUnlocked ?? scope.parentalUnlocked,
            });
          },
        }
      : {}),
    ...(listProgressByKeys
      ? {
          listProgressByKeys: (itemKeys, profileId) =>
            listProgressByKeys(itemKeys, profileId ?? getScope().profileId),
        }
      : {}),
    ...(listSeriesUnplayedCounts
      ? {
          listSeriesUnplayedCounts: (seriesKeys, profileId) =>
            listSeriesUnplayedCounts(seriesKeys, profileId ?? getScope().profileId),
        }
      : {}),
    ...(clearProgress
      ? {
          clearProgress: (itemKey, profileId) =>
            clearProgress(itemKey, profileId ?? getScope().profileId),
        }
      : {}),
    ...(toggleFavorite
      ? {
          toggleFavorite: (input) =>
            toggleFavorite({
              ...input,
              profileId: input.profileId ?? getScope().profileId,
            }),
        }
      : {}),
    ...(setFavorite
      ? {
          setFavorite: (input, active) =>
            setFavorite(
              {
                ...input,
                profileId: input.profileId ?? getScope().profileId,
              },
              active,
            ),
        }
      : {}),
    ...(reorderFavorites
      ? {
          reorderFavorites: (orderedItemKeys, profileId) =>
            reorderFavorites(orderedItemKeys, profileId ?? getScope().profileId),
        }
      : {}),
    ...(listFavorites
      ? {
          listFavorites: (limit, profileId, opts) => {
            const scope = getScope();
            return listFavorites(limit, profileId ?? scope.profileId, {
              ...opts,
              parentalUnlocked: opts?.parentalUnlocked ?? scope.parentalUnlocked,
            });
          },
        }
      : {}),
    ...(listFavoriteKeys
      ? {
          listFavoriteKeys: (profileId) => listFavoriteKeys(profileId ?? getScope().profileId),
        }
      : {}),
    ...(getTrackPreference
      ? {
          getTrackPreference: (scopeKey, profileId) =>
            getTrackPreference(scopeKey, profileId ?? getScope().profileId),
        }
      : {}),
    ...(saveTrackPreference
      ? {
          saveTrackPreference: (input) =>
            saveTrackPreference({
              ...input,
              profileId: input.profileId ?? getScope().profileId,
            }),
        }
      : {}),
    ...(clearTrackPreference
      ? {
          clearTrackPreference: (scopeKey, profileId) =>
            clearTrackPreference(scopeKey, profileId ?? getScope().profileId),
        }
      : {}),
    ...(recordRecentChannel
      ? {
          recordRecentChannel: (itemKey, sourceId, profileId) =>
            recordRecentChannel(itemKey, sourceId, profileId ?? getScope().profileId),
        }
      : {}),
    ...(listRecentChannels
      ? {
          listRecentChannels: (limit, profileId, opts) => {
            const scope = getScope();
            return listRecentChannels(limit, profileId ?? scope.profileId, {
              ...opts,
              parentalUnlocked: opts?.parentalUnlocked ?? scope.parentalUnlocked,
            });
          },
        }
      : {}),
    ...(c.listProfiles ? { listProfiles: c.listProfiles.bind(c) } : {}),
    ...(c.createProfile ? { createProfile: c.createProfile.bind(c) } : {}),
    ...(c.updateProfile ? { updateProfile: c.updateProfile.bind(c) } : {}),
    ...(c.deleteProfile ? { deleteProfile: c.deleteProfile.bind(c) } : {}),
    ...(c.getParentalSettings ? { getParentalSettings: c.getParentalSettings.bind(c) } : {}),
    ...(c.updateParentalSettings
      ? { updateParentalSettings: c.updateParentalSettings.bind(c) }
      : {}),
    ...(c.listParentalLocks ? { listParentalLocks: c.listParentalLocks.bind(c) } : {}),
    ...(c.setParentalLock ? { setParentalLock: c.setParentalLock.bind(c) } : {}),
    ...(c.hasParentalPin ? { hasParentalPin: c.hasParentalPin.bind(c) } : {}),
    ...(c.setParentalPin ? { setParentalPin: c.setParentalPin.bind(c) } : {}),
    ...(c.verifyParentalPin ? { verifyParentalPin: c.verifyParentalPin.bind(c) } : {}),
    ...(c.clearParentalPin ? { clearParentalPin: c.clearParentalPin.bind(c) } : {}),
    ...(listChannelOverrides
      ? {
          listChannelOverrides: (profileId) =>
            listChannelOverrides(profileId ?? getScope().profileId),
        }
      : {}),
    ...(setChannelOverride
      ? {
          setChannelOverride: (input) =>
            setChannelOverride({
              ...input,
              profileId: input.profileId ?? getScope().profileId,
            }),
        }
      : {}),
    ...(clearChannelOverride
      ? {
          clearChannelOverride: (itemKey, profileId) =>
            clearChannelOverride(itemKey, profileId ?? getScope().profileId),
        }
      : {}),
    ...(reorderChannels
      ? {
          reorderChannels: (itemKeys, sourceId, profileId) =>
            reorderChannels(itemKeys, sourceId, profileId ?? getScope().profileId),
        }
      : {}),
    ...(listCustomGroups
      ? {
          listCustomGroups: (profileId, opts) => {
            const scope = getScope();
            return listCustomGroups(profileId ?? scope.profileId, {
              ...opts,
              parentalUnlocked: opts?.parentalUnlocked ?? scope.parentalUnlocked,
            });
          },
        }
      : {}),
    ...(createCustomGroup
      ? {
          createCustomGroup: (input) =>
            createCustomGroup({
              ...input,
              profileId: input.profileId ?? getScope().profileId,
            }),
        }
      : {}),
    ...(c.updateCustomGroup ? { updateCustomGroup: c.updateCustomGroup.bind(c) } : {}),
    ...(c.deleteCustomGroup ? { deleteCustomGroup: c.deleteCustomGroup.bind(c) } : {}),
    ...(c.setCustomGroupItems ? { setCustomGroupItems: c.setCustomGroupItems.bind(c) } : {}),
    ...(c.addChannelToCustomGroup
      ? { addChannelToCustomGroup: c.addChannelToCustomGroup.bind(c) }
      : {}),
    ...(c.removeChannelFromCustomGroup
      ? { removeChannelFromCustomGroup: c.removeChannelFromCustomGroup.bind(c) }
      : {}),
    ...(c.getVodEnrichment ? { getVodEnrichment: c.getVodEnrichment.bind(c) } : {}),
    ...(c.enrichVodItem ? { enrichVodItem: c.enrichVodItem.bind(c) } : {}),
    ...(listCollections
      ? {
          listCollections: (profileId, opts) => {
            const scope = getScope();
            return listCollections(profileId ?? scope.profileId, {
              ...opts,
              parentalUnlocked: opts?.parentalUnlocked ?? scope.parentalUnlocked,
            });
          },
        }
      : {}),
    ...(createCollection
      ? {
          createCollection: (input) =>
            createCollection({
              ...input,
              profileId: input.profileId ?? getScope().profileId,
            }),
        }
      : {}),
    ...(renameCollection
      ? {
          renameCollection: (id, name, profileId) =>
            renameCollection(id, name, profileId ?? getScope().profileId),
        }
      : {}),
    ...(reorderCollections
      ? {
          reorderCollections: (orderedIds, profileId) =>
            reorderCollections(orderedIds, profileId ?? getScope().profileId),
        }
      : {}),
    ...(deleteCollection
      ? {
          deleteCollection: (id, profileId) =>
            deleteCollection(id, profileId ?? getScope().profileId),
        }
      : {}),
    ...(listCollectionItems
      ? {
          listCollectionItems: (collectionId, opts) =>
            listCollectionItems(collectionId, mergeParentalOpts(opts, getScope())),
        }
      : {}),
    ...(listCollectionsForItem
      ? {
          listCollectionsForItem: (itemKey, profileId) =>
            listCollectionsForItem(itemKey, profileId ?? getScope().profileId),
        }
      : {}),
    ...(addItemToCollection
      ? {
          addItemToCollection: (collectionId, itemKey, kind, profileId) =>
            addItemToCollection(collectionId, itemKey, kind, profileId ?? getScope().profileId),
        }
      : {}),
    ...(removeItemFromCollection
      ? {
          removeItemFromCollection: (collectionId, itemKey, profileId) =>
            removeItemFromCollection(collectionId, itemKey, profileId ?? getScope().profileId),
        }
      : {}),
    ...(reorderCollectionItems
      ? {
          reorderCollectionItems: (collectionId, orderedItemKeys, profileId) =>
            reorderCollectionItems(
              collectionId,
              orderedItemKeys,
              profileId ?? getScope().profileId,
            ),
        }
      : {}),
    ...(listDownloads
      ? {
          listDownloads: (opts) =>
            listDownloads({
              ...opts,
              profileId: opts?.profileId ?? getScope().profileId,
            }),
        }
      : {}),
    ...(getDownload
      ? {
          getDownload: (itemKey, profileId) =>
            getDownload(itemKey, profileId ?? getScope().profileId),
        }
      : {}),
    ...(upsertDownload
      ? {
          upsertDownload: (input) =>
            upsertDownload({
              ...input,
              profileId: input.profileId ?? getScope().profileId,
            }),
        }
      : {}),
    ...(deleteDownload
      ? {
          deleteDownload: (itemKey, profileId) =>
            deleteDownload(itemKey, profileId ?? getScope().profileId),
        }
      : {}),
    ...(c.flushPendingWrites ? { flushPendingWrites: c.flushPendingWrites.bind(c) } : {}),
    close: () => c.close(),
  };
}
