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
    listFavorites: async (limit, profileId, opts) =>
      (await open()).listFavorites?.(limit, profileId, opts) ?? [],
    listFavoriteKeys: async (profileId) => (await open()).listFavoriteKeys?.(profileId) ?? [],
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
