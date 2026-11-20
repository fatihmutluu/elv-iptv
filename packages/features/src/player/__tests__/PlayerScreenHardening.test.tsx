import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { FormFactorProvider, I18nProvider, RemoteKeysProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, View } from 'react-native';
import type { AppLifecyclePort, AppLifecycleState } from '../../ports/app-lifecycle';
import type { PlayableEntry, PlayTarget } from '../../ports/play-target';
import { PlayerScreen } from '../PlayerScreen';
import { createFakeAndroidKeys, createManualClock } from './player-test-harness';

const KEYCODE_CHANNEL_UP = 166;

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

describe('PlayerScreen PR 5 hardening', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('saves VOD position before background stop, resumes at startMs across re-backgrounds, and clears it on item change', async () => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);

    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const loadSpy = jest.spyOn(engine, 'load');
    const videoHost = { open: () => ({ engine, renderSurface: () => null }) };
    const lifecycle = createFakeLifecycle();
    const catalog = {
      resolveStream: jest.fn(async (key: string) =>
        ok({ url: `http://sim.example.test/${key}.mp4`, headers: {} }),
      ),
    };

    const movieA: PlayTarget = {
      itemKey: 'x:src-1:vod:201',
      sourceId: 'src-1',
      title: 'Movie Alpha',
      kind: 'vod',
    };

    const view = await render(
      <FormFactorProvider value="tv">
        <I18nProvider i18n={createAppI18n('en')}>
          <PlayerScreen
            catalog={catalog}
            videoHost={videoHost}
            appLifecycle={lifecycle.port}
            target={movieA}
            clock={{ now: manual.now }}
            timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
            onExit={jest.fn()}
          />
        </I18nProvider>
      </FormFactorProvider>,
    );

    await waitFor(() => {
      expect(loadSpy).toHaveBeenCalledTimes(1);
    });
    expect(loadSpy.mock.calls[0]?.[0]).not.toHaveProperty('startMs');
    const firstAttempt = loadSpy.mock.calls[0]?.[0]?.attempt ?? 1;

    await act(async () => {
      manual.advance(350);
      engine.emit({
        attempt: firstAttempt,
        type: 'clock',
        anchor: { positionMs: 42_000, atMs: manual.now(), rate: 1, durationMs: 120_000 },
      });
      manual.advance(5_000);
    });

    await act(async () => {
      lifecycle.emit('background');
    });
    expect(engine.openMedias()).toBe(0);

    await act(async () => {
      lifecycle.emit('active');
    });
    await waitFor(() => {
      expect(loadSpy).toHaveBeenCalledTimes(2);
    });
    expect(loadSpy.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'vod',
      startMs: 47_000,
    });

    // Re-background while still tuning (anchor undefined) preserves the 47s resume point.
    await act(async () => {
      lifecycle.emit('background');
      lifecycle.emit('active');
    });
    await waitFor(() => {
      expect(loadSpy).toHaveBeenCalledTimes(3);
    });
    expect(loadSpy.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'vod',
      startMs: 47_000,
    });

    // Switching to a different movie clears the saved VOD position.
    await view.rerender(
      <FormFactorProvider value="tv">
        <I18nProvider i18n={createAppI18n('en')}>
          <PlayerScreen
            catalog={catalog}
            videoHost={videoHost}
            appLifecycle={lifecycle.port}
            target={{ ...movieA, itemKey: 'x:src-1:vod:202', title: 'Movie Beta' }}
            clock={{ now: manual.now }}
            timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
            onExit={jest.fn()}
          />
        </I18nProvider>
      </FormFactorProvider>,
    );
    await waitFor(() => {
      expect(loadSpy).toHaveBeenCalledTimes(4);
    });
    expect(loadSpy.mock.calls.at(-1)?.[0]).not.toHaveProperty('startMs');

    await view.unmount();
  });

  it('exits on desktop close host key and double-back close sequence even while TrackPickerModal is open', async () => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);

    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    let hostKeyListener: ((key: 'channel-up' | 'channel-down' | 'back') => void) | undefined;
    const onChangeIndex = jest.fn();
    const onExit = jest.fn();

    const view = await render(
      <FormFactorProvider value="desktop">
        <I18nProvider i18n={createAppI18n('en')}>
          <PlayerScreen
            catalog={{
              resolveStream: async (k) =>
                ok({ url: `http://sim.example.test/${k}.ts`, headers: {} }),
            }}
            videoHost={{
              open: () => ({
                engine,
                renderSurface: () => <View />,
                onHostKey: (listener) => {
                  hostKeyListener = listener;
                  return () => {
                    hostKeyListener = undefined;
                  };
                },
              }),
            }}
            target={{
              itemKey: 'ch-0',
              sourceId: 'src-1',
              title: 'Channel Zero',
              kind: 'live',
              playlist: {
                count: 2,
                currentIndex: 0,
                onChangeIndex,
                getAt: async (i) => ({
                  itemKey: `ch-${i}`,
                  sourceId: 'src-1',
                  title: `Channel ${i}`,
                  kind: 'live',
                }),
              },
            }}
            clock={{ now: manual.now }}
            timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
            onExit={onExit}
          />
        </I18nProvider>
      </FormFactorProvider>,
    );

    await waitFor(() => {
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });
    await act(async () => {
      engine.emit({
        attempt: 1,
        type: 'tracks',
        tracks: {
          audio: [{ id: 'a:1', language: 'eng' }],
          subtitles: [{ id: 's:1', language: 'eng' }],
          selectedAudioId: 'a:1',
          selectedSubtitleId: null,
        },
      });
    });

    await fireEvent.press(screen.getByTestId('player-tracks-button'));
    expect(screen.getByTestId('player-tracks-panel')).toBeTruthy();

    await act(async () => {
      (hostKeyListener as ((key: string) => void) | undefined)?.('close');
    });
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onChangeIndex).not.toHaveBeenCalled();

    expect(screen.getByTestId('player-tracks-panel')).toBeTruthy();
    await act(async () => {
      hostKeyListener?.('back');
      hostKeyListener?.('back');
    });
    expect(screen.queryByTestId('player-tracks-panel')).toBeNull();
    expect(onExit).toHaveBeenCalledTimes(2);

    await view.unmount();
  });

  it('coalesces held CH+ repeats at 450 ms while updating OSD immediately, guards playlistIndexRef on failed getAt, and syncs target.playlist updates', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const keys = createFakeAndroidKeys();
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });

    const entries: readonly PlayableEntry[] = [0, 1, 2, 3, 4].map((i) => ({
      itemKey: `ch-${i}`,
      sourceId: 'src-1',
      title: `Channel ${i}`,
      kind: 'live',
    }));
    let failIndex1 = true;
    const onChangeIndex = jest.fn();
    const catalog = {
      resolveStream: jest.fn(async (k: string) =>
        ok({ url: `http://sim.example.test/${k}.ts`, headers: {} }),
      ),
    };

    const singleItemTarget: PlayTarget = {
      ...(entries[0] as PlayableEntry),
      playlist: {
        count: 1,
        currentIndex: 0,
        onChangeIndex,
        getAt: async (i) => entries[i],
      },
    };
    const videoHost = { open: () => ({ engine, renderSurface: () => <View /> }) };

    const view = await render(
      <RemoteKeysProvider android={keys.source}>
        <FormFactorProvider value="tv">
          <I18nProvider i18n={createAppI18n('en')}>
            <PlayerScreen
              catalog={catalog}
              videoHost={videoHost}
              target={singleItemTarget}
              clock={{ now: manual.now }}
              timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
              onExit={jest.fn()}
            />
          </I18nProvider>
        </FormFactorProvider>
      </RemoteKeysProvider>,
    );

    await waitFor(() => {
      expect(catalog.resolveStream).toHaveBeenCalledWith('ch-0');
    });
    expect(screen.queryByTestId('player-next')).toBeNull();

    // Update target.playlist without changing target.itemKey: syncs canZap & playlist without re-tuning.
    const fullTarget: PlayTarget = {
      ...(entries[0] as PlayableEntry),
      playlist: {
        count: 5,
        currentIndex: 0,
        onChangeIndex,
        getAt: async (i) => {
          if (i === 1 && failIndex1) return undefined;
          return entries[i];
        },
      },
    };
    await view.rerender(
      <RemoteKeysProvider android={keys.source}>
        <FormFactorProvider value="tv">
          <I18nProvider i18n={createAppI18n('en')}>
            <PlayerScreen
              catalog={catalog}
              videoHost={videoHost}
              target={fullTarget}
              clock={{ now: manual.now }}
              timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
              onExit={jest.fn()}
            />
          </I18nProvider>
        </FormFactorProvider>
      </RemoteKeysProvider>,
    );
    expect(screen.getByTestId('player-next')).toBeTruthy();
    expect(catalog.resolveStream).toHaveBeenCalledTimes(1);

    // Failed getAt(1) does not advance playlistIndexRef: next isolated CH+ retries ch-1 immediately (0 ms).
    await act(async () => {
      keys.tap(KEYCODE_CHANNEL_UP);
    });
    expect(screen.getByTestId('osd-title')).toHaveTextContent('Channel 0');
    expect(onChangeIndex).not.toHaveBeenCalled();

    failIndex1 = false;
    await act(async () => {
      keys.tap(KEYCODE_CHANNEL_UP);
    });
    await waitFor(() => {
      expect(catalog.resolveStream).toHaveBeenLastCalledWith('ch-1');
    });
    expect(screen.getByTestId('osd-title')).toHaveTextContent('Channel 1');

    // Hold CH+: initial press tunes ch-2 immediately; held repeats step OSD through ch-3 -> ch-4 without tuning until 450 ms settles.
    await act(async () => {
      keys.down(KEYCODE_CHANNEL_UP);
    });
    await waitFor(() => {
      expect(catalog.resolveStream).toHaveBeenLastCalledWith('ch-2');
    });

    await act(async () => {
      jest.advanceTimersByTime(625);
    });
    await waitFor(() => {
      expect(screen.getByTestId('osd-title')).toHaveTextContent('Channel 3');
    });
    await act(async () => {
      jest.advanceTimersByTime(130);
    });
    await waitFor(() => {
      expect(screen.getByTestId('osd-title')).toHaveTextContent('Channel 4');
    });
    await act(async () => {
      keys.up(KEYCODE_CHANNEL_UP);
    });

    expect(catalog.resolveStream).not.toHaveBeenCalledWith('ch-3');
    expect(catalog.resolveStream).not.toHaveBeenCalledWith('ch-4');

    await act(async () => {
      manual.advance(449);
    });
    expect(catalog.resolveStream).not.toHaveBeenCalledWith('ch-4');

    await act(async () => {
      manual.advance(1);
    });
    await waitFor(() => {
      expect(catalog.resolveStream).toHaveBeenLastCalledWith('ch-4');
    });

    await view.unmount();
  });
});
