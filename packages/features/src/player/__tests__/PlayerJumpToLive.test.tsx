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
  return { view, engine, clock, attempt };
}

describe('PlayerScreen Jump to live button (#141)', () => {
  it('shows Jump to live ONLY on lagging live MPEG-TS (never HLS or within 4s) and invokes jumpToLiveEdge on mobile OSD', async () => {
    const { view, engine, clock, attempt } = await mountScreen({
      formFactor: 'phone',
      target: LIVE_TARGET,
    });

    // HLS live (isLiveTs omitted) -> never shown
    await act(async () => {
      engine.emit({
        attempt,
        type: 'clock',
        anchor: { positionMs: 10_000, atMs: clock.now(), rate: 1, liveEdgeMs: 30_000 },
      });
    });
    expect(screen.queryByTestId('player-jump-to-live')).toBeNull();

    // HLS live (isLiveTs: false) -> never shown
    await act(async () => {
      engine.emit({
        attempt,
        type: 'clock',
        anchor: {
          positionMs: 10_000,
          atMs: clock.now(),
          rate: 1,
          liveEdgeMs: 30_000,
          isLiveTs: false,
        },
      });
    });
    expect(screen.queryByTestId('player-jump-to-live')).toBeNull();

    // Live MPEG-TS within 4s of live edge -> hidden
    await act(async () => {
      engine.emit({
        attempt,
        type: 'clock',
        anchor: {
          positionMs: 26_500,
          atMs: clock.now(),
          rate: 1,
          liveEdgeMs: 30_000,
          isLiveTs: true,
        },
      });
    });
    expect(screen.queryByTestId('player-jump-to-live')).toBeNull();

    // Live MPEG-TS lagging > 4s behind liveEdgeMs -> Jump to live appears
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

    // Pressing Jump to live seeks to liveEdgeMs - 3_000 (27_000) and hides button
    await fireEvent.press(jumpBtn);
    expect(engine.commands.at(-1)).toEqual({ name: 'seek', attempt, positionMs: 27_000 });
    expect(screen.queryByTestId('player-jump-to-live')).toBeNull();

    await view.unmount();
  });

  it('renders Jump to live on DesktopCinemaBar for lagging live MPEG-TS and hides it on VOD', async () => {
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
      positionMs: 22_000,
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
