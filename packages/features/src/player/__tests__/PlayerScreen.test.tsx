import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { FormFactorProvider, I18nProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';
import type { AppLifecyclePort, AppLifecycleState } from '../../ports/app-lifecycle';
import type { PlayTarget } from '../../ports/play-target';
import type { OpenVideoEngine, VideoHost } from '../../ports/video-host';
import { PlayerScreen } from '../PlayerScreen';
import { createManualClock } from './player-test-harness';

function createFakeLifecycle() {
  const listeners = new Set<(s: AppLifecycleState) => void>();
  const port: AppLifecyclePort = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    port,
    emit(state: AppLifecycleState) {
      for (const l of [...listeners]) l(state);
    },
  };
}

describe('PlayerScreen lifecycle', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('opens videoHost inside useEffect, tunes the stream, exits on button press, and releases on unmount', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const releaseSpy = jest.spyOn(engine, 'release');
    let openedCount = 0;

    const videoHost: VideoHost = {
      open: () => {
        openedCount += 1;
        return {
          engine,
          renderSurface: ({ testID }) => <View testID={testID ?? 'surface'} />,
        };
      },
    };

    const catalog = {
      resolveStream: jest.fn(async (key: string) =>
        ok({ url: `http://sim.example.test/${key}.ts`, headers: {} }),
      ),
    };

    const onExit = jest.fn();
    const target: PlayTarget = {
      itemKey: 'x:src-1:live:101',
      sourceId: 'src-1',
      title: '1. Channel Alpha',
      kind: 'live',
    };

    const view = await render(
      <FormFactorProvider value="desktop">
        <I18nProvider i18n={createAppI18n('en')}>
          <PlayerScreen
            catalog={catalog}
            videoHost={videoHost}
            target={target}
            clock={{ now: manual.now }}
            timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
            onExit={onExit}
          />
        </I18nProvider>
      </FormFactorProvider>,
    );

    expect(openedCount).toBe(1);
    await waitFor(() => {
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });

    await act(async () => {
      manual.advance(350);
    });
    expect(screen.getByTestId('osd-title')).toHaveTextContent('1. Channel Alpha');
    expect(screen.queryByTestId('osd-status')).toBeNull();

    await fireEvent.press(screen.getByTestId('player-back'));
    expect(onExit).toHaveBeenCalledTimes(1);

    await view.unmount();
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(engine.openMedias()).toBe(0);
  });

  it('places surfaceLayer in flex flow above PlayerOsd on desktop and uses absolute overlay on tv', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const videoHost: VideoHost = {
      open: () => ({
        engine,
        renderSurface: ({ testID }) => <View testID={testID ?? 'surface'} />,
      }),
    };
    const catalog = {
      resolveStream: jest.fn(async (key: string) =>
        ok({ url: `http://sim.example.test/${key}.ts`, headers: {} }),
      ),
    };
    const target: PlayTarget = {
      itemKey: 'x:src-1:live:101',
      sourceId: 'src-1',
      title: '1. Channel Alpha',
      kind: 'live',
    };

    const desktopView = await render(
      <FormFactorProvider value="desktop">
        <I18nProvider i18n={createAppI18n('en')}>
          <PlayerScreen
            catalog={catalog}
            videoHost={videoHost}
            target={target}
            clock={{ now: manual.now }}
            timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
            onExit={() => undefined}
          />
        </I18nProvider>
      </FormFactorProvider>,
    );

    const desktopLayer = screen.getByTestId('player-surface-layer');
    expect(desktopLayer.props.style).toEqual({ flex: 1 });
    await waitFor(() => {
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });
    await act(async () => {
      engine.emit({
        attempt: 1,
        type: 'tracks',
        tracks: {
          audio: [{ id: 'a:1', language: 'tur' }],
          subtitles: [{ id: 's:1', language: 'tur' }],
          selectedAudioId: 'a:1',
          selectedSubtitleId: null,
        },
      });
    });
    await fireEvent.press(screen.getByTestId('player-subtitles-button'));
    expect(screen.getByTestId('player-settings-panel')).toBeTruthy();
    expect(screen.getByTestId('player-surface-layer').props.style).toEqual({ flex: 1 });
    await desktopView.unmount();

    const tvEngine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const tvView = await render(
      <FormFactorProvider value="tv">
        <I18nProvider i18n={createAppI18n('en')}>
          <PlayerScreen
            catalog={catalog}
            videoHost={{
              open: () => ({
                engine: tvEngine,
                renderSurface: ({ testID }) => <View testID={testID ?? 'surface'} />,
              }),
            }}
            target={target}
            clock={{ now: manual.now }}
            timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
            onExit={() => undefined}
          />
        </I18nProvider>
      </FormFactorProvider>,
    );

    const tvLayer = screen.getByTestId('player-surface-layer');
    expect(tvLayer.props.style).toMatchObject({
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
    await tvView.unmount();
  });

  it('releases an async videoHost.open() engine immediately if unmounted before open() resolves', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const releaseSpy = jest.spyOn(engine, 'release');

    let resolveOpen!: (opened: OpenVideoEngine | null) => void;
    const videoHost: VideoHost = {
      open: () =>
        new Promise<OpenVideoEngine | null>((resolve) => {
          resolveOpen = resolve;
        }),
    };

    const catalog = {
      resolveStream: jest.fn(async () =>
        ok({ url: 'http://sim.example.test/101.ts', headers: {} }),
      ),
    };

    const view = await render(
      <FormFactorProvider value="desktop">
        <I18nProvider i18n={createAppI18n('en')}>
          <PlayerScreen
            catalog={catalog}
            videoHost={videoHost}
            target={{
              itemKey: 'x:src-1:live:101',
              sourceId: 'src-1',
              title: 'Channel Alpha',
              kind: 'live',
            }}
            onExit={jest.fn()}
          />
        </I18nProvider>
      </FormFactorProvider>,
    );

    await view.unmount();

    await act(async () => {
      resolveOpen({
        engine,
        renderSurface: () => null,
      });
    });

    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(engine.commands).toHaveLength(0);
    expect(catalog.resolveStream).not.toHaveBeenCalled();
  });

  it('stops the active stream on background and re-tunes on active (ignoring active when idle)', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const lifecycle = createFakeLifecycle();
    const catalog = {
      resolveStream: jest.fn(async () =>
        ok({ url: 'http://sim.example.test/live/101.ts', headers: {} }),
      ),
    };

    const view = await render(
      <FormFactorProvider value="tv">
        <I18nProvider i18n={createAppI18n('en')}>
          <PlayerScreen
            catalog={catalog}
            videoHost={{
              open: () => ({ engine, renderSurface: () => null }),
            }}
            appLifecycle={lifecycle.port}
            target={{
              itemKey: 'x:src-1:live:101',
              sourceId: 'src-1',
              title: 'Channel Alpha',
              kind: 'live',
            }}
            clock={{ now: manual.now }}
            timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
            onExit={jest.fn()}
          />
        </I18nProvider>
      </FormFactorProvider>,
    );

    await waitFor(() => {
      expect(engine.openMedias()).toBe(1);
    });
    await act(async () => {
      manual.advance(350);
    });
    expect(screen.queryByTestId('osd-status')).toBeNull();

    const loadsBefore = engine.commands.filter((c) => c.name === 'load').length;
    await act(async () => {
      lifecycle.emit('active');
    });
    expect(engine.commands.filter((c) => c.name === 'load')).toHaveLength(loadsBefore);

    await act(async () => {
      lifecycle.emit('background');
    });
    expect(engine.openMedias()).toBe(0);
    expect(screen.getByTestId('osd-status')).toHaveTextContent('Idle');

    await act(async () => {
      lifecycle.emit('active');
    });
    await waitFor(() => {
      expect(engine.openMedias()).toBe(1);
    });
    expect(engine.commands.filter((c) => c.name === 'load')).toHaveLength(loadsBefore + 1);

    await view.unmount();
  });
});
