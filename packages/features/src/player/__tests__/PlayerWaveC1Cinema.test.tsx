import type { NowNextEntry, PersistedTrackPreference, SaveTrackPreferenceInput } from '@elv/data';
import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import type { MediaTracks, PlaybackService, PlaybackState } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import {
  FormFactorProvider,
  I18nProvider,
  ThemeProvider,
  TvRemoteProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, StyleSheet, View } from 'react-native';
import type { PlayableEntry, PlayTarget } from '../../ports/play-target';
import type { VideoResizeMode } from '../../ports/video-host';
import { CatalogUiCacheProvider } from '../../shared/CatalogUiCacheProvider';
import { createCatalogUiCache } from '../../shared/catalog-ui-cache';
import { PlayerScreen } from '../PlayerScreen';
import { PlayerStatsHud } from '../PlayerStatsHud';
import { VodProgressBar } from '../VodProgressBar';
import { createManualClock } from './player-test-harness';

const TRACKS: MediaTracks = {
  audio: [
    { id: 'a:1', language: 'eng', label: 'English', codec: 'aac', channels: 2 },
    { id: 'a:2', language: 'tur', label: 'Turkish', codec: 'ac3', channels: 6 },
  ],
  subtitles: [
    { id: 's:1', language: 'eng', label: 'English' },
    { id: 's:2', language: 'tur', label: 'Turkish' },
  ],
  selectedAudioId: 'a:1',
  selectedSubtitleId: null,
};

const SERIES_EP1: PlayTarget = {
  itemKey: 'x:src-1:episode:101',
  kind: 'vod',
  title: 'Arcane — S1 E1',
  subtitle: 'Welcome to the Playground',
  sourceId: 'src-1',
  seriesKey: 'x:src-1:series:55',
  nextEpisodes: [
    {
      itemKey: 'x:src-1:episode:102',
      kind: 'vod',
      title: 'Arcane — S1 E2',
      subtitle: 'Some Mysteries Are Better Left Unsolved',
      sourceId: 'src-1',
      seriesKey: 'x:src-1:series:55',
    },
  ],
};

const LIVE_CHANNELS: PlayableEntry[] = [
  { itemKey: 'ch:1', kind: 'live', title: '1. Cinema HD', sourceId: 'src-1' },
  { itemKey: 'ch:2', kind: 'live', title: '2. News 24', sourceId: 'src-1' },
];

const EPOCH_BASE = new Date(2026, 10, 22, 20, 0, 0, 0).getTime();

describe('Wave C1 Minimalist Cinema OSD, #160 Ends At/Stats, #355 Fine Scrub, #124/#208/#310/#393', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('Product Decision #40: renders floating cinema OSD on desktop in-canvas, switches to docked on onOverlayModeChange, and caps portrait phone top-right icons to 3', async () => {
    jest.replaceProperty(Platform, 'OS', 'web' as typeof Platform.OS);
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const setResizeMode = jest.fn();
    let emitMode: ((mode: 'floating' | 'docked') => void) | undefined;

    const view = await render(
      <ThemeProvider preset="obsidianCrimson">
        <TvRemoteProvider>
          <ViewportProvider
            value={{
              formFactor: 'desktop',
              orientation: 'landscape',
              inputModality: 'pointer',
              width: 1280,
              height: 720,
            }}
          >
            <FormFactorProvider value="desktop">
              <I18nProvider i18n={createAppI18n('en')}>
                <PlayerScreen
                  catalog={{
                    resolveStream: async (k) =>
                      ok({ url: `http://sim.example.test/${k}.mp4`, headers: {} }),
                  }}
                  videoHost={{
                    open: () => ({
                      engine,
                      overlayMode: 'floating',
                      onOverlayModeChange: (listener) => {
                        emitMode = listener;
                        return () => {
                          emitMode = undefined;
                        };
                      },
                      setResizeMode,
                      toggleMute: jest.fn(),
                      setVolume: jest.fn(),
                      renderSurface: () => <View testID="mock-surface" />,
                    }),
                  }}
                  target={SERIES_EP1}
                  clock={{ now: manual.now }}
                  timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
                  onExit={jest.fn()}
                />
              </I18nProvider>
            </FormFactorProvider>
          </ViewportProvider>
        </TvRemoteProvider>
      </ThemeProvider>,
    );

    await waitFor(() => expect(engine.commands.some((c) => c.name === 'load')).toBe(true));
    const attempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
    await act(async () => {
      manual.advance(350);
      engine.emit({ attempt, type: 'tracks', tracks: TRACKS });
      engine.emit({
        attempt,
        type: 'clock',
        anchor: { positionMs: 31_000, atMs: manual.now(), rate: 1, durationMs: 1_252_000 },
      });
    });

    // Floating mode: full-bleed absolute scrim OSD, unobstructed center canvas, bare top icons, pill CTA
    expect(StyleSheet.flatten(screen.getByTestId('player-osd').props.style)?.position).toBe(
      'absolute',
    );
    expect(screen.queryByTestId('player-center-transport')).toBeNull();
    expect(screen.getByTestId('player-bottom-transport')).toBeTruthy();
    expect(screen.getByTestId('player-back')).toBeTruthy();
    expect(screen.getByTestId('player-tracks-button')).toBeTruthy();
    expect(screen.getByTestId('player-mute-button')).toBeTruthy();
    expect(screen.getByTestId('player-aspect-button')).toBeTruthy();
    expect(screen.getByTestId('player-speed-button')).toBeTruthy();
    expect(screen.getByTestId('player-settings-button')).toBeTruthy();
    expect(screen.getByTestId('player-next-episode-pill')).toHaveTextContent('Next Episode');

    // Bare top button has zero resting background fill & zero resting border
    expect(
      StyleSheet.flatten(screen.getByTestId('player-aspect-button').props.style)?.borderWidth,
    ).toBe(0);

    // Clicking desktop aspect icon cycles fit -> fill and forwards to videoHost.setResizeMode
    await fireEvent.press(screen.getByTestId('player-aspect-button'));
    expect(setResizeMode).toHaveBeenLastCalledWith('fill');

    // Dynamic fallback to 'docked' (legacy child-HWND) removes position: 'absolute'
    await act(async () => {
      emitMode?.('docked');
    });
    expect(StyleSheet.flatten(screen.getByTestId('player-osd').props.style)?.position).not.toBe(
      'absolute',
    );
    await view.unmount();

    // Portrait Phone: top-right caps strictly to Subtitles, Lock, Settings (no mute/aspect/speed)
    jest.replaceProperty(Platform, 'OS', 'android' as typeof Platform.OS);
    const phoneEngine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const phoneView = await render(
      <ThemeProvider preset="obsidianCrimson">
        <TvRemoteProvider>
          <ViewportProvider
            value={{
              formFactor: 'phone',
              orientation: 'portrait',
              inputModality: 'touch',
              width: 390,
              height: 844,
            }}
          >
            <FormFactorProvider value="phone">
              <I18nProvider i18n={createAppI18n('en')}>
                <PlayerScreen
                  catalog={{
                    resolveStream: async (k) =>
                      ok({ url: `http://sim.example.test/${k}.mp4`, headers: {} }),
                  }}
                  videoHost={{
                    open: () => ({ engine: phoneEngine, renderSurface: () => <View /> }),
                  }}
                  target={SERIES_EP1}
                  clock={{ now: manual.now }}
                  timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
                  onExit={jest.fn()}
                />
              </I18nProvider>
            </FormFactorProvider>
          </ViewportProvider>
        </TvRemoteProvider>
      </ThemeProvider>,
    );
    await waitFor(() => expect(phoneEngine.commands.some((c) => c.name === 'load')).toBe(true));
    const pAtt = phoneEngine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
    await act(async () => {
      manual.advance(350);
      phoneEngine.emit({ attempt: pAtt, type: 'tracks', tracks: TRACKS });
    });
    expect(screen.getByTestId('player-tracks-button')).toBeTruthy();
    expect(screen.getByTestId('player-lock-button')).toBeTruthy();
    expect(screen.getByTestId('player-settings-button')).toBeTruthy();
    expect(screen.queryByTestId('player-aspect-button')).toBeNull();
    expect(screen.queryByTestId('player-speed-button')).toBeNull();
    await phoneView.unmount();
  });

  it('#160: cycles VOD right timestamp (Total -> -Remaining -> speed-adjusted Ends At), renders Live EPG Ends At, and shows Diagnostics metrics in PlayerStatsHud', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const onPersistTimeDisplayMode = jest.fn();

    const view = await render(
      <ThemeProvider preset="obsidianCrimson">
        <TvRemoteProvider>
          <FormFactorProvider value="desktop">
            <I18nProvider i18n={createAppI18n('en')}>
              <PlayerScreen
                catalog={{
                  resolveStream: async (k) =>
                    ok({ url: `http://sim.example.test/${k}.mp4`, headers: {} }),
                }}
                videoHost={{
                  open: () => ({ engine, overlayMode: 'floating', renderSurface: () => <View /> }),
                }}
                target={SERIES_EP1}
                clock={{ now: manual.now }}
                wallClock={() => EPOCH_BASE}
                timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
                osdTimeDisplayMode="total"
                onPersistOsdTimeDisplayMode={onPersistTimeDisplayMode}
                onExit={jest.fn()}
              />
            </I18nProvider>
          </FormFactorProvider>
        </TvRemoteProvider>
      </ThemeProvider>,
    );

    await waitFor(() => expect(engine.commands.some((c) => c.name === 'load')).toBe(true));
    const att = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
    // 10 min into a 40 min video (30 min remaining) at 20:00 -> Ends at 20:30 at 1x
    await act(async () => {
      manual.advance(350);
      engine.emit({
        attempt: att,
        type: 'clock',
        anchor: { positionMs: 600_000, atMs: manual.now(), rate: 0, durationMs: 2_400_000 },
      });
    });

    expect(screen.getByTestId('player-progress-time-current')).toHaveTextContent('10:00');
    expect(screen.getByTestId('player-progress-time')).toHaveTextContent('40:00');

    // Press end timestamp -> cycles to '-30:00' and persists 'remaining'
    await fireEvent.press(screen.getByTestId('player-progress-time-end'));
    expect(screen.getByTestId('player-progress-time')).toHaveTextContent('-30:00');
    expect(onPersistTimeDisplayMode).toHaveBeenLastCalledWith('remaining');

    // Press again -> cycles to 'Ends at 20:30' and persists 'endsAt'
    await fireEvent.press(screen.getByTestId('player-progress-time-end'));
    expect(screen.getByTestId('player-progress-time')).toHaveTextContent('Ends at 20:30');
    expect(onPersistTimeDisplayMode).toHaveBeenLastCalledWith('endsAt');

    // Change speed to 2x -> 30 min remaining / 2 = 15 min -> 'Ends at 20:15'
    await fireEvent.press(screen.getByTestId('player-speed-button'));
    await fireEvent.press(screen.getByTestId('player-settings-speed-2'));
    expect(screen.getByTestId('player-progress-time')).toHaveTextContent('Ends at 20:15');
    await view.unmount();

    // Live EPG Ends At display when osdTimeDisplayMode === 'endsAt'
    const liveEngine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const nowNextEntry: NowNextEntry = {
      channelKey: 'ch:1',
      now: {
        channelKey: 'ch:1',
        sourceId: 'src-1',
        guideId: 'g:1',
        title: 'Prime Time Movie',
        subTitle: null,
        description: null,
        episodeNum: null,
        icon: null,
        start: EPOCH_BASE - 15 * 60_000,
        stop: EPOCH_BASE + 45 * 60_000,
      },
      next: null,
    };
    const liveView = await render(
      <ThemeProvider preset="obsidianCrimson">
        <TvRemoteProvider>
          <FormFactorProvider value="tv">
            <I18nProvider i18n={createAppI18n('en')}>
              <PlayerScreen
                catalog={{
                  resolveStream: async (k) =>
                    ok({ url: `http://sim.example.test/${k}.ts`, headers: {} }),
                  nowNext: async () => [nowNextEntry],
                }}
                videoHost={{ open: () => ({ engine: liveEngine, renderSurface: () => <View /> }) }}
                target={{
                  ...(LIVE_CHANNELS[0] as PlayableEntry),
                  playlist: {
                    count: LIVE_CHANNELS.length,
                    currentIndex: 0,
                    getAt: async (i) => LIVE_CHANNELS[i],
                    onChangeIndex: jest.fn(),
                  },
                }}
                clock={{ now: manual.now }}
                wallClock={() => EPOCH_BASE}
                timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
                osdTimeDisplayMode="endsAt"
                onExit={jest.fn()}
              />
            </I18nProvider>
          </FormFactorProvider>
        </TvRemoteProvider>
      </ThemeProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('osd-live-ends-at')).toHaveTextContent('Ends at 20:45');
    });
    expect(screen.getByTestId('player-channel-list-button')).toHaveTextContent('Channels');
    await liveView.unmount();

    // Diagnostic Overlay: renders live droppedFrames from PlaybackService + CatalogUiCache hit rate + UI stalls
    const cache = createCatalogUiCache();
    cache.setHome({
      continueWatching: [],
      favorites: [],
      favoriteKeys: new Set(),
      progressByKey: new Map(),
      liveCategory: null,
      liveItems: [],
      movies: [],
      series: [],
    });
    cache.getHome(); // 1 hit -> 100% hit rate
    const statsState: PlaybackState = {
      status: { kind: 'playing' },
      attempt: 1,
      tracks: TRACKS,
      videoInfo: { width: 1920, height: 1080, fps: 60 },
      droppedFrames: 4,
      staleEventsDropped: 0,
      surfaceRecreationToken: 0,
      anchor: { positionMs: 12_000, atMs: 0, rate: 0, durationMs: 120_000 },
    };
    const statsService = {
      getState: () => statsState,
      subscribe: () => () => undefined,
    } as unknown as PlaybackService;
    const hudView = await render(
      <ThemeProvider preset="obsidianCrimson">
        <CatalogUiCacheProvider cache={cache}>
          <PlayerStatsHud
            visible
            isDesktop={false}
            service={statsService}
            clock={{ now: () => 0 }}
            i18n={createAppI18n('en')}
          />
        </CatalogUiCacheProvider>
      </ThemeProvider>,
    );
    expect(screen.getByTestId('player-stats-hud')).toHaveTextContent(/4/);
    expect(screen.getByTestId('player-stats-hud')).toHaveTextContent(/100%/);
    expect(screen.getByTestId('player-stats-hud')).toHaveTextContent(/UI stalls/);
    await hudView.unmount();
  });

  it('#355: touch fine-scrubbing steps 1x -> 0.25x -> 0.1x without playhead jump, fires tier/origin haptics, and commits once on release', async () => {
    jest.replaceProperty(Platform, 'OS', 'android' as typeof Platform.OS);
    const onSeekRatio = jest.fn();
    const onFineScrubHaptic = jest.fn();
    const state: PlaybackState = {
      status: { kind: 'playing' },
      attempt: 1,
      tracks: TRACKS,
      staleEventsDropped: 0,
      surfaceRecreationToken: 0,
      anchor: { positionMs: 500_000, atMs: 1_000, rate: 0, durationMs: 1_000_000 },
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
          isTv={false}
          label="Progress"
          i18n={createAppI18n('en')}
          onFineScrubHaptic={onFineScrubHaptic}
          onSeekRatio={onSeekRatio}
        />
      </ThemeProvider>,
    );

    await fireEvent(screen.getByTestId('player-progress-bar'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 200, height: 24 } },
    });
    const scrubber = screen.getByTestId('player-progress-touch-scrubber');

    // Grant at x=100 (50% = 8:20), y=400
    await fireEvent(scrubber, 'responderGrant', {
      nativeEvent: { locationX: 100, pageX: 100, pageY: 400, identifier: 1 },
    });
    expect(screen.queryByTestId('player-progress-scrub-tier')).toBeNull();

    // Drag vertically 70px down (into 0.25x quarter tier) with zero dx -> zero playhead jump!
    await fireEvent(scrubber, 'responderMove', {
      nativeEvent: { locationX: 100, pageX: 100, pageY: 470, identifier: 1 },
    });
    expect(screen.getByTestId('player-progress-scrub-tier')).toHaveTextContent(/0\.25×/);
    expect(screen.getByTestId('player-progress-hover-time')).toHaveTextContent('8:20');
    expect(onFineScrubHaptic).toHaveBeenCalledWith('tier');

    // Drag +80px horizontally at 0.25x -> delta = (80 / 200) * 0.25 = +0.10 -> ratio 0.60 (10:00)
    await fireEvent(scrubber, 'responderMove', {
      nativeEvent: { locationX: 180, pageX: 180, pageY: 470, identifier: 1 },
    });
    expect(screen.getByTestId('player-progress-hover-time')).toHaveTextContent('10:00');

    // Drag vertically 130px down (into 0.1x ultra-fine tier) and +100px horizontally -> +0.05 -> 0.65 (10:50)
    await fireEvent(scrubber, 'responderMove', {
      nativeEvent: { locationX: 280, pageX: 280, pageY: 530, identifier: 1 },
    });
    expect(screen.getByTestId('player-progress-scrub-tier')).toHaveTextContent(/0\.1×/);
    expect(screen.getByTestId('player-progress-hover-time')).toHaveTextContent('10:50');

    // Release commits one coalesced seek at 0.65
    await fireEvent(scrubber, 'responderRelease', {
      nativeEvent: { locationX: 280, pageX: 280, pageY: 530, identifier: 1 },
    });
    expect(onSeekRatio).toHaveBeenCalledTimes(1);
    expect(onSeekRatio.mock.calls[0]?.[0]).toBeCloseTo(0.65, 4);
    await view.unmount();
  });

  it('#208/#393/#310/#124: hydrates & persists per-series track/aspect preferences and forwards HEVC-over-DV & SDH filter flags', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const loadSpy = jest.spyOn(engine, 'load');
    const savedPrefs: SaveTrackPreferenceInput[] = [];
    const hydrated: PersistedTrackPreference = {
      profileId: 'default',
      scopeKey: 'x:src-1:series:55',
      sourceId: 'src-1',
      audioLang: 'tur',
      audioLabel: 'Turkish',
      subLang: 'eng',
      subLabel: 'English',
      subDisabled: false,
      audioDelayMs: 0,
      subDelayMs: 0,
      resizeMode: 'stretch',
      updatedAt: 1_000,
    };
    const getTrackPreference = jest.fn(async () => hydrated);
    const saveTrackPreference = jest.fn(async (input: SaveTrackPreferenceInput) => {
      savedPrefs.push(input);
    });
    const setFilterSdh = jest.fn();
    const setResizeMode = jest.fn<void, [VideoResizeMode]>();

    const view = await render(
      <ThemeProvider preset="obsidianCrimson">
        <TvRemoteProvider>
          <FormFactorProvider value="desktop">
            <I18nProvider i18n={createAppI18n('en')}>
              <PlayerScreen
                catalog={{
                  resolveStream: async (k) =>
                    ok({ url: `http://sim.example.test/${k}.mp4`, headers: {} }),
                  getTrackPreference,
                  saveTrackPreference,
                }}
                videoHost={{
                  open: () => ({
                    engine,
                    overlayMode: 'floating',
                    setFilterSdh,
                    setResizeMode,
                    renderSurface: () => <View />,
                  }),
                }}
                target={SERIES_EP1}
                preferHevcOverDolbyVision={true}
                filterSdhSubtitles={true}
                clock={{ now: manual.now }}
                timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
                onExit={jest.fn()}
              />
            </I18nProvider>
          </FormFactorProvider>
        </TvRemoteProvider>
      </ThemeProvider>,
    );

    await waitFor(() => expect(loadSpy).toHaveBeenCalled());
    const loadCmd = loadSpy.mock.calls[0]?.[0];
    expect(loadCmd?.options?.preferHevcOverDolbyVision).toBe(true);
    expect(loadCmd?.options?.filterSdhSubtitles).toBe(true);
    expect(setFilterSdh).toHaveBeenCalledWith(true);
    expect(getTrackPreference).toHaveBeenCalledWith('x:src-1:series:55');
    await waitFor(() => expect(setResizeMode).toHaveBeenCalledWith('stretch'));

    // Emit tracks -> hydrated persisted preference selects Turkish audio (a:2) & English subs (s:1)
    await act(async () => {
      manual.advance(350);
      engine.emit({ attempt: loadCmd?.attempt ?? 1, type: 'tracks', tracks: TRACKS });
    });
    await waitFor(() => {
      expect(engine.commands.filter((c) => c.name === 'selectAudioTrack').at(-1)?.trackId).toBe(
        'a:2',
      );
      expect(engine.commands.filter((c) => c.name === 'selectSubtitleTrack').at(-1)?.trackId).toBe(
        's:1',
      );
    });

    // Manual audio switch persists to series scopeKey
    await fireEvent.press(screen.getByTestId('player-tracks-button'));
    await fireEvent.press(screen.getByTestId('player-audio-track-a:1'));
    expect(saveTrackPreference).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeKey: 'x:src-1:series:55',
        audioLang: 'eng',
      }),
    );

    // Manual aspect change persists resizeMode to series scopeKey
    await fireEvent.press(screen.getByTestId('player-tracks-close'));
    await fireEvent.press(screen.getByTestId('player-aspect-button'));
    expect(savedPrefs.at(-1)).toMatchObject({
      scopeKey: 'x:src-1:series:55',
      resizeMode: 'fit',
    });

    await view.unmount();
  });
});
