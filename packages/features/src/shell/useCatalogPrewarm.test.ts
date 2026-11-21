import type { CatalogService, CategoryRow, ItemRow, SourceRow } from '@elv/data';
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
  const listFavorites = vi.fn(async () => []);
  const listFavoriteKeys = vi.fn(async () => []);
  const listProgressByKeys = vi.fn(async () => []);
  const itemDetail = vi.fn(async () => null);

  const catalog = {
    categories,
    items,
    listContinueWatching,
    listFavorites,
    listFavoriteKeys,
    listProgressByKeys,
    itemDetail,
  } as unknown as CatalogService;

  return { catalog, categories, items, listContinueWatching, listFavorites, listFavoriteKeys };
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
});
