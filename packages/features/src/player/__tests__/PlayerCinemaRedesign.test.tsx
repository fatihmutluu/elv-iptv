import type { NextEpisodeRow, NowNextEntry } from '@elv/data';
import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import type { MediaTracks } from '@elv/playback';
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
import { Platform, StyleSheet, View } from 'react-native';
import type { LiveChannelPlaylist, PlayableEntry, PlayTarget } from '../../ports/play-target';
import type { OpenVideoEngine, VideoHost } from '../../ports/video-host';
import { PlayerScreen, type PlayerScreenProps } from '../PlayerScreen';
import { HOLD_SPEED_DELAY_MS } from '../PlayerTouchGestures';
import { PROGRESS_OSD_AUTO_HIDE_MS } from '../player-overlay-model';
import { createManualClock } from './player-test-harness';

const TRACKS_51: MediaTracks = {
  audio: [{ id: 'a:1', language: 'eng', label: 'English 5.1', codec: 'eac3', channels: 6 }],
  subtitles: [{ id: 's:1', language: 'eng', label: 'English', codec: 'subrip' }],
  selectedAudioId: 'a:1',
  selectedSubtitleId: null,
};

const NOW_NEXT: NowNextEntry = {
  channelKey: 'ch:1',
  now: {
    channelKey: 'ch:1',
    sourceId: 's1',
    guideId: 'g:1',
    title: 'Evening News Hour',
    subTitle: 'Live from Studio A',
    description: 'Top stories and weather.',
    episodeNum: null,
    icon: null,
    genre: null,
    flags: 0,
    start: 0,
    stop: 100_000,
  },
  next: {
    channelKey: 'ch:1',
    sourceId: 's1',
    guideId: 'g:1',
    title: 'Late Night Cinema',
    subTitle: null,
    description: null,
    episodeNum: null,
    icon: null,
    genre: null,
    flags: 0,
    start: 100_000,
    stop: 200_000,
  },
};

const FIRST_CHANNEL: PlayableEntry = {
  itemKey: 'ch:1',
  sourceId: 's1',
  title: '1. Alpha News',
  kind: 'live',
};

const CHANNELS: readonly PlayableEntry[] = [
  FIRST_CHANNEL,
  { itemKey: 'ch:2', sourceId: 's1', title: '2. Beta Sports', kind: 'live' },
  { itemKey: 'ch:3', sourceId: 's1', title: '3. Gamma Docs', kind: 'live' },
];

const VOD_TARGET: PlayTarget = {
  itemKey: 'x:s1:ep:s01e10',
  sourceId: 's1',
  title: 'Horizon — S1 Finale',
  subtitle: 'S1 E10',
  kind: 'vod',
  itemKind: 'episode',
  seriesKey: 'series:horizon',
  season: 1,
  episode: 10,
};

function makePlaylist(initialIndex = 0): LiveChannelPlaylist {
  let idx = initialIndex;
  return {
    count: CHANNELS.length,
    get currentIndex() {
      return idx;
    },
    getAt: async (i) => CHANNELS[i],
    onChangeIndex: (next) => {
      idx = next;
    },
  };
}

function installWebWindow() {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const win = {
    document: { activeElement: null as unknown },
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
    async emitKey(type: 'keydown' | 'keyup', init: { key: string; shiftKey?: boolean }) {
      const preventDefault = jest.fn();
      await act(async () => {
        for (const fn of [...(listeners.get(type) ?? [])]) {
          fn({ ...init, preventDefault, target: null });
        }
      });
      return { preventDefault };
    },
    restore() {
      globals.window = prev;
    },
  };
}

async function mountRedesignedPlayer(opts: {
  formFactor: FormFactor;
  os: 'web' | 'android';
  target: PlayTarget;
  initialOsdHidden?: boolean;
  autoHideOsdMs?: number;
  initialVolume?: number;
  autoSubtitlesOnSkipBack?: boolean;
  autoPlayNextEpisode?: boolean;
  nowNext?: jest.Mock;
  queryNextEpisode?: jest.Mock;
}) {
  jest.replaceProperty(Platform, 'OS', opts.os as typeof Platform.OS);
  const manual = createManualClock();
  const engine = createFakePlayerEngine({
    now: manual.now,
    schedule: manual.schedule,
    cancel: manual.cancel,
  });
  const setVolume = jest.fn();
  const setBrightness = jest.fn();
  const setSpeedSpy = jest.fn();
  engine.setSpeed = setSpeedSpy;
  const selectSubtitleSpy = jest.spyOn(engine, 'selectSubtitleTrack');
  const toggleMute = jest.fn();
  const onPersistVolume = jest.fn();
  const onToggleAutoSubtitlesOnSkipBack = jest.fn();
  const onExit = jest.fn();
  const onTargetChange = jest.fn();
  let fullscreenState = false;
  let fsListener: ((next: boolean) => void) | undefined;
  const toggleFullscreen = jest.fn(() => {
    fullscreenState = !fullscreenState;
    fsListener?.(fullscreenState);
  });

  const opened: OpenVideoEngine = {
    engine,
    renderSurface: ({ testID }) => <View testID={testID ?? 'surface'} />,
    toggleMute,
    setVolume,
    setBrightness,
    toggleFullscreen,
    isFullscreen: () => fullscreenState,
    onFullscreenChange: (fn) => {
      fsListener = fn;
      return () => {
        fsListener = undefined;
      };
    },
  };
  const videoHost: VideoHost = { open: () => opened };
  const catalog: PlayerScreenProps['catalog'] = {
    resolveStream: jest.fn(async (key: string) =>
      ok({ url: `http://sim.example.test/${key}.mp4`, headers: {} }),
    ),
    getProgress: jest.fn(async () => null),
    saveProgress: jest.fn(async (input) =>
      ok({
        profileId: 'default',
        sourceId: input.sourceId,
        itemKey: input.itemKey,
        kind: input.kind,
        title: input.title,
        subtitle: input.subtitle ?? null,
        logo: input.logo ?? null,
        seriesKey: input.seriesKey ?? null,
        season: input.season ?? null,
        episode: input.episode ?? null,
        positionMs: input.positionMs,
        durationMs: input.durationMs,
        watched: input.watched ?? false,
        updatedAt: 0,
      }),
    ),
    ...(opts.nowNext !== undefined ? { nowNext: opts.nowNext } : {}),
    ...(opts.queryNextEpisode !== undefined ? { queryNextEpisode: opts.queryNextEpisode } : {}),
  };

  const view = await render(
    <ThemeProvider preset="obsidianCrimson">
      <TvRemoteProvider>
        <ViewportProvider
          value={{
            width: opts.formFactor === 'desktop' ? 1280 : 393,
            height: opts.formFactor === 'desktop' ? 720 : 852,
            formFactor: opts.formFactor,
            orientation: opts.formFactor === 'desktop' ? 'landscape' : 'portrait',
          }}
        >
          <FormFactorProvider value={opts.formFactor}>
            <I18nProvider i18n={createAppI18n('en')}>
              <PlayerScreen
                catalog={catalog}
                videoHost={videoHost}
                target={opts.target}
                clock={{ now: manual.now }}
                timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
                {...(opts.initialOsdHidden !== undefined
                  ? { initialOsdHidden: opts.initialOsdHidden }
                  : {})}
                {...(opts.autoHideOsdMs !== undefined ? { autoHideOsdMs: opts.autoHideOsdMs } : {})}
                {...(opts.initialVolume !== undefined ? { initialVolume: opts.initialVolume } : {})}
                onPersistVolume={onPersistVolume}
                {...(opts.autoSubtitlesOnSkipBack !== undefined
                  ? { autoSubtitlesOnSkipBack: opts.autoSubtitlesOnSkipBack }
                  : {})}
                onToggleAutoSubtitlesOnSkipBack={onToggleAutoSubtitlesOnSkipBack}
                {...(opts.autoPlayNextEpisode !== undefined
                  ? { autoPlayNextEpisode: opts.autoPlayNextEpisode }
                  : {})}
                onTargetChange={onTargetChange}
                onExit={onExit}
              />
            </I18nProvider>
          </FormFactorProvider>
        </ViewportProvider>
      </TvRemoteProvider>
    </ThemeProvider>,
  );

  await waitFor(() => {
    expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
  });
  const attempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;

  return {
    view,
    manual,
    engine,
    attempt,
    catalog,
    setVolume,
    setBrightness,
    setSpeedSpy,
    selectSubtitleSpy,
    toggleMute,
    toggleFullscreen,
    onPersistVolume,
    onToggleAutoSubtitlesOnSkipBack,
    onTargetChange,
    onExit,
  };
}

describe('Cinema Quietude v2 player redesign end-to-end (#391, #58, #394, #114, #57, #392)', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('#391 & #394: 3-tier OSD peek on wheel/seek (2s auto-hide), volume slider, sheet scroll isolation, dynamic fullscreen, and idle cursor hide', async () => {
    const web = installWebWindow();
    try {
      const p = await mountRedesignedPlayer({
        formFactor: 'desktop',
        os: 'web',
        target: VOD_TARGET,
        initialOsdHidden: true,
        autoHideOsdMs: 3_500,
        initialVolume: 70,
      });

      await act(async () => {
        p.manual.advance(350);
        p.engine.emit({
          attempt: p.attempt,
          type: 'clock',
          anchor: { positionMs: 30_000, atMs: p.manual.now(), rate: 1, durationMs: 120_000 },
        });
        p.engine.emit({ attempt: p.attempt, type: 'tracks', tracks: TRACKS_51 });
      });

      // Hidden while playing -> cursor hidden and no OSD rendered
      expect(screen.queryByTestId('player-osd')).toBeNull();
      expect(StyleSheet.flatten(screen.getByTestId('player-screen').props.style)).toMatchObject({
        cursor: 'none',
      });

      // Scroll-wheel up steps volume 70 -> 75, persists, calls preventDefault, and opens 'progress' peek ONLY
      const preventWheel = jest.fn();
      await fireEvent(screen.getByTestId('player-screen'), 'wheel', {
        deltaY: -120,
        preventDefault: preventWheel,
      });
      expect(preventWheel).toHaveBeenCalledTimes(1);
      expect(p.setVolume).toHaveBeenLastCalledWith(75);
      expect(p.onPersistVolume).toHaveBeenLastCalledWith(75);
      expect(screen.getByTestId('player-osd-progress-peek')).toBeTruthy();
      expect(screen.getByTestId('player-peek-volume')).toHaveTextContent('Volume 75%');
      expect(screen.queryByTestId('player-play-pause')).toBeNull();
      expect(screen.queryByTestId('player-settings-button')).toBeNull();

      // 2000ms auto-hide returns 'progress' peek back to 'hidden'
      await act(async () => {
        p.manual.advance(PROGRESS_OSD_AUTO_HIDE_MS);
      });
      expect(screen.queryByTestId('player-osd')).toBeNull();

      // Pointer hover wakes full 'controls' tier with minimalist top/bottom bars, hover volume popover, and dynamic fullscreen icon
      await fireEvent(screen.getByTestId('player-screen'), 'pointerMove', {
        nativeEvent: { pointerType: 'mouse', clientX: 200, clientY: 200 },
      });
      expect(screen.getByTestId('player-osd-top')).toBeTruthy();
      expect(screen.getByTestId('player-osd-bottom')).toBeTruthy();
      expect(screen.getByTestId('player-bottom-transport')).toBeTruthy();
      await fireEvent(screen.getByTestId('player-mute-button'), 'hoverIn');
      expect(screen.getByTestId('player-volume-slider')).toBeTruthy();
      expect(StyleSheet.flatten(screen.getByTestId('player-osd').props.style)?.position).not.toBe(
        'absolute',
      );

      // Dynamic fullscreen label toggles Fullscreen <-> Exit fullscreen
      expect(screen.getByTestId('player-fullscreen-button').props.accessibilityLabel).toBe(
        'Fullscreen',
      );
      await fireEvent.press(screen.getByTestId('player-fullscreen-button'));
      expect(screen.getByTestId('player-fullscreen-button').props.accessibilityLabel).toBe(
        'Exit fullscreen',
      );

      // Opening Settings isolates scroll-wheel (never calls preventDefault or changes volume)
      await fireEvent.press(screen.getByTestId('player-settings-button'));
      expect(screen.getByTestId('player-settings-panel')).toBeTruthy();
      const preventSheetWheel = jest.fn();
      const volCallsBefore = p.setVolume.mock.calls.length;
      await fireEvent(screen.getByTestId('player-screen'), 'wheel', {
        deltaY: 120,
        preventDefault: preventSheetWheel,
      });
      expect(preventSheetWheel).not.toHaveBeenCalled();
      expect(p.setVolume).toHaveBeenCalledTimes(volCallsBefore);

      // Escape steps down: closes Settings -> stays in controls -> Escape exits
      await web.emitKey('keydown', { key: 'Escape' });
      await web.emitKey('keyup', { key: 'Escape' });
      expect(screen.queryByTestId('player-settings-panel')).toBeNull();
      expect(p.onExit).not.toHaveBeenCalled();
      await web.emitKey('keydown', { key: 'Escape' });
      await web.emitKey('keyup', { key: 'Escape' });
      expect(p.onExit).toHaveBeenCalledTimes(1);

      await p.view.unmount();
    } finally {
      web.restore();
    }
  });

  it('#58: declutters Playing status & duplicate VOD clock, shows buffering spinner, renders real StreamVideoInfo badges, and opens non-blocking PlayerInfoSheet', async () => {
    const web = installWebWindow();
    try {
      const p = await mountRedesignedPlayer({
        formFactor: 'desktop',
        os: 'web',
        target: VOD_TARGET,
      });

      // While tuning: buffering ActivityIndicator renders inside Play/Pause and status shows Tuning
      expect(screen.getByTestId('player-play-pause-loading')).toBeTruthy();
      expect(screen.getByTestId('osd-status')).toHaveTextContent(/Tuning/);

      await act(async () => {
        p.manual.advance(350);
        p.engine.emit({
          attempt: p.attempt,
          type: 'clock',
          anchor: { positionMs: 15_000, atMs: p.manual.now(), rate: 1, durationMs: 120_000 },
        });
        p.engine.emit({ attempt: p.attempt, type: 'tracks', tracks: TRACKS_51 });
        p.engine.emit({
          attempt: p.attempt,
          type: 'mediaInfo',
          info: { width: 3840, height: 2160, fps: 60, codec: 'hevc', hdr: 'hdr10' },
        });
      });

      // Playing status is hidden, buffering spinner gone, duplicate VOD clock eliminated
      expect(screen.queryByTestId('osd-status')).toBeNull();
      expect(screen.queryByTestId('player-play-pause-loading')).toBeNull();
      expect(screen.queryByTestId('osd-clock')).toBeNull();

      // Real decoded telemetry badges rendered as compact MicroPills
      expect(screen.getByTestId('player-stream-badge-res')).toHaveTextContent('4K');
      expect(screen.getByTestId('player-stream-badge-fps')).toHaveTextContent('60 fps');
      expect(screen.getByTestId('player-stream-badge-hdr')).toHaveTextContent('HDR10');
      expect(screen.getByTestId('player-stream-badge-audio')).toHaveTextContent('5.1');

      // Press 'i' -> opens non-blocking PlayerInfoSheet without pausing playback
      await web.emitKey('keydown', { key: 'i' });
      expect(screen.getByTestId('player-info-panel')).toBeTruthy();
      expect(screen.getByTestId('player-info-badge-hdr')).toHaveTextContent('HDR10');
      expect(p.engine.commands.some((c) => c.name === 'pause')).toBe(false);

      // Press 'i' again -> closes PlayerInfoSheet cleanly
      await web.emitKey('keydown', { key: 'i' });
      expect(screen.queryByTestId('player-info-panel')).toBeNull();

      await p.view.unmount();
    } finally {
      web.restore();
    }
  });

  it('#114: wires auto-subtitles on skip back in PlayerSettingsSheet + temporary subtitle activation, and mounts mobile PlayerTouchGestures with hold-to-2x', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      const p = await mountRedesignedPlayer({
        formFactor: 'phone',
        os: 'android',
        target: VOD_TARGET,
        autoSubtitlesOnSkipBack: true,
      });

      await act(async () => {
        p.manual.advance(350);
        p.engine.emit({
          attempt: p.attempt,
          type: 'clock',
          anchor: { positionMs: 40_000, atMs: p.manual.now(), rate: 1, durationMs: 120_000 },
        });
        p.engine.emit({ attempt: p.attempt, type: 'tracks', tracks: TRACKS_51 });
      });

      // Settings exposes auto-subtitles on skip back toggle on VOD
      await fireEvent.press(screen.getByTestId('player-settings-button'));
      const toggle = screen.getByTestId('player-auto-subtitles-skip-back-toggle');
      expect(toggle).toHaveTextContent(/Subtitles on skip back/);
      await fireEvent.press(toggle);
      expect(p.onToggleAutoSubtitlesOnSkipBack).toHaveBeenCalledTimes(1);
      await fireEvent.press(screen.getByTestId('player-settings-close'));

      // Skipping back (-10s) activates temporary subtitle track and clears it after 15s
      await fireEvent.press(screen.getByTestId('player-seek-back'));
      expect(p.selectSubtitleSpy).toHaveBeenCalledWith(expect.any(Number), 's:1');
      await act(async () => {
        p.manual.advance(15_000);
      });
      expect(p.selectSubtitleSpy).toHaveBeenLastCalledWith(expect.any(Number), null);

      // Touch gestures: 500ms hold on VOD engages temporary 2x speed + pill, release restores 1x
      const gestures = screen.getByTestId('player-touch-gestures');
      await fireEvent(gestures, 'layout', {
        nativeEvent: { layout: { width: 393, height: 852 } },
      });
      await fireEvent(gestures, 'responderGrant', {
        nativeEvent: { locationX: 200, locationY: 400 },
      });
      await act(async () => {
        jest.advanceTimersByTime(HOLD_SPEED_DELAY_MS);
      });
      expect(p.setSpeedSpy).toHaveBeenLastCalledWith(expect.any(Number), 2);
      expect(screen.getByTestId('player-touch-hold-speed-pill')).toHaveTextContent('2× speed');

      await fireEvent(gestures, 'responderRelease', {
        nativeEvent: { locationX: 200, locationY: 400 },
      });
      await act(async () => {
        p.manual.advance(100);
      });
      expect(p.setSpeedSpy).toHaveBeenLastCalledWith(expect.any(Number), 1);
      expect(screen.queryByTestId('player-touch-hold-speed-pill')).toBeNull();

      // Left vertical swipe adjusts brightness through host callback
      await fireEvent(gestures, 'responderGrant', {
        nativeEvent: { locationX: 80, locationY: 300 },
      });
      await fireEvent(gestures, 'responderMove', {
        nativeEvent: { locationX: 80, locationY: 420 },
      });
      await fireEvent(gestures, 'responderRelease', {
        nativeEvent: { locationX: 80, locationY: 420 },
      });
      expect(p.setBrightness).toHaveBeenCalled();

      await p.view.unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  it('#57: opens HWND-safe desktop PlayerChannelDrawer with G/button, displays Now/Next schedule, selects channel safely, and closes on Escape', async () => {
    const web = installWebWindow();
    try {
      const nowNext = jest.fn(async (keys: readonly string[]) =>
        keys[0] === 'ch:1' ? [NOW_NEXT] : [{ channelKey: keys[0] ?? '', now: null, next: null }],
      );
      const liveTarget: PlayTarget = {
        ...FIRST_CHANNEL,
        playlist: makePlaylist(0),
      };
      const p = await mountRedesignedPlayer({
        formFactor: 'desktop',
        os: 'web',
        target: liveTarget,
        nowNext,
      });

      const order: string[] = [];
      const origStop = p.engine.stop.bind(p.engine);
      jest.spyOn(p.engine, 'stop').mockImplementation((att) => {
        order.push('stop');
        origStop(att);
      });
      const origLoad = p.engine.load.bind(p.engine);
      jest.spyOn(p.engine, 'load').mockImplementation((cmd) => {
        order.push(`load:${cmd.url}`);
        origLoad(cmd);
      });

      await act(async () => {
        p.manual.advance(350);
      });

      // Live now-playing programme appears cleanly in Cinema Bar
      await waitFor(() => {
        expect(screen.getByTestId('osd-now-programme')).toHaveTextContent(/Evening News Hour/);
      });

      // Press 'g' opens docked desktop channel drawer alongside player-surface-layer
      await web.emitKey('keydown', { key: 'g' });
      expect(screen.getByTestId('player-channel-drawer-desktop')).toBeTruthy();
      expect(screen.getByTestId('player-surface-layer').props.style).toEqual({ flex: 1 });
      await waitFor(() => {
        expect(screen.getByTestId('player-channel-row-0')).toBeTruthy();
        expect(screen.getByTestId('player-channel-drawer-schedule')).toHaveTextContent(
          /Evening News Hour/,
        );
      });

      // Escape closes drawer without exiting player
      await web.emitKey('keydown', { key: 'Escape' });
      await web.emitKey('keyup', { key: 'Escape' });
      expect(screen.queryByTestId('player-channel-drawer-desktop')).toBeNull();
      expect(p.onExit).not.toHaveBeenCalled();

      // Re-open via button and select channel 2 -> stop() BEFORE load(ch:2) & drawer closes
      await fireEvent.press(screen.getByTestId('player-channel-list-button'));
      await waitFor(() => {
        expect(screen.getByTestId('player-channel-row-1')).toBeTruthy();
      });
      order.length = 0;
      await fireEvent.press(screen.getByTestId('player-channel-row-1'));

      await waitFor(() => {
        expect(screen.getByTestId('osd-title')).toHaveTextContent('2. Beta Sports');
      });
      expect(screen.queryByTestId('player-channel-drawer-desktop')).toBeNull();
      expect(order.indexOf('stop')).toBeGreaterThanOrEqual(0);
      expect(order.findIndex((e) => e.includes('ch:2'))).toBeGreaterThan(order.indexOf('stop'));
      expect(p.engine.maxConcurrentMedias()).toBe(1);

      await p.view.unmount();
    } finally {
      web.restore();
    }
  });

  it('#392: resolves cross-season next episode via queryNextEpisode, counts down, and hands off with stop() before load()', async () => {
    const crossSeasonRow: NextEpisodeRow = {
      id: 201,
      key: 'x:s1:ep:s02e01',
      sourceId: 's1',
      seriesKey: 'series:horizon',
      seriesTitle: 'Horizon',
      season: 2,
      episode: 1,
      title: 'New Dawn',
      logo: null,
      durationSec: 3600,
    };
    const queryNextEpisode = jest.fn(async (_seriesKey: string, currentKey: string) =>
      currentKey === 'x:s1:ep:s01e10' ? crossSeasonRow : null,
    );

    const p = await mountRedesignedPlayer({
      formFactor: 'desktop',
      os: 'web',
      target: VOD_TARGET,
      autoPlayNextEpisode: true,
      queryNextEpisode,
    });

    const order: string[] = [];
    const origStop = p.engine.stop.bind(p.engine);
    jest.spyOn(p.engine, 'stop').mockImplementation((att) => {
      order.push('stop');
      origStop(att);
    });
    const origLoad = p.engine.load.bind(p.engine);
    jest.spyOn(p.engine, 'load').mockImplementation((cmd) => {
      order.push(`load:${cmd.url}:${cmd.startMs ?? 'none'}`);
      origLoad(cmd);
    });

    await waitFor(() => {
      expect(queryNextEpisode).toHaveBeenCalledWith('series:horizon', 'x:s1:ep:s01e10', undefined);
    });

    await act(async () => {
      p.manual.advance(350);
      p.engine.emit({
        attempt: p.attempt,
        type: 'clock',
        anchor: { positionMs: 92_000, atMs: p.manual.now(), rate: 1, durationMs: 100_000 },
      });
    });

    // Cross-season S2 E1 countdown card appears automatically
    await waitFor(() => {
      expect(screen.getByTestId('player-next-episode-banner')).toBeTruthy();
    });
    expect(screen.getByTestId('player-next-episode')).toHaveTextContent('Next: S2 E1');
    expect(screen.getByTestId('player-next-episode-countdown')).toHaveTextContent(
      'Next episode in 10s',
    );

    // Advance 10s -> auto-advances to S2 E1 with stop() BEFORE load(..., 0) & single connection
    order.length = 0;
    for (let s = 0; s < 10; s++) {
      await act(async () => {
        p.manual.advance(1_000);
      });
    }

    await waitFor(() => {
      expect(p.catalog.resolveStream).toHaveBeenLastCalledWith('x:s1:ep:s02e01');
      expect(screen.getByTestId('osd-title')).toHaveTextContent('Horizon — New Dawn');
    });
    const stopIdx = order.indexOf('stop');
    const loadIdx = order.indexOf('load:http://sim.example.test/x:s1:ep:s02e01.mp4:0');
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(loadIdx).toBeGreaterThan(stopIdx);
    expect(p.engine.maxConcurrentMedias()).toBe(1);

    await p.view.unmount();
  });

  it('#391, #58 & #57: mobile/TV floating OSD renders progress peek without top/center chrome, circular Live prev/next icons, and Live Now/Next strip', async () => {
    const nowNext = jest.fn(async () => [NOW_NEXT]);
    const liveTarget: PlayTarget = {
      ...FIRST_CHANNEL,
      playlist: makePlaylist(0),
    };
    const live = await mountRedesignedPlayer({
      formFactor: 'phone',
      os: 'android',
      target: liveTarget,
      nowNext,
    });

    await act(async () => {
      live.manual.advance(350);
      live.engine.emit({
        attempt: live.attempt,
        type: 'mediaInfo',
        info: { width: 1920, height: 1080, fps: 50 },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('player-live-now-next')).toBeTruthy();
    });
    // Portrait phone hides StreamBadgePills so the top header stays sleek 2-line (badges live in Info & Settings)
    expect(screen.queryByTestId('player-stream-badge-res')).toBeNull();
    expect(screen.queryByTestId('player-stream-badge-fps')).toBeNull();
    // Live prev/next are sleek circular icon buttons with accessible labels (no text children)
    const prevBtn = screen.getByTestId('player-prev');
    const nextBtn = screen.getByTestId('player-next');
    expect(prevBtn.props.accessibilityLabel).toBe('Prev');
    expect(nextBtn.props.accessibilityLabel).toBe('Next');
    expect(StyleSheet.flatten(prevBtn.props.style)?.width).toBe(44);
    expect(screen.getByTestId('player-channel-list-button')).toBeTruthy();
    expect(screen.getByTestId('osd-clock')).toBeTruthy();
    await live.view.unmount();

    // VOD hidden -> double-tap right on mobile triggers floating 'progress' peek ONLY
    const vod = await mountRedesignedPlayer({
      formFactor: 'phone',
      os: 'android',
      target: VOD_TARGET,
      initialOsdHidden: true,
    });
    await act(async () => {
      vod.manual.advance(350);
      vod.engine.emit({
        attempt: vod.attempt,
        type: 'clock',
        anchor: { positionMs: 20_000, atMs: vod.manual.now(), rate: 1, durationMs: 120_000 },
      });
    });
    expect(screen.queryByTestId('player-osd')).toBeNull();

    const gestures = screen.getByTestId('player-touch-gestures');
    await fireEvent(gestures, 'layout', { nativeEvent: { layout: { width: 400, height: 800 } } });
    // Double-tap right side (> 60% width) -> +10s seek -> floating 'progress' peek
    for (let i = 0; i < 2; i++) {
      await fireEvent(gestures, 'responderGrant', {
        nativeEvent: { locationX: 340, locationY: 400 },
      });
      await fireEvent(gestures, 'responderRelease', {
        nativeEvent: { locationX: 340, locationY: 400 },
      });
    }
    expect(screen.getByTestId('player-osd-progress-peek')).toBeTruthy();
    expect(screen.queryByTestId('player-osd-top')).toBeNull();
    expect(screen.queryByTestId('player-center-transport')).toBeNull();

    await act(async () => {
      vod.manual.advance(PROGRESS_OSD_AUTO_HIDE_MS);
    });
    expect(screen.queryByTestId('player-osd')).toBeNull();
    await vod.view.unmount();
  });
});
