import { createAppI18n } from '@elv/i18n';
import type { MediaTracks, PlaybackClock, PlaybackService, PlaybackTimers } from '@elv/playback';
import { ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StrictMode, useRef } from 'react';
import { Platform, View } from 'react-native';
import { PlayerOsdBottomBar } from '../DesktopCinemaBar';
import { deduplicateOsdTitle, PlayerOsdTopBar } from '../PlayerOsdTopBar';
import { PlayerStatsHud } from '../PlayerStatsHud';
import { PlayerTouchGestures } from '../PlayerTouchGestures';
import { StillWatchingPrompt } from '../StillWatchingPrompt';
import { sanitizeTrackMetaForIpc } from '../usePlayerCinemaExtras';
import { usePlayerOverlayPrefs } from '../usePlayerOverlayPrefs';
import { useInitialTrackSelection } from '../usePlayerTrackAndDecoderSync';
import { useSleepTimer } from '../useSleepTimer';
import { useStillWatching } from '../useStillWatching';
import { createTouchScrubResponder } from '../vod-progress-helpers';

const i18n = createAppI18n('en');

function StrictModeTimersProbe({
  onApis,
}: {
  readonly onApis: (
    sleep: ReturnType<typeof useSleepTimer>,
    still: ReturnType<typeof useStillWatching>,
  ) => void;
}) {
  const clockRef = useRef<PlaybackClock>({ now: () => 0 });
  const timersRef = useRef<PlaybackTimers>({
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  const sleepApi = useSleepTimer({
    defaultAction: 'stop',
    clockRef,
    timersRef,
    onExpire: jest.fn(),
  });
  const stillApi = useStillWatching({
    timeoutMin: 60,
    statusKind: 'playing',
    clockRef,
    timersRef,
    onStop: jest.fn(),
  });
  onApis(sleepApi, stillApi);
  return <View />;
}

function InitialTrackProbe({
  service,
  tracks,
}: {
  readonly service: PlaybackService;
  readonly tracks: MediaTracks;
}) {
  useInitialTrackSelection({
    activeService: service,
    activeTarget: {
      kind: 'vod',
      itemKey: 'movie:1',
      sourceId: 'src-1',
      title: 'Movie',
    },
    tracks,
    subtitleMode: 'off',
  });
  return <View />;
}

function OverlayPrefsProbe({
  itemKey,
  onApi,
}: {
  readonly itemKey: string;
  readonly onApi: (api: ReturnType<typeof usePlayerOverlayPrefs>) => void;
}) {
  onApi(
    usePlayerOverlayPrefs({
      itemKey,
      hasService: true,
      defaultResizeMode: 'fit',
    }),
  );
  return <View />;
}

describe('Wave C1 review & visual regression fixes', () => {
  it('#355: touch fine-scrub responder reverses immediately with zero overshoot dead-zone debt', () => {
    const ratios: number[] = [];
    const responder = createTouchScrubResponder({
      canScrub: () => true,
      getWidth: () => 100,
      onStart: (r) => ratios.push(r),
      onMove: (r) => ratios.push(r),
      onCommit: jest.fn(),
      onCancel: jest.fn(),
    });

    responder.panHandlers.onResponderGrant({
      nativeEvent: { locationX: 80, pageX: 80, pageY: 10 },
    });
    responder.panHandlers.onResponderMove({
      nativeEvent: { locationX: 150, pageX: 150, pageY: 10 },
    });
    expect(ratios.at(-1)).toBeCloseTo(1.0, 5);

    responder.panHandlers.onResponderMove({
      nativeEvent: { locationX: 140, pageX: 140, pageY: 10 },
    });
    expect(ratios.at(-1)).toBeCloseTo(0.9, 5);

    responder.panHandlers.onResponderMove({
      nativeEvent: { locationX: -50, pageX: -50, pageY: 10 },
    });
    expect(ratios.at(-1)).toBeCloseTo(0.0, 5);

    responder.panHandlers.onResponderMove({
      nativeEvent: { locationX: -35, pageX: -35, pageY: 10 },
    });
    expect(ratios.at(-1)).toBeCloseTo(0.15, 5);
  });

  it('#118: StrictMode double-effect leaves sleep timer and still-watching controllers functional', async () => {
    let sleepApi: ReturnType<typeof useSleepTimer> | null = null;
    let stillApi: ReturnType<typeof useStillWatching> | null = null;

    const view = await render(
      <StrictMode>
        <StrictModeTimersProbe
          onApis={(sleep, still) => {
            sleepApi = sleep;
            stillApi = still;
          }}
        />
      </StrictMode>,
    );

    expect(sleepApi).not.toBeNull();
    expect(stillApi).not.toBeNull();
    await act(async () => {
      sleepApi?.selectMinutes(15);
      stillApi?.recordUserActivity();
    });
    await view.unmount();
  });

  it('#393: useInitialTrackSelection always calls selectSubtitleTrack(null) even when selectedSubtitleId is already null', async () => {
    const selectSubtitleTrack = jest.fn();
    const service = {
      selectAudioTrack: jest.fn(),
      selectSubtitleTrack,
    } as unknown as PlaybackService;

    const tracks: MediaTracks = {
      audio: [{ id: 'a-en', language: 'en', label: 'English', isDefault: true }],
      subtitles: [{ id: 's-en', language: 'en', label: 'English' }],
      selectedAudioId: 'a-en',
      selectedSubtitleId: null,
    };

    const view = await render(<InitialTrackProbe service={service} tracks={tracks} />);
    expect(selectSubtitleTrack).toHaveBeenCalledWith(null);
    await view.unmount();
  });

  it('#208: sanitizeTrackMetaForIpc strips control chars and truncates lang/label lengths', () => {
    expect(sanitizeTrackMetaForIpc('  en\u0000\u001f-US-very-long-tag-12345  ', 16)).toBe(
      'en-US-very-long-',
    );
    const longLabel = `Title\u0007 ${'x'.repeat(200)}`;
    const clean = sanitizeTrackMetaForIpc(longLabel, 128);
    expect(clean).not.toBeNull();
    expect(clean?.length).toBe(128);
    expect(clean?.startsWith('Title ')).toBe(true);
    expect(sanitizeTrackMetaForIpc('\u0000\u0001  ', 16)).toBeNull();
  });

  it('#124/#208: usePlayerOverlayPrefs resets resizeMode to defaultResizeMode when itemKey changes', async () => {
    const apiBox: { current: ReturnType<typeof usePlayerOverlayPrefs> | null } = { current: null };
    const onApi = (next: ReturnType<typeof usePlayerOverlayPrefs>) => {
      apiBox.current = next;
    };

    const view = await render(<OverlayPrefsProbe itemKey="movie:1" onApi={onApi} />);
    await act(async () => {
      apiBox.current?.publicPrefs.setResizeMode('stretch');
    });
    expect(apiBox.current?.publicPrefs.resizeMode).toBe('stretch');

    await view.rerender(<OverlayPrefsProbe itemKey="movie:2" onApi={onApi} />);
    expect(apiBox.current?.publicPrefs.resizeMode).toBe('fit');
    await view.unmount();
  });

  it('deduplicates series episode title against subtitle, hides badges/chapters on portrait phone, and offsets Stats HUD when OSD is visible', async () => {
    expect(
      deduplicateOsdTitle('Northern Signal — E1 · Opening Signal', 'S1 E1 · Opening Signal'),
    ).toBe('Northern Signal');
    expect(deduplicateOsdTitle('Dune', '2021 · Sci-Fi')).toBe('Dune');

    const statsService = {
      getState: () => ({
        status: { kind: 'playing' },
        attempt: 1,
        tracks: { audio: [], subtitles: [], selectedAudioId: null, selectedSubtitleId: null },
        videoInfo: { width: 1920, height: 1080, fps: 24 },
        staleEventsDropped: 0,
        surfaceRecreationToken: 0,
      }),
      subscribe: () => () => undefined,
    } as unknown as PlaybackService;

    const portrait = {
      width: 393,
      height: 852,
      formFactor: 'phone' as const,
      orientation: 'portrait' as const,
      safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
      overscan: { x: 0, y: 0 },
    };

    const view = await render(
      <ThemeProvider preset="obsidianCrimson">
        <ViewportProvider value={portrait}>
          <PlayerOsdTopBar
            title="Northern Signal — E1 · Opening Signal"
            subtitle="S1 E1 · Opening Signal"
            statusLine=""
            statusKind="playing"
            failure={null}
            isVod
            isPausedOrEnded={false}
            canZap={false}
            hasTracks={false}
            showRetry={false}
            isTv={false}
            videoInfo={{ width: 1920, height: 1080, hdr: 'hdr10' }}
            tvOsdFocused={false}
            tvOsdAction="playPause"
            tracksOpen={false}
            i18n={i18n}
            service={statsService}
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
          <PlayerOsdBottomBar
            title="Northern Signal"
            statusLine=""
            failure={null}
            isVod
            isPausedOrEnded={false}
            canZap={false}
            hasTracks={false}
            hasNextEpisodeAction
            showRetry={false}
            isTv={false}
            chapters={[{ id: 'ch:0', title: 'Intro', startMs: 0, endMs: 60_000 }]}
            tvOsdFocused={false}
            tvOsdAction="playPause"
            tracksOpen={false}
            i18n={i18n}
            service={statsService}
            clock={{ now: () => 0 }}
            onExit={jest.fn()}
            onTogglePlayPause={jest.fn()}
            onSeekBack={jest.fn()}
            onSeekForward={jest.fn()}
            onSeekRatio={jest.fn()}
            onOpenTracks={jest.fn()}
            onPlayNextEpisode={jest.fn()}
            onPrevChapter={jest.fn()}
            onNextChapter={jest.fn()}
            onPrev={jest.fn()}
            onNext={jest.fn()}
            onRetry={jest.fn()}
          />
          <PlayerStatsHud
            visible
            osdVisible
            isDesktop={false}
            service={statsService}
            clock={{ now: () => 0 }}
            i18n={i18n}
          />
          <StillWatchingPrompt
            visible
            docked
            remainingSeconds={45}
            isTv={false}
            i18n={i18n}
            onKeepWatching={jest.fn()}
            onStopNow={jest.fn()}
          />
        </ViewportProvider>
      </ThemeProvider>,
    );

    expect(screen.getByTestId('osd-title')).toHaveTextContent('Northern Signal');
    expect(screen.getByTestId('osd-subtitle')).toHaveTextContent('S1 E1 · Opening Signal');
    expect(screen.queryByTestId('player-prev-chapter')).toBeNull();
    expect(screen.queryByTestId('player-next-chapter')).toBeNull();
    expect(screen.getByTestId('player-narrow-cta-row')).toBeTruthy();
    expect(screen.getByTestId('player-next-episode-pill')).toBeTruthy();

    const hudStyle = screen.getByTestId('player-stats-hud').props.style;
    const flattened = Array.isArray(hudStyle)
      ? Object.assign({}, ...hudStyle.filter(Boolean))
      : hudStyle;
    expect(flattened.top).toBe(96);

    const promptStyle = screen.getByTestId('player-still-watching-prompt').props.style;
    const flatPrompt = Array.isArray(promptStyle)
      ? Object.assign({}, ...promptStyle.filter(Boolean))
      : promptStyle;
    expect(flatPrompt.position).not.toBe('absolute');

    await view.unmount();
  });

  it('PlayerTouchGestures wakes OSD on web click when responder did not fire', async () => {
    jest.replaceProperty(Platform, 'OS', 'web' as typeof Platform.OS);
    const onSingleTap = jest.fn();
    const onTouchActivity = jest.fn();

    const view = await render(
      <ThemeProvider preset="obsidianCrimson">
        <PlayerTouchGestures
          isVod
          volume={100}
          brightness={1}
          i18n={i18n}
          onTouchActivity={onTouchActivity}
          onSingleTap={onSingleTap}
          onVolumeChange={jest.fn()}
          onBrightnessChange={jest.fn()}
        />
      </ThemeProvider>,
    );

    fireEvent(screen.getByTestId('player-touch-gestures'), 'click');
    expect(onTouchActivity).toHaveBeenCalledTimes(1);
    expect(onSingleTap).toHaveBeenCalledTimes(1);
    await view.unmount();
  });
});
