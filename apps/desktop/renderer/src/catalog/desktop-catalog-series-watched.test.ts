import { ok } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogBridge } from '../../../src/shared/catalog-ipc.ts';
import { createDesktopCatalogFromBridge } from './desktop-catalog.ts';

describe('createDesktopCatalogFromBridge — series & season watched forwarding', () => {
  it('forwards setSeasonWatched and setSeriesWatched to the preload bridge', async () => {
    const setSeasonWatched = vi.fn(async () => ok(6));
    const setSeriesWatched = vi.fn(async () => ok(14));

    const catalog = createDesktopCatalogFromBridge({
      setSeasonWatched,
      setSeriesWatched,
      close: async () => undefined,
    } as unknown as CatalogBridge);

    expect(await catalog.setSeasonWatched?.('x:s1:series:5', 2, true, 'default')).toEqual(ok(6));
    expect(setSeasonWatched).toHaveBeenCalledWith('x:s1:series:5', 2, true, 'default');

    expect(await catalog.setSeriesWatched?.('x:s1:series:5', false, 'kids')).toEqual(ok(14));
    expect(setSeriesWatched).toHaveBeenCalledWith('x:s1:series:5', false, 'kids');
  });

  it('returns storage/unsupported cleanly when a legacy preload bridge omits series watched methods', async () => {
    const catalog = createDesktopCatalogFromBridge({
      close: async () => undefined,
    } as unknown as CatalogBridge);

    expect(await catalog.setSeasonWatched?.('x:s1:series:5', 1, true)).toMatchObject({
      ok: false,
      error: { category: 'storage', code: 'unsupported' },
    });
    expect(await catalog.setSeriesWatched?.('x:s1:series:5', true)).toMatchObject({
      ok: false,
      error: { category: 'storage', code: 'unsupported' },
    });
  });
});
