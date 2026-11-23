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
    categories: async (sourceId, kind, opts) => (await open()).categories(sourceId, kind, opts),
    items: async (categoryId, offset, limit, opts) =>
      (await open()).items(categoryId, offset, limit, opts),
    liveVariants: async (itemKey, categoryId) =>
      (await open()).liveVariants?.(itemKey, categoryId) ?? [],
    itemVersions: async (itemKey) => (await open()).itemVersions?.(itemKey) ?? [],
    allSourcesItems: async (kind, offset, limit, sourceIds, opts) =>
      (await open()).allSourcesItems?.(kind, offset, limit, sourceIds, opts) ?? [],
    itemDetail: async (itemKey) => {
      const svc = await open();
      return svc.itemDetail ? svc.itemDetail(itemKey) : null;
    },
    search: async (query, opts) =>
      (await open()).search?.(query, opts) ?? { live: [], movies: [], series: [] },
    nowNext: async (channelKeys, nowMs) => (await open()).nowNext?.(channelKeys, nowMs) ?? [],
    epgWindow: async (channelKeys, fromMs, toMs) =>
      (await open()).epgWindow?.(channelKeys, fromMs, toMs) ?? {},
    channelByNumber: async (num, sourceId) =>
      (await open()).channelByNumber?.(num, sourceId) ?? null,
    seasons: (seriesId) => wrapResult(async () => (await open()).seasons(seriesId)),
    episodes: async (seriesId, season) => (await open()).episodes(seriesId, season),
    queryNextEpisode: async (seriesKey, currentItemKey, profileId) =>
      (await open()).queryNextEpisode?.(seriesKey, currentItemKey, profileId) ?? null,
    resolveStream: (itemKey) => wrapResult(async () => (await open()).resolveStream(itemKey)),
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
    listContinueWatching: async (limit, profileId) =>
      (await open()).listContinueWatching?.(limit, profileId) ?? [],
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
    listFavorites: async (limit, profileId) =>
      (await open()).listFavorites?.(limit, profileId) ?? [],
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
    listRecentChannels: async (limit, profileId) =>
      (await open()).listRecentChannels?.(limit, profileId) ?? [],
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
