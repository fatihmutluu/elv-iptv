import { createAppI18n } from '@elv/i18n';
import {
  type ClockAnchor,
  EMPTY_TRACKS,
  type PlaybackService,
  type PlaybackState,
} from '@elv/playback';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { PlayerOsd } from '../PlayerScreenParts';
import { VodProgressBar } from '../VodProgressBar';

function createFakeService(anchor: ClockAnchor | undefined) {
  let state: PlaybackState = {
    status: { kind: 'playing' },
    attempt: 1,
    tracks: EMPTY_TRACKS,
    staleEventsDropped: 0,
    ...(anchor === undefined ? {} : { anchor }),
  };
  const listeners = new Set<(s: PlaybackState) => void>();
  const service = {
    getState: () => state,
    subscribe: (listener: (s: PlaybackState) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as PlaybackService;
  return {
    service,
    setAnchor(next: ClockAnchor | undefined): void {
      const { anchor: _drop, ...rest } = state;
      state = next === undefined ? rest : { ...rest, anchor: next };
      for (const listener of [...listeners]) listener(state);
    },
  };
}

const NOW = 10_000;
const clock = { now: () => NOW };
const PLAYING: ClockAnchor = { positionMs: 30_000, atMs: NOW, rate: 1, durationMs: 120_000 };
const PAUSED: ClockAnchor = { ...PLAYING, rate: 0 };

function osdProps(overrides: Partial<Parameters<typeof PlayerOsd>[0]> = {}) {
  return {
    title: 'Sample',
    statusLine: 'Playing',
    failure: null,
    isVod: false,
    isPausedOrEnded: false,
    canZap: false,
    hasTracks: false,
    showRetry: false,
    isTv: false,
    tvOsdFocused: false,
    tvOsdAction: 'playPause' as const,
    tracksOpen: false,
    i18n: createAppI18n('en'),
    service: null,
    clock,
    onExit: jest.fn(),
    onTogglePlayPause: jest.fn(),
    onSeekBack: jest.fn(),
    onSeekForward: jest.fn(),
    onSeekRatio: jest.fn(),
    onOpenTracks: jest.fn(),
    onPrev: jest.fn(),
    onNext: jest.fn(),
    onRetry: jest.fn(),
    ...overrides,
  };
}

describe('VodProgressBar and OsdClock gated ticking', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('requests animation frames only while the anchor advances', async () => {
    const raf = jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 7);
    const caf = jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const fake = createFakeService(undefined);
    const view = await render(
      <VodProgressBar
        service={fake.service}
        clock={clock}
        isTv={false}
        label="Progress"
        onSeekRatio={jest.fn()}
      />,
    );
    expect(raf).not.toHaveBeenCalled();
    expect(screen.getByTestId('player-progress-time')).toHaveTextContent('0:00 / --:--');

    await act(async () => {
      fake.setAnchor(PAUSED);
    });
    expect(raf).not.toHaveBeenCalled();
    expect(screen.getByTestId('player-progress-time')).toHaveTextContent('0:30 / 2:00');

    await act(async () => {
      fake.setAnchor(PLAYING);
    });
    expect(raf).toHaveBeenCalledTimes(1);

    await act(async () => {
      fake.setAnchor(PAUSED);
    });
    expect(caf).toHaveBeenCalledWith(7);
    expect(raf).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('shows the scrub preview position instead of the anchor position', async () => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const fake = createFakeService(PAUSED);
    await render(
      <VodProgressBar
        service={fake.service}
        clock={clock}
        isTv
        label="Progress"
        previewPositionMs={90_000}
        onSeekRatio={jest.fn()}
      />,
    );
    expect(screen.getByTestId('player-progress-time')).toHaveTextContent('1:30 / 2:00');
    expect(screen.getByTestId('player-progress-fill').props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ width: '75%' })]),
    );
  });

  it('seeks from the bar rectangle and clientX on web, with a click-through rail', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const fake = createFakeService(PAUSED);
    const onSeekRatio = jest.fn();
    await render(
      <VodProgressBar
        service={fake.service}
        clock={clock}
        isTv={false}
        label="Progress"
        onSeekRatio={onSeekRatio}
      />,
    );
    expect(screen.getByTestId('player-progress-rail').props.pointerEvents).toBe('none');
    await fireEvent.press(screen.getByTestId('player-progress-bar'), {
      nativeEvent: { clientX: 150, locationX: 3, offsetX: 3 },
      currentTarget: {
        blur: jest.fn(),
        getBoundingClientRect: () => ({ left: 50, width: 200 }),
      },
    });
    expect(onSeekRatio).toHaveBeenCalledWith(0.5);
  });

  it('wakes OsdClock on media-second boundaries only while playing', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const raf = jest.spyOn(globalThis, 'requestAnimationFrame');
    const timeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    const clearSpy = jest.spyOn(globalThis, 'clearTimeout');
    const secondTicks = () => timeoutSpy.mock.calls.filter(([, ms]) => ms === 1_001).length;
    let now = NOW;
    const movingClock = { now: () => now };
    const fake = createFakeService(PAUSED);
    const view = await render(
      <PlayerOsd {...osdProps({ service: fake.service, clock: movingClock })} />,
    );
    expect(screen.getByTestId('osd-clock')).toHaveTextContent('0:30');
    expect(secondTicks()).toBe(0);

    await act(async () => {
      fake.setAnchor(PLAYING);
    });
    expect(secondTicks()).toBe(1);
    expect(raf).not.toHaveBeenCalled();
    await act(async () => {
      now += 1_001;
      jest.advanceTimersByTime(1_001);
    });
    expect(screen.getByTestId('osd-clock')).toHaveTextContent('0:31');

    const clearsBefore = clearSpy.mock.calls.length;
    await act(async () => {
      fake.setAnchor(PAUSED);
    });
    expect(clearSpy.mock.calls.length).toBeGreaterThan(clearsBefore);
    const ticksWhilePaused = timeoutSpy.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    expect(timeoutSpy.mock.calls.slice(ticksWhilePaused).some(([, ms]) => (ms ?? 0) >= 999)).toBe(
      false,
    );
    expect(raf).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('hides the default TV focus ring on Retry while the track picker is open', async () => {
    const fake = createFakeService(PAUSED);
    const view = await render(
      <PlayerOsd {...osdProps({ service: fake.service, isTv: true, showRetry: true })} />,
    );
    expect(screen.getByTestId('player-retry').props.accessibilityState).toMatchObject({
      selected: true,
    });
    await view.rerender(
      <PlayerOsd
        {...osdProps({ service: fake.service, isTv: true, showRetry: true, tracksOpen: true })}
      />,
    );
    expect(screen.getByTestId('player-retry').props.accessibilityState).toMatchObject({
      selected: false,
    });
  });
});
