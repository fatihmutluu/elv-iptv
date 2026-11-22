import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import type { LoadCommand } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { I18nProvider, ThemeProvider, TvRemoteProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { View } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import type { VideoSurfaceProps } from '../../ports/video-host';
import { PlayerScreen } from '../PlayerScreen';
import { createManualClock } from './player-test-harness';

function wrapPhone(children: ReactElement): ReactElement {
  return (
    <TvRemoteProvider>
      <ViewportProvider
        value={{ formFactor: 'phone', width: 852, height: 393, orientation: 'landscape' }}
      >
        <I18nProvider i18n={createAppI18n('en')}>
          <ThemeProvider preset="obsidianCrimson">{children}</ThemeProvider>
        </I18nProvider>
      </ViewportProvider>
    </TvRemoteProvider>
  );
}

describe('PlayerScreen Wave 5B wiring (#144, #147, #222, #262, #266)', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('forwards bufferPreset to load, useTextureView and surfaceRecreationToken to renderSurface (#144, #147, #262)', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      scripts: { 'http://sim.example.test/ch1.ts': [] },
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const loads: LoadCommand[] = [];
    const origLoad = engine.load.bind(engine);
    jest.spyOn(engine, 'load').mockImplementation((cmd) => {
      loads.push(cmd);
      origLoad(cmd);
    });

    const surfaceProps: VideoSurfaceProps[] = [];
    const catalog = {
      resolveStream: jest.fn(async () =>
        ok({ url: 'http://sim.example.test/ch1.ts', headers: {} }),
      ),
    };
    const target: PlayTarget = {
      itemKey: 'ch-1',
      sourceId: 'src-1',
      title: 'News HD',
      kind: 'live',
    };

    const view = await render(
      wrapPhone(
        <PlayerScreen
          catalog={catalog}
          videoHost={{
            open: () => ({
              engine,
              renderSurface: (props) => {
                surfaceProps.push(props);
                return <View testID={props.testID ?? 'surface'} />;
              },
            }),
          }}
          target={target}
          bufferPreset="large"
          useTextureView
          clock={{ now: manual.now }}
          timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
          onExit={jest.fn()}
        />,
      ),
    );

    await waitFor(() => {
      expect(loads.length).toBeGreaterThanOrEqual(1);
      expect(surfaceProps.at(-1)?.useTextureView).toBe(true);
    });

    const lastLoad = loads.at(-1);
    expect(lastLoad?.options?.bufferPreset).toBe('large');
    expect(surfaceProps.at(-1)?.surfaceRecreationToken).toBe(0);

    // 3 consecutive decoder errors trigger Rung 3 recreate -> surfaceRecreationToken increments to 1
    await act(async () => {
      const attempt = loads.at(-1)?.attempt ?? 1;
      engine.emit({ attempt, type: 'error', error: { code: 'decoder' } });
      manual.advance(0);
    });
    await act(async () => {
      const attempt = engine.commands.at(-1)?.attempt ?? 1;
      engine.emit({ attempt, type: 'error', error: { code: 'decoder' } });
      manual.advance(1_000);
    });
    await act(async () => {
      const attempt = engine.commands.at(-1)?.attempt ?? 1;
      engine.emit({ attempt, type: 'error', error: { code: 'decoder' } });
      manual.advance(2_000);
    });

    await waitFor(() => {
      expect(surfaceProps.at(-1)?.surfaceRecreationToken).toBe(1);
    });
    await view.unmount();
  });

  it('hides PlayerOsd, PlayerLockedOverlay, and PlayerStatsHud while in Picture-in-Picture (#266)', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const pipListeners = new Set<(inPip: boolean) => void>();
    const surfaceProps: VideoSurfaceProps[] = [];
    const catalog = {
      resolveStream: jest.fn(async () =>
        ok({ url: 'http://sim.example.test/movie.mp4', headers: {} }),
      ),
    };
    const target: PlayTarget = {
      itemKey: 'movie-1',
      sourceId: 'src-1',
      title: 'Demo Movie',
      kind: 'vod',
    };

    const view = await render(
      wrapPhone(
        <PlayerScreen
          catalog={catalog}
          videoHost={{
            open: () => ({
              engine,
              renderSurface: (props) => {
                surfaceProps.push(props);
                return <View testID={props.testID ?? 'surface'} />;
              },
              enterPictureInPicture: () => true,
              onPictureInPictureChange: (listener) => {
                pipListeners.add(listener);
                return () => {
                  pipListeners.delete(listener);
                };
              },
            }),
          }}
          target={target}
          clock={{ now: manual.now }}
          timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
          onExit={jest.fn()}
        />,
      ),
    );

    expect(await screen.findByTestId('player-osd')).toBeOnTheScreen();

    // Open Stats HUD, close settings sheet, and lock controls to verify ALL overlays hide in PiP
    await fireEvent.press(screen.getByTestId('player-settings-button'));
    await fireEvent.press(screen.getByTestId('player-stats-toggle'));
    await fireEvent.press(screen.getByTestId('player-settings-close'));
    expect(screen.getByTestId('player-stats-hud')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('player-lock-button'));
    expect(screen.getByTestId('player-locked-overlay')).toBeOnTheScreen();

    // Enter PiP -> pure clean video (no OSD, no lock overlay, no stats HUD, subtitle inset = 0)
    await act(async () => {
      for (const l of pipListeners) l(true);
    });
    expect(screen.queryByTestId('player-osd')).toBeNull();
    expect(screen.queryByTestId('player-locked-overlay')).toBeNull();
    expect(screen.queryByTestId('player-stats-hud')).toBeNull();
    expect(surfaceProps.at(-1)?.subtitleBottomInsetPx).toBe(0);

    // Exit PiP -> locked overlay & stats HUD restore cleanly
    await act(async () => {
      for (const l of pipListeners) l(false);
    });
    expect(screen.getByTestId('player-locked-overlay')).toBeOnTheScreen();
    expect(screen.getByTestId('player-stats-hud')).toBeOnTheScreen();

    await view.unmount();
    expect(pipListeners.size).toBe(0);
  });

  it('wires VOD bar scrubbing to engine.setScrubbing(true/false) and resets on unmount (#222)', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const catalog = {
      resolveStream: jest.fn(async () =>
        ok({ url: 'http://sim.example.test/vod.mp4', headers: {} }),
      ),
    };
    const target: PlayTarget = {
      itemKey: 'vod-1',
      sourceId: 'src-1',
      title: 'Scrub Movie',
      kind: 'vod',
    };

    const view = await render(
      wrapPhone(
        <PlayerScreen
          catalog={catalog}
          videoHost={{
            open: () => ({
              engine,
              renderSurface: () => <View testID="fake-surface" />,
            }),
          }}
          target={target}
          clock={{ now: manual.now }}
          timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
          onExit={jest.fn()}
        />,
      ),
    );

    await waitFor(() => {
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });
    const attempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
    await act(async () => {
      manual.advance(300);
      engine.emit({
        attempt,
        type: 'clock',
        anchor: { positionMs: 30_000, atMs: manual.now(), rate: 1, durationMs: 600_000 },
      });
    });

    const bar = await screen.findByTestId('player-progress-bar');
    await fireEvent(bar, 'layout', {
      nativeEvent: { layout: { width: 400, height: 24, x: 0, y: 0 } },
    });
    const touchScrubber = screen.getByTestId('player-progress-touch-scrubber');
    await act(async () => {
      fireEvent(touchScrubber, 'responderGrant', {
        nativeEvent: { locationX: 100, pageX: 100, identifier: 1 },
      });
    });
    expect(engine.commands.filter((c) => c.name === 'setScrubbing')).toEqual([
      { name: 'setScrubbing', attempt, scrubbing: true },
    ]);

    await act(async () => {
      fireEvent(touchScrubber, 'responderRelease', {
        nativeEvent: { locationX: 200, pageX: 200, identifier: 1 },
      });
    });
    expect(engine.commands.filter((c) => c.name === 'setScrubbing')).toEqual([
      { name: 'setScrubbing', attempt, scrubbing: true },
      { name: 'setScrubbing', attempt, scrubbing: false },
    ]);

    // Unmount while scrubbing -> guarantees setScrubbing(false)
    await act(async () => {
      fireEvent(touchScrubber, 'responderGrant', {
        nativeEvent: { locationX: 120, pageX: 120, identifier: 2 },
      });
    });
    await view.unmount();
    expect(engine.commands.filter((c) => c.name === 'setScrubbing').at(-1)).toEqual({
      name: 'setScrubbing',
      attempt,
      scrubbing: false,
    });
  });
});
