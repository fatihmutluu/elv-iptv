import type { CatalogService } from './catalog';
import { DEFAULT_PROFILE_ID } from './user-state';

/** Default debounce window (ms) for coalescing rapid user-state writes. */
export const DEFAULT_WRITE_COALESCE_MS = 500;

/** Timer injection and window configuration for {@link createWriteCoalescer}. */
export interface WriteCoalescerOptions {
  /** Coalescing window in milliseconds (default: {@link DEFAULT_WRITE_COALESCE_MS}). */
  windowMs?: number;
  /** Injectable timer scheduler for deterministic tests (defaults to `globalThis.setTimeout`). */
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Injectable timer canceller for deterministic tests (defaults to `globalThis.clearTimeout`). */
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

/** Deduplicates rapid async writes per key within a sliding time window. */
export interface WriteCoalescer {
  /**
   * Schedules `job` under `key`. Rapid calls for the same `key` within `windowMs` collapse into a
   * single execution of the latest `job`; all superseded callers resolve or reject with the final
   * committed outcome.
   */
  schedule<T>(key: string, job: () => Promise<T>): Promise<T>;
  /**
   * Synchronously starts any pending write for `key` (cancelling its timer) and returns its
   * in-flight settlement promise (or an already in-flight promise for `key`), or `undefined` if idle.
   */
  triggerKey(key: string): Promise<void> | undefined;
  /** Immediately flushes any pending or in-flight write for `key`. */
  flushKey(key: string): Promise<void>;
  /** Immediately flushes all pending or in-flight writes whose key starts with `prefix`. */
  flushPrefix(prefix: string): Promise<void>;
  /** Cancels all active timers and awaits all pending and in-flight writes (concurrent & re-entrant safe). */
  flush(): Promise<void>;
  /** Number of keys currently queued on a debounce timer. */
  pendingCount(): number;
  /** Number of writes currently executing in-flight. */
  inFlightCount(): number;
  /** Cancels all pending debounce timers and rejects waiting callers with a disposal error. */
  dispose(): void;
}

interface PendingEntry {
  timer: ReturnType<typeof setTimeout> | undefined;
  job: () => Promise<unknown>;
  waiters: Array<{
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }>;
}

/**
 * Creates a pure-TS per-key write coalescer that collapses rapid async write bursts into a single
 * committed operation per key while guaranteeing every awaiting caller settles cleanly.
 */
export function createWriteCoalescer(opts: WriteCoalescerOptions = {}): WriteCoalescer {
  const windowMs =
    opts.windowMs !== undefined && Number.isFinite(opts.windowMs)
      ? Math.max(0, opts.windowMs)
      : DEFAULT_WRITE_COALESCE_MS;
  const setTimer =
    opts.setTimeoutFn ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));
  const clearTimer =
    opts.clearTimeoutFn ??
    ((handle: ReturnType<typeof setTimeout>) => {
      globalThis.clearTimeout(handle);
    });

  const pending = new Map<string, PendingEntry>();
  const inFlight = new Set<Promise<void>>();
  const keyTail = new Map<string, Promise<void>>();

  const runEntry = (key: string, entry: PendingEntry): Promise<void> => {
    const prev = keyTail.get(key) ?? Promise.resolve();
    const execution = prev.then(async () => {
      try {
        const value = await entry.job();
        for (const w of entry.waiters) w.resolve(value);
      } catch (error) {
        for (const w of entry.waiters) w.reject(error);
      }
    });
    inFlight.add(execution);
    keyTail.set(key, execution);
    void execution.finally(() => {
      inFlight.delete(execution);
      if (keyTail.get(key) === execution) {
        keyTail.delete(key);
      }
    });
    return execution;
  };

  const triggerKey = (key: string): Promise<void> | undefined => {
    const entry = pending.get(key);
    if (entry === undefined) return keyTail.get(key);
    pending.delete(key);
    if (entry.timer !== undefined) {
      clearTimer(entry.timer);
      entry.timer = undefined;
    }
    return runEntry(key, entry);
  };

  const flushKey = async (key: string): Promise<void> => {
    while (pending.has(key) || keyTail.has(key)) {
      const active = triggerKey(key);
      if (active !== undefined) {
        await active;
      }
    }
  };

  return {
    schedule<T>(key: string, job: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const waiter = {
          resolve: (value: unknown) => resolve(value as T),
          reject,
        };
        if (windowMs <= 0) {
          void runEntry(key, { timer: undefined, job, waiters: [waiter] });
          return;
        }
        const existing = pending.get(key);
        if (existing !== undefined) {
          if (existing.timer !== undefined) {
            clearTimer(existing.timer);
          }
          existing.job = job;
          existing.waiters.push(waiter);
          existing.timer = setTimer(() => {
            triggerKey(key);
          }, windowMs);
          return;
        }
        const entry: PendingEntry = {
          timer: undefined,
          job,
          waiters: [waiter],
        };
        pending.set(key, entry);
        entry.timer = setTimer(() => {
          triggerKey(key);
        }, windowMs);
      });
    },

    triggerKey,
    flushKey,

    async flushPrefix(prefix: string): Promise<void> {
      if (pending.size === 0 && keyTail.size === 0) return;
      for (;;) {
        const matching: Promise<void>[] = [];
        for (const key of [...pending.keys()]) {
          if (key.startsWith(prefix)) {
            const active = triggerKey(key);
            if (active !== undefined) matching.push(active);
          }
        }
        for (const [key, tail] of keyTail) {
          if (key.startsWith(prefix)) matching.push(tail);
        }
        if (matching.length === 0) return;
        await Promise.all(matching);
      }
    },

    async flush(): Promise<void> {
      while (pending.size > 0 || inFlight.size > 0) {
        if (pending.size > 0) {
          for (const key of [...pending.keys()]) {
            triggerKey(key);
          }
        }
        if (inFlight.size > 0) {
          await Promise.all([...inFlight]);
        }
      }
    },

    pendingCount(): number {
      return pending.size;
    },

    inFlightCount(): number {
      return inFlight.size;
    },

    dispose(): void {
      const error = new Error('WriteCoalescer disposed');
      const entries = [...pending.values()];
      pending.clear();
      for (const entry of entries) {
        if (entry.timer !== undefined) {
          clearTimer(entry.timer);
          entry.timer = undefined;
        }
        for (const w of entry.waiters) w.reject(error);
      }
    },
  };
}

/** Options for {@link createCoalescedCatalog}. */
export type CoalescedCatalogOptions = WriteCoalescerOptions;

/** A {@link CatalogService} wrapper that coalesces rapid user-state writes and guarantees `flushPendingWrites`. */
export interface CoalescedCatalogService extends CatalogService {
  flushPendingWrites(): Promise<void>;
}

const normalizeProfile = (profileId?: string): string => {
  const trimmed = profileId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_PROFILE_ID;
};

/**
 * Wraps a {@link CatalogService} so rapid `setFavorite`, `setWatched`, and `saveProgress` bursts
 * coalesce per `(profileId, itemKey)` within `windowMs` (default 500 ms). Preserves causal
 * ordering between `saveProgress` and `setWatched`, flushes matching pending writes before reads
 * and `toggleFavorite`/`clearProgress`, and flushes all pending writes before `removeSource`/`close`.
 */
export function createCoalescedCatalog(
  catalog: CatalogService,
  opts?: CoalescedCatalogOptions,
): CoalescedCatalogService {
  const coalescer = createWriteCoalescer(opts);
  const c = catalog;

  const favKey = (itemKey: string, profileId?: string): string =>
    `fav:${normalizeProfile(profileId)}:${itemKey}`;
  const progressKey = (itemKey: string, profileId?: string): string =>
    `progress:${normalizeProfile(profileId)}:${itemKey}`;
  const watchedKey = (itemKey: string, profileId?: string): string =>
    `watched:${normalizeProfile(profileId)}:${itemKey}`;
  const ratingKey = (itemKey: string, profileId?: string): string =>
    `rating:${normalizeProfile(profileId)}:${itemKey}`;

  const flushPendingWrites = async (): Promise<void> => {
    await coalescer.flush();
    await c.flushPendingWrites?.();
  };

  const saveProgressFn = c.saveProgress?.bind(c);
  const setWatchedFn = c.setWatched?.bind(c);
  const setSeasonWatchedFn = c.setSeasonWatched?.bind(c);
  const setSeriesWatchedFn = c.setSeriesWatched?.bind(c);
  const getProgressFn = c.getProgress?.bind(c);
  const queryNextEpisodeFn = c.queryNextEpisode?.bind(c);
  const listContinueWatchingFn = c.listContinueWatching?.bind(c);
  const listWatchedFn = c.listWatched?.bind(c);
  const listProgressByKeysFn = c.listProgressByKeys?.bind(c);
  const listSeriesUnplayedCountsFn = c.listSeriesUnplayedCounts?.bind(c);
  const clearProgressFn = c.clearProgress?.bind(c);
  const setFavoriteFn = c.setFavorite?.bind(c);
  const toggleFavoriteFn = c.toggleFavorite?.bind(c);
  const reorderFavoritesFn = c.reorderFavorites?.bind(c);
  const listFavoritesFn = c.listFavorites?.bind(c);
  const listFavoriteKeysFn = c.listFavoriteKeys?.bind(c);
  const listMyListNewEpisodesFn = c.listMyListNewEpisodes?.bind(c);
  const dismissMyListNewEpisodeFn = c.dismissMyListNewEpisode?.bind(c);
  const refreshMyListNewEpisodesFn = c.refreshMyListNewEpisodes?.bind(c);
  const setRatingFn = c.setRating?.bind(c);
  const getRatingFn = c.getRating?.bind(c);
  const listRatingsFn = c.listRatings?.bind(c);
  const listRatingMapFn = c.listRatingMap?.bind(c);

  const deleteProfileFn = c.deleteProfile?.bind(c);

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
    async removeSource(id) {
      await flushPendingWrites();
      return c.removeSource(id);
    },
    importSource: (id, importOpts) => c.importSource(id, importOpts),
    listSources: () => c.listSources(),
    categories: (sourceId, kind, catOpts) => c.categories(sourceId, kind, catOpts),
    items: (categoryId, offset, limit, itemOpts) => c.items(categoryId, offset, limit, itemOpts),
    seasons: (seriesId, seasonOpts) => c.seasons(seriesId, seasonOpts),
    episodes: (seriesId, season, epOpts) => c.episodes(seriesId, season, epOpts),
    resolveStream: (itemKey, streamOpts) => c.resolveStream(itemKey, streamOpts),
    ...(c.importGuide ? { importGuide: c.importGuide.bind(c) } : {}),
    ...(c.latestImportHealth ? { latestImportHealth: c.latestImportHealth.bind(c) } : {}),
    ...(c.liveVariants ? { liveVariants: c.liveVariants.bind(c) } : {}),
    ...(c.itemVersions ? { itemVersions: c.itemVersions.bind(c) } : {}),
    ...(c.allSourcesItems ? { allSourcesItems: c.allSourcesItems.bind(c) } : {}),
    ...(c.itemDetail ? { itemDetail: c.itemDetail.bind(c) } : {}),
    ...(c.search ? { search: c.search.bind(c) } : {}),
    ...(c.searchSuggestions ? { searchSuggestions: c.searchSuggestions.bind(c) } : {}),
    ...(c.alphabetIndex ? { alphabetIndex: c.alphabetIndex.bind(c) } : {}),
    ...(c.nowNext ? { nowNext: c.nowNext.bind(c) } : {}),
    ...(c.epgWindow ? { epgWindow: c.epgWindow.bind(c) } : {}),
    ...(c.epgSlice ? { epgSlice: c.epgSlice.bind(c) } : {}),
    ...(c.channelByNumber ? { channelByNumber: c.channelByNumber.bind(c) } : {}),
    ...(c.getTrackPreference ? { getTrackPreference: c.getTrackPreference.bind(c) } : {}),
    ...(c.saveTrackPreference ? { saveTrackPreference: c.saveTrackPreference.bind(c) } : {}),
    ...(c.clearTrackPreference ? { clearTrackPreference: c.clearTrackPreference.bind(c) } : {}),
    ...(c.recordRecentChannel ? { recordRecentChannel: c.recordRecentChannel.bind(c) } : {}),
    ...(c.listRecentChannels ? { listRecentChannels: c.listRecentChannels.bind(c) } : {}),
    ...(c.listProfiles ? { listProfiles: c.listProfiles.bind(c) } : {}),
    ...(c.createProfile ? { createProfile: c.createProfile.bind(c) } : {}),
    ...(c.updateProfile ? { updateProfile: c.updateProfile.bind(c) } : {}),
    ...(deleteProfileFn
      ? {
          deleteProfile: async (id) => {
            const p = normalizeProfile(id);
            await coalescer.flushPrefix(`fav:${p}:`);
            await coalescer.flushPrefix(`progress:${p}:`);
            await coalescer.flushPrefix(`watched:${p}:`);
            await coalescer.flushPrefix(`rating:${p}:`);
            return deleteProfileFn(id);
          },
        }
      : {}),
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
    ...(c.setChannelOverride ? { setChannelOverride: c.setChannelOverride.bind(c) } : {}),
    ...(c.clearChannelOverride ? { clearChannelOverride: c.clearChannelOverride.bind(c) } : {}),
    ...(c.reorderChannels ? { reorderChannels: c.reorderChannels.bind(c) } : {}),
    ...(c.listCustomGroups ? { listCustomGroups: c.listCustomGroups.bind(c) } : {}),
    ...(c.createCustomGroup ? { createCustomGroup: c.createCustomGroup.bind(c) } : {}),
    ...(c.updateCustomGroup ? { updateCustomGroup: c.updateCustomGroup.bind(c) } : {}),
    ...(c.deleteCustomGroup ? { deleteCustomGroup: c.deleteCustomGroup.bind(c) } : {}),
    ...(c.setCustomGroupItems ? { setCustomGroupItems: c.setCustomGroupItems.bind(c) } : {}),
    ...(c.addChannelToCustomGroup
      ? { addChannelToCustomGroup: c.addChannelToCustomGroup.bind(c) }
      : {}),
    ...(c.removeChannelFromCustomGroup
      ? { removeChannelFromCustomGroup: c.removeChannelFromCustomGroup.bind(c) }
      : {}),
    ...(c.resolveCatchupStream ? { resolveCatchupStream: c.resolveCatchupStream.bind(c) } : {}),
    ...(c.fetchChannelArchiveEpg
      ? { fetchChannelArchiveEpg: c.fetchChannelArchiveEpg.bind(c) }
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
    ...(c.listReminders ? { listReminders: c.listReminders.bind(c) } : {}),
    ...(c.upsertReminder ? { upsertReminder: c.upsertReminder.bind(c) } : {}),
    ...(c.removeReminder ? { removeReminder: c.removeReminder.bind(c) } : {}),
    ...(c.markReminderFired ? { markReminderFired: c.markReminderFired.bind(c) } : {}),
    ...(c.pruneExpiredReminders ? { pruneExpiredReminders: c.pruneExpiredReminders.bind(c) } : {}),
    ...(c.listFailoverGroups ? { listFailoverGroups: c.listFailoverGroups.bind(c) } : {}),
    ...(c.getFailoverGroupByChannel
      ? { getFailoverGroupByChannel: c.getFailoverGroupByChannel.bind(c) }
      : {}),
    ...(c.createFailoverGroup ? { createFailoverGroup: c.createFailoverGroup.bind(c) } : {}),
    ...(c.renameFailoverGroup ? { renameFailoverGroup: c.renameFailoverGroup.bind(c) } : {}),
    ...(c.deleteFailoverGroup ? { deleteFailoverGroup: c.deleteFailoverGroup.bind(c) } : {}),
    ...(c.addFailoverGroupMember
      ? { addFailoverGroupMember: c.addFailoverGroupMember.bind(c) }
      : {}),
    ...(c.removeFailoverGroupMember
      ? { removeFailoverGroupMember: c.removeFailoverGroupMember.bind(c) }
      : {}),
    ...(c.reorderFailoverGroupMembers
      ? { reorderFailoverGroupMembers: c.reorderFailoverGroupMembers.bind(c) }
      : {}),
    ...(c.suggestFailoverGroups ? { suggestFailoverGroups: c.suggestFailoverGroups.bind(c) } : {}),
    ...(c.applySuggestedFailoverGroups
      ? { applySuggestedFailoverGroups: c.applySuggestedFailoverGroups.bind(c) }
      : {}),
    ...(c.reportStreamOutcome ? { reportStreamOutcome: c.reportStreamOutcome.bind(c) } : {}),
    ...(c.getVodEnrichment ? { getVodEnrichment: c.getVodEnrichment.bind(c) } : {}),
    ...(c.enrichVodItem ? { enrichVodItem: c.enrichVodItem.bind(c) } : {}),
    ...(c.listCollections ? { listCollections: c.listCollections.bind(c) } : {}),
    ...(c.createCollection ? { createCollection: c.createCollection.bind(c) } : {}),
    ...(c.renameCollection ? { renameCollection: c.renameCollection.bind(c) } : {}),
    ...(c.reorderCollections ? { reorderCollections: c.reorderCollections.bind(c) } : {}),
    ...(c.deleteCollection ? { deleteCollection: c.deleteCollection.bind(c) } : {}),
    ...(c.listCollectionItems ? { listCollectionItems: c.listCollectionItems.bind(c) } : {}),
    ...(c.listCollectionsForItem
      ? { listCollectionsForItem: c.listCollectionsForItem.bind(c) }
      : {}),
    ...(c.addItemToCollection ? { addItemToCollection: c.addItemToCollection.bind(c) } : {}),
    ...(c.removeItemFromCollection
      ? { removeItemFromCollection: c.removeItemFromCollection.bind(c) }
      : {}),
    ...(c.reorderCollectionItems
      ? { reorderCollectionItems: c.reorderCollectionItems.bind(c) }
      : {}),
    ...(setRatingFn
      ? {
          setRating: (input, value) =>
            coalescer.schedule(ratingKey(input.itemKey, input.profileId), () =>
              setRatingFn(input, value),
            ),
        }
      : {}),
    ...(getRatingFn
      ? {
          getRating: async (itemKey, profileId) => {
            await coalescer.flushKey(ratingKey(itemKey, profileId));
            return getRatingFn(itemKey, profileId);
          },
        }
      : {}),
    ...(listRatingsFn
      ? {
          listRatings: async (listOpts) => {
            await coalescer.flushPrefix(`rating:${normalizeProfile(listOpts?.profileId)}:`);
            return listRatingsFn(listOpts);
          },
        }
      : {}),
    ...(listRatingMapFn
      ? {
          listRatingMap: async (profileId) => {
            await coalescer.flushPrefix(`rating:${normalizeProfile(profileId)}:`);
            return listRatingMapFn(profileId);
          },
        }
      : {}),
    ...(c.listDownloads ? { listDownloads: c.listDownloads.bind(c) } : {}),
    ...(c.getDownload ? { getDownload: c.getDownload.bind(c) } : {}),
    ...(c.upsertDownload ? { upsertDownload: c.upsertDownload.bind(c) } : {}),
    ...(c.deleteDownload ? { deleteDownload: c.deleteDownload.bind(c) } : {}),
    ...(c.getElvEnrichmentForKeys
      ? { getElvEnrichmentForKeys: c.getElvEnrichmentForKeys.bind(c) }
      : {}),
    ...(c.getElvTitleDetail ? { getElvTitleDetail: c.getElvTitleDetail.bind(c) } : {}),
    ...(c.listMergedVodVersions ? { listMergedVodVersions: c.listMergedVodVersions.bind(c) } : {}),
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
    ...(c.listLiveVariants ? { listLiveVariants: c.listLiveVariants.bind(c) } : {}),
    ...(c.findGuideChannelByCleanName
      ? { findGuideChannelByCleanName: c.findGuideChannelByCleanName.bind(c) }
      : {}),
    ...(c.listElvImdbGenres ? { listElvImdbGenres: c.listElvImdbGenres.bind(c) } : {}),
    ...(c.listElvItemsByImdbGenre
      ? { listElvItemsByImdbGenre: c.listElvItemsByImdbGenre.bind(c) }
      : {}),
    ...(c.getElvRecommendations
      ? {
          getElvRecommendations: async (recOpts) => {
            const p = normalizeProfile(recOpts.profileId);
            await coalescer.flushPrefix(`fav:${p}:`);
            await coalescer.flushPrefix(`progress:${p}:`);
            await coalescer.flushPrefix(`watched:${p}:`);
            await coalescer.flushPrefix(`rating:${p}:`);
            return c.getElvRecommendations ? c.getElvRecommendations(recOpts) : [];
          },
        }
      : {}),
    ...(c.refreshElvFeeds ? { refreshElvFeeds: c.refreshElvFeeds.bind(c) } : {}),
    ...(c.listElvFranchiseItems ? { listElvFranchiseItems: c.listElvFranchiseItems.bind(c) } : {}),
    ...(c.listElvPersonLibraryItems
      ? { listElvPersonLibraryItems: c.listElvPersonLibraryItems.bind(c) }
      : {}),
    ...(c.searchElvMatchCandidates
      ? { searchElvMatchCandidates: c.searchElvMatchCandidates.bind(c) }
      : {}),
    ...(c.applyElvFixMatch ? { applyElvFixMatch: c.applyElvFixMatch.bind(c) } : {}),
    ...(c.setElvClient ? { setElvClient: c.setElvClient.bind(c) } : {}),
    ...(queryNextEpisodeFn
      ? {
          queryNextEpisode: async (seriesKey, currentItemKey, profileId, nextOpts) => {
            const p = normalizeProfile(profileId);
            await coalescer.flushPrefix(`progress:${p}:`);
            await coalescer.flushPrefix(`watched:${p}:`);
            return queryNextEpisodeFn(seriesKey, currentItemKey, profileId, nextOpts);
          },
        }
      : {}),
    ...(getProgressFn
      ? {
          getProgress: async (itemKey, profileId) => {
            await coalescer.flushKey(progressKey(itemKey, profileId));
            await coalescer.flushKey(watchedKey(itemKey, profileId));
            return getProgressFn(itemKey, profileId);
          },
        }
      : {}),
    ...(listContinueWatchingFn
      ? {
          listContinueWatching: async (limit, profileId, listOpts) => {
            const p = normalizeProfile(profileId);
            await coalescer.flushPrefix(`progress:${p}:`);
            await coalescer.flushPrefix(`watched:${p}:`);
            return listContinueWatchingFn(limit, profileId, listOpts);
          },
        }
      : {}),
    ...(listWatchedFn
      ? {
          listWatched: async (limit, profileId, listOpts) => {
            const p = normalizeProfile(profileId);
            await coalescer.flushPrefix(`progress:${p}:`);
            await coalescer.flushPrefix(`watched:${p}:`);
            return listWatchedFn(limit, profileId, listOpts);
          },
        }
      : {}),
    ...(listProgressByKeysFn
      ? {
          listProgressByKeys: async (itemKeys, profileId) => {
            if (coalescer.pendingCount() > 0 || coalescer.inFlightCount() > 0) {
              for (const itemKey of itemKeys) {
                await coalescer.flushKey(progressKey(itemKey, profileId));
                await coalescer.flushKey(watchedKey(itemKey, profileId));
              }
            }
            return listProgressByKeysFn(itemKeys, profileId);
          },
        }
      : {}),
    ...(listSeriesUnplayedCountsFn
      ? {
          listSeriesUnplayedCounts: async (seriesKeys, profileId) => {
            const p = normalizeProfile(profileId);
            await coalescer.flushPrefix(`progress:${p}:`);
            await coalescer.flushPrefix(`watched:${p}:`);
            return listSeriesUnplayedCountsFn(seriesKeys, profileId);
          },
        }
      : {}),
    ...(toggleFavoriteFn
      ? {
          toggleFavorite: async (input) => {
            await coalescer.flushKey(favKey(input.itemKey, input.profileId));
            return toggleFavoriteFn(input);
          },
        }
      : {}),
    ...(reorderFavoritesFn
      ? {
          reorderFavorites: async (orderedItemKeys, profileId) => {
            await coalescer.flushPrefix(`fav:${normalizeProfile(profileId)}:`);
            return reorderFavoritesFn(orderedItemKeys, profileId);
          },
        }
      : {}),
    ...(listFavoritesFn
      ? {
          listFavorites: async (limit, profileId, listOpts) => {
            await coalescer.flushPrefix(`fav:${normalizeProfile(profileId)}:`);
            return listFavoritesFn(limit, profileId, listOpts);
          },
        }
      : {}),
    ...(listFavoriteKeysFn
      ? {
          listFavoriteKeys: async (profileId) => {
            await coalescer.flushPrefix(`fav:${normalizeProfile(profileId)}:`);
            return listFavoriteKeysFn(profileId);
          },
        }
      : {}),
    ...(listMyListNewEpisodesFn
      ? {
          listMyListNewEpisodes: async (limit, profileId, listOpts) => {
            const p = normalizeProfile(profileId);
            await coalescer.flushPrefix(`fav:${p}:`);
            await coalescer.flushPrefix(`progress:${p}:`);
            await coalescer.flushPrefix(`watched:${p}:`);
            return listMyListNewEpisodesFn(limit, profileId, listOpts);
          },
        }
      : {}),
    ...(dismissMyListNewEpisodeFn
      ? {
          dismissMyListNewEpisode: (episodeKey, profileId) =>
            dismissMyListNewEpisodeFn(episodeKey, profileId),
        }
      : {}),
    ...(refreshMyListNewEpisodesFn
      ? {
          refreshMyListNewEpisodes: async (profileId, refreshOpts) => {
            const p = normalizeProfile(profileId);
            await coalescer.flushPrefix(`fav:${p}:`);
            await coalescer.flushPrefix(`progress:${p}:`);
            await coalescer.flushPrefix(`watched:${p}:`);
            return refreshMyListNewEpisodesFn(profileId, refreshOpts);
          },
        }
      : {}),
    ...(saveProgressFn
      ? {
          saveProgress: (input) => {
            const prevWatched = coalescer.triggerKey(watchedKey(input.itemKey, input.profileId));
            return coalescer.schedule(progressKey(input.itemKey, input.profileId), async () => {
              if (prevWatched !== undefined) await prevWatched;
              return saveProgressFn(input);
            });
          },
        }
      : {}),
    ...(setWatchedFn
      ? {
          setWatched: (itemKey, watched, profileId) => {
            const prevProgress = coalescer.triggerKey(progressKey(itemKey, profileId));
            return coalescer.schedule(watchedKey(itemKey, profileId), async () => {
              if (prevProgress !== undefined) await prevProgress;
              return setWatchedFn(itemKey, watched, profileId);
            });
          },
        }
      : {}),
    ...(setSeasonWatchedFn
      ? {
          setSeasonWatched: async (seriesKey, season, watched, profileId) => {
            const p = normalizeProfile(profileId);
            await coalescer.flushPrefix(`progress:${p}:`);
            await coalescer.flushPrefix(`watched:${p}:`);
            return setSeasonWatchedFn(seriesKey, season, watched, profileId);
          },
        }
      : {}),
    ...(setSeriesWatchedFn
      ? {
          setSeriesWatched: async (seriesKey, watched, profileId) => {
            const p = normalizeProfile(profileId);
            await coalescer.flushPrefix(`progress:${p}:`);
            await coalescer.flushPrefix(`watched:${p}:`);
            return setSeriesWatchedFn(seriesKey, watched, profileId);
          },
        }
      : {}),
    ...(clearProgressFn
      ? {
          clearProgress: async (itemKey, profileId) => {
            await coalescer.flushKey(progressKey(itemKey, profileId));
            await coalescer.flushKey(watchedKey(itemKey, profileId));
            return clearProgressFn(itemKey, profileId);
          },
        }
      : {}),
    ...(setFavoriteFn
      ? {
          setFavorite: (input, active) =>
            coalescer.schedule(favKey(input.itemKey, input.profileId), () =>
              setFavoriteFn(input, active),
            ),
        }
      : {}),
    flushPendingWrites,
    async close() {
      await flushPendingWrites();
      coalescer.dispose();
      await c.close();
    },
  };
}
