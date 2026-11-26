import { describe, expect, it, vi } from 'vitest';
import type { CatalogBridge } from '../../../src/shared/catalog-ipc.ts';
import { createDesktopCatalogFromBridge } from './desktop-catalog.ts';

describe('createDesktopCatalogFromBridge — ratings forwarding', () => {
  it('forwards setRating, getRating, listRatings, listRatingMap and sanitizes display title', async () => {
    const setRating = vi.fn(async () => ({ ok: true as const, value: 'like' as const }));
    const getRating = vi.fn(async () => 'like' as const);
    const listRatings = vi.fn(async () => []);
    const listRatingMap = vi.fn(async () => ({ 's1:movie:1': 'like' as const }));

    const catalog = createDesktopCatalogFromBridge({
      setRating,
      getRating,
      listRatings,
      listRatingMap,
      close: async () => undefined,
    } as unknown as CatalogBridge);

    expect(
      await catalog.setRating?.(
        { sourceId: 's1', itemKey: 's1:movie:1', kind: 'movie', title: '  Dune\u0007 ' },
        'like',
      ),
    ).toEqual({ ok: true, value: 'like' });
    expect(setRating).toHaveBeenCalledWith(
      { sourceId: 's1', itemKey: 's1:movie:1', kind: 'movie', title: 'Dune' },
      'like',
    );
    expect(await catalog.getRating?.('s1:movie:1', 'default')).toBe('like');
    expect(await catalog.listRatings?.({ value: 'like', limit: 20 })).toEqual([]);
    expect(await catalog.listRatingMap?.('default')).toEqual({ 's1:movie:1': 'like' });
  });
});
