import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import type { MediaTracks, PlaybackService, PlaybackState } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import {
  FormFactorProvider,
  I18nProvider,
  RemoteKeysProvider,
  ThemeProvider,
  TvRemoteProvider,
} from '@elv/ui-kit';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react-native';
import { Platform, StyleSheet, View } from 'react-native';
import type { PlayableEntry, PlayTarget } from '../../ports/play-target';
import { CHANNEL_DIGIT_TIMEOUT_MS } from '../channel-digit-entry';
import { PlayerScreen } from '../PlayerScreen';
import { useOsdAutoHide } from '../useOsdAutoHide';
import { VodProgressBar } from '../VodProgressBar';
import { createFakeAndroidKeys, createManualClock } from './player-test-harness';

// Android keycodes mapped in packages/ui-kit/src/tv/android-keys.ts (#439)
const KEY_BACK = 4;
const KEY_1 = 8;
const KEY_2 = 9;
const KEY_5 = 12;
const KEY_UP = 19;
const KEY_DOWN = 20;
const KEY_RIGHT = 22;
const KEY_SELECT = 23;
const KEY_MENU = 82;
const KEY_PLAY_PAUSE = 85;
const KEY_STOP = 86;
const KEY_NEXT = 87;
const KEY_PREVIOUS = 88;
const KEY_REWIND = 89;
const KEY_FAST_FORWARD = 90;
const KEY_PLAY = 126;
const KEY_PAUSE = 127;
const KEY_INFO = 165;
const KEY_CAPTIONS = 175;
const KEY_AUDIO_TRACK = 222;
const KEY_LAST_CHANNEL = 229;

const TRACKS: MediaTracks = {
  audio: [
    { id: 'a:1', language: 'tur', label: 'Turkish', codec: 'aac', channels: 2 },
    { id: 'a:2', language: 'eng', label: 'English', codec: 'ac3', channels: 6 },
  ],
  subtitles: [
    { id: 's:1', language: 'tur', codec: 'subrip' },
    { id: 's:2', language: 'eng', codec: 'subrip' },
  ],
  selectedAudioId: 'a:1',
  selectedSubtitleId: 's:1',
};

const CH1: PlayableEntry = {
  itemKey: 'ch:1',
  sourceId: 'src-1',
  title: '1. News HD',
  kind: 'live',
};
const CH2: PlayableEntry = {
  itemKey: 'ch:2',
  sourceId: 'src-1',
  title: '2. Sports HD',
  kind: 'live',
};
const CH3: PlayableEntry = {
  itemKey: 'ch:3',
  sourceId: 'src-1',
  title: '3. Cinema HD',
  kind: 'live',
};

const EP2: PlayableEntry = {
  itemKey: 'x:src-1:ep:2',
  sourceId: 'src-1',
  title: 'Episode 2',
  kind: 'vod',
};

const VOD_TARGET: PlayTarget = {
  itemKey: 'x:src-1:ep:1',
  sourceId: 'src-1',
  title: 'Episode 1',
  kind: 'vod',
  nextEpisodes: [EP2],
};

async function mountTvScreen(opts: {
  target?: PlayTarget;
  initialOsdHidden?: boolean;
  autoHideOsdMs?: number;
  withTracks?: boolean;
  channelByNumber?: (
    num: number,
    sourceId?: string,
  ) => Promise<null | {
    id: number;
    key: string;
    kind: 'live';
    sourceId: string;
    providerId: string | null;
    name: string;
    logo: string | null;
    rating: null;
    year: null;
    num: number | null;
  }>;
}) {
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
  const onExit = jest.fn();
  const catalog = {
    resolveStream: jest.fn(async (k: string) =>
      ok({ url: `http://sim.example.test/${k}.ts`, headers: {} }),
    ),
    ...(opts.channelByNumber !== undefined ? { channelByNumber: opts.channelByNumber } : {}),
  };
  const target = opts.target ?? VOD_TARGET;

  const view = await render(
    <ThemeProvider preset="obsidianCrimson">
      <RemoteKeysProvider android={keys.source}>
        <TvRemoteProvider>
          <FormFactorProvider value="tv">
            <I18nProvider i18n={createAppI18n('en')}>
              <PlayerScreen
                catalog={catalog}
                videoHost={{ open: () => ({ engine, renderSurface: () => <View /> }) }}
                target={target}
                clock={{ now: manual.now }}
                timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
                initialOsdHidden={opts.initialOsdHidden}
                autoHideOsdMs={opts.autoHideOsdMs}
                onExit={onExit}
              />
            </I18nProvider>
          </FormFactorProvider>
        </TvRemoteProvider>
      </RemoteKeysProvider>
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
    if (target.kind === 'vod') {
      engine.emit({
        attempt,
        type: 'clock',
        anchor: { positionMs: 40_000, atMs: manual.now(), rate: 0, durationMs: 200_000 },
      });
    }
    if (opts.withTracks) {
      engine.emit({ attempt, type: 'tracks', tracks: TRACKS });
    }
  });

  return { view, keys, manual, engine, onExit, catalog, attempt };
}

describe('Wave 3B Player TV focus, hidden-OSD passthrough, live controls, atomic timeout & RTL seek (#439, #277, #130)', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('#277: useOsdAutoHide extends auto-hide cleanly across rapid same-commit and consecutive activity bursts with zero premature expiry', async () => {
    const manual = createManualClock();
    const timersRef = {
      current: { setTimeout: manual.schedule, clearTimeout: manual.cancel },
    };
    const onAutoHide = jest.fn();

    const hook = await renderHook(
      (p: { active: boolean; itemKey: string }) =>
        useOsdAutoHide({
          autoHideOsdMs: 2_000,
          active: p.active,
          itemKey: p.itemKey,
          timersRef,
          onAutoHide,
        }),
      { initialProps: { active: true, itemKey: 'item:1' } },
    );

    // Advance 1_500 ms -> rapid back-to-back activity calls in one commit must extend timer cleanly
    await act(async () => {
      manual.advance(1_500);
      hook.result.current.notifyOsdActivity();
      hook.result.current.notifyOsdActivity();
      hook.result.current.notifyOsdActivity();
    });

    // Original deadline (+500 ms) must NOT fire
    await act(async () => {
      manual.advance(1_500);
    });
    expect(onAutoHide).not.toHaveBeenCalled();

    // Another activity pulse after 1_500 ms extends by another full 2_000 ms
    await act(async () => {
      hook.result.current.notifyOsdActivity();
    });
    await act(async () => {
      manual.advance(1_999);
    });
    expect(onAutoHide).not.toHaveBeenCalled();

    // At 2_000 ms after last activity, fires exactly once
    await act(async () => {
      manual.advance(1);
    });
    expect(onAutoHide).toHaveBeenCalledTimes(1);

    // clearAutoHide disarms so timer does not fire; notifyOsdActivity re-arms atomically even in same commit
    await act(async () => {
      hook.result.current.clearAutoHide();
      hook.result.current.notifyOsdActivity();
    });
    await act(async () => {
      manual.advance(2_000);
    });
    expect(onAutoHide).toHaveBeenCalledTimes(2);

    await hook.unmount();
  });

  it('#439: hidden-OSD transport & media keys wake OSD AND execute immediately, while directional/select/menu only wake OSD', async () => {
    const tv = await mountTvScreen({ initialOsdHidden: true, withTracks: true });
    expect(screen.queryByTestId('player-osd')).toBeNull();

    // PlayPause while hidden wakes OSD AND pauses immediately on first press
    await act(async () => tv.keys.tap(KEY_PLAY_PAUSE));
    expect(screen.getByTestId('player-osd')).toBeTruthy();
    expect(tv.engine.commands.filter((c) => c.name === 'pause')).toHaveLength(1);

    // Hide OSD via Up -> Rewind while hidden wakes OSD AND scrubs immediately
    await act(async () => tv.keys.tap(KEY_UP));
    expect(screen.queryByTestId('player-osd')).toBeNull();
    await act(async () => tv.keys.down(KEY_REWIND));
    await act(async () => tv.keys.up(KEY_REWIND));
    expect(screen.getByTestId('player-osd')).toBeTruthy();
    expect(tv.engine.commands.filter((c) => c.name === 'seek').at(-1)?.positionMs).toBe(30_000);

    // Hide OSD -> FastForward while hidden wakes OSD AND scrubs forward immediately
    await act(async () => tv.keys.tap(KEY_UP));
    expect(screen.queryByTestId('player-osd')).toBeNull();
    await act(async () => tv.keys.down(KEY_FAST_FORWARD));
    await act(async () => tv.keys.up(KEY_FAST_FORWARD));
    expect(screen.getByTestId('player-osd')).toBeTruthy();
    expect(tv.engine.commands.filter((c) => c.name === 'seek').at(-1)?.positionMs).toBe(40_000);

    // Hide OSD -> Digit 5 while hidden wakes OSD AND seeks to 50% immediately
    await act(async () => tv.keys.tap(KEY_UP));
    await act(async () => tv.keys.tap(KEY_5));
    expect(screen.getByTestId('player-osd')).toBeTruthy();
    expect(tv.engine.commands.filter((c) => c.name === 'seek').at(-1)?.positionMs).toBe(100_000);

    // Hide OSD -> Info while hidden wakes OSD AND toggles stats HUD immediately
    await act(async () => tv.keys.tap(KEY_UP));
    expect(screen.queryByTestId('player-stats-hud')).toBeNull();
    await act(async () => tv.keys.tap(KEY_INFO));
    expect(screen.getByTestId('player-osd')).toBeTruthy();
    expect(screen.getByTestId('player-stats-hud')).toBeTruthy();

    // Hide OSD -> Captions opens TrackPicker focused on subtitles column
    await act(async () => tv.keys.tap(KEY_UP));
    await act(async () => tv.keys.tap(KEY_CAPTIONS));
    expect(screen.getByTestId('player-tracks-panel')).toBeTruthy();
    expect(screen.getByTestId('player-subtitle-track-s:1').props.accessibilityState).toMatchObject({
      selected: true,
    });
    await act(async () => tv.keys.tap(KEY_BACK)); // close tracks (restores focus to 'tracks')
    await act(async () => tv.keys.tap(KEY_BACK)); // blur OSD

    // Hide OSD -> AudioTrack opens TrackPicker focused on audio column
    await act(async () => tv.keys.tap(KEY_UP));
    await act(async () => tv.keys.tap(KEY_AUDIO_TRACK));
    expect(screen.getByTestId('player-tracks-panel')).toBeTruthy();
    expect(screen.getByTestId('player-audio-track-a:1').props.accessibilityState).toMatchObject({
      selected: true,
    });
    await act(async () => tv.keys.tap(KEY_BACK));
    await act(async () => tv.keys.tap(KEY_BACK));

    // Hide OSD -> Menu only wakes OSD without opening tracks
    await act(async () => tv.keys.tap(KEY_UP));
    expect(screen.queryByTestId('player-osd')).toBeNull();
    await act(async () => tv.keys.tap(KEY_MENU));
    expect(screen.getByTestId('player-osd')).toBeTruthy();
    expect(screen.queryByTestId('player-tracks-panel')).toBeNull();

    // Next on VOD plays next episode
    await act(async () => tv.keys.tap(KEY_NEXT));
    await waitFor(() => {
      expect(tv.catalog.resolveStream).toHaveBeenLastCalledWith('x:src-1:ep:2');
    });

    // Stop stops playback and exits immediately even when OSD is hidden
    await act(async () => tv.keys.tap(KEY_UP));
    await act(async () => tv.keys.tap(KEY_STOP));
    expect(tv.engine.commands.at(-1)?.name).toBe('stop');
    expect(tv.onExit).toHaveBeenCalledTimes(1);

    await tv.view.unmount();
  });

  it('#439: fullscreen Live TV supports playPause/play/pause, next/previous/lastChannel, and 0-9 channel number entry via channelByNumber or playlist fallback', async () => {
    const channelByNumber = jest.fn(async (num: number, sourceId?: string) =>
      num === 12 && sourceId === 'src-1'
        ? {
            id: 12,
            key: 'ch:12',
            kind: 'live' as const,
            sourceId: 'src-1',
            providerId: '12',
            name: '12. Discovery HD',
            logo: null,
            rating: null,
            year: null,
            num: 12,
          }
        : null,
    );
    const entries = [CH1, CH2, CH3];
    const onChangeIndex = jest.fn();
    const tv = await mountTvScreen({
      initialOsdHidden: true,
      channelByNumber,
      target: {
        ...CH1,
        previousChannel: CH3,
        previousChannelIndex: 2,
        playlist: {
          count: entries.length,
          currentIndex: 0,
          onChangeIndex,
          getAt: async (i) => entries[i],
        },
      },
    });

    // PlayPause on Live pauses playback immediately even from hidden OSD
    await act(async () => tv.keys.tap(KEY_PLAY_PAUSE));
    expect(tv.engine.commands.filter((c) => c.name === 'pause')).toHaveLength(1);
    const pauseAttempt = tv.engine.commands.filter((c) => c.name === 'pause').at(-1)?.attempt ?? 1;
    await act(async () => {
      tv.engine.emit({ attempt: pauseAttempt, type: 'state', state: 'paused' });
    });
    await act(async () => tv.keys.tap(KEY_PLAY));
    expect(tv.engine.commands.filter((c) => c.name === 'play')).toHaveLength(1);
    const playAttempt = tv.engine.commands.filter((c) => c.name === 'play').at(-1)?.attempt ?? 1;
    await act(async () => {
      tv.engine.emit({ attempt: playAttempt, type: 'state', state: 'playing' });
    });
    await act(async () => tv.keys.tap(KEY_PAUSE));
    expect(tv.engine.commands.filter((c) => c.name === 'pause')).toHaveLength(2);

    // Direct channel number entry "12": shows badge, commits after 1_200 ms via catalog.channelByNumber(12, 'src-1')
    await act(async () => tv.keys.tap(KEY_1));
    await act(async () => tv.keys.tap(KEY_2));
    expect(screen.getByTestId('player-channel-digits')).toHaveTextContent('12');
    await act(async () => {
      tv.manual.advance(CHANNEL_DIGIT_TIMEOUT_MS);
    });
    await waitFor(() => {
      expect(channelByNumber).toHaveBeenCalledWith(12, 'src-1');
      expect(tv.catalog.resolveStream).toHaveBeenLastCalledWith('ch:12');
    });
    expect(screen.getByTestId('osd-title')).toHaveTextContent('12. Discovery HD');
    expect(screen.queryByTestId('player-channel-digits')).toBeNull();

    // LastChannel jumps back to CH1 (the channel before jumping to ch:12)
    await act(async () => tv.keys.tap(KEY_LAST_CHANNEL));
    await waitFor(() => {
      expect(tv.catalog.resolveStream).toHaveBeenLastCalledWith('ch:1');
    });

    // Next zaps +1 (to CH2), Previous zaps -1 (back to CH1)
    await act(async () => tv.keys.tap(KEY_NEXT));
    await waitFor(() => {
      expect(tv.catalog.resolveStream).toHaveBeenLastCalledWith('ch:2');
    });
    await act(async () => tv.keys.tap(KEY_PREVIOUS));
    await waitFor(() => {
      expect(tv.catalog.resolveStream).toHaveBeenLastCalledWith('ch:1');
    });

    // Digit entry cancelled by Back does not tune after timeout
    await act(async () => tv.keys.tap(KEY_2));
    expect(screen.getByTestId('player-channel-digits')).toHaveTextContent('2');
    await act(async () => tv.keys.tap(KEY_BACK));
    await act(async () => {
      tv.manual.advance(CHANNEL_DIGIT_TIMEOUT_MS + 100);
    });
    expect(channelByNumber).toHaveBeenCalledTimes(1);

    await tv.view.unmount();

    // Playlist fallback when channelByNumber is NOT provided: typing "2" tunes playlist.getAt(1) -> CH2
    const tvFallback = await mountTvScreen({
      target: {
        ...CH1,
        playlist: {
          count: entries.length,
          currentIndex: 0,
          onChangeIndex: jest.fn(),
          getAt: async (i) => entries[i],
        },
      },
    });
    await act(async () => tvFallback.keys.tap(KEY_2));
    await act(async () => {
      tvFallback.manual.advance(CHANNEL_DIGIT_TIMEOUT_MS);
    });
    await waitFor(() => {
      expect(tvFallback.catalog.resolveStream).toHaveBeenLastCalledWith('ch:2');
    });
    expect(screen.getByTestId('osd-title')).toHaveTextContent('2. Sports HD');

    // CH+ from hidden OSD still zaps without blocking
    await tvFallback.view.unmount();
  });

  it('#130: gates hasTVPreferredFocus during sheets, restores opener focus on close, and debounces duplicate Select bursts', async () => {
    const tv = await mountTvScreen({ withTracks: true });

    // Anchor hasTVPreferredFocus is true when no sheet is open
    const getAnchor = () =>
      screen.getByTestId('player-tv-focus-anchor', { includeHiddenElements: true });
    expect(getAnchor().props.hasTVPreferredFocus).toBe(true);

    // Focus OSD ('tracks') -> Select opens TrackPicker -> anchor hasTVPreferredFocus becomes false
    await act(async () => tv.keys.tap(KEY_DOWN));
    await act(async () => tv.keys.tap(KEY_SELECT));
    expect(screen.getByTestId('player-tracks-panel')).toBeTruthy();
    expect(getAnchor().props.hasTVPreferredFocus).toBe(false);

    // Back closes TrackPicker -> restores TV OSD focus to 'tracks' AND re-enables anchor hasTVPreferredFocus
    await act(async () => tv.keys.tap(KEY_BACK));
    expect(screen.queryByTestId('player-tracks-panel')).toBeNull();
    expect(getAnchor().props.hasTVPreferredFocus).toBe(true);
    expect(screen.getByTestId('player-tracks-button').props.accessibilityState).toMatchObject({
      selected: true,
    });

    // Move Right to 'settings' -> Select opens Settings -> anchor hasTVPreferredFocus becomes false
    await act(async () => tv.keys.tap(KEY_RIGHT));
    await act(async () => tv.keys.tap(KEY_SELECT));
    expect(screen.getByTestId('player-settings-panel')).toBeTruthy();
    expect(getAnchor().props.hasTVPreferredFocus).toBe(false);

    // Navigate to Stats row (index 4 on VOD TV: subtitles, audio, speed, aspect, stats)
    for (let i = 0; i < 4; i += 1) await act(async () => tv.keys.tap(KEY_DOWN));
    // First Select toggles Stats ON; duplicate Select < 220ms later is SUPPRESSED (stays ON!)
    await act(async () => tv.keys.tap(KEY_SELECT));
    expect(screen.getByTestId('player-stats-hud', { includeHiddenElements: true })).toBeTruthy();
    await act(async () => {
      tv.manual.advance(50);
      tv.keys.tap(KEY_SELECT);
    });
    expect(screen.getByTestId('player-stats-hud', { includeHiddenElements: true })).toBeTruthy();

    // After >= 220 ms window, Select toggles Stats OFF cleanly
    await act(async () => {
      tv.manual.advance(220);
      tv.keys.tap(KEY_SELECT);
    });
    expect(screen.queryByTestId('player-stats-hud', { includeHiddenElements: true })).toBeNull();

    // Back closes Settings -> restores focus to 'settings' button
    await act(async () => tv.keys.tap(KEY_BACK));
    expect(screen.queryByTestId('player-settings-panel')).toBeNull();
    expect(screen.getByTestId('player-settings-button').props.accessibilityState).toMatchObject({
      selected: true,
    });

    await tv.view.unmount();
  });

  it('#130: forces direction: ltr on VodProgressBar scrubber track and progress fill rail for RTL locales', async () => {
    const state: PlaybackState = {
      status: { kind: 'playing' },
      attempt: 1,
      tracks: TRACKS,
      staleEventsDropped: 0,
      surfaceRecreationToken: 0,
      anchor: { positionMs: 30_000, atMs: 1_000, rate: 0, durationMs: 120_000 },
    };
    const service = {
      getState: () => state,
      subscribe: () => () => undefined,
    } as unknown as PlaybackService;

    const view = await render(
      <ThemeProvider preset="obsidianCrimson">
        <VodProgressBar
          service={service}
          clock={{ now: () => 1_000 }}
          isTv
          label="Progress"
          onSeekRatio={jest.fn()}
        />
      </ThemeProvider>,
    );

    expect(StyleSheet.flatten(screen.getByTestId('player-progress-bar').props.style)).toMatchObject(
      { direction: 'ltr' },
    );
    expect(
      StyleSheet.flatten(screen.getByTestId('player-progress-rail').props.style),
    ).toMatchObject({ direction: 'ltr' });

    await view.unmount();
  });

  it('#130 review #3: drops duplicate Select bursts 5ms apart across TrackPicker/Settings/submenu opens while directional moves reset immediately', async () => {
    const tv = await mountTvScreen({ withTracks: true });

    // Duplicate Select 5ms apart when opening TrackPicker must NOT immediately select audio track a:1
    await act(async () => tv.keys.tap(KEY_DOWN));
    await act(async () => {
      tv.keys.tap(KEY_SELECT);
      tv.manual.advance(5);
      tv.keys.tap(KEY_SELECT);
    });
    expect(screen.getByTestId('player-tracks-panel')).toBeTruthy();
    expect(tv.engine.commands.filter((c) => c.name === 'selectAudioTrack')).toHaveLength(0);

    // Directional Down resets the guard immediately so intentional Select picks a:2 without waiting 220ms
    await act(async () => {
      tv.keys.tap(KEY_DOWN);
      tv.keys.tap(KEY_SELECT);
    });
    expect(tv.engine.commands.filter((c) => c.name === 'selectAudioTrack').at(-1)?.trackId).toBe(
      'a:2',
    );
    await act(async () => tv.keys.tap(KEY_BACK));

    // Move Right to 'settings' -> duplicate Select 5ms apart opens Settings root WITHOUT entering Subtitles submenu
    await act(async () => tv.keys.tap(KEY_RIGHT));
    await act(async () => {
      tv.keys.tap(KEY_SELECT);
      tv.manual.advance(5);
      tv.keys.tap(KEY_SELECT);
    });
    expect(screen.getByTestId('player-settings-panel')).toBeTruthy();
    expect(screen.getByTestId('player-settings-row-subtitles')).toBeTruthy();
    expect(screen.queryByTestId('player-settings-sub-off')).toBeNull();

    // After >= 220ms, duplicate Select 5ms apart entering Subtitles submenu must NOT immediately select Off
    await act(async () => {
      tv.manual.advance(250);
      tv.keys.tap(KEY_SELECT);
      tv.manual.advance(5);
      tv.keys.tap(KEY_SELECT);
    });
    expect(screen.getByTestId('player-settings-sub-off')).toBeTruthy();
    expect(tv.engine.commands.filter((c) => c.name === 'selectSubtitleTrack')).toHaveLength(0);

    await tv.view.unmount();
  });

  it('#439 review #6: renders player-channel-digits MicroPill in DesktopCinemaBar on Live desktop playback', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const view = await render(
      <ThemeProvider preset="obsidianCrimson">
        <FormFactorProvider value="desktop">
          <I18nProvider i18n={createAppI18n('en')}>
            <PlayerScreen
              catalog={{
                resolveStream: async (k) =>
                  ok({ url: `http://sim.example.test/${k}.ts`, headers: {} }),
              }}
              videoHost={{ open: () => ({ engine, renderSurface: () => <View /> }) }}
              target={CH1}
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
    const onKeyDown = screen.getByTestId('player-screen').props.onKeyDown as (e: {
      key: string;
      preventDefault?: () => void;
    }) => void;
    await act(async () => {
      onKeyDown({ key: '1', preventDefault: jest.fn() });
      onKeyDown({ key: '2', preventDefault: jest.fn() });
    });
    expect(screen.getByTestId('player-channel-digits')).toHaveTextContent('12');
    await view.unmount();
  });
});
