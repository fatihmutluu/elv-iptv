import type { NowNextEntry } from '@elv/data';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { PLAYER_NOW_NEXT_REFRESH_MS, usePlayerNowNext } from '../usePlayerNowNext';

const ENTRY_1: NowNextEntry = {
  channelKey: 'ch:1',
  now: {
    channelKey: 'ch:1',
    sourceId: 'src-1',
    guideId: 'g:1',
    start: 1_000,
    stop: 3_601_000,
    title: 'Evening News',
    subTitle: null,
    description: 'Top stories.',
    episodeNum: null,
    icon: null,
    genre: null,
    flags: 0,
  },
  next: {
    channelKey: 'ch:1',
    sourceId: 'src-1',
    guideId: 'g:1',
    start: 3_601_000,
    stop: 7_201_000,
    title: 'Late Movie',
    subTitle: null,
    description: null,
    episodeNum: null,
    icon: null,
    genre: null,
    flags: 0,
  },
};

const ENTRY_2: NowNextEntry = {
  channelKey: 'ch:1',
  now: ENTRY_1.next,
  next: null,
};

describe('usePlayerNowNext & useChannelSchedulePreview (#58, #57)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('queries catalog.nowNext on mount, refreshes every 60s, and cleans up on unmount', async () => {
    const nowNext = jest
      .fn<Promise<NowNextEntry[]>, [readonly string[], number]>()
      .mockResolvedValueOnce([ENTRY_1])
      .mockResolvedValueOnce([ENTRY_2]);

    let fakeNow = 10_000;
    const hook = await renderHook(
      (p: { itemKey?: string; enabled: boolean }) =>
        usePlayerNowNext({
          catalog: { nowNext },
          itemKey: p.itemKey,
          enabled: p.enabled,
          clock: { now: () => fakeNow },
        }),
      { initialProps: { itemKey: 'ch:1', enabled: true } },
    );

    await waitFor(() => {
      expect(hook.result.current).toEqual(ENTRY_1);
    });
    expect(nowNext).toHaveBeenCalledTimes(1);
    expect(nowNext).toHaveBeenLastCalledWith(['ch:1'], 10_000);

    fakeNow = 70_000;
    await act(async () => {
      jest.advanceTimersByTime(PLAYER_NOW_NEXT_REFRESH_MS);
    });
    await waitFor(() => {
      expect(hook.result.current).toEqual(ENTRY_2);
    });
    expect(nowNext).toHaveBeenCalledTimes(2);
    expect(nowNext).toHaveBeenLastCalledWith(['ch:1'], 70_000);

    // Unmount stops periodic refresh
    await hook.unmount();
    await act(async () => {
      jest.advanceTimersByTime(PLAYER_NOW_NEXT_REFRESH_MS * 3);
    });
    expect(nowNext).toHaveBeenCalledTimes(2);
  });

  it('returns null without querying when disabled or catalog omits nowNext, and drops stale responses on itemKey change', async () => {
    let resolveFirst!: (rows: NowNextEntry[]) => void;
    const nowNext = jest.fn<Promise<NowNextEntry[]>, [readonly string[], number]>(
      (keys) =>
        new Promise((resolve) => {
          if (keys[0] === 'ch:1') resolveFirst = resolve;
          else resolve([{ channelKey: 'ch:2', now: null, next: null }]);
        }),
    );

    const hook = await renderHook(
      (p: { itemKey?: string; enabled: boolean }) =>
        usePlayerNowNext({
          catalog: { nowNext },
          itemKey: p.itemKey,
          enabled: p.enabled,
        }),
      { initialProps: { itemKey: 'ch:1', enabled: false } },
    );

    expect(hook.result.current).toBeNull();
    expect(nowNext).not.toHaveBeenCalled();

    await hook.rerender({ itemKey: 'ch:1', enabled: true });
    expect(nowNext).toHaveBeenCalledTimes(1);

    // Zap to ch:2 before ch:1 resolves
    await hook.rerender({ itemKey: 'ch:2', enabled: true });
    await waitFor(() => {
      expect(hook.result.current).toEqual({ channelKey: 'ch:2', now: null, next: null });
    });

    // Stale ch:1 response must not overwrite ch:2
    await act(async () => {
      resolveFirst([ENTRY_1]);
    });
    expect(hook.result.current?.channelKey).toBe('ch:2');

    await hook.unmount();
  });
});
