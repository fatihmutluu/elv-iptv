import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createFakePlayerEngine } from '@elv/playback/testing';
import {
  type FormFactor,
  FormFactorProvider,
  I18nProvider,
  ThemeProvider,
  TvRemoteProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import { PlayerScreen } from '../PlayerScreen';
import { createManualClock } from './player-test-harness';

const LIVE_TARGET: PlayTarget = {
  itemKey: 'x:src-1:live:101',
  sourceId: 'src-1',
  title: 'News Live',
  kind: 'live',
};

const VOD_TARGET: PlayTarget = {
  itemKey: 'x:src-1:vod:202',
  sourceId: 'src-1',
  title: 'Feature Film',
  kind: 'vod',
};

async function mountScreen(opts: { formFactor: FormFactor; target: PlayTarget }) {
  const manual = createManualClock();
  const clock = { now: manual.now };
  const timers = { setTimeout: manual.schedule, clearTimeout: manual.cancel };
  const engine = createFakePlayerEngine({
    now: manual.now,
    schedule: manual.schedule,
    cancel: manual.cancel,
    scripts: {},
  });
  const i18n = createAppI18n('en');
  const view = await render(
    <ThemeProvider>
      <I18nProvider i18n={i18n}>
        <FormFactorProvider value={opts.formFactor}>
          <ViewportProvider
            value={{
              width: opts.formFactor === 'phone' ? 393 : 1280,
              height: opts.formFactor === 'phone' ? 852 : 720,
              orientation: opts.formFactor === 'phone' ? 'portrait' : 'landscape',
              formFactor: opts.formFactor,
            }}
          >
            <TvRemoteProvider>
              <PlayerScreen
                target={opts.target}
                catalog={{
                  resolveStream: async () =>
                    ok({
                      url: 'http://provider.invalid/live/101.ts',
                      headers: {},
                      accountKey: 'src-1',
                      maxConnections: 1,
                    }),
                }}
                videoHost={{
                  open: () => ({
                    engine,
                    renderSurface: () => <View testID="fake-surface" />,
                  }),
                }}
                clock={clock}
                timers={timers}
                onExit={() => undefined}
              />
            </TvRemoteProvider>
          </ViewportProvider>
        </FormFactorProvider>
      </I18nProvider>
    </ThemeProvider>,
  );

  await waitFor(() => {
    expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
  });
  const attempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
  await act(async () => {
    engine.emit({ attempt, type: 'firstFrame', atMs: clock.now() });
    engine.emit({ attempt, type: 'state', state: 'playing' });
  });
  return { view, engine, clock, manual, attempt };
}

describe('PlayerScreen Jump to live button (#141)', () => {
  it('shows Jump to live ONLY on seekable or lagging > 15s live MPEG-TS, renders syncing feedback on press, disables duplicates, and clears on post-seek clock', async () => {
    const { view, engine, clock, attempt } = await mountScreen({
      formFactor: 'phone',
      target: LIVE_TARGET,
    });

    // HLS live (isLiveTs omitted, no seekable window) -> never shown
    await act(async () => {
      engine.emit({
        attempt,
        type: 'clock',
        anchor: { positionMs: 10_000, atMs: clock.now(), rate: 1, liveEdgeMs: 30_000 },
      });
    });
    expect(screen.queryByTestId('player-jump-to-live')).toBeNull();

    // Non-seekable live stream (timeShiftSupported: false) -> never shown
    await act(async () => {
      engine.emit({
        attempt,
        type: 'clock',
        anchor: {
          positionMs: 10_000,
          atMs: clock.now(),
          rate: 1,
          liveEdgeMs: 30_000,
          timeShiftSupported: false,
        },
      });
    });
    expect(screen.queryByTestId('player-jump-to-live')).toBeNull();

    // Bounded live time-shift within 12s normal readahead (8s behind) -> hidden (no false positive!)
    await act(async () => {
      engine.emit({
        attempt,
        type: 'clock',
        anchor: {
          positionMs: 52_000,
          atMs: clock.now(),
          rate: 1,
          liveSeekableStartMs: 0,
          liveEdgeMs: 60_000,
          timeShiftSupported: true,
        },
      });
    });
    expect(screen.queryByTestId('player-jump-to-live')).toBeNull();

    // Live MPEG-TS within 15s of live edge (10s behind) -> hidden
    await act(async () => {
      engine.emit({
        attempt,
        type: 'clock',
        anchor: {
          positionMs: 20_000,
          atMs: clock.now(),
          rate: 1,
          liveEdgeMs: 30_000,
          isLiveTs: true,
        },
      });
    });
    expect(screen.queryByTestId('player-jump-to-live')).toBeNull();

    // Live MPEG-TS lagging > 15s behind liveEdgeMs -> Jump to live appears
    await act(async () => {
      engine.emit({
        attempt,
        type: 'clock',
        anchor: {
          positionMs: 10_000,
          atMs: clock.now(),
          rate: 1,
          liveEdgeMs: 30_000,
          isLiveTs: true,
        },
      });
    });
    const jumpBtn = screen.getByTestId('player-jump-to-live');
    expect(jumpBtn).toHaveTextContent(/Jump to live/);

    // Pressing Jump to live seeks to liveEdgeMs - 1_000 (29_000), shows syncing spinner/label, and disables duplicates
    await fireEvent.press(jumpBtn);
    expect(engine.commands.at(-1)).toEqual({ name: 'seek', attempt, positionMs: 29_000 });
    const syncingBtn = screen.getByTestId('player-jump-to-live');
    expect(syncingBtn).toHaveTextContent(/Jumping to live/);
    expect(screen.getByTestId('player-jump-to-live-loading')).toBeTruthy();

    // Duplicate click while syncing is ignored
    const cmdCount = engine.commands.length;
    await fireEvent.press(syncingBtn);
    expect(engine.commands.length).toBe(cmdCount);

    // Next clock update confirming we're back at live edge clears syncing and hides button
    await act(async () => {
      engine.emit({
        attempt,
        type: 'clock',
        anchor: {
          positionMs: 29_500,
          atMs: clock.now() + 200,
          rate: 1,
          liveEdgeMs: 30_500,
          isLiveTs: true,
        },
      });
    });
    expect(screen.queryByTestId('player-jump-to-live')).toBeNull();

    await view.unmount();
  });

  it('renders Jump to live on DesktopCinemaBar, clears syncing after 4s safety timer, unpauses in 1 click, and hides on VOD', async () => {
    const desktop = await mountScreen({ formFactor: 'desktop', target: LIVE_TARGET });
    await act(async () => {
      desktop.engine.emit({
        attempt: desktop.attempt,
        type: 'clock',
        anchor: {
          positionMs: 5_000,
          atMs: desktop.clock.now(),
          rate: 1,
          liveEdgeMs: 25_000,
          isLiveTs: true,
        },
      });
    });
    const btn = screen.getByTestId('player-jump-to-live');
    expect(btn).toHaveTextContent(/Jump to live/);
    await fireEvent.press(btn);
    expect(desktop.engine.commands.at(-1)).toEqual({
      name: 'seek',
      attempt: desktop.attempt,
      positionMs: 24_000,
    });
    expect(screen.getByTestId('player-jump-to-live')).toHaveTextContent(/Jumping to live/);

    // 4_000 ms safety timer clears syncing even if engine never emits another clock
    await act(async () => {
      desktop.manual.advance(4_000);
    });
    expect(screen.queryByTestId('player-jump-to-live')).toBeNull();

    // Paused bounded time-shift stream jumps & unpauses cleanly in 1 click without extra attempt race
    await act(async () => {
      desktop.engine.emit({
        attempt: desktop.attempt,
        type: 'clock',
        anchor: {
          positionMs: 55_000,
          atMs: desktop.clock.now(),
          rate: 0,
          liveSeekableStartMs: 0,
          liveEdgeMs: 60_000,
          timeShiftSupported: true,
        },
      });
      desktop.engine.emit({ attempt: desktop.attempt, type: 'state', state: 'paused' });
    });
    const pausedBtn = screen.getByTestId('player-jump-to-live');
    await fireEvent.press(pausedBtn);
    expect(desktop.engine.commands.slice(-2)).toEqual([
      { name: 'seek', attempt: desktop.attempt, positionMs: 60_000 },
      { name: 'play', attempt: desktop.attempt },
    ]);
    expect(screen.getByTestId('player-jump-to-live')).toHaveTextContent(/Jumping to live/);

    // Playing confirmation clears syncing
    await act(async () => {
      desktop.engine.emit({ attempt: desktop.attempt, type: 'state', state: 'playing' });
    });
    expect(screen.queryByTestId('player-jump-to-live')).toBeNull();
    await desktop.view.unmount();

    // VOD must NEVER show Jump to live even if clock anchor carries isLiveTs: true
    const vod = await mountScreen({ formFactor: 'desktop', target: VOD_TARGET });
    await act(async () => {
      vod.engine.emit({
        attempt: vod.attempt,
        type: 'clock',
        anchor: {
          positionMs: 5_000,
          atMs: vod.clock.now(),
          rate: 1,
          durationMs: 120_000,
          liveEdgeMs: 120_000,
          isLiveTs: true,
        },
      });
    });
    expect(screen.queryByTestId('player-jump-to-live')).toBeNull();
    await vod.view.unmount();
  });
});
