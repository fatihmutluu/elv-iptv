import type { WatchProgressRow } from '@elv/data';
import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createPlaybackService, type MediaTracks } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { I18nProvider, RemoteKeysProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, StyleSheet, type TextStyle, View, type ViewStyle } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import type { VideoHost, VideoSurfaceProps } from '../../ports/video-host';
import { ConnectionLimitDialog } from '../ConnectionLimitDialog';
import { PlayerChannelDrawer } from '../PlayerChannelDrawer';
import { PlayerOsdTopBar } from '../PlayerOsdTopBar';
import { PlayerScreen } from '../PlayerScreen';
import { StillWatchingPrompt } from '../StillWatchingPrompt';
import { TrackPickerModal } from '../TrackPickerModal';
import { VodProgressBar } from '../VodProgressBar';
import { createFakeAndroidKeys, createManualClock } from './player-test-harness';

const KEYCODE_PROG_RED = 183;
const KEYCODE_PROG_GREEN = 184;
const KEYCODE_PROG_YELLOW = 185;
const KEYCODE_PROG_BLUE = 186;

const TEST_TRACKS: MediaTracks = {
  audio: [{ id: 'a1', label: 'English', language: 'eng' }],
  subtitles: [{ id: 's1', label: 'Turkish', language: 'tur' }],
  selectedAudioId: 'a1',
  selectedSubtitleId: null,
};

function flattenViewStyle(style: unknown): ViewStyle {
  return (StyleSheet.flatten(style as ViewStyle) ?? {}) as ViewStyle;
}

function flattenTextStyle(style: unknown): TextStyle {
  return (StyleSheet.flatten(style as TextStyle) ?? {}) as TextStyle;
}

describe('Player Wave C4B (#62, #163, #133, #416)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('scales OSD title and channel drawer row minHeight deterministically at fontScale = 1.2 (#62)', async () => {
    const i18n = createAppI18n('en');
    const view = await render(
      <ViewportProvider
        value={{ formFactor: 'tv', orientation: 'landscape', width: 1920, height: 1080 }}
      >
        <I18nProvider i18n={i18n}>
          <ThemeProvider fontScale={1.2} uiFontFamily="atkinson">
            <PlayerOsdTopBar
              title="Horizon Live"
              statusLine=""
              statusKind="playing"
              failure={null}
              isVod={false}
              isPausedOrEnded={false}
              canZap={false}
              hasTracks={false}
              showRetry={false}
              isTv
              tvOsdFocused={false}
              tvOsdAction="playPause"
              tracksOpen={false}
              i18n={i18n}
              service={null}
              clock={{ now: () => 0 }}
              onExit={jest.fn()}
              onTogglePlayPause={jest.fn()}
              onSeekBack={jest.fn()}
              onSeekForward={jest.fn()}
              onSeekRatio={jest.fn()}
              onOpenTracks={jest.fn()}
              onPrev={jest.fn()}
              onNext={jest.fn()}
              onRetry={jest.fn()}
            />
            <PlayerChannelDrawer
              visible
              docked={false}
              playlist={{
                count: 1,
                currentIndex: 0,
                getAt: async () => ({
                  itemKey: 'live:1',
                  sourceId: 's1',
                  title: 'Channel One',
                  kind: 'live',
                }),
                onChangeIndex: jest.fn(),
              }}
              currentItemKey="live:1"
              formFactor="tv"
              isTv
              i18n={i18n}
              onSelectChannel={jest.fn()}
              onClose={jest.fn()}
            />
          </ThemeProvider>
        </I18nProvider>
      </ViewportProvider>,
    );

    const titleStyle = flattenTextStyle(screen.getByTestId('osd-title').props.style);
    expect(titleStyle.fontSize).toBe(Math.round(28 * 1.2));
    expect(titleStyle.fontFamily).toBeDefined();

    await waitFor(() => {
      expect(screen.getByTestId('player-channel-row-0')).toBeTruthy();
    });
    const rowStyleProp = screen.getByTestId('player-channel-row-0').props.style;
    const resolvedRowStyle = flattenViewStyle(
      typeof rowStyleProp === 'function' ? rowStyleProp({ pressed: false }) : rowStyleProp,
    );
    expect(resolvedRowStyle.minHeight).toBe(Math.round(46 * 1.2));

    await view.unmount();
  });

  it('forwards subtitleFontFamily, handles TV color keys from hidden OSD, and renders player AmbientTvClock (#163, #133, #416)', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const keys = createFakeAndroidKeys();
    const setSubtitleFontFamily = jest.fn();
    let latestSurfaceProps: VideoSurfaceProps | undefined;

    const videoHost: VideoHost = {
      open: () => ({
        engine,
        setSubtitleFontFamily,
        renderSurface: (props) => {
          latestSurfaceProps = props;
          return <View testID={props.testID ?? 'surface'} />;
        },
      }),
    };

    const liveTarget: PlayTarget = {
      itemKey: 'live:1',
      sourceId: 's1',
      title: 'Live Channel 1',
      kind: 'live',
      playlist: {
        count: 2,
        currentIndex: 0,
        getAt: async (idx) => ({
          itemKey: `live:${idx + 1}`,
          sourceId: 's1',
          title: `Live Channel ${idx + 1}`,
          kind: 'live',
        }),
        onChangeIndex: jest.fn(),
      },
    };

    const catalog = {
      resolveStream: jest.fn(async () => ok({ url: 'http://stream.test/1', headers: {} })),
      getProgress: jest.fn(async () => null),
      saveProgress: jest.fn(async () => ok({} as WatchProgressRow)),
    };

    const i18n = createAppI18n('en');
    const view = await render(
      <RemoteKeysProvider android={keys.source}>
        <ViewportProvider
          value={{ formFactor: 'tv', orientation: 'landscape', width: 1920, height: 1080 }}
        >
          <I18nProvider i18n={i18n}>
            <ThemeProvider>
              <PlayerScreen
                catalog={catalog}
                videoHost={videoHost}
                target={liveTarget}
                clock={{ now: manual.now }}
                timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
                initialOsdHidden
                subtitleFontFamily="atkinson"
                tvClockMode="player"
                onExit={jest.fn()}
              />
            </ThemeProvider>
          </I18nProvider>
        </ViewportProvider>
      </RemoteKeysProvider>,
    );

    await waitFor(() => {
      expect(setSubtitleFontFamily).toHaveBeenCalledWith('atkinson');
      expect(latestSurfaceProps?.subtitleFontFamily).toBe('atkinson');
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });

    const loadAttempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
    await act(async () => {
      manual.advance(350);
      engine.emit({ attempt: loadAttempt, type: 'tracks', tracks: TEST_TRACKS });
    });

    // Color Red wakes hidden OSD and toggles TrackPicker on subtitles
    await act(async () => keys.tap(KEYCODE_PROG_RED));
    expect(screen.getByTestId('player-tracks-panel')).toBeTruthy();
    await act(async () => keys.tap(KEYCODE_PROG_RED));
    expect(screen.queryByTestId('player-tracks-panel')).toBeNull();

    // Color Green toggles TrackPicker on audio
    await act(async () => keys.tap(KEYCODE_PROG_GREEN));
    expect(screen.getByTestId('player-tracks-panel')).toBeTruthy();
    await act(async () => keys.tap(KEYCODE_PROG_GREEN));
    expect(screen.queryByTestId('player-tracks-panel')).toBeNull();

    // Color Yellow toggles performance Stats HUD
    expect(screen.queryByTestId('player-stats-hud')).toBeNull();
    await act(async () => keys.tap(KEYCODE_PROG_YELLOW));
    expect(screen.getByTestId('player-stats-hud')).toBeTruthy();
    await act(async () => keys.tap(KEYCODE_PROG_YELLOW));
    expect(screen.queryByTestId('player-stats-hud')).toBeNull();

    // Color Blue toggles live Channel Drawer
    await act(async () => keys.tap(KEYCODE_PROG_BLUE));
    expect(screen.getByTestId('player-channel-drawer-panel')).toBeTruthy();
    await act(async () => keys.tap(KEYCODE_PROG_BLUE));
    expect(screen.queryByTestId('player-channel-drawer-panel')).toBeNull();

    expect(screen.getByTestId('player-ambient-clock')).toBeTruthy();

    await view.rerender(
      <RemoteKeysProvider android={keys.source}>
        <ViewportProvider
          value={{ formFactor: 'tv', orientation: 'landscape', width: 1920, height: 1080 }}
        >
          <I18nProvider i18n={i18n}>
            <ThemeProvider>
              <PlayerScreen
                catalog={catalog}
                videoHost={videoHost}
                target={liveTarget}
                clock={{ now: manual.now }}
                timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
                subtitleFontFamily="opendyslexic"
                tvClockMode="never"
                onExit={jest.fn()}
              />
            </ThemeProvider>
          </I18nProvider>
        </ViewportProvider>
      </RemoteKeysProvider>,
    );
    expect(setSubtitleFontFamily).toHaveBeenLastCalledWith('opendyslexic');
    expect(latestSurfaceProps?.subtitleFontFamily).toBe('opendyslexic');
    expect(screen.queryByTestId('player-ambient-clock')).toBeNull();

    await view.unmount();
  });

  it('applies TV overscanX/overscanY insets on TV dialogs and announces clamped remaining time in VodProgressBar (#133)', async () => {
    const i18n = createAppI18n('en');
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const service = createPlaybackService({
      engine,
      clock: { now: manual.now },
      timers: { setTimeout: manual.schedule, clearTimeout: manual.cancel },
    });
    service.tune({
      item: 'vod:1',
      accountKey: 's1',
      kind: 'vod',
      resolve: async () => ok({ url: 'http://vod.test/movie.mp4', headers: {} }),
    });
    await waitFor(() => {
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });
    const loadAttempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
    manual.advance(350);
    engine.emit({
      attempt: loadAttempt,
      type: 'clock',
      anchor: { positionMs: 120_000, atMs: manual.now(), rate: 1, durationMs: 100_000 },
    });

    const view = await render(
      <ViewportProvider
        overscanX={0.08}
        overscanY={0.06}
        value={{ formFactor: 'tv', orientation: 'landscape', width: 1000, height: 1000 }}
      >
        <I18nProvider i18n={i18n}>
          <ThemeProvider>
            <VodProgressBar
              service={service}
              clock={{ now: manual.now }}
              isTv
              label="Seek"
              timeDisplayMode="remaining"
              playbackSpeed={2}
              i18n={i18n}
              onCycleTimeDisplayMode={jest.fn()}
              onSeekRatio={jest.fn()}
            />
            <ConnectionLimitDialog
              check={{ ownActiveCount: 1, maxConnections: 1, canStopOwnStream: true }}
              onStopOther={jest.fn()}
              onCancel={jest.fn()}
              onContinueAnyway={jest.fn()}
            />
            <StillWatchingPrompt
              visible
              remainingSeconds={45}
              isTv
              i18n={i18n}
              onKeepWatching={jest.fn()}
              onStopNow={jest.fn()}
            />
            <TrackPickerModal
              tracks={{ audio: [], subtitles: [], selectedAudioId: null, selectedSubtitleId: null }}
              cursor={{ column: 'subtitles', index: 0 }}
              isTv
              formFactor="tv"
              i18n={i18n}
              onSelectAudio={jest.fn()}
              onSelectSubtitle={jest.fn()}
              onClose={jest.fn()}
            />
          </ThemeProvider>
        </I18nProvider>
      </ViewportProvider>,
    );

    expect(screen.getByTestId('player-progress-time')).toHaveTextContent('-0:00');
    expect(screen.getByTestId('player-progress-time-end').props.accessibilityLabel).toBe(
      '0:00 remaining',
    );

    const connStyle = flattenViewStyle(screen.getByTestId('connection-limit-dialog').props.style);
    expect(connStyle.paddingHorizontal).toBe(100);
    expect(connStyle.paddingVertical).toBe(80);

    const stillStyle = flattenViewStyle(
      screen.getByTestId('player-still-watching-prompt').props.style,
    );
    expect(stillStyle.paddingHorizontal).toBe(104);
    expect(stillStyle.paddingVertical).toBe(84);

    const tracksStyle = flattenViewStyle(screen.getByTestId('player-tracks-panel').props.style);
    expect(tracksStyle.paddingHorizontal).toBe(128);
    expect(tracksStyle.paddingBottom).toBe(76);

    service.dispose();
    await view.unmount();
  });
});
