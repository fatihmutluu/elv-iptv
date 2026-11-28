import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import type { MediaTracks, PlaybackService, PlaybackState } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import {
  type FormFactor,
  FormFactorProvider,
  I18nProvider,
  ThemeProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, StyleSheet, View } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import { PlayerScreen } from '../PlayerScreen';
import { PlayerSettingsSheet } from '../PlayerSettingsSheet';
import { formatPlaybackPosition, VodProgressBar } from '../VodProgressBar';
import { createManualClock } from './player-test-harness';

const TRACKS: MediaTracks = {
  audio: [{ id: 'a:1', language: 'eng', label: 'English', codec: 'aac', channels: 2 }],
  subtitles: [{ id: 's:1', language: 'eng', codec: 'subrip' }],
  selectedAudioId: 'a:1',
  selectedSubtitleId: null,
};

const VOD_TARGET: PlayTarget = {
  itemKey: 'x:s1:vod:901',
  sourceId: 's1',
  title: 'Cinema Quietude Feature',
  subtitle: 'Director Cut',
  kind: 'vod',
};

function flatStyle(testID: string) {
  return StyleSheet.flatten(screen.getByTestId(testID).props.style);
}

function createFakeService(positionMs = 30_000, durationMs = 120_000): PlaybackService {
  const state: PlaybackState = {
    status: { kind: 'playing' },
    attempt: 1,
    tracks: TRACKS,
    staleEventsDropped: 0,
    surfaceRecreationToken: 0,
    anchor: { positionMs, atMs: 1_000, rate: 0, durationMs },
  };
  return {
    getState: () => state,
    subscribe: () => () => undefined,
  } as unknown as PlaybackService;
}

function installWebWindow() {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const win = {
    addEventListener: jest.fn((type: string, fn: (e: unknown) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    }),
    removeEventListener: jest.fn((type: string, fn: (e: unknown) => void) => {
      listeners.get(type)?.delete(fn);
    }),
  };
  const globals = globalThis as unknown as { window?: unknown };
  const prev = globals.window;
  globals.window = win;
  return {
    win,
    async emit(type: string, e: Record<string, unknown>) {
      await act(async () => {
        for (const fn of [...(listeners.get(type) ?? [])]) fn(e);
      });
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
    restore() {
      globals.window = prev;
    },
  };
}

describe('VodProgressBar Cinema Quietude v2 scrubber', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('expands 3px -> 6px on web hover, shows clamped hover timecode preview pill, and drag-scrubs cleanly', async () => {
    jest.replaceProperty(Platform, 'OS', 'web' as typeof Platform.OS);
    const web = installWebWindow();
    const onSeekRatio = jest.fn();
    const service = createFakeService(30_000, 120_000);

    try {
      const view = await render(
        <ThemeProvider preset="obsidianCrimson">
          <VodProgressBar
            service={service}
            clock={{ now: () => 1_000 }}
            isTv={false}
            label="Progress"
            onSeekRatio={onSeekRatio}
          />
        </ThemeProvider>,
      );

      expect(flatStyle('player-progress-rail')?.height).toBe(5);
      expect(screen.queryByTestId('player-progress-hover-time')).toBeNull();

      const bar = screen.getByTestId('player-progress-bar');
      const mockTarget = {
        getBoundingClientRect: () => ({ left: 100, width: 200 }),
        blur: jest.fn(),
      };

      // Hover in & move to 50% (clientX = 200 -> 1:00)
      await fireEvent(bar, 'hoverIn');
      await fireEvent(bar, 'pointerMove', {
        nativeEvent: { clientX: 200 },
        currentTarget: mockTarget,
      });
      expect(flatStyle('player-progress-rail')?.height).toBe(8);
      const pill = screen.getByTestId('player-progress-hover-time');
      expect(pill).toHaveTextContent('1:00');
      expect(flatStyle('player-progress-hover-time')?.fontVariant).toEqual(['tabular-nums']);

      // Hover out hides preview pill and returns to 5px
      await fireEvent(bar, 'hoverOut');
      expect(screen.queryByTestId('player-progress-hover-time')).toBeNull();
      expect(flatStyle('player-progress-rail')?.height).toBe(5);

      // Pointer drag: down at 25% -> move to 75% (live preview 1:30) -> up commits 0.75
      await fireEvent(bar, 'pointerDown', {
        nativeEvent: { clientX: 150 },
        currentTarget: mockTarget,
      });
      expect(flatStyle('player-progress-rail')?.height).toBe(8);
      expect(web.listenerCount('pointermove')).toBe(1);

      await web.emit('pointermove', { clientX: 250 });
      expect(screen.getByTestId('player-progress-time-current')).toHaveTextContent('1:30');
      expect(screen.getByTestId('player-progress-time')).toHaveTextContent('0:30');
      expect(screen.getByTestId('player-progress-hover-time')).toHaveTextContent('1:30');
      expect(onSeekRatio).not.toHaveBeenCalled();

      await web.emit('pointerup', { clientX: 250 });
      expect(onSeekRatio).toHaveBeenCalledTimes(1);
      expect(onSeekRatio).toHaveBeenCalledWith(0.75);
      expect(web.listenerCount('pointermove')).toBe(0);

      await view.unmount();
    } finally {
      web.restore();
    }
  });

  it('keeps hover timecode pill inside docked desktop DOM bounds (top >= 0), ignores right-click drag, and guards NaN', async () => {
    jest.replaceProperty(Platform, 'OS', 'web' as typeof Platform.OS);
    expect(formatPlaybackPosition(Number.NaN)).toBe('0:00');
    const web = installWebWindow();
    const onSeekRatio = jest.fn();
    const service = createFakeService(30_000, 120_000);

    try {
      const view = await render(
        <ThemeProvider preset="obsidianCrimson">
          <VodProgressBar
            service={service}
            clock={{ now: () => 1_000 }}
            isTv={false}
            docked
            label="Progress"
            onSeekRatio={onSeekRatio}
          />
        </ThemeProvider>,
      );

      const bar = screen.getByTestId('player-progress-bar');
      expect(flatStyle('player-progress-bar')?.paddingTop).toBeGreaterThanOrEqual(24);
      const mockTarget = {
        getBoundingClientRect: () => ({ left: 0, width: 200 }),
        blur: jest.fn(),
      };

      // Right-click pointerDown must not initiate drag scrubbing
      await fireEvent(bar, 'pointerDown', {
        nativeEvent: { clientX: 100, button: 2 },
        currentTarget: mockTarget,
      });
      expect(web.listenerCount('pointermove')).toBe(0);

      // Hover shows pill positioned inside bar bounds (top >= 0, no overflowing bottom offset)
      await fireEvent(bar, 'pointerMove', {
        nativeEvent: { clientX: 100 },
        currentTarget: mockTarget,
      });
      const pillStyle = flatStyle('player-progress-hover-pill');
      expect(pillStyle?.top).toBeGreaterThanOrEqual(0);
      expect(pillStyle?.bottom).toBeUndefined();

      await view.unmount();
    } finally {
      web.restore();
    }
  });
});

describe('PlayerSettingsSheet Playback Speed submenu', () => {
  it('shows Playback speed row on VOD, omits it on Live, and selects 0.5x-2x', async () => {
    const i18n = createAppI18n('en');
    const onOpenView = jest.fn();
    const onSelectSpeed = jest.fn();

    const view = await render(
      <ThemeProvider preset="obsidianCrimson">
        <I18nProvider i18n={i18n}>
          <PlayerSettingsSheet
            visible
            isVod
            playbackSpeed={1.25}
            menuState={{ view: 'root', index: 0 }}
            tracks={TRACKS}
            statsVisible={false}
            isTv={false}
            formFactor="desktop"
            i18n={i18n}
            onOpenView={onOpenView}
            onSelectAudio={jest.fn()}
            onSelectSubtitle={jest.fn()}
            onSelectSpeed={onSelectSpeed}
            onToggleStats={jest.fn()}
            onClose={jest.fn()}
          />
        </I18nProvider>
      </ThemeProvider>,
    );

    expect(screen.getByTestId('player-settings-row-speed')).toHaveTextContent(/1\.25×/);
    await fireEvent.press(screen.getByTestId('player-settings-row-speed'));
    expect(onOpenView).toHaveBeenCalledWith('speed');

    await view.rerender(
      <ThemeProvider preset="obsidianCrimson">
        <I18nProvider i18n={i18n}>
          <PlayerSettingsSheet
            visible
            isVod
            playbackSpeed={1.25}
            menuState={{ view: 'speed', index: 3 }}
            tracks={TRACKS}
            statsVisible={false}
            isTv={false}
            formFactor="desktop"
            i18n={i18n}
            onOpenView={onOpenView}
            onSelectAudio={jest.fn()}
            onSelectSubtitle={jest.fn()}
            onSelectSpeed={onSelectSpeed}
            onToggleStats={jest.fn()}
            onClose={jest.fn()}
          />
        </I18nProvider>
      </ThemeProvider>,
    );

    expect(screen.getByTestId('player-settings-speed-1.25').props.accessibilityState).toMatchObject(
      { selected: true },
    );
    await fireEvent.press(screen.getByTestId('player-settings-speed-1.5'));
    expect(onSelectSpeed).toHaveBeenCalledWith(1.5);

    // Live hides speed row
    await view.rerender(
      <ThemeProvider preset="obsidianCrimson">
        <I18nProvider i18n={i18n}>
          <PlayerSettingsSheet
            visible
            isVod={false}
            playbackSpeed={1}
            menuState={{ view: 'root', index: 0 }}
            tracks={TRACKS}
            statsVisible={false}
            isTv={false}
            formFactor="desktop"
            i18n={i18n}
            onOpenView={onOpenView}
            onSelectAudio={jest.fn()}
            onSelectSubtitle={jest.fn()}
            onSelectSpeed={onSelectSpeed}
            onToggleStats={jest.fn()}
            onClose={jest.fn()}
          />
        </I18nProvider>
      </ThemeProvider>,
    );
    expect(screen.queryByTestId('player-settings-row-speed')).toBeNull();
    await view.unmount();
  });
});

describe('PlayerScreen Cinema Bar (Desktop) & Floating 3-Zone OSD (TV/Mobile)', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function mountPlayer(formFactor: FormFactor, target: PlayTarget = VOD_TARGET) {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const setSpeedSpy = jest.fn();
    engine.setSpeed = setSpeedSpy;
    const toggleMute = jest.fn();
    const toggleFullscreen = jest.fn();

    const view = await render(
      <ThemeProvider preset="obsidianCrimson">
        <ViewportProvider
          value={{
            width: formFactor === 'phone' ? 393 : 1280,
            height: formFactor === 'phone' ? 852 : 720,
            orientation: formFactor === 'phone' ? 'portrait' : 'landscape',
            formFactor,
          }}
        >
          <FormFactorProvider value={formFactor}>
            <I18nProvider i18n={createAppI18n('en')}>
              <PlayerScreen
                catalog={{
                  resolveStream: async (k) =>
                    ok({ url: `http://sim.example.test/${k}.mkv`, headers: {} }),
                }}
                videoHost={{
                  open: () => ({
                    engine,
                    renderSurface: () => <View testID="fake-surface" />,
                    toggleMute,
                    toggleFullscreen,
                  }),
                }}
                target={target}
                clock={{ now: manual.now }}
                timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
                onExit={jest.fn()}
              />
            </I18nProvider>
          </FormFactorProvider>
        </ViewportProvider>
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
        anchor: { positionMs: 20_000, atMs: manual.now(), rate: 1, durationMs: 120_000 },
      });
      engine.emit({ attempt, type: 'tracks', tracks: TRACKS });
    });

    return { view, engine, setSpeedSpy, toggleMute, toggleFullscreen };
  }

  it('renders HWND-safe Desktop Cinema Bar with mute toggle, fullscreen icon, and 1x speed pill', async () => {
    const { view, setSpeedSpy, toggleMute, toggleFullscreen } = await mountPlayer('desktop');

    // Normal flex flow invariant: player-osd is NOT position: 'absolute'
    expect(flatStyle('player-osd')?.position).not.toBe('absolute');

    // Mute toggles accessibilityLabel between Mute and Unmute
    const muteBtn = screen.getByTestId('player-mute-button');
    expect(muteBtn.props.accessibilityLabel).toBe('Mute');
    await fireEvent.press(muteBtn);
    expect(toggleMute).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('player-mute-button').props.accessibilityLabel).toBe('Unmute');

    // Fullscreen button uses player.enterFullscreen label
    const fsBtn = screen.getByTestId('player-fullscreen-button');
    expect(fsBtn.props.accessibilityLabel).toBe('Fullscreen');
    await fireEvent.press(fsBtn);
    expect(toggleFullscreen).toHaveBeenCalledTimes(1);

    // Speed pill opens Settings directly to Speed submenu & sets playback speed on engine
    const speedBtn = screen.getByTestId('player-speed-button');
    expect(speedBtn).toHaveTextContent('1×');
    await fireEvent.press(speedBtn);
    expect(screen.getByTestId('player-settings-speed-1.5')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('player-settings-speed-1.5'));
    expect(setSpeedSpy).toHaveBeenCalledWith(expect.any(Number), 1.5);
    expect(screen.getByTestId('player-speed-button')).toHaveTextContent('1.5×');

    await view.unmount();
  });

  it('renders Minimalist Cinema OSD with unobstructed center and bottom circular transport on TV and Phone', async () => {
    const tv = await mountPlayer('tv');
    expect(screen.getByTestId('player-osd-top')).toBeTruthy();
    expect(screen.queryByTestId('player-center-transport')).toBeNull();
    expect(screen.getByTestId('player-bottom-transport')).toBeTruthy();
    expect(screen.getByTestId('player-osd-bottom')).toBeTruthy();
    expect(flatStyle('player-play-pause')?.width).toBe(80);
    await tv.view.unmount();

    const phone = await mountPlayer('phone');
    expect(screen.getByTestId('player-osd-top')).toBeTruthy();
    expect(screen.queryByTestId('player-center-transport')).toBeNull();
    expect(screen.getByTestId('player-bottom-transport')).toBeTruthy();
    expect(screen.getByTestId('player-osd-bottom')).toBeTruthy();
    expect(flatStyle('player-play-pause')?.width).toBe(60);
    await phone.view.unmount();
  });
});
