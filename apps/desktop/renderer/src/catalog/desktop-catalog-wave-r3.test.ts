import { describe, expect, it, vi } from 'vitest';
import type { CatalogBridge } from '../../../src/shared/catalog-ipc.ts';
import { createDesktopCatalogFromBridge } from './desktop-catalog.ts';

describe('createDesktopCatalogFromBridge — Wave R3 recommendation dismissals forwarding', () => {
  it('forwards dismissRecommendation, restoreRecommendation, and listDismissedRecommendationKeys', async () => {
    const dismissRecommendation = vi.fn(async () => undefined);
    const restoreRecommendation = vi.fn(async () => undefined);
    const listDismissedRecommendationKeys = vi.fn(async () => ['s1:movie:1']);

    const catalog = createDesktopCatalogFromBridge({
      dismissRecommendation,
      restoreRecommendation,
      listDismissedRecommendationKeys,
      close: async () => undefined,
    } as unknown as CatalogBridge);

    await catalog.dismissRecommendation?.('s1:movie:1', 'movie', 'kids');
    expect(dismissRecommendation).toHaveBeenCalledWith('s1:movie:1', 'movie', 'kids');

    expect(await catalog.listDismissedRecommendationKeys?.('kids')).toEqual(['s1:movie:1']);
    expect(listDismissedRecommendationKeys).toHaveBeenCalledWith('kids');

    await catalog.restoreRecommendation?.('s1:movie:1', 'kids');
    expect(restoreRecommendation).toHaveBeenCalledWith('s1:movie:1', 'kids');
  });

  it('falls back safely when optional Wave R3 bridge methods are absent', async () => {
    const catalog = createDesktopCatalogFromBridge({
      close: async () => undefined,
    } as unknown as CatalogBridge);

    await expect(catalog.dismissRecommendation?.('s1:movie:1', 'movie')).resolves.toBeUndefined();
    await expect(catalog.restoreRecommendation?.('s1:movie:1')).resolves.toBeUndefined();
    await expect(catalog.listDismissedRecommendationKeys?.()).resolves.toEqual([]);
  });
});
