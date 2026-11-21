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
 */
export function createLazyCatalog(load: () => Promise<CatalogService>): CatalogService {
  return {
    addSource: (input) => wrapResult(async () => (await load()).addSource(input)),
    addSourceFromLink: (input) => wrapResult(async () => (await load()).addSourceFromLink(input)),
    removeSource: (id) => wrapResult(async () => (await load()).removeSource(id)),
    importSource: (id, opts) => wrapResult(async () => (await load()).importSource(id, opts)),
    listSources: async () => (await load()).listSources(),
    categories: async (sourceId, kind) => (await load()).categories(sourceId, kind),
    items: async (categoryId, offset, limit) => (await load()).items(categoryId, offset, limit),
    itemDetail: async (itemKey) => {
      const svc = await load();
      return svc.itemDetail ? svc.itemDetail(itemKey) : null;
    },
    search: async (query, opts) =>
      (await load()).search?.(query, opts) ?? { live: [], movies: [], series: [] },
    seasons: (seriesId) => wrapResult(async () => (await load()).seasons(seriesId)),
    episodes: async (seriesId, season) => (await load()).episodes(seriesId, season),
    resolveStream: (itemKey) => wrapResult(async () => (await load()).resolveStream(itemKey)),
    saveProgress: (input) =>
      wrapResult(async () => {
        const cat = await load();
        return cat.saveProgress ? cat.saveProgress(input) : err(elvError('storage', 'unsupported'));
      }),
    setWatched: (itemKey, watched, profileId) =>
      wrapResult(async () => {
        const cat = await load();
        return cat.setWatched
          ? cat.setWatched(itemKey, watched, profileId)
          : err(elvError('storage', 'unsupported'));
      }),
    getProgress: async (itemKey, profileId) =>
      (await load()).getProgress?.(itemKey, profileId) ?? null,
    listContinueWatching: async (limit, profileId) =>
      (await load()).listContinueWatching?.(limit, profileId) ?? [],
    listProgressByKeys: async (itemKeys, profileId) =>
      (await load()).listProgressByKeys?.(itemKeys, profileId) ?? [],
    clearProgress: (itemKey, profileId) =>
      wrapResult(async () => {
        const cat = await load();
        return cat.clearProgress
          ? cat.clearProgress(itemKey, profileId)
          : err(elvError('storage', 'unsupported'));
      }),
    toggleFavorite: (input) =>
      wrapResult(async () => {
        const cat = await load();
        return cat.toggleFavorite
          ? cat.toggleFavorite(input)
          : err(elvError('storage', 'unsupported'));
      }),
    listFavorites: async (limit, profileId) =>
      (await load()).listFavorites?.(limit, profileId) ?? [],
    listFavoriteKeys: async (profileId) => (await load()).listFavoriteKeys?.(profileId) ?? [],
    close: async () => {
      const cat = await load().catch(() => undefined);
      await cat?.close();
    },
  };
}
