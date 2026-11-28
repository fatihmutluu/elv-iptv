import type {
  CatalogService,
  CategoryRow,
  FavoriteRow,
  ItemDetailRow,
  ItemRow,
  SourceRow,
} from '@elv/data';
import { describe, expect, it, vi } from 'vitest';
import { createCatalogUiCache } from '../shared';
import { runCatalogPrewarm } from './useCatalogPrewarm';

const SOURCE: SourceRow = {
  id: 'src-1',
  kind: 'xtream',
  name: 'Demo',
  createdAt: 100,
  needsImport: false,
};

function makeCategory(kind: 'live' | 'movie' | 'series', idx: number): CategoryRow {
  return {
    id: `src-1|${kind}|cat-${idx}`,
    sourceId: 'src-1',
    kind,
    name: `${kind}-${idx}`,
    position: idx,
    itemCount: 20,
  };
}

function makeItem(kind: 'live' | 'movie' | 'series', idx: number): ItemRow {
  return {
    id: idx,
    key: `x:src-1:${kind}:${idx}`,
    sourceId: 'src-1',
    providerId: String(idx),
    kind,
    name: `${kind} item ${idx}`,
    logo: null,
    rating: null,
    year: 2025,
    num: kind === 'live' ? idx : null,
  };
}

function createMockCatalog() {
  const categories = vi.fn(async (_sourceId: string, kind: 'live' | 'movie' | 'series') => [
    makeCategory(kind, 1),
    makeCategory(kind, 2),
  ]);
  const items = vi.fn(async (catId: string, _offset: number, _limit: number) => {
    const kind = catId.includes('|live|') ? 'live' : catId.includes('|movie|') ? 'movie' : 'series';
    return [makeItem(kind, 1), makeItem(kind, 2)];
  });
  const listContinueWatching = vi.fn(async () => []);
  const listFavorites = vi.fn(async (): Promise<FavoriteRow[]> => []);
  const listFavoriteKeys = vi.fn(async (): Promise<string[]> => []);
  const listProgressByKeys = vi.fn(async () => []);
  const itemDetail = vi.fn(async (_itemKey: string): Promise<ItemDetailRow | null> => null);

  const catalog = {
    categories,
    items,
    listContinueWatching,
    listFavorites,
    listFavoriteKeys,
    listProgressByKeys,
    itemDetail,
  } as unknown as CatalogService;

  return {
    catalog,
    categories,
    items,
    listContinueWatching,
    listFavorites,
    listFavoriteKeys,
    itemDetail,
  };
}

describe('runCatalogPrewarm', () => {
  it('prewarms Home, Live, Movies, and Series slices and never double-fetches already-warm slices', async () => {
    const mock = createMockCatalog();
    const uiCache = createCatalogUiCache({ revision: 1, locale: 'en' });

    await runCatalogPrewarm({
      catalog: mock.catalog,
      sources: [SOURCE],
      uiCache,
      isCancelled: () => false,
    });

    expect(uiCache.getHome()?.snapshot.movies).toHaveLength(2);
    expect(uiCache.getLive()?.hasLoadedCategories).toBe(true);
    expect(uiCache.getLive()?.hasLoadedFavorites).toBe(true);
    expect(uiCache.getLiveFirstChannels('src-1|live|cat-1')).toHaveLength(2);
    expect(uiCache.getCatalog('movie')?.categories).toHaveLength(2);
    expect(
      uiCache.getCatalog('movie')?.railItemsByCategoryId.get('src-1|movie|cat-1'),
    ).toHaveLength(2);
    expect(uiCache.getCatalog('series')?.categories).toHaveLength(2);
    expect(
      uiCache.getCatalog('series')?.railItemsByCategoryId.get('src-1|series|cat-1'),
    ).toHaveLength(2);

    const catCallsAfterFirst = mock.categories.mock.calls.length;
    const itemCallsAfterFirst = mock.items.mock.calls.length;

    // Second prewarm for same revision is a zero-fetch no-op
    await runCatalogPrewarm({
      catalog: mock.catalog,
      sources: [SOURCE],
      uiCache,
      isCancelled: () => false,
    });

    expect(mock.categories).toHaveBeenCalledTimes(catCallsAfterFirst);
    expect(mock.items).toHaveBeenCalledTimes(itemCallsAfterFirst);
  });

  it('aborts cleanly without writing stale slices when cancelled or revision advances mid-flight', async () => {
    const mock = createMockCatalog();
    const uiCache = createCatalogUiCache({ revision: 1, locale: 'en' });

    let cancelled = false;
    mock.categories.mockImplementationOnce(async () => {
      cancelled = true;
      return [makeCategory('live', 1)];
    });

    await runCatalogPrewarm({
      catalog: mock.catalog,
      sources: [SOURCE],
      uiCache,
      isCancelled: () => cancelled,
    });

    expect(uiCache.getHome()).toBeNull();
    expect(uiCache.getLive()).toBeNull();
    expect(uiCache.getCatalog('movie')).toBeNull();

    // Revision bump mid-flight also suppresses writes
    const uiCache2 = createCatalogUiCache({ revision: 2, locale: 'en' });
    mock.categories.mockImplementationOnce(async () => {
      uiCache2.setRevision(3, 'en');
      return [makeCategory('live', 1)];
    });
    await runCatalogPrewarm({
      catalog: mock.catalog,
      sources: [SOURCE],
      uiCache: uiCache2,
      isCancelled: () => false,
    });
    expect(uiCache2.getHome()).toBeNull();
    expect(uiCache2.getLive()).toBeNull();

    // Locale change mid-flight (same revision) also suppresses stale writes
    const uiCache3 = createCatalogUiCache({ revision: 5, locale: 'en' });
    mock.categories.mockImplementationOnce(async () => {
      uiCache3.setRevision(5, 'tr');
      return [makeCategory('live', 1)];
    });
    await runCatalogPrewarm({
      catalog: mock.catalog,
      sources: [SOURCE],
      uiCache: uiCache3,
      isCancelled: () => false,
    });
    expect(uiCache3.getHome()).toBeNull();
    expect(uiCache3.getLive()).toBeNull();
  });

  it('is a no-op when sources is empty or all sources still need import', async () => {
    const mock = createMockCatalog();
    const uiCache = createCatalogUiCache({ revision: 0, locale: 'en' });

    await runCatalogPrewarm({
      catalog: mock.catalog,
      sources: [],
      uiCache,
      isCancelled: () => false,
    });

    await runCatalogPrewarm({
      catalog: mock.catalog,
      sources: [{ ...SOURCE, needsImport: true }],
      uiCache,
      isCancelled: () => false,
    });

    expect(mock.categories).not.toHaveBeenCalled();
    expect(uiCache.getHome()).toBeNull();
  });

  it('warms activeTab immediately before yielding to idle for non-visible background tabs', async () => {
    const mock = createMockCatalog();
    const uiCache = createCatalogUiCache({ revision: 1, locale: 'en' });

    let releaseIdle: (() => void) | undefined;
    let idleCalled = false;
    const yieldToIdle = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          idleCalled = true;
          releaseIdle = resolve;
        }),
    );

    const runPromise = runCatalogPrewarm({
      catalog: mock.catalog,
      sources: [SOURCE],
      uiCache,
      activeTab: 'home',
      isCancelled: () => false,
      yieldToIdle,
    });

    // Wait until Home finishes and prewarm pauses at yieldToIdle
    await vi.waitFor(() => {
      expect(idleCalled).toBe(true);
    });

    // Active tab (Home) is already warm; non-visible tabs have NOT started yet
    expect(uiCache.getHome()).not.toBeNull();
    expect(uiCache.getLive()).toBeNull();
    expect(uiCache.getCatalog('movie')).toBeNull();
    expect(uiCache.getCatalog('series')).toBeNull();

    releaseIdle?.();
    await runPromise;

    expect(yieldToIdle).toHaveBeenCalledTimes(1);
    expect(uiCache.getLive()?.hasLoadedCategories).toBe(true);
    expect(uiCache.getCatalog('movie')?.categories).toHaveLength(2);
    expect(uiCache.getCatalog('series')?.categories).toHaveLength(2);
  });

  it('cancels background tabs cleanly when cancelled while yielded to idle', async () => {
    const mock = createMockCatalog();
    const uiCache = createCatalogUiCache({ revision: 1, locale: 'en' });

    let cancelled = false;
    await runCatalogPrewarm({
      catalog: mock.catalog,
      sources: [SOURCE],
      uiCache,
      activeTab: 'home',
      isCancelled: () => cancelled,
      yieldToIdle: async () => {
        cancelled = true;
      },
    });

    expect(uiCache.getHome()).not.toBeNull();
    expect(uiCache.getLive()).toBeNull();
    expect(uiCache.getCatalog('movie')).toBeNull();
    expect(uiCache.getCatalog('series')).toBeNull();
  });

  it('dedupes live favorites and bounds concurrent itemDetail calls to <= 8 per batch', async () => {
    const mock = createMockCatalog();
    const uiCache = createCatalogUiCache({ revision: 1, locale: 'en' });

    const favs: FavoriteRow[] = Array.from({ length: 22 }, (_, i) => ({
      profileId: 'default',
      itemKey: `x:src-1:live:${i % 20}`, // 2 duplicates + 20 unique live channels
      kind: 'live',
      sourceId: 'src-1',
      title: `Channel ${i}`,
      logo: null,
      rating: null,
      year: null,
      addedAt: 100 + i,
      sortOrder: i,
    }));
    mock.listFavorites.mockResolvedValue(favs);

    let activeCalls = 0;
    let peakCalls = 0;
    mock.itemDetail.mockImplementation(async (itemKey: string) => {
      activeCalls += 1;
      peakCalls = Math.max(peakCalls, activeCalls);
      await new Promise((r) => setTimeout(r, 2));
      activeCalls -= 1;
      return {
        ...makeItem('live', Number(itemKey.split(':').pop() ?? 0)),
        key: itemKey,
        plot: null,
      };
    });

    await runCatalogPrewarm({
      catalog: mock.catalog,
      sources: [SOURCE],
      uiCache,
      activeTab: 'live',
      isCancelled: () => false,
      yieldToIdle: () => Promise.resolve(),
    });

    expect(mock.itemDetail).toHaveBeenCalledTimes(20);
    expect(peakCalls).toBeLessThanOrEqual(8);
    expect(uiCache.getLive()?.favoriteChannels).toHaveLength(20);

    // Cancellation mid-batch stops remaining batches immediately
    const mock2 = createMockCatalog();
    const uiCache2 = createCatalogUiCache({ revision: 2, locale: 'en' });
    mock2.listFavorites.mockResolvedValue(favs);
    let cancelled = false;
    mock2.itemDetail.mockImplementation(async (itemKey: string) => {
      cancelled = true;
      return { ...makeItem('live', 1), key: itemKey, plot: null };
    });
    await runCatalogPrewarm({
      catalog: mock2.catalog,
      sources: [SOURCE],
      uiCache: uiCache2,
      activeTab: 'live',
      isCancelled: () => cancelled,
      yieldToIdle: () => Promise.resolve(),
    });
    expect(mock2.itemDetail).toHaveBeenCalledTimes(8);
    expect(uiCache2.getLive()?.hasLoadedFavorites).toBe(false);
  });
});
