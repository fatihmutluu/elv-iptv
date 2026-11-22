import type { NextEpisodeRow } from '@elv/data';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { PlayableEntry, PlayTarget } from '../../ports/play-target';
import {
  mapNextEpisodeRowToPlayableEntry,
  useNextEpisodeResolver,
} from '../useNextEpisodeResolver';

const INLINE_EP2: PlayableEntry = {
  itemKey: 'ep:1-2',
  sourceId: 'src-1',
  accountKey: 'fp:abc',
  title: 'Starlight — Episode 2',
  subtitle: 'S1 E2',
  kind: 'vod',
  itemKind: 'episode',
  seriesKey: 'ser:1',
  season: 1,
  episode: 2,
};

const EP_TARGET: PlayTarget = {
  itemKey: 'ep:1-10',
  sourceId: 'src-1',
  accountKey: 'fp:abc',
  title: 'Starlight — Finale',
  kind: 'vod',
  itemKind: 'episode',
  seriesKey: 'ser:1',
  season: 1,
  episode: 10,
};

const NEXT_SEASON_ROW: NextEpisodeRow = {
  id: 201,
  key: 'ep:2-1',
  sourceId: 'src-1',
  seriesKey: 'ser:1',
  seriesTitle: 'Starlight',
  logo: 'https://img.invalid/starlight.jpg',
  season: 2,
  episode: 1,
  title: 'New Horizon',
  durationSec: 2700,
};

describe('useNextEpisodeResolver (#392)', () => {
  it('maps NextEpisodeRow into PlayableEntry cleanly', () => {
    expect(mapNextEpisodeRowToPlayableEntry(NEXT_SEASON_ROW, EP_TARGET)).toEqual({
      itemKey: 'ep:2-1',
      sourceId: 'src-1',
      accountKey: 'fp:abc',
      title: 'Starlight — New Horizon',
      subtitle: 'S2 E1',
      kind: 'vod',
      itemKind: 'episode',
      seriesKey: 'ser:1',
      season: 2,
      episode: 1,
      logo: 'https://img.invalid/starlight.jpg',
    });
  });

  it('returns activeTarget.nextEpisodes[0] immediately without querying catalog', async () => {
    const queryNextEpisode = jest.fn();
    const hook = await renderHook(() =>
      useNextEpisodeResolver({
        catalog: { queryNextEpisode },
        activeTarget: { ...EP_TARGET, nextEpisodes: [INLINE_EP2] },
      }),
    );

    expect(hook.result.current).toEqual(INLINE_EP2);
    expect(queryNextEpisode).not.toHaveBeenCalled();
    await hook.unmount();
  });

  it('resolves cross-season next episode via catalog.queryNextEpisode and cancels stale resolutions on itemKey change', async () => {
    let resolveFirst!: (row: NextEpisodeRow | null) => void;
    const queryNextEpisode = jest.fn<Promise<NextEpisodeRow | null>, [string, string, string?]>(
      (_seriesKey, itemKey) =>
        new Promise((resolve) => {
          if (itemKey === 'ep:1-10') resolveFirst = resolve;
          else resolve(null);
        }),
    );

    const hook = await renderHook(
      (p: { target: PlayTarget }) =>
        useNextEpisodeResolver({
          catalog: { queryNextEpisode },
          activeTarget: p.target,
        }),
      { initialProps: { target: EP_TARGET } },
    );

    expect(hook.result.current).toBeUndefined();
    expect(queryNextEpisode).toHaveBeenCalledWith('ser:1', 'ep:1-10', undefined);

    await act(async () => {
      resolveFirst(NEXT_SEASON_ROW);
    });
    await waitFor(() => {
      expect(hook.result.current?.itemKey).toBe('ep:2-1');
    });
    expect(hook.result.current?.subtitle).toBe('S2 E1');

    // Switch to finale episode where DB returns null -> clears previous next-up immediately
    await hook.rerender({ target: { ...EP_TARGET, itemKey: 'ep:2-10', season: 2, episode: 10 } });
    expect(hook.result.current).toBeUndefined();
    await waitFor(() => {
      expect(queryNextEpisode).toHaveBeenCalledWith('ser:1', 'ep:2-10', undefined);
    });
    expect(hook.result.current).toBeUndefined();

    await hook.unmount();
  });

  it('returns undefined without querying for Live or non-series movies', async () => {
    const queryNextEpisode = jest.fn();
    const hook = await renderHook(() =>
      useNextEpisodeResolver({
        catalog: { queryNextEpisode },
        activeTarget: {
          itemKey: 'mov:1',
          sourceId: 'src-1',
          title: 'Standalone Movie',
          kind: 'vod',
        },
      }),
    );

    expect(hook.result.current).toBeUndefined();
    expect(queryNextEpisode).not.toHaveBeenCalled();
    await hook.unmount();
  });
});
