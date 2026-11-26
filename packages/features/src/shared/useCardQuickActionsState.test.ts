import type { CatalogService, ItemRow, RatingValue } from '@elv/data';
import { elvError, err, ok, type Result } from '@elv/domain';
import { act, createElement } from 'react';
import { createRoot } from 'test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { type CardQuickActionsState, useCardQuickActionsState } from './useCardQuickActionsState';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ITEM: ItemRow = {
  id: 1,
  key: 'x:s1:movie:1',
  kind: 'movie',
  sourceId: 's1',
  providerId: '1',
  name: 'Dune',
  logo: null,
  rating: 8.5,
  year: 2024,
  num: null,
};

function Probe({
  catalog,
  refreshToken = 0,
  userStateVersion = 0,
  onState,
}: {
  readonly catalog: CatalogService;
  readonly refreshToken?: number;
  readonly userStateVersion?: number;
  readonly onState: (state: CardQuickActionsState) => void;
}) {
  onState(useCardQuickActionsState({ catalog, refreshToken, userStateVersion }));
  return null;
}

describe('useCardQuickActionsState (#409)', () => {
  it('hydrates favoriteKeys, optimistically toggles favorite & watched, and rolls back on error or rejection', async () => {
    const listFavoriteKeys = vi.fn(async () => ['x:s1:movie:existing']);
    const setFavorite = vi.fn(
      async (_input: unknown, active: boolean): Promise<Result<boolean>> => ok(active),
    );
    const setWatched = vi.fn(async (): Promise<Result<void>> => ok(undefined));
    const catalog = { listFavoriteKeys, setFavorite, setWatched } as unknown as CatalogService;

    let state!: CardQuickActionsState;
    const root = createRoot();
    await act(async () => {
      root.render(
        createElement(Probe, {
          catalog,
          onState: (s) => {
            state = s;
          },
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(state.favoriteKeys.has('x:s1:movie:existing')).toBe(true);
    expect(state.favoriteKeys.has(ITEM.key)).toBe(false);

    // Successful favorite toggle -> adds, then removes
    await act(async () => {
      await state.toggleFavorite(ITEM);
    });
    expect(state.favoriteKeys.has(ITEM.key)).toBe(true);
    await act(async () => {
      await state.toggleFavorite(ITEM);
    });
    expect(state.favoriteKeys.has(ITEM.key)).toBe(false);

    // Error Result rolls back favorite
    setFavorite.mockResolvedValueOnce(err(elvError('storage', 'write-failed')));
    await act(async () => {
      await state.toggleFavorite(ITEM);
    });
    expect(state.favoriteKeys.has(ITEM.key)).toBe(false);

    // Rejected promise rolls back favorite
    setFavorite.mockRejectedValueOnce(new Error('sqlite-busy'));
    await act(async () => {
      await state.toggleFavorite(ITEM);
    });
    expect(state.favoriteKeys.has(ITEM.key)).toBe(false);

    // Watched toggle succeeds, then rolls back on error Result and rejection
    await act(async () => {
      await state.toggleWatched(ITEM, false);
    });
    expect(state.watchedOverrides.get(ITEM.key)).toBe(true);

    setWatched.mockResolvedValueOnce(err(elvError('storage', 'write-failed')));
    await act(async () => {
      await state.toggleWatched(ITEM, true);
    });
    expect(state.watchedOverrides.get(ITEM.key)).toBe(true);

    setWatched.mockRejectedValueOnce(new Error('sqlite-busy'));
    await act(async () => {
      await state.toggleWatched(ITEM, true);
    });
    expect(state.watchedOverrides.get(ITEM.key)).toBe(true);

    // Bumping userStateVersion clears settled watched overrides
    await act(async () => {
      root.render(
        createElement(Probe, {
          catalog,
          userStateVersion: 1,
          onState: (s) => {
            state = s;
          },
        }),
      );
      await Promise.resolve();
    });
    expect(state.watchedOverrides.size).toBe(0);

    act(() => {
      root.unmount();
    });
  });

  it('falls back cleanly to toggleFavorite / saveProgress and no-op catalog stubs', async () => {
    const toggleFavorite = vi.fn(async () => ok(true));
    const saveProgress = vi.fn(async () => ok({} as never));
    const catalog = { toggleFavorite, saveProgress } as unknown as CatalogService;
    let state!: CardQuickActionsState;
    const root = createRoot();

    await act(async () => {
      root.render(
        createElement(Probe, {
          catalog,
          onState: (s) => {
            state = s;
          },
        }),
      );
      await Promise.resolve();
    });

    await act(async () => {
      await state.toggleFavorite(ITEM);
      await state.toggleWatched(ITEM, false);
    });
    expect(toggleFavorite).toHaveBeenCalledTimes(1);
    expect(saveProgress).toHaveBeenCalledTimes(1);
    expect(state.favoriteKeys.has(ITEM.key)).toBe(true);
    expect(state.watchedOverrides.get(ITEM.key)).toBe(true);

    // No-op catalog (no mutation methods)
    const noopCatalog = {} as unknown as CatalogService;
    await act(async () => {
      root.render(
        createElement(Probe, {
          catalog: noopCatalog,
          onState: (s) => {
            state = s;
          },
        }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      await state.toggleFavorite(ITEM);
      await state.toggleWatched(ITEM, false);
    });
    expect(state.watchedOverrides.get(ITEM.key)).toBe(true);

    act(() => {
      root.unmount();
    });
  });

  it('hydrates ratingByKey, toggles like/dislike/clear with rollback, and ignores live items', async () => {
    const listRatingMap = vi.fn(async () => ({ 'x:s1:movie:existing': 'like' as RatingValue }));
    const setRating = vi.fn(
      async (_input: unknown, value: RatingValue | null): Promise<Result<RatingValue | null>> =>
        ok(value),
    );
    const catalog = { listRatingMap, setRating } as unknown as CatalogService;
    const liveItem: ItemRow = { ...ITEM, key: 'x:s1:live:9', kind: 'live', name: 'News HD' };

    let state!: CardQuickActionsState;
    const root = createRoot();
    await act(async () => {
      root.render(
        createElement(Probe, {
          catalog,
          onState: (s) => {
            state = s;
          },
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(state.ratingByKey.get('x:s1:movie:existing')).toBe('like');
    expect(state.ratingByKey.get(ITEM.key)).toBeUndefined();

    // Like -> Dislike -> Clear
    await act(async () => {
      await state.toggleRating(ITEM, 'like');
    });
    expect(state.ratingByKey.get(ITEM.key)).toBe('like');
    expect(setRating).toHaveBeenLastCalledWith(
      expect.objectContaining({ itemKey: ITEM.key }),
      'like',
    );

    await act(async () => {
      await state.toggleRating(ITEM, 'dislike');
    });
    expect(state.ratingByKey.get(ITEM.key)).toBe('dislike');
    expect(setRating).toHaveBeenLastCalledWith(
      expect.objectContaining({ itemKey: ITEM.key }),
      'dislike',
    );

    await act(async () => {
      await state.toggleRating(ITEM, 'dislike');
    });
    expect(state.ratingByKey.get(ITEM.key)).toBeUndefined();
    expect(setRating).toHaveBeenLastCalledWith(
      expect.objectContaining({ itemKey: ITEM.key }),
      null,
    );

    // Error Result & rejection roll back cleanly
    setRating.mockResolvedValueOnce(err(elvError('storage', 'write-failed')));
    await act(async () => {
      await state.toggleRating(ITEM, 'like');
    });
    expect(state.ratingByKey.get(ITEM.key)).toBeUndefined();

    setRating.mockRejectedValueOnce(new Error('sqlite-busy'));
    await act(async () => {
      await state.toggleRating(ITEM, 'dislike');
    });
    expect(state.ratingByKey.get(ITEM.key)).toBeUndefined();

    // Live TV items are strictly ignored
    const callsBeforeLive = setRating.mock.calls.length;
    await act(async () => {
      const okLive = await state.toggleRating(liveItem, 'like');
      expect(okLive).toBe(false);
    });
    expect(setRating.mock.calls.length).toBe(callsBeforeLive);
    expect(state.ratingByKey.get(liveItem.key)).toBeUndefined();

    act(() => {
      root.unmount();
    });
  });
});
