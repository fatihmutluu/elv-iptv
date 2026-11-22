import { elvError, err, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createFakePlayerEngine, type FakeStep } from '@elv/playback/testing';
import { FormFactorProvider, I18nProvider, RemoteKeysProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, View } from 'react-native';
import type { PlayableEntry, PlayTarget } from '../../ports/play-target';
import { PlayerScreen } from '../PlayerScreen';
import { createFakeAndroidKeys, createManualClock } from './player-test-harness';

const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_CENTER = 23;
const KEYCODE_BACK = 4;
const KEYCODE_MENU = 82;
const KEYCODE_CHANNEL_UP = 166;
const KEYCODE_CHANNEL_DOWN = 167;

describe('PlayerScreen zapping and failure handling', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('zaps live channels with wrapping, supersedes stale async getAt calls, and keeps engine + OSD mounted once', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    const keys = createFakeAndroidKeys();
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    let openCalls = 0;

    const entry0: PlayableEntry = {
      itemKey: 'ch-0',
      sourceId: 'src-1',
      title: '1. Alpha',
      kind: 'live',
    };
    const entry1: PlayableEntry = {
      itemKey: 'ch-1',
      sourceId: 'src-1',
      title: '2. Beta',
      kind: 'live',
    };
    const entry2: PlayableEntry = {
      itemKey: 'ch-2',
      sourceId: 'src-1',
      title: '3. Gamma',
      kind: 'live',
    };
    const entries: readonly PlayableEntry[] = [entry0, entry1, entry2];

    let holdIndex1: ((entry: PlayableEntry | undefined) => void) | undefined;
    const onChangeIndex = jest.fn();
    const onTargetChange = jest.fn();

    const target: PlayTarget = {
      ...entry0,
      playlist: {
        count: 3,
        currentIndex: 0,
        onChangeIndex,
        getAt: (idx) => {
          if (idx === 1 && holdIndex1 === undefined) {
            return new Promise((resolve) => {
              holdIndex1 = resolve;
            });
          }
          return Promise.resolve(entries[idx]);
        },
      },
    };

    const catalog = {
      resolveStream: jest.fn(async (key: string) =>
        ok({ url: `http://sim.example.test/${key}.ts`, headers: {} }),
      ),
    };

    const view = await render(
      <RemoteKeysProvider android={keys.source}>
        <FormFactorProvider value="tv">
          <I18nProvider i18n={createAppI18n('en')}>
            <PlayerScreen
              catalog={catalog}
              videoHost={{
                open: () => {
                  openCalls += 1;
                  return { engine, renderSurface: () => <View testID="tv-surface" /> };
                },
              }}
              target={target}
              clock={{ now: manual.now }}
              timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
              onTargetChange={onTargetChange}
              onExit={jest.fn()}
            />
          </I18nProvider>
        </FormFactorProvider>
      </RemoteKeysProvider>,
    );

    await waitFor(() => {
      expect(catalog.resolveStream).toHaveBeenCalledWith('ch-0');
    });

    await act(async () => {
      keys.tap(KEYCODE_CHANNEL_UP);
      keys.tap(KEYCODE_DPAD_UP);
    });

    await waitFor(() => {
      expect(screen.getByTestId('osd-title')).toHaveTextContent('3. Gamma');
    });
    expect(onChangeIndex).toHaveBeenLastCalledWith(2);

    await act(async () => {
      holdIndex1?.(entry1);
    });
    expect(screen.getByTestId('osd-title')).toHaveTextContent('3. Gamma');
    expect(onChangeIndex).toHaveBeenLastCalledWith(2);

    await act(async () => {
      keys.tap(KEYCODE_CHANNEL_UP);
    });
    await waitFor(() => {
      expect(screen.getByTestId('osd-title')).toHaveTextContent('1. Alpha');
    });
    expect(onChangeIndex).toHaveBeenLastCalledWith(0);

    await act(async () => {
      keys.tap(KEYCODE_CHANNEL_DOWN);
    });
    await waitFor(() => {
      expect(screen.getByTestId('osd-title')).toHaveTextContent('3. Gamma');
    });
    expect(onChangeIndex).toHaveBeenLastCalledWith(2);
    expect(onTargetChange).toHaveBeenCalled();
    expect(openCalls).toBe(1);
    expect(engine.maxConcurrentMedias()).toBe(1);
    expect(screen.getByTestId('player-osd')).toBeTruthy();

    await view.unmount();
  });

  it('shows localized error + hint on failure, retries on Retry, and calls onExit on Back', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    const keys = createFakeAndroidKeys();
    const manual = createManualClock();

    const failSteps: readonly FakeStep[] = [
      { afterMs: 0, emit: 'error', error: { code: 'http-401' } },
    ];
    const okSteps: readonly FakeStep[] = [
      { afterMs: 0, emit: 'state', state: 'opening' },
      { afterMs: 10, emit: 'firstFrame' },
      { afterMs: 10, emit: 'state', state: 'playing' },
    ];

    let attemptNum = 0;
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
      scripts: {
        'http://sim.example.test/fail.ts': failSteps,
        'http://sim.example.test/ok.ts': okSteps,
      },
    });

    const onExit = jest.fn();
    const catalog = {
      resolveStream: jest.fn(async () => {
        attemptNum += 1;
        if (attemptNum === 1) {
          return err(elvError('auth', 'invalid-credentials'));
        }
        return ok({ url: 'http://sim.example.test/ok.ts', headers: {} });
      }),
    };

    const view = await render(
      <RemoteKeysProvider android={keys.source}>
        <FormFactorProvider value="tv">
          <I18nProvider i18n={createAppI18n('en')}>
            <PlayerScreen
              catalog={catalog}
              videoHost={{ open: () => ({ engine, renderSurface: () => null }) }}
              target={{
                itemKey: 'x:src-1:vod:201',
                sourceId: 'src-1',
                title: 'Synthetic Movie One',
                kind: 'vod',
              }}
              clock={{ now: manual.now }}
              timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
              onExit={onExit}
            />
          </I18nProvider>
        </FormFactorProvider>
      </RemoteKeysProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('osd-error-hint')).toBeTruthy();
    });
    expect(screen.getByTestId('osd-status')).toHaveTextContent('Sign-in failed for this stream.');
    expect(screen.getByTestId('player-retry')).toBeTruthy();

    await act(async () => {
      keys.tap(KEYCODE_DPAD_CENTER);
    });
    await waitFor(() => {
      expect(catalog.resolveStream).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      manual.advance(50);
    });
    expect(screen.queryByTestId('osd-status')).toBeNull();

    await act(async () => {
      keys.tap(KEYCODE_BACK);
      keys.tap(KEYCODE_DPAD_DOWN);
    });
    expect(onExit).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByTestId('player-back'));
    expect(onExit).toHaveBeenCalledTimes(2);

    await view.unmount();
  });

  it('opens TrackPickerModal on live TV via Menu without colliding with Up/Down channel zapping', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    const keys = createFakeAndroidKeys();
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const onChangeIndex = jest.fn();

    const view = await render(
      <RemoteKeysProvider android={keys.source}>
        <FormFactorProvider value="tv">
          <I18nProvider i18n={createAppI18n('en')}>
            <PlayerScreen
              catalog={{
                resolveStream: async (k) =>
                  ok({ url: `http://sim.example.test/${k}.ts`, headers: {} }),
              }}
              videoHost={{ open: () => ({ engine, renderSurface: () => <View /> }) }}
              target={{
                itemKey: 'ch-0',
                sourceId: 'src-1',
                title: 'Live Multi-Track',
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
              onExit={jest.fn()}
            />
          </I18nProvider>
        </FormFactorProvider>
      </RemoteKeysProvider>,
    );

    await waitFor(() => {
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });
    const attempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
    await act(async () => {
      engine.emit({
        attempt,
        type: 'tracks',
        tracks: {
          audio: [
            { id: 'a:1', language: 'tur' },
            { id: 'a:2', language: 'eng' },
          ],
          subtitles: [{ id: 's:1', language: 'tur' }],
          selectedAudioId: 'a:1',
          selectedSubtitleId: null,
        },
      });
    });

    expect(screen.queryByTestId('player-progress-bar')).toBeNull();
    expect(screen.queryByTestId('player-play-pause')).toBeNull();

    await act(async () => {
      keys.tap(KEYCODE_MENU);
    });
    expect(screen.getByTestId('player-tracks-panel')).toBeTruthy();

    await act(async () => {
      keys.tap(KEYCODE_DPAD_DOWN);
    });
    await act(async () => {
      keys.tap(KEYCODE_DPAD_CENTER);
    });
    expect(onChangeIndex).not.toHaveBeenCalled();
    expect(engine.commands.filter((c) => c.name === 'selectAudioTrack').at(-1)?.trackId).toBe(
      'a:2',
    );

    await view.unmount();
  });
});
