import { describe, expect, it, vi } from 'vitest';
import type { CatalogBridge } from '../../../src/shared/catalog-ipc.ts';
import { createDesktopCatalogFromBridge } from './desktop-catalog.ts';

describe('desktop-catalog my-list-new-episodes (#502)', () => {
  it('forwards new-episodes methods cleanly through createDesktopCatalogFromBridge', async () => {
    const listMyListNewEpisodes = vi.fn(async () => []);
    const dismissMyListNewEpisode = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const refreshMyListNewEpisodes = vi.fn(async () => ({
      ok: true as const,
      value: { checkedSeriesCount: 2, newlyDetectedCount: 1 },
    }));
    const bridge = {
      listMyListNewEpisodes,
      dismissMyListNewEpisode,
      refreshMyListNewEpisodes,
      close: vi.fn(async () => {}),
    } as unknown as CatalogBridge;

    const catalog = createDesktopCatalogFromBridge(bridge);
    await catalog.listMyListNewEpisodes?.(12, 'p1', { parentalUnlocked: true });
    await catalog.dismissMyListNewEpisode?.('ep-1', 'p1');
    const refreshed = await catalog.refreshMyListNewEpisodes?.('p1', { maxSeries: 5, force: true });

    expect(listMyListNewEpisodes).toHaveBeenCalledWith(12, 'p1', { parentalUnlocked: true });
    expect(dismissMyListNewEpisode).toHaveBeenCalledWith('ep-1', 'p1');
    expect(refreshMyListNewEpisodes).toHaveBeenCalledWith('p1', { maxSeries: 5, force: true });
    expect(refreshed).toEqual({
      ok: true,
      value: { checkedSeriesCount: 2, newlyDetectedCount: 1 },
    });
  });
});
