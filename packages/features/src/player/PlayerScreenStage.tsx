import type { CatalogService } from '@elv/data';
import type {
  AccessibilityFontFamily,
  AndroidDecoderMode,
  BufferPreset,
  DefaultResizeModePref,
  DeinterlaceMode,
  LiveChannelSwitchModePref,
  OsdTimeDisplayMode,
  SeekStepSecPref,
  SleepTimerAction,
  SubtitleModePref,
  TvClockMode,
} from '@elv/domain';
import type { AppI18n } from '@elv/i18n';
import type { PlaybackClock, PlaybackService, PlaybackTimers } from '@elv/playback';
import { MicroPill, TvFocusAnchor, useTheme, useViewport } from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { StyleSheet, View } from 'react-native';
import type { AppLifecyclePort } from '../ports/app-lifecycle';
import type { PlayTarget } from '../ports/play-target';
import type { PlaybackGuard } from '../ports/playback-guard';
import type { VideoHost, VideoResizeMode } from '../ports/video-host';
import { useProfile } from '../shared';
import type { PlayerOsdProps } from './DesktopCinemaBar';
import {
  DesktopDockedTopBar,
  HIDE_CURSOR_WEB_STYLE,
  PlayerLockedOverlay,
  PlayerOsd,
  playerStyles,
} from './PlayerScreenParts';
import { PlayerStatsHud } from './PlayerStatsHud';
import { computeBrightnessDimOpacity, PlayerTouchGestures } from './PlayerTouchGestures';
import { StillWatchingPrompt } from './StillWatchingPrompt';

/** Props of `PlayerScreen`. */
export interface PlayerScreenProps {
  catalog: Pick<CatalogService, 'resolveStream' | 'getProgress' | 'saveProgress'> &
    Partial<
      Pick<
        CatalogService,
        | 'channelByNumber'
        | 'nowNext'
        | 'queryNextEpisode'
        | 'getTrackPreference'
        | 'saveTrackPreference'
        | 'recordRecentChannel'
        | 'listRecentChannels'
        | 'liveVariants'
      >
    > & {
      readonly epgNowNext?: CatalogService['nowNext'];
    };
  videoHost: VideoHost;
  target: PlayTarget;
  playbackGuard?: PlaybackGuard;
  appLifecycle?: AppLifecyclePort;
  clock?: PlaybackClock;
  /** Wall-clock Unix epoch timestamp provider in ms for EPG Now/Next & Ends At (`Date.now`). */
  wallClock?: () => number;
  timers?: PlaybackTimers;
  initialOsdHidden?: boolean;
  autoHideOsdMs?: number;
  initialVolume?: number;
  onPersistVolume?: (volume: number) => void;
  autoSubtitlesOnSkipBack?: boolean;
  onToggleAutoSubtitlesOnSkipBack?: () => void;
  autoPlayNextEpisode?: boolean;
  onToggleAutoPlayNextEpisode?: () => void;
  reduceMotion?: boolean;
  bufferPreset?: BufferPreset;
  useTextureView?: boolean;
  seekStepSec?: SeekStepSecPref;
  defaultResizeMode?: DefaultResizeModePref;
  onPersistResizeMode?: (mode: VideoResizeMode) => void;
  preferredAudioLang?: string;
  preferredSubtitleLang?: string;
  preferredAudioLanguages?: readonly string[];
  preferredSubtitleLanguages?: readonly string[];
  preferDefaultAudioTrack?: boolean;
  preferHevcOverDolbyVision?: boolean;
  filterSdhSubtitles?: boolean;
  subtitleMode?: SubtitleModePref;
  subtitleFontFamily?: AccessibilityFontFamily;
  tvClockMode?: TvClockMode;
  osdTimeDisplayMode?: OsdTimeDisplayMode;
  onPersistOsdTimeDisplayMode?: (mode: OsdTimeDisplayMode) => void;
  sleepTimerDefaultAction?: SleepTimerAction;
  onPersistSleepTimerAction?: (action: SleepTimerAction) => void;
  stillWatchingTimeoutMin?: number;
  onPlaybackActiveChange?: (active: boolean) => void;
  onFineScrubHaptic?: (kind: 'tier' | 'origin') => void;
  preferredAudioDevice?: string;
  onPersistAudioDevice?: (deviceName: string) => void;
  androidDecoderMode?: AndroidDecoderMode;
  onSelectAndroidDecoderMode?: (mode: AndroidDecoderMode) => void;
  deinterlaceMode?: DeinterlaceMode;
  onPersistDeinterlaceMode?: (mode: DeinterlaceMode) => void;
  pitchLock?: boolean;
  onPersistPitchLock?: (locked: boolean) => void;
  audioNormalization?: boolean;
  onPersistAudioNormalization?: (enabled: boolean) => void;
  windowAspectRatioLock?: boolean;
  onWindowAspectRatioLockChange?: (enabled: boolean) => void;
  backgroundAudioPlayback?: boolean;
  liveChannelSwitchMode?: LiveChannelSwitchModePref;
  /** When `true`, suspends player remote/keyboard shortcuts while a root overlay is open. */
  externalOverlayOpen?: boolean;
  onTargetChange?: (next: PlayTarget) => void;
  onExit: () => void;
}

/** Props of {@link PlayerScreenStage}. */
export interface PlayerScreenStageProps {
  readonly isTv: boolean;
  readonly isDesktop: boolean;
  readonly inPip: boolean;
  readonly isVod: boolean;
  readonly useDockedDesktopLayout: boolean;
  readonly hideDesktopCursor: boolean;
  readonly anySheetOpen: boolean;
  readonly locked: boolean;
  readonly osdHidden: boolean;
  readonly showTouchGestures: boolean;
  readonly holdSpeedActive: boolean;
  readonly statsVisible: boolean;
  readonly nextEpisodeVisible: boolean;
  readonly brightness: number;
  readonly volume: number;
  readonly durationMs: number | undefined;
  readonly currentPosMs: number | undefined;
  readonly activeService: PlaybackService | null;
  readonly clock: PlaybackClock;
  readonly i18n: AppI18n;
  readonly osdProps: PlayerOsdProps;
  readonly desktopFallbackKeyProps: Record<string, unknown>;
  readonly touchHoverProps: Record<string, unknown>;
  readonly desktopWebProps: Record<string, unknown> | undefined;
  readonly surfaceNode: ReactElement | null;
  readonly nextEpisodeNode: ReactElement;
  readonly trackPickerNode: ReactElement | null;
  readonly infoSheetNode: ReactElement;
  readonly channelDrawerNode: ReactElement;
  readonly settingsSheetNode: ReactElement;
  readonly stillWatchingVisible: boolean;
  readonly stillWatchingRemainingSec: number;
  readonly stillWatchingFocusedAction?: 'continue' | 'stop';
  readonly onKeepWatching: () => void;
  readonly onStopWatching: () => void;
  readonly onTouchActivity: () => void;
  readonly onSingleTap: () => void;
  readonly onDoubleTapSeek: (deltaMs: number) => void;
  readonly onScrubPreview: (deltaMs: number | undefined) => void;
  readonly onScrubCommit: (deltaMs: number) => void;
  readonly onHoldSpeedStart: () => void;
  readonly onHoldSpeedEnd: () => void;
  readonly onVolumeChange: (volume: number) => void;
  readonly onBrightnessChange: (level: number) => void;
  readonly onUnlock: () => void;
}

/**
 * Presentational root layout of `PlayerScreen`, separating floating cinema scrims (`overlayMode: 'floating'`)
 * from native child-HWND flex-safe docked desktop layout (`overlayMode: 'docked'`).
 */
export function PlayerScreenStage(p: PlayerScreenStageProps): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const { pinDialog, profilePickerOpen } = useProfile();
  const hasExternalOverlay = pinDialog !== null || profilePickerOpen;
  const osdNode = <PlayerOsd {...p.osdProps} />;

  return (
    <View
      testID="player-screen"
      style={[
        playerStyles.root,
        { backgroundColor: theme.colors.bgCanvas },
        p.hideDesktopCursor ? HIDE_CURSOR_WEB_STYLE : undefined,
      ]}
      {...p.desktopFallbackKeyProps}
      {...p.touchHoverProps}
      {...p.desktopWebProps}
    >
      {p.isTv ? (
        <TvFocusAnchor
          testID="player-tv-focus-anchor"
          hasTVPreferredFocus={
            !p.anySheetOpen && !p.locked && !p.stillWatchingVisible && !hasExternalOverlay
          }
        />
      ) : null}

      {p.useDockedDesktopLayout ? (
        <>
          {!p.inPip && !p.osdHidden ? <DesktopDockedTopBar {...p.osdProps} /> : null}
          <View testID="player-desktop-stage" style={playerStyles.desktopStageRow}>
            {!p.inPip ? p.channelDrawerNode : null}
            {p.surfaceNode}
          </View>
        </>
      ) : (
        p.surfaceNode
      )}

      {!p.inPip && !p.isTv && !p.isDesktop && p.brightness < 1 ? (
        <View
          testID="player-brightness-dim-overlay"
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: theme.colors.bgCanvas,
              opacity: computeBrightnessDimOpacity(p.brightness),
            },
          ]}
        />
      ) : null}

      {p.showTouchGestures ? (
        <PlayerTouchGestures
          isVod={p.isVod}
          volume={p.volume}
          brightness={p.brightness}
          renderDimOverlay={false}
          durationMs={p.durationMs}
          positionMs={p.currentPosMs}
          i18n={p.i18n}
          onTouchActivity={p.onTouchActivity}
          onSingleTap={p.onSingleTap}
          {...(p.isVod
            ? {
                onDoubleTapSeek: p.onDoubleTapSeek,
                onScrubPreview: p.onScrubPreview,
                onScrubCommit: p.onScrubCommit,
                onHoldSpeedStart: p.onHoldSpeedStart,
                onHoldSpeedEnd: p.onHoldSpeedEnd,
              }
            : {})}
          onVolumeChange={p.onVolumeChange}
          onBrightnessChange={p.onBrightnessChange}
        />
      ) : null}

      {p.holdSpeedActive && !p.showTouchGestures ? (
        <View
          pointerEvents="none"
          style={[
            playerStyles.holdSpeedWrap,
            { top: 20 + viewport.safeArea.top + viewport.overscan.y },
          ]}
        >
          <MicroPill
            testID="player-hold-speed-pill"
            label={p.i18n.t('player.holdSpeedActive')}
            tone="accent"
          />
        </View>
      ) : null}

      <PlayerStatsHud
        visible={!p.inPip && p.statsVisible}
        osdVisible={!p.osdHidden}
        service={p.activeService}
        clock={p.clock}
        i18n={p.i18n}
        isDesktop={p.isDesktop}
        docked={p.useDockedDesktopLayout}
      />

      {p.inPip ? null : p.useDockedDesktopLayout ? (
        <>
          {p.nextEpisodeNode}
          {p.trackPickerNode}
          {p.infoSheetNode}
          {p.settingsSheetNode}
          {p.osdHidden ? null : osdNode}
        </>
      ) : p.locked ? (
        <PlayerLockedOverlay i18n={p.i18n} onUnlock={p.onUnlock} />
      ) : (
        <>
          <View
            testID="player-next-episode-container"
            pointerEvents="box-none"
            style={
              p.nextEpisodeVisible
                ? p.isTv
                  ? [
                      playerStyles.nextEpisodeOverlayTv,
                      {
                        right: 48 + viewport.overscan.x,
                        bottom: 112 + viewport.overscan.y,
                      },
                    ]
                  : [
                      playerStyles.nextEpisodeOverlay,
                      {
                        right: 16 + viewport.safeArea.right,
                        bottom: 96 + viewport.safeArea.bottom,
                      },
                    ]
                : undefined
            }
          >
            {p.nextEpisodeNode}
          </View>
          {p.osdHidden ? null : osdNode}
          {p.channelDrawerNode}
          {p.trackPickerNode}
          {p.infoSheetNode}
          {p.settingsSheetNode}
        </>
      )}

      <StillWatchingPrompt
        visible={!p.inPip && p.stillWatchingVisible}
        remainingSeconds={p.stillWatchingRemainingSec}
        isTv={p.isTv}
        docked={p.useDockedDesktopLayout}
        focusedAction={p.stillWatchingFocusedAction ?? 'continue'}
        i18n={p.i18n}
        onKeepWatching={p.onKeepWatching}
        onStopNow={p.onStopWatching}
      />
    </View>
  );
}
