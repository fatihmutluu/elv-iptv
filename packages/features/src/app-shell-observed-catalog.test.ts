import type { CatalogService } from '@elv/data';
import { elvError, err, ok } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import { createObservedCatalog } from './app-shell-observed-catalog';
import { createPlaybackGuard } from './ports/playback-guard';

describe('createObservedCatalog user-state mutation invalidation (#512)', () => {
  it('invokes onUserStateMutated when setRating, setFavorite, toggleFavorite, or setWatched succeeds and skips on error', async () => {
    const onUserStateMutated = vi.fn();
    const syncSourcesAndBump = vi.fn(async () => undefined);
    const playbackGuard = createPlaybackGuard(() => undefined);

    const setRating = vi
      .fn()
      .mockResolvedValueOnce(ok('like'))
      .mockResolvedValueOnce(err(elvError('storage', 'write-failed')));
    const setFavorite = vi
      .fn()
      .mockResolvedValueOnce(ok(true))
      .mockResolvedValueOnce(err(elvError('storage', 'write-failed')));
    const toggleFavorite = vi
      .fn()
      .mockResolvedValueOnce(ok(false))
      .mockResolvedValueOnce(err(elvError('storage', 'write-failed')));
    const setWatched = vi
      .fn()
      .mockResolvedValueOnce(ok(undefined))
      .mockResolvedValueOnce(err(elvError('storage', 'write-failed')));

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
      setRating,
      setFavorite,
      toggleFavorite,
      setWatched,
    } as unknown as CatalogService;

    const observed = createObservedCatalog(
      base,
      playbackGuard,
      syncSourcesAndBump,
      onUserStateMutated,
    );

    const ratingInput = {
      sourceId: 's1',
      itemKey: 'x:s1:movie:1',
      kind: 'movie' as const,
      title: 'Inception',
    };
    const favInput = {
      sourceId: 's1',
      itemKey: 'x:s1:movie:1',
      kind: 'movie' as const,
      title: 'Inception',
    };

    expect((await observed.setRating?.(ratingInput, 'like'))?.ok).toBe(true);
    expect(onUserStateMutated).toHaveBeenCalledTimes(1);
    expect((await observed.setRating?.(ratingInput, 'dislike'))?.ok).toBe(false);
    expect(onUserStateMutated).toHaveBeenCalledTimes(1);

    expect((await observed.setFavorite?.(favInput, true))?.ok).toBe(true);
    expect(onUserStateMutated).toHaveBeenCalledTimes(2);
    expect((await observed.setFavorite?.(favInput, false))?.ok).toBe(false);
    expect(onUserStateMutated).toHaveBeenCalledTimes(2);

    expect((await observed.toggleFavorite?.(favInput))?.ok).toBe(true);
    expect(onUserStateMutated).toHaveBeenCalledTimes(3);
    expect((await observed.toggleFavorite?.(favInput))?.ok).toBe(false);
    expect(onUserStateMutated).toHaveBeenCalledTimes(3);

    expect((await observed.setWatched?.('x:s1:movie:1', true))?.ok).toBe(true);
    expect(onUserStateMutated).toHaveBeenCalledTimes(4);
    expect((await observed.setWatched?.('x:s1:movie:1', false))?.ok).toBe(false);
    expect(onUserStateMutated).toHaveBeenCalledTimes(4);

    expect(syncSourcesAndBump).not.toHaveBeenCalled();
  });
});
