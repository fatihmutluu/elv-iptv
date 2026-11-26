import type { CatalogService, MyListNewEpisodeRow } from '@elv/data';
import { elvError, ok } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import { createLazyCatalog } from './lazy-catalog';

const SAMPLE_EPISODE: MyListNewEpisodeRow = {
  profileId: 'p1',
  episodeKey: 'x:s1:episode:205',
  seriesKey: 'x:s1:series:10',
  sourceId: 's1',
  seriesTitle: 'Starlight Harbor',
  seriesLogo: 'https://art.test/starlight.jpg',
  season: 2,
  episode: 5,
  episodeTitle: 'The Signal',
  detectedAt: 1_700_000_000_000,
};

function makeMinimalCatalog(overrides: Partial<CatalogService> = {}): CatalogService {
  return {
    addSource: vi.fn(),
    addSourceFromLink: vi.fn(),
    removeSource: vi.fn(),
    importSource: vi.fn(),
    listSources: vi.fn(async () => []),
    categories: vi.fn(async () => []),
    items: vi.fn(async () => []),
    seasons: vi.fn(async () => ok([])),
    episodes: vi.fn(async () => []),
    resolveStream: vi.fn(),
    close: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as CatalogService;
}

describe('createLazyCatalog My List new episodes forwarding (#502)', () => {
  it('forwards listMyListNewEpisodes, dismissMyListNewEpisode, and refreshMyListNewEpisodes with all args', async () => {
    const listMyListNewEpisodes = vi.fn(async () => [SAMPLE_EPISODE]);
    const dismissMyListNewEpisode = vi.fn(async () => ok(undefined));
    const refreshMyListNewEpisodes = vi.fn(async () =>
      ok({ checkedSeriesCount: 2, newlyDetectedCount: 1 }),
    );
    const lazy = createLazyCatalog(async () =>
      makeMinimalCatalog({
        listMyListNewEpisodes,
        dismissMyListNewEpisode,
        refreshMyListNewEpisodes,
      }),
    );

    const listed = await lazy.listMyListNewEpisodes?.(12, 'p1', { parentalUnlocked: true });
    expect(listed).toEqual([SAMPLE_EPISODE]);
    expect(listMyListNewEpisodes).toHaveBeenCalledWith(12, 'p1', { parentalUnlocked: true });

    const dismissed = await lazy.dismissMyListNewEpisode?.('x:s1:episode:205', 'p1');
    expect(dismissed).toEqual(ok(undefined));
    expect(dismissMyListNewEpisode).toHaveBeenCalledWith('x:s1:episode:205', 'p1');

    const refreshed = await lazy.refreshMyListNewEpisodes?.('p1', {
      cooldownMs: 60_000,
      maxSeries: 3,
      force: true,
    });
    expect(refreshed).toEqual(ok({ checkedSeriesCount: 2, newlyDetectedCount: 1 }));
    expect(refreshMyListNewEpisodes).toHaveBeenCalledWith('p1', {
      cooldownMs: 60_000,
      maxSeries: 3,
      force: true,
    });
  });

  it('returns safe fallbacks when underlying CatalogService omits new-episodes methods', async () => {
    const lazy = createLazyCatalog(async () => makeMinimalCatalog());

    expect(await lazy.listMyListNewEpisodes?.(24, 'default')).toEqual([]);
    expect(await lazy.dismissMyListNewEpisode?.('x:s1:episode:205')).toEqual({
      ok: false,
      error: elvError('storage', 'unsupported'),
    });
    expect(await lazy.refreshMyListNewEpisodes?.('default')).toEqual({
      ok: false,
      error: elvError('storage', 'unsupported'),
    });
  });

  it('converts opener rejections into typed storage errors for dismiss and refresh', async () => {
    const lazy = createLazyCatalog(async () => {
      throw Object.assign(new Error('bridge closed'), {
        error: elvError('storage', 'bridge-unavailable'),
      });
    });

    expect(await lazy.dismissMyListNewEpisode?.('x:s1:episode:205')).toEqual({
      ok: false,
      error: elvError('storage', 'bridge-unavailable'),
    });
    expect(await lazy.refreshMyListNewEpisodes?.()).toEqual({
      ok: false,
      error: elvError('storage', 'bridge-unavailable'),
    });
  });
});
