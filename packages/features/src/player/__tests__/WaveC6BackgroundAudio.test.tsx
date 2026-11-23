import { elvError, err, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createFakePlayerEngine } from '@elv/playback/testing';
import {
  type FormFactor,
  FormFactorProvider,
  I18nProvider,
  ThemeProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, render, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { View } from 'react-native';
import type { AppLifecyclePort, AppLifecycleState } from '../../ports/app-lifecycle';
import type { PlayTarget } from '../../ports/play-target';
import type { VideoHost } from '../../ports/video-host';
import { PlayerScreen, type PlayerScreenProps } from '../PlayerScreen';

function createControllableLifecycle(): {
  readonly port: AppLifecyclePort;
  emit: (state: AppLifecycleState) => void;
} {
  const listeners = new Set<(state: AppLifecycleState) => void>();
  return {
    port: {
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    emit(state) {
      for (const listener of [...listeners]) {
        listener(state);
      }
    },
  };
}

function wrap(formFactor: FormFactor, node: ReactElement): ReactElement {
  return (
    <ThemeProvider preset="obsidianCrimson">
      <I18nProvider i18n={createAppI18n('en')}>
        <FormFactorProvider value={formFactor}>
          <ViewportProvider
            value={{
              formFactor,
              orientation: formFactor === 'phone' ? 'portrait' : 'landscape',
              inputModality:
                formFactor === 'tv' ? 'tv' : formFactor === 'desktop' ? 'pointer' : 'touch',
              width: formFactor === 'phone' ? 390 : 1280,
              height: formFactor === 'phone' ? 844 : 720,
            }}
          >
            {node}
          </ViewportProvider>
        </FormFactorProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}

const LIVE_TARGET: PlayTarget = {
  itemKey: 'live:src-1:ch-1',
  sourceId: 'src-1',
  title: 'News 24',
  kind: 'live',
};

function createTestCatalog(): PlayerScreenProps['catalog'] {
  return {
    resolveStream: jest.fn(async () =>
      ok({
        url: 'http://example.invalid/live/ch-1.ts',
        headers: {},
      }),
    ),
    getProgress: jest.fn(async () => null),
    saveProgress: jest.fn(async () => err(elvError('storage', 'test-noop'))),
  };
}

describe('Wave C6 background audio handoff & engine forwarding (#412)', () => {
  it('keeps playback alive on background when backgroundAudioPlayback is true on phone and forwards to engine', async () => {
    const engine = createFakePlayerEngine({
      now: () => 1_000,
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    const stopSpy = jest.spyOn(engine, 'stop');
    const loadSpy = jest.spyOn(engine, 'load');
    const setBackgroundAudioEnabled = jest.fn<void, [boolean]>();
    const lifecycle = createControllableLifecycle();
    const videoHost: VideoHost = {
      open: () => ({
        engine,
        renderSurface: (props) => <View testID={props.testID ?? 'player-surface'} />,
        setBackgroundAudioEnabled,
      }),
    };

    const view = await render(
      wrap(
        'phone',
        <PlayerScreen
          catalog={createTestCatalog()}
          videoHost={videoHost}
          target={LIVE_TARGET}
          appLifecycle={lifecycle.port}
          backgroundAudioPlayback={true}
          onExit={jest.fn()}
        />,
      ),
    );

    await waitFor(() => {
      expect(loadSpy).toHaveBeenCalledTimes(1);
      expect(setBackgroundAudioEnabled).toHaveBeenLastCalledWith(true);
    });

    await act(async () => {
      engine.emit({ attempt: 1, type: 'state', state: 'playing' });
    });

    await act(async () => {
      lifecycle.emit('background');
    });
    expect(stopSpy).not.toHaveBeenCalled();

    await act(async () => {
      lifecycle.emit('active');
    });
    expect(loadSpy).toHaveBeenCalledTimes(1);

    await view.unmount();
  });

  it('stops playback immediately on background when backgroundAudioPlayback is false (default) on phone', async () => {
    const engine = createFakePlayerEngine({
      now: () => 1_000,
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    const stopSpy = jest.spyOn(engine, 'stop');
    const loadSpy = jest.spyOn(engine, 'load');
    const setBackgroundAudioEnabled = jest.fn<void, [boolean]>();
    const lifecycle = createControllableLifecycle();
    const videoHost: VideoHost = {
      open: () => ({
        engine,
        renderSurface: (props) => <View testID={props.testID ?? 'player-surface'} />,
        setBackgroundAudioEnabled,
      }),
    };

    const view = await render(
      wrap(
        'phone',
        <PlayerScreen
          catalog={createTestCatalog()}
          videoHost={videoHost}
          target={LIVE_TARGET}
          appLifecycle={lifecycle.port}
          backgroundAudioPlayback={false}
          onExit={jest.fn()}
        />,
      ),
    );

    await waitFor(() => {
      expect(loadSpy).toHaveBeenCalledTimes(1);
      expect(setBackgroundAudioEnabled).toHaveBeenLastCalledWith(false);
    });

    await act(async () => {
      engine.emit({ attempt: 1, type: 'state', state: 'playing' });
    });

    await act(async () => {
      lifecycle.emit('background');
    });
    expect(stopSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      lifecycle.emit('active');
    });
    await waitFor(() => {
      expect(loadSpy).toHaveBeenCalledTimes(2);
    });

    await view.unmount();
  });

  it.each<FormFactor>(['tv', 'desktop'])(
    'stops playback on background on %s even when backgroundAudioPlayback is true',
    async (formFactor) => {
      const engine = createFakePlayerEngine({
        now: () => 1_000,
        schedule: (fn, ms) => setTimeout(fn, ms),
        cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      });
      const stopSpy = jest.spyOn(engine, 'stop');
      const loadSpy = jest.spyOn(engine, 'load');
      const setBackgroundAudioEnabled = jest.fn<void, [boolean]>();
      const lifecycle = createControllableLifecycle();
      const videoHost: VideoHost = {
        open: () => ({
          engine,
          renderSurface: (props) => <View testID={props.testID ?? 'player-surface'} />,
          setBackgroundAudioEnabled,
        }),
      };

      const view = await render(
        wrap(
          formFactor,
          <PlayerScreen
            catalog={createTestCatalog()}
            videoHost={videoHost}
            target={LIVE_TARGET}
            appLifecycle={lifecycle.port}
            backgroundAudioPlayback={true}
            onExit={jest.fn()}
          />,
        ),
      );

      await waitFor(() => {
        expect(loadSpy).toHaveBeenCalledTimes(1);
        expect(setBackgroundAudioEnabled).toHaveBeenLastCalledWith(false);
      });

      await act(async () => {
        engine.emit({ attempt: 1, type: 'state', state: 'playing' });
      });

      await act(async () => {
        lifecycle.emit('background');
      });
      expect(stopSpy).toHaveBeenCalledTimes(1);

      await view.unmount();
    },
  );

  it('forwards live updates of backgroundAudioPlayback to OpenVideoEngine on tablet', async () => {
    const engine = createFakePlayerEngine({
      now: () => 1_000,
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    const setBackgroundAudioEnabled = jest.fn<void, [boolean]>();
    const lifecycle = createControllableLifecycle();
    const videoHost: VideoHost = {
      open: () => ({
        engine,
        renderSurface: (props) => <View testID={props.testID ?? 'player-surface'} />,
        setBackgroundAudioEnabled,
      }),
    };
    const catalog = createTestCatalog();
    const onExit = jest.fn();

    const view = await render(
      wrap(
        'tablet',
        <PlayerScreen
          catalog={catalog}
          videoHost={videoHost}
          target={LIVE_TARGET}
          appLifecycle={lifecycle.port}
          backgroundAudioPlayback={false}
          onExit={onExit}
        />,
      ),
    );

    await waitFor(() => {
      expect(setBackgroundAudioEnabled).toHaveBeenLastCalledWith(false);
    });

    await view.rerender(
      wrap(
        'tablet',
        <PlayerScreen
          catalog={catalog}
          videoHost={videoHost}
          target={LIVE_TARGET}
          appLifecycle={lifecycle.port}
          backgroundAudioPlayback={true}
          onExit={onExit}
        />,
      ),
    );

    await waitFor(() => {
      expect(setBackgroundAudioEnabled).toHaveBeenLastCalledWith(true);
    });

    await view.unmount();
  });
});
