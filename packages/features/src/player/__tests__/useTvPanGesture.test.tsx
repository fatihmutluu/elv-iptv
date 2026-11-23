import type { PlayerEngine } from '@elv/playback';
import { act, renderHook } from '@testing-library/react-native';
import type { OpenVideoEngine, TvPanGestureEvent } from '../../ports/video-host';
import {
  computeTvPanScrubDeltaMs,
  TV_PAN_SCRUB_MS_PER_PT_MAX,
  TV_PAN_SCRUB_MS_PER_PT_MIN,
  type UseTvPanGestureOptions,
  useTvPanGesture,
} from '../useTvPanGesture';

function createFakeEngine() {
  const listeners = new Set<(event: TvPanGestureEvent) => void>();
  const setTvPanGestureEnabled = jest.fn<void, [boolean]>();
  const onTvPanGesture = jest.fn((listener: (event: TvPanGestureEvent) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
  const engine: OpenVideoEngine = {
    engine: {} as PlayerEngine,
    renderSurface: () => null,
    setTvPanGestureEnabled,
    onTvPanGesture,
  };
  const emit = (event: TvPanGestureEvent) => {
    for (const fn of listeners) fn(event);
  };
  return {
    engine,
    setTvPanGestureEnabled,
    onTvPanGesture,
    emit,
    activeCount: () => listeners.size,
  };
}

function defaultOptions(
  engine: OpenVideoEngine | undefined,
  overrides: Partial<UseTvPanGestureOptions> = {},
): UseTvPanGestureOptions {
  return {
    openedEngine: engine,
    isTv: true,
    hasService: true,
    isVod: true,
    hasChannelList: true,
    anySheetOpen: false,
    locked: false,
    stillWatchingVisible: false,
    durationMs: 3_600_000,
    onScrubPreview: jest.fn(),
    onScrubCommit: jest.fn(),
    onScrubCancel: jest.fn(),
    onOpenInfo: jest.fn(),
    onOpenChannelList: jest.fn(),
    ...overrides,
  };
}

describe('useTvPanGesture (#225)', () => {
  it('computes duration-scaled and clamped horizontal scrub deltas', () => {
    // 5-min clip -> clamped to min 120 ms/pt
    expect(computeTvPanScrubDeltaMs(10, 300_000)).toBe(10 * TV_PAN_SCRUB_MS_PER_PT_MIN);
    // 10-min clip -> 600_000 / 4000 = 150 ms/pt
    expect(computeTvPanScrubDeltaMs(10, 600_000)).toBe(1500);
    // 2-hour movie -> clamped to max 450 ms/pt
    expect(computeTvPanScrubDeltaMs(-20, 7_200_000)).toBe(-20 * TV_PAN_SCRUB_MS_PER_PT_MAX);
    // Bounded to [-durationMs, durationMs]
    expect(computeTvPanScrubDeltaMs(5_000, 10_000)).toBe(10_000);
    expect(computeTvPanScrubDeltaMs(-5_000, 10_000)).toBe(-10_000);
  });

  it('enables native pan capture only during unobstructed TV playback and disables on sheet/lock/prompt/unmount', async () => {
    const fake = createFakeEngine();
    const hook = await renderHook((props: UseTvPanGestureOptions) => useTvPanGesture(props), {
      initialProps: defaultOptions(fake.engine),
    });

    expect(fake.setTvPanGestureEnabled).toHaveBeenLastCalledWith(true);
    expect(fake.activeCount()).toBe(1);

    await hook.rerender(defaultOptions(fake.engine, { anySheetOpen: true }));
    expect(fake.setTvPanGestureEnabled).toHaveBeenLastCalledWith(false);

    await hook.rerender(defaultOptions(fake.engine, { anySheetOpen: false }));
    expect(fake.setTvPanGestureEnabled).toHaveBeenLastCalledWith(true);

    await hook.rerender(defaultOptions(fake.engine, { locked: true }));
    expect(fake.setTvPanGestureEnabled).toHaveBeenLastCalledWith(false);

    await hook.rerender(defaultOptions(fake.engine, { stillWatchingVisible: true }));
    expect(fake.setTvPanGestureEnabled).toHaveBeenLastCalledWith(false);

    await hook.rerender(defaultOptions(fake.engine));
    expect(fake.setTvPanGestureEnabled).toHaveBeenLastCalledWith(true);

    await hook.unmount();
    expect(fake.setTvPanGestureEnabled).toHaveBeenLastCalledWith(false);
    expect(fake.activeCount()).toBe(0);
  });

  it('drives VOD horizontal preview/commit/cancel scrubbing without opening drawers', async () => {
    const fake = createFakeEngine();
    const opts = defaultOptions(fake.engine, { durationMs: 600_000 }); // 150 ms/pt
    const hook = await renderHook(() => useTvPanGesture(opts));

    await act(async () => {
      fake.emit({ axis: 'horizontal', phase: 'began', translation: 20, velocity: 100 });
      fake.emit({ axis: 'horizontal', phase: 'changed', translation: 50, velocity: 120 });
      fake.emit({ axis: 'horizontal', phase: 'ended', translation: 60, velocity: 0 });
    });

    expect(opts.onScrubPreview).toHaveBeenNthCalledWith(1, 3000);
    expect(opts.onScrubPreview).toHaveBeenNthCalledWith(2, 7500);
    expect(opts.onScrubCommit).toHaveBeenCalledWith(9000);
    expect(opts.onScrubCancel).not.toHaveBeenCalled();
    expect(opts.onOpenInfo).not.toHaveBeenCalled();
    expect(opts.onOpenChannelList).not.toHaveBeenCalled();

    await act(async () => {
      fake.emit({ axis: 'horizontal', phase: 'began', translation: -10, velocity: -50 });
      fake.emit({ axis: 'horizontal', phase: 'cancelled', translation: -10, velocity: 0 });
    });
    expect(opts.onScrubCancel).toHaveBeenCalledTimes(1);

    await hook.unmount();
  });

  it('ignores horizontal pan events on live streams', async () => {
    const fake = createFakeEngine();
    const opts = defaultOptions(fake.engine, { isVod: false });
    const hook = await renderHook(() => useTvPanGesture(opts));

    await act(async () => {
      fake.emit({ axis: 'horizontal', phase: 'began', translation: 100, velocity: 200 });
      fake.emit({ axis: 'horizontal', phase: 'ended', translation: 100, velocity: 0 });
    });

    expect(opts.onScrubPreview).not.toHaveBeenCalled();
    expect(opts.onScrubCommit).not.toHaveBeenCalled();
    await hook.unmount();
  });

  it('routes vertical pans above threshold to Info (down) or Channel Drawer (up, fallback Info on VOD) without seeking', async () => {
    const fake = createFakeEngine();
    const opts = defaultOptions(fake.engine, { isVod: false, hasChannelList: true });
    const hook = await renderHook((p: UseTvPanGestureOptions) => useTvPanGesture(p), {
      initialProps: opts,
    });

    // Below threshold -> ignored
    await act(async () => {
      fake.emit({ axis: 'vertical', phase: 'ended', translation: 30, velocity: 100 });
    });
    expect(opts.onOpenInfo).not.toHaveBeenCalled();
    expect(opts.onOpenChannelList).not.toHaveBeenCalled();

    // Downward >= 48 pt -> Info
    await act(async () => {
      fake.emit({ axis: 'vertical', phase: 'ended', translation: 60, velocity: 50 });
    });
    expect(opts.onOpenInfo).toHaveBeenCalledTimes(1);

    // Upward velocity >= 280 -> Channel List
    await act(async () => {
      fake.emit({ axis: 'vertical', phase: 'ended', translation: -20, velocity: -320 });
    });
    expect(opts.onOpenChannelList).toHaveBeenCalledTimes(1);

    // VOD with no channel list: upward falls back to Info
    const vodOpts = defaultOptions(fake.engine, { isVod: true, hasChannelList: false });
    await hook.rerender(vodOpts);
    await act(async () => {
      fake.emit({ axis: 'vertical', phase: 'ended', translation: -64, velocity: -100 });
    });
    expect(vodOpts.onOpenInfo).toHaveBeenCalledTimes(1);
    expect(vodOpts.onOpenChannelList).not.toHaveBeenCalled();
    expect(vodOpts.onScrubPreview).not.toHaveBeenCalled();
    expect(vodOpts.onScrubCommit).not.toHaveBeenCalled();

    await hook.unmount();
  });

  it('cancels an active horizontal scrub if a sheet opens mid-gesture', async () => {
    const fake = createFakeEngine();
    const opts = defaultOptions(fake.engine);
    const hook = await renderHook((p: UseTvPanGestureOptions) => useTvPanGesture(p), {
      initialProps: opts,
    });

    await act(async () => {
      fake.emit({ axis: 'horizontal', phase: 'began', translation: 40, velocity: 80 });
    });
    expect(opts.onScrubPreview).toHaveBeenCalledTimes(1);

    await hook.rerender({ ...opts, anySheetOpen: true });
    expect(opts.onScrubCancel).toHaveBeenCalledTimes(1);

    await hook.unmount();
  });
});
