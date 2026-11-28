import type { CatalogService } from '@elv/data';
import { createProfileScopedElvMethods } from './profile-scoped-elv-methods';
import {
  createProfileScopedBrowseMethods,
  filterByItemKey,
  filterBySourceId,
  filterSourcesForProfile,
  isKeyFromExcludedSource,
  mergeParentalOpts,
  type ProfileCatalogScope,
  resolveExcludedSourceIds,
} from './profile-scoped-source-filter';

export { filterSourcesForProfile, type ProfileCatalogScope };

const OVERFETCH_MIN_LIMIT = 200;

function resolveExcludedFetchLimit(limit: number | undefined): number {
  if (limit === undefined) return OVERFETCH_MIN_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.max(Math.floor(limit) * 4, OVERFETCH_MIN_LIMIT);
}

function filterAndSliceBySourceId<T extends { readonly sourceId: string }>(
  rows: readonly T[],
  excluded: ReadonlySet<string>,
  limit: number | undefined,
): T[] {
  const filtered = filterBySourceId(rows, excluded);
  if (limit === undefined) return filtered;
  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  return filtered.slice(0, safeLimit);
}

/**
 * Wraps a {@link CatalogService} so every catalog read, stream resolution, and user-state
 * read/write automatically inherits the active profile ID, temporary parental-unlock state,
 * per-profile source exclusions, and strict fail-closed withholding on `parentalLoadError`.
 */
export function createProfileScopedCatalog(
  catalog: CatalogService,
  getScope: () => ProfileCatalogScope,
): CatalogService {
  const c = catalog;
  const saveProgress = c.saveProgress?.bind(c);
  const setWatched = c.setWatched?.bind(c);
  const setSeasonWatched = c.setSeasonWatched?.bind(c);
  const setSeriesWatched = c.setSeriesWatched?.bind(c);
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
  const listMyListNewEpisodes = c.listMyListNewEpisodes?.bind(c);
  const dismissMyListNewEpisode = c.dismissMyListNewEpisode?.bind(c);
  const refreshMyListNewEpisodes = c.refreshMyListNewEpisodes?.bind(c);
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
  const setRating = c.setRating?.bind(c);
  const getRating = c.getRating?.bind(c);
  const listRatings = c.listRatings?.bind(c);
  const listRatingMap = c.listRatingMap?.bind(c);
  const excludedFor = (effectivePid: string, scope: ProfileCatalogScope) =>
    resolveExcludedSourceIds(c, effectivePid, scope);

  return {
    addSource: (input) => c.addSource(input),
    addSourceFromLink: (input) => c.addSourceFromLink(input),
    ...(c.addLocalM3uSource ? { addLocalM3uSource: c.addLocalM3uSource.bind(c) } : {}),
    ...(c.discoverSourceCategories
      ? { discoverSourceCategories: c.discoverSourceCategories.bind(c) }
      : {}),
    ...(c.updateSourceSettings ? { updateSourceSettings: c.updateSourceSettings.bind(c) } : {}),
    ...(c.renameSource ? { renameSource: c.renameSource.bind(c) } : {}),
    ...(c.setSourceExcludedProfiles
      ? { setSourceExcludedProfiles: c.setSourceExcludedProfiles.bind(c) }
      : {}),
    removeSource: (id) => c.removeSource(id),
    importSource: (id, opts) => c.importSource(id, opts),
    ...(c.importGuide ? { importGuide: c.importGuide.bind(c) } : {}),
    listSources: () => c.listSources(),
    ...(c.latestImportHealth ? { latestImportHealth: c.latestImportHealth.bind(c) } : {}),
    ...createProfileScopedBrowseMethods(c, getScope),
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
          listReminders: async (profileId, opts) => {
            const scope = getScope();
            if (scope.parentalLoadError) return [];
            const pid = profileId ?? scope.profileId;
            const [excluded, rows] = await Promise.all([
              excludedFor(pid, scope),
              listReminders(pid, {
                ...opts,
                parentalUnlocked: opts?.parentalUnlocked ?? scope.parentalUnlocked,
              }),
            ]);
            return filterBySourceId(rows, excluded);
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
              parentalUnlocked: scope.parentalLoadError
                ? false
                : (input.parentalUnlocked ?? scope.parentalUnlocked),
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
    ...(setSeasonWatched
      ? {
          setSeasonWatched: (seriesKey, season, watched, profileId) =>
            setSeasonWatched(seriesKey, season, watched, profileId ?? getScope().profileId),
        }
      : {}),
    ...(setSeriesWatched
      ? {
          setSeriesWatched: (seriesKey, watched, profileId) =>
            setSeriesWatched(seriesKey, watched, profileId ?? getScope().profileId),
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
          listContinueWatching: async (limit, profileId, opts) => {
            const scope = getScope();
            if (scope.parentalLoadError) return [];
            const pid = profileId ?? scope.profileId;
            const excluded = await excludedFor(pid, scope);
            const fetchLimit = excluded.size > 0 ? resolveExcludedFetchLimit(limit) : limit;
            const rows = await listContinueWatching(fetchLimit, pid, {
              ...opts,
              parentalUnlocked: opts?.parentalUnlocked ?? scope.parentalUnlocked,
            });
            return excluded.size === 0 ? rows : filterAndSliceBySourceId(rows, excluded, limit);
          },
        }
      : {}),
    ...(listWatched
      ? {
          listWatched: async (limit, profileId, opts) => {
            const scope = getScope();
            if (scope.parentalLoadError) return [];
            const pid = profileId ?? scope.profileId;
            const excluded = await excludedFor(pid, scope);
            const fetchLimit = excluded.size > 0 ? resolveExcludedFetchLimit(limit) : limit;
            const rows = await listWatched(fetchLimit, pid, {
              ...opts,
              parentalUnlocked: opts?.parentalUnlocked ?? scope.parentalUnlocked,
            });
            return excluded.size === 0 ? rows : filterAndSliceBySourceId(rows, excluded, limit);
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
          listFavorites: async (limit, profileId, opts) => {
            const scope = getScope();
            if (scope.parentalLoadError) return [];
            const pid = profileId ?? scope.profileId;
            const excluded = await excludedFor(pid, scope);
            const fetchLimit = excluded.size > 0 ? resolveExcludedFetchLimit(limit) : limit;
            const rows = await listFavorites(fetchLimit, pid, {
              ...opts,
              parentalUnlocked: opts?.parentalUnlocked ?? scope.parentalUnlocked,
            });
            return excluded.size === 0 ? rows : filterAndSliceBySourceId(rows, excluded, limit);
          },
        }
      : {}),
    ...(listFavoriteKeys
      ? {
          listFavoriteKeys: async (profileId) => {
            const scope = getScope();
            if (scope.parentalLoadError) return [];
            const pid = profileId ?? scope.profileId;
            const [excluded, keys] = await Promise.all([
              excludedFor(pid, scope),
              listFavoriteKeys(pid),
            ]);
            return excluded.size === 0
              ? keys
              : keys.filter((k) => !isKeyFromExcludedSource(k, excluded));
          },
        }
      : {}),
    ...(listMyListNewEpisodes
      ? {
          listMyListNewEpisodes: async (limit, profileId, opts) => {
            const scope = getScope();
            if (scope.parentalLoadError) return [];
            const pid = profileId ?? scope.profileId;
            const excluded = await excludedFor(pid, scope);
            const fetchLimit = excluded.size > 0 ? resolveExcludedFetchLimit(limit) : limit;
            const rows = await listMyListNewEpisodes(fetchLimit, pid, {
              ...opts,
              parentalUnlocked: opts?.parentalUnlocked ?? scope.parentalUnlocked,
            });
            return excluded.size === 0 ? rows : filterAndSliceBySourceId(rows, excluded, limit);
          },
        }
      : {}),
    ...(dismissMyListNewEpisode
      ? {
          dismissMyListNewEpisode: (episodeKey, profileId) =>
            dismissMyListNewEpisode(episodeKey, profileId ?? getScope().profileId),
        }
      : {}),
    ...(refreshMyListNewEpisodes
      ? {
          refreshMyListNewEpisodes: (profileId, opts) =>
            refreshMyListNewEpisodes(profileId ?? getScope().profileId, opts),
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
          listRecentChannels: async (limit, profileId, opts) => {
            const scope = getScope();
            if (scope.parentalLoadError) return [];
            const pid = profileId ?? scope.profileId;
            const excluded = await excludedFor(pid, scope);
            const fetchLimit = excluded.size > 0 ? resolveExcludedFetchLimit(limit) : limit;
            const rows = await listRecentChannels(fetchLimit, pid, {
              ...opts,
              parentalUnlocked: opts?.parentalUnlocked ?? scope.parentalUnlocked,
            });
            return excluded.size === 0 ? rows : filterAndSliceBySourceId(rows, excluded, limit);
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
          listCustomGroups: async (profileId, opts) => {
            const scope = getScope();
            if (scope.parentalLoadError) return [];
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
    ...createProfileScopedElvMethods(c, getScope),
    ...(listCollections
      ? {
          listCollections: async (profileId, opts) => {
            const scope = getScope();
            if (scope.parentalLoadError) return [];
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
          listCollectionItems: async (collectionId, opts) => {
            const scope = getScope();
            if (scope.parentalLoadError) return [];
            const merged = mergeParentalOpts(opts, scope);
            const [excluded, rows] = await Promise.all([
              excludedFor(merged.profileId ?? scope.profileId, scope),
              listCollectionItems(collectionId, merged),
            ]);
            return filterBySourceId(rows, excluded);
          },
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
          listDownloads: async (opts) => {
            const scope = getScope();
            if (scope.parentalLoadError) return [];
            const pid = opts?.profileId ?? scope.profileId;
            const [excluded, rows] = await Promise.all([
              excludedFor(pid, scope),
              listDownloads({
                ...opts,
                profileId: pid,
              }),
            ]);
            return filterBySourceId(rows, excluded);
          },
        }
      : {}),
    ...(getDownload
      ? {
          getDownload: async (itemKey, profileId) => {
            const scope = getScope();
            if (scope.parentalLoadError) return null;
            const pid = profileId ?? scope.profileId;
            const excluded = await excludedFor(pid, scope);
            if (isKeyFromExcludedSource(itemKey, excluded)) return null;
            const row = await getDownload(itemKey, pid);
            if (row === null) return null;
            return excluded.has(row.sourceId) ? null : row;
          },
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
    ...(setRating
      ? {
          setRating: (input, value) =>
            setRating(
              {
                ...input,
                profileId: input.profileId ?? getScope().profileId,
              },
              value,
            ),
        }
      : {}),
    ...(getRating
      ? {
          getRating: (itemKey, profileId) => getRating(itemKey, profileId ?? getScope().profileId),
        }
      : {}),
    ...(listRatings
      ? {
          listRatings: async (opts) => {
            const scope = getScope();
            if (scope.parentalLoadError) return [];
            const pid = opts?.profileId ?? scope.profileId;
            const [excluded, rows] = await Promise.all([
              excludedFor(pid, scope),
              listRatings({
                ...opts,
                profileId: pid,
                parentalUnlocked: opts?.parentalUnlocked ?? scope.parentalUnlocked,
              }),
            ]);
            return filterByItemKey(rows, excluded);
          },
        }
      : {}),
    ...(listRatingMap
      ? {
          listRatingMap: async (profileId) => {
            const scope = getScope();
            if (scope.parentalLoadError) return {};
            const pid = profileId ?? scope.profileId;
            const [excluded, map] = await Promise.all([
              excludedFor(pid, scope),
              listRatingMap(pid),
            ]);
            if (excluded.size === 0) return map;
            const out: Record<string, (typeof map)[string]> = {};
            for (const [k, v] of Object.entries(map)) {
              if (!isKeyFromExcludedSource(k, excluded)) out[k] = v;
            }
            return out;
          },
        }
      : {}),
    ...(c.flushPendingWrites ? { flushPendingWrites: c.flushPendingWrites.bind(c) } : {}),
    close: () => c.close(),
  };
}
