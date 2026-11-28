import type { CatalogService } from '@elv/data';
import { ok } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import { createProfileScopedCatalog } from './profile-scoped-catalog';

describe('createProfileScopedCatalog — series & season watched forwarding', () => {
  it('injects active profileId by default and preserves explicit profileId override', async () => {
    const setSeasonWatched = vi.fn(async () => ok(5));
    const setSeriesWatched = vi.fn(async () => ok(12));

    const base = {
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
      setSeasonWatched,
      setSeriesWatched,
    } as unknown as CatalogService;

    let activeProfileId = 'kids';
    const scoped = createProfileScopedCatalog(base, () => ({
      profileId: activeProfileId,
      parentalUnlocked: false,
    }));

    expect(await scoped.setSeasonWatched?.('x:s1:series:1', 1, true)).toEqual(ok(5));
    expect(setSeasonWatched).toHaveBeenLastCalledWith('x:s1:series:1', 1, true, 'kids');

    expect(await scoped.setSeriesWatched?.('x:s1:series:1', false)).toEqual(ok(12));
    expect(setSeriesWatched).toHaveBeenLastCalledWith('x:s1:series:1', false, 'kids');

    activeProfileId = 'adult';
    expect(await scoped.setSeasonWatched?.('x:s1:series:1', 2, false, 'explicit-p')).toEqual(ok(5));
    expect(setSeasonWatched).toHaveBeenLastCalledWith('x:s1:series:1', 2, false, 'explicit-p');

    expect(await scoped.setSeriesWatched?.('x:s1:series:1', true, 'explicit-p')).toEqual(ok(12));
    expect(setSeriesWatched).toHaveBeenLastCalledWith('x:s1:series:1', true, 'explicit-p');
  });
});
