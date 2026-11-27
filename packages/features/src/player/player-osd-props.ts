import type { NowNextEntry } from '@elv/data';
import type { TvClockMode } from '@elv/domain';
import type { AppI18n } from '@elv/i18n';
import type {
  ChapterInfo,
  MediaTracks,
  PlaybackClock,
  PlaybackService,
  PlaybackStatus,
  StreamVideoInfo,
} from '@elv/playback';
import type { PlayableEntry, PlayTarget } from '../ports/play-target';
import type { PlayerOsdProps } from './DesktopCinemaBar';
import type { DescribedPlaybackFailure } from './errors';
import type { usePlayerControls } from './usePlayerControls';
import type { VodEndTimeDisplayMode } from './vod-progress-math';

/** Inputs for {@link buildPlayerOsdProps}. */
export interface BuildPlayerOsdPropsInput {
  readonly activeTarget: PlayTarget;
  readonly previewTarget: PlayTarget | null;
  readonly statusLine: string;
  readonly sessionUnavailable: boolean;
  readonly status: PlaybackStatus;
  readonly overlayMode: 'floating' | 'docked';
  readonly failure: DescribedPlaybackFailure | null;
  readonly isCatchup: boolean;
  readonly liveTimeShiftSupported: boolean;
  readonly canZap: boolean;
  readonly hasTracks: boolean;
  readonly hasPreviousChannel: boolean;
  readonly nextEpisode: PlayableEntry | undefined;
  readonly nextEpisodeVisible: boolean;
  readonly showRetry: boolean;
  readonly isTv: boolean;
  readonly isDesktop: boolean;
  readonly isFullscreen: boolean;
  readonly alwaysOnTop: boolean;
  readonly chapters: readonly ChapterInfo[] | undefined;
  readonly timeDisplayMode: VodEndTimeDisplayMode;
  readonly videoInfo: StreamVideoInfo | undefined;
  readonly tracks: MediaTracks;
  readonly nowNext: NowNextEntry | null;
  readonly wallClock: () => number;
  readonly tvClockMode: TvClockMode;
  readonly effectivePreviewMs: number | undefined;
  readonly i18n: AppI18n;
  readonly activeService: PlaybackService | null;
  readonly clock: PlaybackClock;
  readonly controls: ReturnType<typeof usePlayerControls>;
  readonly hostToggleMute: (() => void) | undefined;
  readonly hostToggleFullscreen: (() => void) | undefined;
  readonly hostToggleAlwaysOnTop: (() => void) | undefined;
  readonly onMinimizeToMiniPlayer?: (() => void) | undefined;
  readonly onEnterPip?: (() => void) | undefined;
  readonly onEnterMultiView?: (() => void) | undefined;
  readonly onPopoutPlayer?: (() => void) | undefined;
  readonly onDockPopout?: (() => void) | undefined;
  readonly onExit: () => void;
  readonly onCycleTimeDisplayMode: () => void;
  readonly onFineScrubHaptic: ((kind: 'tier' | 'origin') => void) | undefined;
  readonly onPlayNextEpisode: () => void;
  readonly onPrevChapter: () => void;
  readonly onNextChapter: () => void;
  readonly onJumpPreviousChannel: () => void;
  readonly onBackToLive: () => void;
  readonly onPrev: () => void;
  readonly onNext: () => void;
  readonly onRetry: () => void;
}

/** Assembles {@link PlayerOsdProps} from `PlayerScreen` hook outputs. */
export function buildPlayerOsdProps(p: BuildPlayerOsdPropsInput): PlayerOsdProps {
  const { activeTarget, previewTarget, controls, status } = p;
  return {
    title: previewTarget?.title ?? activeTarget.title,
    subtitle: previewTarget !== null ? previewTarget.subtitle : activeTarget.subtitle,
    isChannelPreview: previewTarget !== null,
    channelDigits: controls.channelDigits,
    statusLine: p.statusLine,
    statusKind: p.sessionUnavailable ? ('idle' as const) : status.kind,
    osdTier: controls.osdTier,
    overlayMode: p.isDesktop ? p.overlayMode : ('floating' as const),
    isBuffering: status.kind === 'tuning' || status.kind === 'recovering',
    failure: p.failure,
    isVod: activeTarget.kind === 'vod',
    isCatchup: p.isCatchup,
    liveTimeShiftSupported: p.liveTimeShiftSupported,
    timeShiftUnavailableVisible: controls.timeShiftUnavailableVisible,
    isPausedOrEnded: controls.isPausedOrEnded,
    canZap: p.canZap,
    hasTracks: p.hasTracks,
    hasPreviousChannel: p.hasPreviousChannel,
    hasNextEpisodeAction:
      activeTarget.kind === 'vod' && !p.isCatchup && p.nextEpisode !== undefined,
    nextEpisodeBannerVisible: p.nextEpisodeVisible,
    canLock: controls.canLock,
    showRetry: p.showRetry,
    isTv: p.isTv,
    isDesktop: p.isDesktop,
    muted: controls.muted,
    volume: controls.volume,
    isFullscreen: p.isFullscreen,
    alwaysOnTop: p.alwaysOnTop,
    playbackSpeed: controls.playbackSpeed,
    chapters: p.chapters,
    timeDisplayMode: p.timeDisplayMode,
    videoInfo: p.videoInfo,
    tracks: p.tracks,
    nowNext: p.nowNext,
    nowMs: p.wallClock(),
    wallClock: p.wallClock,
    tvClockMode: p.tvClockMode,
    tvOsdFocused: controls.tvOsdFocused,
    tvScrubberFocused: controls.tvScrubberFocused,
    tvOsdAction: controls.tvOsdAction,
    tracksOpen: controls.tracksOpen,
    settingsOpen: controls.settingsOpen,
    settingsView: controls.settingsMenu.view,
    infoOpen: controls.infoOpen,
    channelListOpen: controls.channelListOpen,
    previewPositionMs: p.effectivePreviewMs,
    i18n: p.i18n,
    service: p.activeService,
    clock: p.clock,
    onExit: p.onExit,
    onTogglePlayPause: controls.togglePlayPause,
    onSeekBack: controls.seekStepBack,
    onSeekForward: controls.seekStepForward,
    onSeekRatio: controls.seekToRatio,
    onScrubbingChange: controls.setBarScrubbing,
    onCycleTimeDisplayMode: p.onCycleTimeDisplayMode,
    ...(p.onFineScrubHaptic !== undefined ? { onFineScrubHaptic: p.onFineScrubHaptic } : {}),
    onOpenTracks: controls.openTracks,
    onOpenSettings: () =>
      controls.settingsOpen ? controls.closeSettings() : controls.openSettings(),
    onOpenSpeed: () =>
      controls.settingsOpen && controls.settingsMenu.view === 'speed'
        ? controls.closeSettings()
        : controls.openSettings('speed'),
    onToggleResizeMode: controls.toggleResizeMode,
    onToggleInfo: controls.toggleInfo,
    ...(p.canZap ? { onToggleChannelList: controls.toggleChannelList } : {}),
    onPlayNextEpisode: p.onPlayNextEpisode,
    ...((p.chapters?.length ?? 0) > 0
      ? { onPrevChapter: p.onPrevChapter, onNextChapter: p.onNextChapter }
      : {}),
    ...(p.hostToggleMute !== undefined ? { onToggleMute: controls.toggleMute } : {}),
    onSetVolume: controls.setVolume,
    ...(p.hostToggleFullscreen !== undefined
      ? { onToggleFullscreen: controls.toggleFullscreen }
      : {}),
    ...(p.hostToggleAlwaysOnTop !== undefined
      ? { onToggleAlwaysOnTop: p.hostToggleAlwaysOnTop }
      : {}),
    ...(p.onMinimizeToMiniPlayer !== undefined
      ? { onMinimizeToMiniPlayer: p.onMinimizeToMiniPlayer }
      : {}),
    ...(p.onEnterPip !== undefined ? { onEnterPip: p.onEnterPip } : {}),
    ...(p.onEnterMultiView !== undefined ? { onEnterMultiView: p.onEnterMultiView } : {}),
    ...(p.onPopoutPlayer !== undefined ? { onPopoutPlayer: p.onPopoutPlayer } : {}),
    ...(p.onDockPopout !== undefined ? { onDockPopout: p.onDockPopout } : {}),
    onLock: controls.lockControls,
    onJumpPreviousChannel: p.onJumpPreviousChannel,
    jumpingToLive: controls.jumpingToLive,
    onJumpToLiveEdge: controls.jumpToLiveEdge,
    ...(p.isCatchup ? { onBackToLive: p.onBackToLive } : {}),
    onPrev: p.onPrev,
    onNext: p.onNext,
    onRetry: p.onRetry,
  };
}
