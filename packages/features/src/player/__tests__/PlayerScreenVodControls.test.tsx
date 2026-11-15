import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import type { MediaTracks } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { type FormFactor, FormFactorProvider, I18nProvider, RemoteKeysProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, View } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import { PlayerScreen } from '../PlayerScreen';
import { createFakeAndroidKeys, createManualClock } from './player-test-harness';

const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_LEFT = 21;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;
const KEYCODE_BACK = 4;

const MULTI_TRACKS: MediaTracks = {
  audio: [
    { id: 'a:1', language: 'tur', label: 'Turkish', codec: 'aac', channels: 2 },
    { id: 'a:2', language: 'eng', label: 'English', codec: 'aac', channels: 2 },
  ],
  subtitles: [
    { id: 's:1', language: 'tur', codec: 'subrip' },
    { id: 's:2', language: 'eng', codec: 'subrip' },
  ],
  selectedAudioId: 'a:1',
  selectedSubtitleId: null,
};

describe('PlayerScreen VOD controls, hold-seek, and track picker', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('pauses and resumes VOD on TV OK, extrapolates and freezes VodProgressBar, steps +/-10s, and hold-repeats +30s', async () => {
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

    const catalog = {
      resolveStream: jest.fn(async () =>
        ok({ url: 'http://sim.example.test/movie/200011.mkv', headers: {} }),
      ),
    };
    const target: PlayTarget = {
      itemKey: 'x:src-1:vod:200011',
      sourceId: 'src-1',
      title: 'Two audio tracks and subtitles (MKV)',
      kind: 'vod',
    };

    const view = await render(
      <RemoteKeysProvider android={keys.source}>
        <FormFactorProvider value="tv">
          <I18nProvider i18n={createAppI18n('en')}>
            <PlayerScreen
              catalog={catalog}
              videoHost={{ open: () => ({ engine, renderSurface: () => <View /> }) }}
              target={target}
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

    await act(async () => {
      manual.advance(350);
    });
    expect(screen.getByTestId('osd-status')).toHaveTextContent('Playing');

    const loadAttempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
    await act(async () => {
      engine.emit({
        attempt: loadAttempt,
        type: 'clock',
        anchor: { positionMs: 5_000, atMs: manual.now(), rate: 1, durationMs: 100_000 },
      });
    });
    expect(screen.getByTestId('player-progress-time')).toHaveTextContent('0:05 / 1:40');

    // Extrapolate 3s forward while playing -> OK pauses and freezes at 0:08
    await act(async () => {
      manual.advance(3_000);
      keys.tap(KEYCODE_DPAD_CENTER);
    });
    const pauseCmd = engine.commands.filter((c) => c.name === 'pause').at(-1);
    expect(pauseCmd).toBeDefined();
    await act(async () => {
      engine.emit({ attempt: pauseCmd?.attempt ?? 2, type: 'state', state: 'paused' });
      manual.advance(4_000);
    });
    expect(screen.getByTestId('osd-status')).toHaveTextContent('Paused');
    expect(screen.getByTestId('player-progress-time')).toHaveTextContent('0:08 / 1:40');

    // Left tap (-10s) clamps at 0:00
    await act(async () => {
      keys.tap(KEYCODE_DPAD_LEFT);
    });
    expect(engine.commands.filter((c) => c.name === 'seek').at(-1)?.positionMs).toBe(0);
    expect(screen.getByTestId('player-progress-time')).toHaveTextContent('0:00 / 1:40');

    // Right tap (+10s) steps to 10_000 ms
    await act(async () => {
      keys.tap(KEYCODE_DPAD_RIGHT);
    });
    expect(engine.commands.filter((c) => c.name === 'seek').at(-1)?.positionMs).toBe(10_000);
    expect(screen.getByTestId('player-progress-time')).toHaveTextContent('0:10 / 1:40');

    // Hold Right past LONG_PRESS_MS + SLOW_INTERVAL_MS: initial press (+10s -> 20s) + held repeat (+30s -> 50s)
    await act(async () => {
      keys.down(KEYCODE_DPAD_RIGHT);
    });
    expect(engine.commands.filter((c) => c.name === 'seek').at(-1)?.positionMs).toBe(20_000);

    await act(async () => {
      jest.advanceTimersByTime(650);
    });
    await act(async () => {
      keys.up(KEYCODE_DPAD_RIGHT);
    });
    expect(engine.commands.filter((c) => c.name === 'seek').at(-1)?.positionMs).toBe(50_000);
    expect(screen.getByTestId('player-progress-time')).toHaveTextContent('0:50 / 1:40');

    // OK resumes playback
    await act(async () => {
      keys.tap(KEYCODE_DPAD_CENTER);
    });
    const playCmd = engine.commands.filter((c) => c.name === 'play').at(-1);
    expect(playCmd).toBeDefined();
    await act(async () => {
      engine.emit({ attempt: playCmd?.attempt ?? 3, type: 'state', state: 'playing' });
    });
    expect(screen.getByTestId('osd-status')).toHaveTextContent('Playing');

    await view.unmount();
  });

  it.each(['phone', 'tablet', 'desktop'] as const)(
    'supports touch/mouse Play-Pause, -10s, +10s, and progress-bar press on %s',
    async (formFactor: FormFactor) => {
      jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
      jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);

      const manual = createManualClock();
      const engine = createFakePlayerEngine({
        now: manual.now,
        schedule: manual.schedule,
        cancel: manual.cancel,
      });
      const catalog = {
        resolveStream: jest.fn(async () =>
          ok({ url: 'http://sim.example.test/movie/200010.mp4', headers: {} }),
        ),
      };

      const view = await render(
        <FormFactorProvider value={formFactor}>
          <I18nProvider i18n={createAppI18n('en')}>
            <PlayerScreen
              catalog={catalog}
              videoHost={{ open: () => ({ engine, renderSurface: () => <View /> }) }}
              target={{
                itemKey: 'x:src-1:vod:200010',
                sourceId: 'src-1',
                title: 'Sample VOD',
                kind: 'vod',
              }}
              clock={{ now: manual.now }}
              timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
              onExit={jest.fn()}
            />
          </I18nProvider>
        </FormFactorProvider>,
      );

      await waitFor(() => {
        expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
      });
      await act(async () => {
        manual.advance(350);
      });
      const attempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
      await act(async () => {
        engine.emit({
          attempt,
          type: 'clock',
          anchor: { positionMs: 12_000, atMs: manual.now(), rate: 1, durationMs: 120_000 },
        });
      });

      expect(screen.getByTestId('player-play-pause')).toHaveTextContent('Pause');
      await fireEvent.press(screen.getByTestId('player-seek-forward'));
      expect(engine.commands.filter((c) => c.name === 'seek').at(-1)?.positionMs).toBe(22_000);

      await fireEvent.press(screen.getByTestId('player-seek-back'));
      expect(engine.commands.filter((c) => c.name === 'seek').at(-1)?.positionMs).toBe(12_000);

      const bar = screen.getByTestId('player-progress-bar');
      await fireEvent(bar, 'layout', {
        nativeEvent: { layout: { x: 0, y: 0, width: 200, height: 16 } },
      });
      await fireEvent.press(bar, { nativeEvent: { locationX: 150 } });
      expect(engine.commands.filter((c) => c.name === 'seek').at(-1)?.positionMs).toBe(90_000);

      await fireEvent.press(screen.getByTestId('player-play-pause'));
      const pauseAttempt = engine.commands.filter((c) => c.name === 'pause').at(-1)?.attempt ?? 2;
      await act(async () => {
        engine.emit({ attempt: pauseAttempt, type: 'state', state: 'paused' });
      });
      expect(screen.getByTestId('player-play-pause')).toHaveTextContent('Play');

      await fireEvent.press(screen.getByTestId('player-play-pause'));
      expect(engine.commands.some((c) => c.name === 'play')).toBe(true);

      await view.unmount();
    },
  );

  it('switches audio & subtitle tracks in Turkish via TrackPickerModal without resetting VOD position and closes on Back without exiting', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);

    const keys = createFakeAndroidKeys();
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const onExit = jest.fn();

    const view = await render(
      <RemoteKeysProvider android={keys.source}>
        <FormFactorProvider value="tv">
          <I18nProvider i18n={createAppI18n('tr')}>
            <PlayerScreen
              catalog={{
                resolveStream: async () =>
                  ok({ url: 'http://sim.example.test/movie/200011.mkv', headers: {} }),
              }}
              videoHost={{ open: () => ({ engine, renderSurface: () => <View /> }) }}
              target={{
                itemKey: 'x:src-1:vod:200011',
                sourceId: 'src-1',
                title: 'Two audio tracks and subtitles (MKV)',
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
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });
    await act(async () => {
      manual.advance(350);
    });
    const attempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
    await act(async () => {
      engine.emit({
        attempt,
        type: 'clock',
        anchor: { positionMs: 25_000, atMs: manual.now(), rate: 1, durationMs: 120_000 },
      });
      engine.emit({ attempt, type: 'tracks', tracks: MULTI_TRACKS });
    });

    expect(screen.getByTestId('player-tracks-button')).toHaveTextContent('Ses ve Altyazı');

    // Open TrackPicker via TV VOD shortcut: Down focuses OSD tracks button -> Center opens picker
    await act(async () => {
      keys.tap(KEYCODE_DPAD_DOWN);
    });
    await act(async () => {
      keys.tap(KEYCODE_DPAD_CENTER);
    });

    expect(screen.getByTestId('player-tracks-panel')).toBeTruthy();
    expect(screen.getByTestId('player-audio-track-a:1')).toHaveTextContent('Türkçe');
    expect(screen.getByTestId('player-audio-track-a:2')).toHaveTextContent('İngilizce');
    expect(screen.getByTestId('player-subtitle-off')).toHaveTextContent('Kapalı');
    expect(screen.getByTestId('player-subtitle-track-s:1')).toHaveTextContent('Türkçe');

    // Move Down to English audio (a:2) and select; position stays 0:25 and no reload is issued
    await act(async () => {
      keys.tap(KEYCODE_DPAD_DOWN);
    });
    await act(async () => {
      keys.tap(KEYCODE_DPAD_CENTER);
    });
    expect(engine.commands.filter((c) => c.name === 'selectAudioTrack').at(-1)?.trackId).toBe(
      'a:2',
    );
    expect(engine.commands.filter((c) => c.name === 'load')).toHaveLength(1);
    expect(screen.getByTestId('player-progress-time')).toHaveTextContent('0:25 / 2:00');

    // Move Right to Subtitles column -> Down to Turkish subtitle (s:1) -> select
    await act(async () => {
      keys.tap(KEYCODE_DPAD_RIGHT);
    });
    await act(async () => {
      keys.tap(KEYCODE_DPAD_DOWN);
    });
    await act(async () => {
      keys.tap(KEYCODE_DPAD_CENTER);
    });
    expect(engine.commands.filter((c) => c.name === 'selectSubtitleTrack').at(-1)?.trackId).toBe(
      's:1',
    );

    await act(async () => {
      engine.emit({
        attempt,
        type: 'tracks',
        tracks: { ...MULTI_TRACKS, selectedAudioId: 'a:2', selectedSubtitleId: 's:1' },
      });
    });

    // Move Up to Off (index 0) and select -> null
    await act(async () => {
      keys.tap(KEYCODE_DPAD_UP);
    });
    await act(async () => {
      keys.tap(KEYCODE_DPAD_CENTER);
    });
    expect(engine.commands.filter((c) => c.name === 'selectSubtitleTrack').at(-1)?.trackId).toBe(
      null,
    );

    // Back closes TrackPickerModal without exiting PlayerScreen
    await act(async () => {
      keys.tap(KEYCODE_BACK);
    });
    expect(screen.queryByTestId('player-tracks-panel')).toBeNull();
    expect(onExit).not.toHaveBeenCalled();

    // Second Back exits PlayerScreen
    await act(async () => {
      keys.tap(KEYCODE_BACK);
    });
    expect(onExit).toHaveBeenCalledTimes(1);

    await view.unmount();
  });
});
