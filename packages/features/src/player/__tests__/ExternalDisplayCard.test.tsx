import { createAppI18n } from '@elv/i18n';
import { EMPTY_TRACKS } from '@elv/playback';
import { ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { render } from '@testing-library/react-native';
import { View } from 'react-native';
import { ProfileProvider } from '../../shared';
import { PlayerScreenStage, type PlayerScreenStageProps } from '../PlayerScreenStage';

const i18n = createAppI18n('en');

function makeStageProps(externalPlaybackActive: boolean): PlayerScreenStageProps {
  return {
    isTv: false,
    isDesktop: false,
    inPip: false,
    isMini: false,
    externalPlaybackActive,
    isVod: true,
    title: 'Test Movie',
    subtitle: '',
    useDockedDesktopLayout: false,
    hideDesktopCursor: false,
    anySheetOpen: false,
    locked: false,
    osdHidden: true,
    showTouchGestures: false,
    holdSpeedActive: false,
    statsVisible: false,
    nextEpisodeVisible: false,
    brightness: 1,
    volume: 100,
    durationMs: 60_000,
    currentPosMs: 10_000,
    activeService: null,
    clock: { now: () => 0 },
    i18n,
    osdProps: {
      title: 'Test Movie',
      subtitle: '',
      isVod: true,
      statusKind: 'playing',
      statusLine: '',
      failure: null,
      service: null,
      clock: { now: () => 0 },
      wallClock: () => 0,
      i18n,
      isTv: false,
      isDesktop: false,
      overlayMode: 'floating',
      hasTracks: false,
      tracks: EMPTY_TRACKS,
      hasPreviousChannel: false,
      canZap: false,
      canLock: false,
      isPausedOrEnded: false,
      showRetry: false,
      muted: false,
      volume: 100,
      playbackSpeed: 1,
      timeDisplayMode: 'total',
      osdTier: 'controls',
      tvOsdFocused: false,
      tvOsdAction: 'playPause',
      tvScrubberFocused: false,
      isFullscreen: false,
      onExit: jest.fn(),
      onTogglePlayPause: jest.fn(),
      onSeekBack: jest.fn(),
      onSeekForward: jest.fn(),
      onSeekRatio: jest.fn(),
      onScrubbingChange: jest.fn(),
      onOpenSubtitles: jest.fn(),
      onOpenAudio: jest.fn(),
      onOpenSettings: jest.fn(),
      onToggleChannelList: jest.fn(),
      onToggleResizeMode: jest.fn(),
      onCycleTimeDisplayMode: jest.fn(),
      onLock: jest.fn(),
      onPrev: jest.fn(),
      onNext: jest.fn(),
      onRetry: jest.fn(),
    },
    desktopFallbackKeyProps: {},
    touchHoverProps: {},
    desktopWebProps: undefined,
    surfaceNode: <View testID="mock-surface" />,
    nextEpisodeNode: <View />,
    channelDrawerNode: <View />,
    settingsSheetNode: <View />,
    stillWatchingVisible: false,
    stillWatchingRemainingSec: 0,
    onKeepWatching: jest.fn(),
    onStopWatching: jest.fn(),
    onTouchActivity: jest.fn(),
    onSingleTap: jest.fn(),
    onDoubleTapSeek: jest.fn(),
    onScrubPreview: jest.fn(),
    onScrubCommit: jest.fn(),
    onHoldSpeedStart: jest.fn(),
    onHoldSpeedEnd: jest.fn(),
    onVolumeChange: jest.fn(),
    onBrightnessChange: jest.fn(),
    onUnlock: jest.fn(),
  };
}

describe('PlayerScreenStage ExternalDisplayCard (#258)', () => {
  it('renders ExternalDisplayCard when externalPlaybackActive is true and hides when false', async () => {
    const view = await render(
      <ThemeProvider>
        <ViewportProvider>
          <ProfileProvider catalog={{} as never}>
            <PlayerScreenStage {...makeStageProps(true)} />
          </ProfileProvider>
        </ViewportProvider>
      </ThemeProvider>,
    );

    const card = view.getByTestId('player-external-display-card');
    expect(card).toBeTruthy();
    expect(card.props.pointerEvents).toBe('none');
    expect(view.getByTestId('player-external-display-title').props.children).toBe(
      'Playing on external display',
    );

    await view.rerender(
      <ThemeProvider>
        <ViewportProvider>
          <ProfileProvider catalog={{} as never}>
            <PlayerScreenStage {...makeStageProps(false)} />
          </ProfileProvider>
        </ViewportProvider>
      </ThemeProvider>,
    );
    expect(view.queryByTestId('player-external-display-card')).toBeNull();
  });
});
