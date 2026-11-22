import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import type { MediaTracks } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import {
  FormFactorProvider,
  I18nProvider,
  RemoteKeysProvider,
  THEME_PRESETS,
  ThemeProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, StyleSheet, View } from 'react-native';
import type { PlayableEntry, PlayTarget } from '../../ports/play-target';
import { PlayerScreen } from '../PlayerScreen';
import { SCRUB_SETTLE_MS } from '../scrub-controller';
import { createFakeAndroidKeys, createManualClock } from './player-test-harness';

const KEY_DOWN = 20;
const KEY_LEFT = 21;
const KEY_RIGHT = 22;
const KEY_SELECT = 23;
const KEY_BACK = 4;
const KEY_CHANNEL_UP = 166;

const TRACKS: MediaTracks = {
  audio: [
    { id: 'a:1', language: 'tur', label: 'Turkish', codec: 'aac', channels: 2 },
    { id: 'a:2', language: 'eng', label: 'English', codec: 'ac3', channels: 6 },
  ],
  subtitles: [{ id: 's:1', language: 'tur', codec: 'subrip' }],
  selectedAudioId: 'a:1',
  selectedSubtitleId: null,
};

const EP2: PlayableEntry = {
  itemKey: 'x:s1:ep:2',
  sourceId: 's1',
  title: 'Starlight — E2',
  kind: 'vod',
  season: 1,
  episode: 2,
  subtitle: 'S1 E2 · Drift',
};

const EP3: PlayableEntry = {
  itemKey: 'x:s1:ep:3',
  sourceId: 's1',
  title: 'Starlight — E3',
  kind: 'vod',
  season: 1,
  episode: 3,
  subtitle: 'S1 E3 · Signal',
};

const EP1_TARGET: PlayTarget = {
  itemKey: 'x:s1:ep:1',
  sourceId: 's1',
  title: 'Starlight — E1',
  kind: 'vod',
  season: 1,
  episode: 1,
  subtitle: 'S1 E1 · Pilot',
  nextEpisodes: [EP2, EP3],
};

function flatStyle(testID: string) {
  return StyleSheet.flatten(screen.getByTestId(testID).props.style);
}

describe('PlayerScreen review fixes (TV Live OSD, double-tap, scrub cancel, focus ring, prevChannel index)', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('reaches prevChannel and settings on 10-ft TV Live playback via Select/Right D-pad', async () => {
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
    const ch0: PlayableEntry = { itemKey: 'ch:0', sourceId: 's1', title: '0. News', kind: 'live' };
    const ch1: PlayableEntry = { itemKey: 'ch:1', sourceId: 's1', title: '1. Sport', kind: 'live' };
    const catalog = {
      resolveStream: jest.fn(async (k: string) =>
        ok({ url: `http://sim.example.test/${k}.ts`, headers: {} }),
      ),
    };

    const view = await render(
      <ThemeProvider preset="obsidianCrimson">
        <RemoteKeysProvider android={keys.source}>
          <FormFactorProvider value="tv">
            <I18nProvider i18n={createAppI18n('en')}>
              <PlayerScreen
                catalog={catalog}
                videoHost={{ open: () => ({ engine, renderSurface: () => <View /> }) }}
                target={{ ...ch1, previousChannel: ch0 }}
                clock={{ now: manual.now }}
                timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
                onExit={jest.fn()}
              />
            </I18nProvider>
          </FormFactorProvider>
        </RemoteKeysProvider>
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });
    const attempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
    await act(async () => {
      manual.advance(350);
      engine.emit({ attempt, type: 'tracks', tracks: TRACKS });
    });

    // Select enters Live TV OSD focus (lands on 'tracks') -> Right moves to 'settings' -> Select opens Settings
    await act(async () => keys.tap(KEY_SELECT));
    await act(async () => keys.tap(KEY_RIGHT));
    await act(async () => keys.tap(KEY_SELECT));
    expect(screen.getByTestId('player-settings-panel')).toBeTruthy();

    // Back closes Settings and restores TV OSD focus to 'settings' (#130)
    await act(async () => keys.tap(KEY_BACK));
    expect(screen.queryByTestId('player-settings-panel')).toBeNull();
    expect(screen.getByTestId('player-settings-button').props.accessibilityState).toMatchObject({
      selected: true,
    });

    // Left moves 'settings' -> 'tracks' -> 'prevChannel' -> Select jumps to ch:0
    await act(async () => keys.tap(KEY_LEFT));
    expect(screen.getByTestId('player-tracks-button').props.accessibilityState).toMatchObject({
      selected: true,
    });
    await act(async () => keys.tap(KEY_LEFT));
    expect(screen.getByTestId('player-prev-channel').props.accessibilityState).toMatchObject({
      selected: true,
    });
    await act(async () => keys.tap(KEY_SELECT));

    await waitFor(() => {
      expect(catalog.resolveStream).toHaveBeenLastCalledWith('ch:0');
    });
    expect(screen.getByTestId('osd-title')).toHaveTextContent('0. News');

    await view.unmount();
  });

  it('guards Next Episode against rapid double-tap and cancels pending VOD scrub timer before tuning EP2', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const seekSpy = jest.spyOn(engine, 'seek');
    const catalog = {
      resolveStream: jest.fn(async (k: string) =>
        ok({ url: `http://sim.example.test/${k}.mp4`, headers: {} }),
      ),
    };

    const view = await render(
      <ThemeProvider preset="obsidianCrimson">
        <FormFactorProvider value="desktop">
          <I18nProvider i18n={createAppI18n('en')}>
            <PlayerScreen
              catalog={catalog}
              videoHost={{ open: () => ({ engine, renderSurface: () => <View /> }) }}
              target={EP1_TARGET}
              clock={{ now: manual.now }}
              timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
              onExit={jest.fn()}
            />
          </I18nProvider>
        </FormFactorProvider>
      </ThemeProvider>,
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
        anchor: { positionMs: 92_000, atMs: manual.now(), rate: 1, durationMs: 100_000 },
      });
    });

    // Start a pending scrub on EP1 (arms 750ms settle timer, does not seek yet)
    const onKeyDown = screen.getByTestId('player-screen').props.onKeyDown as (e: {
      key: string;
      preventDefault?: () => void;
    }) => void;
    await act(async () => {
      onKeyDown({ key: 'ArrowLeft', preventDefault: jest.fn() });
    });
    expect(seekSpy).not.toHaveBeenCalled();

    // Synchronous rapid double-tap on Next Episode button before re-render
    const nextBtn = screen.getByTestId('player-next-episode');
    await act(async () => {
      fireEvent.press(nextBtn);
      fireEvent.press(nextBtn);
    });

    await waitFor(() => {
      expect(catalog.resolveStream).toHaveBeenCalledWith('x:s1:ep:2');
    });
    // Must tune ONLY EP2, never skipping to EP3
    expect(catalog.resolveStream).not.toHaveBeenCalledWith('x:s1:ep:3');
    expect(catalog.resolveStream.mock.calls.filter(([k]) => k === 'x:s1:ep:2')).toHaveLength(1);
    expect(screen.getByTestId('osd-title')).toHaveTextContent('Starlight — E2');

    // Advancing past SCRUB_SETTLE_MS must NOT leak EP1's pending scrub onto EP2
    await act(async () => {
      manual.advance(SCRUB_SETTLE_MS + 50);
    });
    expect(seekSpy).not.toHaveBeenCalled();

    await view.unmount();
  });

  it('renders an offset outer focus ring and scale on primary Play/Pause in obsidianCrimson on TV', async () => {
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

    const view = await render(
      <ThemeProvider preset="obsidianCrimson">
        <RemoteKeysProvider android={keys.source}>
          <FormFactorProvider value="tv">
            <I18nProvider i18n={createAppI18n('en')}>
              <PlayerScreen
                catalog={{
                  resolveStream: async (k) =>
                    ok({ url: `http://sim.example.test/${k}.mp4`, headers: {} }),
                }}
                videoHost={{ open: () => ({ engine, renderSurface: () => <View /> }) }}
                target={EP1_TARGET}
                clock={{ now: manual.now }}
                timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
                onExit={jest.fn()}
              />
            </I18nProvider>
          </FormFactorProvider>
        </RemoteKeysProvider>
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });

    // Without tracks, Down focuses playPause directly
    await act(async () => keys.tap(KEY_DOWN));

    const ring = screen.getByTestId('player-play-pause-focus-ring');
    const ringStyle = StyleSheet.flatten(ring.props.style);
    expect(ringStyle).toMatchObject({
      position: 'absolute',
      top: -4,
      right: -4,
      bottom: -4,
      left: -4,
      borderColor: THEME_PRESETS.obsidianCrimson.focusRingColor,
    });
    expect(flatStyle('player-play-pause')?.transform).toEqual([{ scale: 1.04 }]);

    await view.unmount();
  });

  it('keeps playlist.currentIndex and zapController synced across Zap Ch0 -> Ch1 -> Prev (Ch0) -> CH+ (Ch1)', async () => {
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
    const entries: readonly PlayableEntry[] = [
      { itemKey: 'ch:0', sourceId: 's1', title: '0. Alpha', kind: 'live' },
      { itemKey: 'ch:1', sourceId: 's1', title: '1. Beta', kind: 'live' },
      { itemKey: 'ch:2', sourceId: 's1', title: '2. Gamma', kind: 'live' },
    ];
    const onChangeIndex = jest.fn();
    const catalog = {
      resolveStream: jest.fn(async (k: string) =>
        ok({ url: `http://sim.example.test/${k}.ts`, headers: {} }),
      ),
    };

    const view = await render(
      <ThemeProvider preset="obsidianCrimson">
        <RemoteKeysProvider android={keys.source}>
          <FormFactorProvider value="tv">
            <I18nProvider i18n={createAppI18n('en')}>
              <PlayerScreen
                catalog={catalog}
                videoHost={{ open: () => ({ engine, renderSurface: () => <View /> }) }}
                target={{
                  ...(entries[0] as PlayableEntry),
                  playlist: {
                    count: 3,
                    currentIndex: 0,
                    onChangeIndex,
                    getAt: async (i) => entries[i],
                  },
                }}
                clock={{ now: manual.now }}
                timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
                onExit={jest.fn()}
              />
            </I18nProvider>
          </FormFactorProvider>
        </RemoteKeysProvider>
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(catalog.resolveStream).toHaveBeenCalledWith('ch:0');
    });

    // CH+ -> Ch1 (index 1)
    await act(async () => keys.tap(KEY_CHANNEL_UP));
    await waitFor(() => {
      expect(screen.getByTestId('osd-title')).toHaveTextContent('1. Beta');
    });
    expect(onChangeIndex).toHaveBeenLastCalledWith(1);

    // Previous channel -> Ch0 (index 0)
    await fireEvent.press(screen.getByTestId('player-prev-channel'));
    await waitFor(() => {
      expect(screen.getByTestId('osd-title')).toHaveTextContent('0. Alpha');
    });
    expect(onChangeIndex).toHaveBeenLastCalledWith(0);

    // Subsequent CH+ MUST land on Ch1 (index 1), NOT skip to Ch2!
    await act(async () => keys.tap(KEY_CHANNEL_UP));
    await waitFor(() => {
      expect(screen.getByTestId('osd-title')).toHaveTextContent('1. Beta');
    });
    expect(onChangeIndex).toHaveBeenLastCalledWith(1);

    await view.unmount();
  });
});
