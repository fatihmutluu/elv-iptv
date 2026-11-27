import type { CatalogService } from '@elv/data';
import type { PlaybackGuard } from './ports/playback-guard';

/** Wraps `catalog` so source mutations stop playback and trigger shell source reconciliation. */
export function createObservedCatalog(
  catalog: CatalogService,
  playbackGuard: PlaybackGuard,
  syncSourcesAndBump: () => Promise<void>,
  onUserStateMutated?: () => void,
  getActiveProfileId?: () => string,
): CatalogService {
  const c = catalog;
  const wrapUserStateMutation = <Args extends unknown[], R extends { readonly ok: boolean }>(
    fn: ((...args: Args) => Promise<R>) | undefined,
  ): ((...args: Args) => Promise<R>) | undefined => {
    if (fn === undefined) return undefined;
    return async (...args: Args) => {
      const res = await fn.apply(c, args);
      if (res.ok) onUserStateMutated?.();
      return res;
    };
  };
  const wrapSourceResultMutation = <Args extends unknown[], R extends { readonly ok: boolean }>(
    fn: ((...args: Args) => Promise<R>) | undefined,
  ): ((...args: Args) => Promise<R>) | undefined => {
    if (fn === undefined) return undefined;
    return async (...args: Args) => {
      const res = await fn.apply(c, args);
      if (res.ok) {
        await syncSourcesAndBump();
        onUserStateMutated?.();
      }
      return res;
    };
  };
  const renameSource = wrapSourceResultMutation(c.renameSource);
  const rawSetSourceExcludedProfiles = c.setSourceExcludedProfiles;
  const setSourceExcludedProfiles: CatalogService['setSourceExcludedProfiles'] =
    rawSetSourceExcludedProfiles === undefined
      ? undefined
      : async (sourceId, excludedProfileIds) => {
          const res = await rawSetSourceExcludedProfiles.call(c, sourceId, excludedProfileIds);
          if (res.ok) {
            const activeProfileId = getActiveProfileId?.();
            const effectiveExcluded = res.value.excludedProfileIds ?? excludedProfileIds;
            if (
              activeProfileId !== undefined &&
              activeProfileId !== '' &&
              effectiveExcluded.includes(activeProfileId)
            ) {
              await playbackGuard.stopIfUsingSource(sourceId);
            }
            await syncSourcesAndBump();
            onUserStateMutated?.();
          }
          return res;
        };
  const createCollection = wrapUserStateMutation(c.createCollection);
  const renameCollection = wrapUserStateMutation(c.renameCollection);
  const reorderCollections = wrapUserStateMutation(c.reorderCollections);
  const deleteCollection = wrapUserStateMutation(c.deleteCollection);
  const addItemToCollection = wrapUserStateMutation(c.addItemToCollection);
  const removeItemFromCollection = wrapUserStateMutation(c.removeItemFromCollection);
  const reorderCollectionItems = wrapUserStateMutation(c.reorderCollectionItems);
  return {
    addSource: async (input) => {
      const res = await c.addSource(input);
      if (res.ok) await syncSourcesAndBump();
      return res;
    },
    addSourceFromLink: async (input) => {
      const res = await c.addSourceFromLink(input);
      if (res.ok) await syncSourcesAndBump();
      return res;
    },
    ...(c.addLocalM3uSource
      ? {
          addLocalM3uSource: async (
            input: Parameters<NonNullable<CatalogService['addLocalM3uSource']>>[0],
          ) => {
            const fn = c.addLocalM3uSource;
            if (fn === undefined) throw new Error('addLocalM3uSource unavailable');
            const res = await fn.call(c, input);
            if (res.ok) await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.discoverSourceCategories
      ? { discoverSourceCategories: c.discoverSourceCategories.bind(c) }
      : {}),
    ...(c.updateSourceSettings
      ? {
          updateSourceSettings: async (
            sourceId: Parameters<NonNullable<CatalogService['updateSourceSettings']>>[0],
            patch: Parameters<NonNullable<CatalogService['updateSourceSettings']>>[1],
          ) => {
            const fn = c.updateSourceSettings;
            if (fn === undefined) return;
            await fn.call(c, sourceId, patch);
            await syncSourcesAndBump();
          },
        }
      : {}),
    ...(renameSource ? { renameSource } : {}),
    ...(setSourceExcludedProfiles ? { setSourceExcludedProfiles } : {}),
    removeSource: async (id) => {
      await playbackGuard.stopIfUsingSource(id);
      const res = await c.removeSource(id);
      if (res.ok) await syncSourcesAndBump();
      return res;
    },
    importSource: async (id, opts) => {
      const res = await c.importSource(id, opts);
      await syncSourcesAndBump();
      return res;
    },
    listSources: () => c.listSources(),
    categories: (sourceId, kind, opts) => c.categories(sourceId, kind, opts),
    items: (categoryId, offset, limit, opts) => c.items(categoryId, offset, limit, opts),
    ...(c.liveVariants ? { liveVariants: c.liveVariants.bind(c) } : {}),
    ...(c.listLiveVariants ? { listLiveVariants: c.listLiveVariants.bind(c) } : {}),
    ...(c.itemVersions ? { itemVersions: c.itemVersions.bind(c) } : {}),
    ...(c.listMergedVodVersions ? { listMergedVodVersions: c.listMergedVodVersions.bind(c) } : {}),
    ...(c.allSourcesItems ? { allSourcesItems: c.allSourcesItems.bind(c) } : {}),
    seasons: (seriesId, opts) => c.seasons(seriesId, opts),
    episodes: (seriesId, season, opts) => c.episodes(seriesId, season, opts),
    resolveStream: (itemKey, opts) => c.resolveStream(itemKey, opts),
    ...(c.resolveCatchupStream ? { resolveCatchupStream: c.resolveCatchupStream.bind(c) } : {}),
    ...(c.fetchChannelArchiveEpg
      ? { fetchChannelArchiveEpg: c.fetchChannelArchiveEpg.bind(c) }
      : {}),
    ...(c.listGuideSources ? { listGuideSources: c.listGuideSources.bind(c) } : {}),
    ...(c.addGuideSource
      ? {
          addGuideSource: async (
            input: Parameters<NonNullable<CatalogService['addGuideSource']>>[0],
          ) => {
            const fn = c.addGuideSource;
            if (fn === undefined) throw new Error('addGuideSource unavailable');
            const res = await fn.call(c, input);
            if (res.ok) await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.updateGuideSource
      ? {
          updateGuideSource: async (
            id: Parameters<NonNullable<CatalogService['updateGuideSource']>>[0],
            patch: Parameters<NonNullable<CatalogService['updateGuideSource']>>[1],
          ) => {
            const fn = c.updateGuideSource;
            if (fn === undefined) throw new Error('updateGuideSource unavailable');
            const res = await fn.call(c, id, patch);
            if (res.ok) await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.removeGuideSource
      ? {
          removeGuideSource: async (
            id: Parameters<NonNullable<CatalogService['removeGuideSource']>>[0],
          ) => {
            const fn = c.removeGuideSource;
            if (fn === undefined) throw new Error('removeGuideSource unavailable');
            const res = await fn.call(c, id);
            if (res.ok) await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.reorderGuideSources
      ? {
          reorderGuideSources: async (
            sourceId: Parameters<NonNullable<CatalogService['reorderGuideSources']>>[0],
            orderedIds: Parameters<NonNullable<CatalogService['reorderGuideSources']>>[1],
          ) => {
            const fn = c.reorderGuideSources;
            if (fn === undefined) throw new Error('reorderGuideSources unavailable');
            const res = await fn.call(c, sourceId, orderedIds);
            if (res.ok) await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.listGuideChannels ? { listGuideChannels: c.listGuideChannels.bind(c) } : {}),
    ...(c.listChannelGuideOverrides
      ? { listChannelGuideOverrides: c.listChannelGuideOverrides.bind(c) }
      : {}),
    ...(c.setChannelGuideOverride
      ? {
          setChannelGuideOverride: async (
            input: Parameters<NonNullable<CatalogService['setChannelGuideOverride']>>[0],
          ) => {
            const fn = c.setChannelGuideOverride;
            if (fn === undefined) throw new Error('setChannelGuideOverride unavailable');
            const res = await fn.call(c, input);
            if (res.ok) await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.clearChannelGuideOverride
      ? {
          clearChannelGuideOverride: async (
            sourceId: Parameters<NonNullable<CatalogService['clearChannelGuideOverride']>>[0],
            channelKey: Parameters<NonNullable<CatalogService['clearChannelGuideOverride']>>[1],
          ) => {
            const fn = c.clearChannelGuideOverride;
            if (fn === undefined) throw new Error('clearChannelGuideOverride unavailable');
            const res = await fn.call(c, sourceId, channelKey);
            if (res.ok) await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.listReminders ? { listReminders: c.listReminders.bind(c) } : {}),
    ...(c.upsertReminder ? { upsertReminder: c.upsertReminder.bind(c) } : {}),
    ...(c.removeReminder ? { removeReminder: c.removeReminder.bind(c) } : {}),
    ...(c.markReminderFired ? { markReminderFired: c.markReminderFired.bind(c) } : {}),
    ...(c.pruneExpiredReminders ? { pruneExpiredReminders: c.pruneExpiredReminders.bind(c) } : {}),
    ...(c.itemDetail ? { itemDetail: c.itemDetail.bind(c) } : {}),
    ...(c.saveProgress ? { saveProgress: c.saveProgress.bind(c) } : {}),
    ...(c.setWatched ? { setWatched: c.setWatched.bind(c) } : {}),
    ...(c.getProgress ? { getProgress: c.getProgress.bind(c) } : {}),
    ...(c.listContinueWatching ? { listContinueWatching: c.listContinueWatching.bind(c) } : {}),
    ...(c.listWatched ? { listWatched: c.listWatched.bind(c) } : {}),
    ...(c.listProgressByKeys ? { listProgressByKeys: c.listProgressByKeys.bind(c) } : {}),
    ...(c.listSeriesUnplayedCounts
      ? { listSeriesUnplayedCounts: c.listSeriesUnplayedCounts.bind(c) }
      : {}),
    ...(c.listMyListNewEpisodes ? { listMyListNewEpisodes: c.listMyListNewEpisodes.bind(c) } : {}),
    ...(c.dismissMyListNewEpisode
      ? { dismissMyListNewEpisode: c.dismissMyListNewEpisode.bind(c) }
      : {}),
    ...(c.refreshMyListNewEpisodes
      ? { refreshMyListNewEpisodes: c.refreshMyListNewEpisodes.bind(c) }
      : {}),
    ...(c.clearProgress ? { clearProgress: c.clearProgress.bind(c) } : {}),
    ...(c.toggleFavorite ? { toggleFavorite: c.toggleFavorite.bind(c) } : {}),
    ...(c.setFavorite ? { setFavorite: c.setFavorite.bind(c) } : {}),
    ...(c.reorderFavorites ? { reorderFavorites: c.reorderFavorites.bind(c) } : {}),
    ...(c.listFavorites ? { listFavorites: c.listFavorites.bind(c) } : {}),
    ...(c.listFavoriteKeys ? { listFavoriteKeys: c.listFavoriteKeys.bind(c) } : {}),
    ...(c.flushPendingWrites ? { flushPendingWrites: c.flushPendingWrites.bind(c) } : {}),
    ...(c.search ? { search: c.search.bind(c) } : {}),
    ...(c.searchSuggestions ? { searchSuggestions: c.searchSuggestions.bind(c) } : {}),
    ...(c.alphabetIndex ? { alphabetIndex: c.alphabetIndex.bind(c) } : {}),
    ...(c.epgSlice ? { epgSlice: c.epgSlice.bind(c) } : {}),
    ...(c.importGuide
      ? {
          importGuide: async (
            id: Parameters<NonNullable<CatalogService['importGuide']>>[0],
            opts?: Parameters<NonNullable<CatalogService['importGuide']>>[1],
          ) => {
            const fn = c.importGuide;
            if (fn === undefined) throw new Error('importGuide unavailable');
            const res = await fn.call(c, id, opts);
            await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.latestImportHealth ? { latestImportHealth: c.latestImportHealth.bind(c) } : {}),
    ...(c.nowNext ? { nowNext: c.nowNext.bind(c) } : {}),
    ...(c.epgWindow ? { epgWindow: c.epgWindow.bind(c) } : {}),
    ...(c.channelByNumber ? { channelByNumber: c.channelByNumber.bind(c) } : {}),
    ...(c.queryNextEpisode ? { queryNextEpisode: c.queryNextEpisode.bind(c) } : {}),
    ...(c.getTrackPreference ? { getTrackPreference: c.getTrackPreference.bind(c) } : {}),
    ...(c.saveTrackPreference ? { saveTrackPreference: c.saveTrackPreference.bind(c) } : {}),
    ...(c.clearTrackPreference ? { clearTrackPreference: c.clearTrackPreference.bind(c) } : {}),
    ...(c.recordRecentChannel ? { recordRecentChannel: c.recordRecentChannel.bind(c) } : {}),
    ...(c.listRecentChannels ? { listRecentChannels: c.listRecentChannels.bind(c) } : {}),
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
    ...(c.listChannelOverrides ? { listChannelOverrides: c.listChannelOverrides.bind(c) } : {}),
    ...(c.setChannelOverride
      ? {
          setChannelOverride: async (
            input: Parameters<NonNullable<CatalogService['setChannelOverride']>>[0],
          ) => {
            const fn = c.setChannelOverride;
            if (fn === undefined) throw new Error('setChannelOverride unavailable');
            const res = await fn.call(c, input);
            if (res.ok) await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.clearChannelOverride
      ? {
          clearChannelOverride: async (
            itemKey: Parameters<NonNullable<CatalogService['clearChannelOverride']>>[0],
            profileId?: Parameters<NonNullable<CatalogService['clearChannelOverride']>>[1],
          ) => {
            const fn = c.clearChannelOverride;
            if (fn === undefined) throw new Error('clearChannelOverride unavailable');
            const res = await fn.call(c, itemKey, profileId);
            if (res.ok) await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.reorderChannels
      ? {
          reorderChannels: async (
            itemKeys: Parameters<NonNullable<CatalogService['reorderChannels']>>[0],
            sourceId: Parameters<NonNullable<CatalogService['reorderChannels']>>[1],
            profileId?: Parameters<NonNullable<CatalogService['reorderChannels']>>[2],
          ) => {
            const fn = c.reorderChannels;
            if (fn === undefined) throw new Error('reorderChannels unavailable');
            const res = await fn.call(c, itemKeys, sourceId, profileId);
            if (res.ok) await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.listCustomGroups ? { listCustomGroups: c.listCustomGroups.bind(c) } : {}),
    ...(c.createCustomGroup
      ? {
          createCustomGroup: async (
            input: Parameters<NonNullable<CatalogService['createCustomGroup']>>[0],
          ) => {
            const fn = c.createCustomGroup;
            if (fn === undefined) throw new Error('createCustomGroup unavailable');
            const res = await fn.call(c, input);
            if (res.ok) await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.updateCustomGroup
      ? {
          updateCustomGroup: async (
            groupId: Parameters<NonNullable<CatalogService['updateCustomGroup']>>[0],
            patch: Parameters<NonNullable<CatalogService['updateCustomGroup']>>[1],
          ) => {
            const fn = c.updateCustomGroup;
            if (fn === undefined) throw new Error('updateCustomGroup unavailable');
            const res = await fn.call(c, groupId, patch);
            if (res.ok) await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.deleteCustomGroup
      ? {
          deleteCustomGroup: async (
            groupId: Parameters<NonNullable<CatalogService['deleteCustomGroup']>>[0],
          ) => {
            const fn = c.deleteCustomGroup;
            if (fn === undefined) throw new Error('deleteCustomGroup unavailable');
            const res = await fn.call(c, groupId);
            if (res.ok) await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.setCustomGroupItems
      ? {
          setCustomGroupItems: async (
            groupId: Parameters<NonNullable<CatalogService['setCustomGroupItems']>>[0],
            items: Parameters<NonNullable<CatalogService['setCustomGroupItems']>>[1],
          ) => {
            const fn = c.setCustomGroupItems;
            if (fn === undefined) throw new Error('setCustomGroupItems unavailable');
            const res = await fn.call(c, groupId, items);
            if (res.ok) await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.addChannelToCustomGroup
      ? {
          addChannelToCustomGroup: async (
            groupId: Parameters<NonNullable<CatalogService['addChannelToCustomGroup']>>[0],
            itemKey: Parameters<NonNullable<CatalogService['addChannelToCustomGroup']>>[1],
            sourceId: Parameters<NonNullable<CatalogService['addChannelToCustomGroup']>>[2],
          ) => {
            const fn = c.addChannelToCustomGroup;
            if (fn === undefined) throw new Error('addChannelToCustomGroup unavailable');
            const res = await fn.call(c, groupId, itemKey, sourceId);
            if (res.ok) await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.removeChannelFromCustomGroup
      ? {
          removeChannelFromCustomGroup: async (
            groupId: Parameters<NonNullable<CatalogService['removeChannelFromCustomGroup']>>[0],
            itemKey: Parameters<NonNullable<CatalogService['removeChannelFromCustomGroup']>>[1],
          ) => {
            const fn = c.removeChannelFromCustomGroup;
            if (fn === undefined) throw new Error('removeChannelFromCustomGroup unavailable');
            const res = await fn.call(c, groupId, itemKey);
            if (res.ok) await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.getVodEnrichment ? { getVodEnrichment: c.getVodEnrichment.bind(c) } : {}),
    ...(c.enrichVodItem ? { enrichVodItem: c.enrichVodItem.bind(c) } : {}),
    ...(c.getElvEnrichmentForKeys
      ? { getElvEnrichmentForKeys: c.getElvEnrichmentForKeys.bind(c) }
      : {}),
    ...(c.getElvTitleDetail ? { getElvTitleDetail: c.getElvTitleDetail.bind(c) } : {}),
    ...(c.enrichElvPriorityKeys ? { enrichElvPriorityKeys: c.enrichElvPriorityKeys.bind(c) } : {}),
    ...(c.runElvBackgroundMatching
      ? { runElvBackgroundMatching: c.runElvBackgroundMatching.bind(c) }
      : {}),
    ...(c.recordPlaybackQuality ? { recordPlaybackQuality: c.recordPlaybackQuality.bind(c) } : {}),
    ...(c.recordPlaybackVariantFailure
      ? { recordPlaybackVariantFailure: c.recordPlaybackVariantFailure.bind(c) }
      : {}),
    ...(c.setElvManualMatch ? { setElvManualMatch: c.setElvManualMatch.bind(c) } : {}),
    ...(c.wipeElvEnrichment ? { wipeElvEnrichment: c.wipeElvEnrichment.bind(c) } : {}),
    ...(c.searchElvItemKeysByAlias
      ? { searchElvItemKeysByAlias: c.searchElvItemKeysByAlias.bind(c) }
      : {}),
    ...(c.findGuideChannelByCleanName
      ? { findGuideChannelByCleanName: c.findGuideChannelByCleanName.bind(c) }
      : {}),
    ...(c.listCollections ? { listCollections: c.listCollections.bind(c) } : {}),
    ...(createCollection ? { createCollection } : {}),
    ...(renameCollection ? { renameCollection } : {}),
    ...(reorderCollections ? { reorderCollections } : {}),
    ...(deleteCollection ? { deleteCollection } : {}),
    ...(c.listCollectionItems ? { listCollectionItems: c.listCollectionItems.bind(c) } : {}),
    ...(c.listCollectionsForItem
      ? { listCollectionsForItem: c.listCollectionsForItem.bind(c) }
      : {}),
    ...(addItemToCollection ? { addItemToCollection } : {}),
    ...(removeItemFromCollection ? { removeItemFromCollection } : {}),
    ...(reorderCollectionItems ? { reorderCollectionItems } : {}),
    ...(c.listDownloads ? { listDownloads: c.listDownloads.bind(c) } : {}),
    ...(c.getDownload ? { getDownload: c.getDownload.bind(c) } : {}),
    ...(c.upsertDownload ? { upsertDownload: c.upsertDownload.bind(c) } : {}),
    ...(c.deleteDownload ? { deleteDownload: c.deleteDownload.bind(c) } : {}),
    ...(c.setRating ? { setRating: c.setRating.bind(c) } : {}),
    ...(c.getRating ? { getRating: c.getRating.bind(c) } : {}),
    ...(c.listRatings ? { listRatings: c.listRatings.bind(c) } : {}),
    ...(c.listRatingMap ? { listRatingMap: c.listRatingMap.bind(c) } : {}),
    close: () => c.close(),
  };
}
