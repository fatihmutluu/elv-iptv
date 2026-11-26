import { describe, expect, it } from 'vitest';
import type { CatalogBridge } from '../../../src/shared/catalog-ipc';
import { createDesktopCatalogFromBridge } from './desktop-catalog';

describe('desktop CatalogService reorderFavorites', () => {
  it('forwards reorderFavorites and falls back to storage/unsupported when bridge omits it', async () => {
    const calls: unknown[][] = [];
    const bridge = {
      reorderFavorites: async (orderedItemKeys: readonly string[], profileId?: string) => {
        calls.push([orderedItemKeys, profileId]);
        return { ok: true, value: undefined } as const;
      },
    } as unknown as CatalogBridge;
    const service = createDesktopCatalogFromBridge(bridge);
    expect(await service.reorderFavorites?.(['x:s1:live:2', 'x:s1:live:1'], 'kids')).toEqual({
      ok: true,
      value: undefined,
    });
    expect(calls).toEqual([[['x:s1:live:2', 'x:s1:live:1'], 'kids']]);

    const legacyService = createDesktopCatalogFromBridge({} as unknown as CatalogBridge);
    expect(await legacyService.reorderFavorites?.(['x:s1:live:1'])).toEqual({
      ok: false,
      error: { category: 'storage', code: 'unsupported' },
    });
  });

  it('forwards listWatched and falls back to empty array when bridge omits it', async () => {
    const calls: unknown[][] = [];
    const bridge = {
      listWatched: async (
        limit?: number,
        profileId?: string,
        opts?: { readonly kind?: 'movie' | 'series'; readonly parentalUnlocked?: boolean },
      ) => {
        calls.push([limit, profileId, opts]);
        return [];
      },
    } as unknown as CatalogBridge;
    const service = createDesktopCatalogFromBridge(bridge);
    expect(
      await service.listWatched?.(50, 'kids', { kind: 'series', parentalUnlocked: true }),
    ).toEqual([]);
    expect(calls).toEqual([[50, 'kids', { kind: 'series', parentalUnlocked: true }]]);

    const legacyService = createDesktopCatalogFromBridge({} as unknown as CatalogBridge);
    expect(await legacyService.listWatched?.(25, 'default', { kind: 'movie' })).toEqual([]);
  });
});
