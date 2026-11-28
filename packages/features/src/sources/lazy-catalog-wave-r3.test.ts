import { type CatalogService, createCatalogService, openCatalog } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { describe, expect, it, vi } from 'vitest';
import { createLazyCatalog } from './lazy-catalog';

describe('createLazyCatalog — Wave R3 recommendation dismissals', () => {
  it('delegates dismissRecommendation, restoreRecommendation, and listDismissedRecommendationKeys and falls back safely', async () => {
    const handle = testDb();
    await openCatalog(handle.db);
    const underlying = createCatalogService({
      db: handle.db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: {
        async get() {
          throw new Error('unused');
        },
      },
      clock: () => 50_000,
    });

    const lazy = createLazyCatalog(async () => underlying);
    await lazy.dismissRecommendation?.('x:s1:movie:1', 'movie', 'p1');
    expect(await lazy.listDismissedRecommendationKeys?.('p1')).toEqual(['x:s1:movie:1']);
    await lazy.restoreRecommendation?.('x:s1:movie:1', 'p1');
    expect(await lazy.listDismissedRecommendationKeys?.('p1')).toEqual([]);

    await lazy.close();
    handle.close();

    const minimal = {
      addSource: vi.fn(),
      addSourceFromLink: vi.fn(),
      removeSource: vi.fn(),
      importSource: vi.fn(),
      listSources: vi.fn(async () => []),
      categories: vi.fn(async () => []),
      items: vi.fn(async () => []),
      seasons: vi.fn(),
      episodes: vi.fn(async () => []),
      resolveStream: vi.fn(),
      close: vi.fn(async () => undefined),
    } as unknown as CatalogService;

    const lazyMin = createLazyCatalog(async () => minimal);
    await expect(lazyMin.dismissRecommendation?.('x:s1:movie:1', 'movie')).resolves.toBeUndefined();
    await expect(lazyMin.restoreRecommendation?.('x:s1:movie:1')).resolves.toBeUndefined();
    await expect(lazyMin.listDismissedRecommendationKeys?.()).resolves.toEqual([]);
  });
});
