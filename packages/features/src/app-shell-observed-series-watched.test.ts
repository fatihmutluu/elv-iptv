import type { CatalogService } from '@elv/data';
import { elvError, err, ok } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import { createObservedCatalog } from './app-shell-observed-catalog';
import { createPlaybackGuard } from './ports/playback-guard';

describe('createObservedCatalog — series & season watched invalidation', () => {
  it('invokes onUserStateMutated on ok, skips on err, and never triggers syncSourcesAndBump', async () => {
    const onUserStateMutated = vi.fn();
    const syncSourcesAndBump = vi.fn(async () => undefined);
    const playbackGuard = createPlaybackGuard(() => undefined);

    const setSeasonWatched = vi
      .fn()
      .mockResolvedValueOnce(ok(6))
      .mockResolvedValueOnce(err(elvError('storage', 'write-failed')));
    const setSeriesWatched = vi
      .fn()
      .mockResolvedValueOnce(ok(18))
      .mockResolvedValueOnce(err(elvError('network', 'unreachable')));

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

    const observed = createObservedCatalog(
      base,
      playbackGuard,
      syncSourcesAndBump,
      onUserStateMutated,
    );

    expect(await observed.setSeasonWatched?.('x:s1:series:1', 1, true, 'default')).toEqual(ok(6));
    expect(onUserStateMutated).toHaveBeenCalledTimes(1);

    expect((await observed.setSeasonWatched?.('x:s1:series:1', 1, false, 'default'))?.ok).toBe(
      false,
    );
    expect(onUserStateMutated).toHaveBeenCalledTimes(1);

    expect(await observed.setSeriesWatched?.('x:s1:series:1', true, 'default')).toEqual(ok(18));
    expect(onUserStateMutated).toHaveBeenCalledTimes(2);

    expect((await observed.setSeriesWatched?.('x:s1:series:1', false, 'default'))?.ok).toBe(false);
    expect(onUserStateMutated).toHaveBeenCalledTimes(2);

    expect(syncSourcesAndBump).not.toHaveBeenCalled();
  });
});
