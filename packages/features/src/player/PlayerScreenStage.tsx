import type { CatalogService } from '@elv/data';
import type {
  AccessibilityFontFamily,
  AndroidDecoderMode,
  BufferPreset,
  DefaultResizeModePref,
  DeinterlaceMode,
  LiveChannelSwitchModePref,
  OsdTimeDisplayMode,
  PreferencesPatch,
  SeekStepSecPref,
  SleepTimerAction,
  SubtitleModePref,
  SubtitleStyleConfig,
  TvClockMode,
} from '@elv/domain';
import type { AppI18n } from '@elv/i18n';
import type { PlaybackClock, PlaybackService, PlaybackTimers } from '@elv/playback';
import {
  Icon,
  MicroPill,
  TvFocusAnchor,
  useTheme,
  useViewport,
  webBackdropBlur,
} from '@elv/ui-kit';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import type { AppLifecyclePort } from '../ports/app-lifecycle';
import type { PlayTarget } from '../ports/play-target';
import type { PlaybackGuard } from '../ports/playback-guard';
import type { VideoHost, VideoResizeMode } from '../ports/video-host';
import { useProfile } from '../shared';
import type { PlayerOsdProps } from './DesktopCinemaBar';
import { ExternalDisplayCard } from './ExternalDisplayCard';
import {
  ExternalSubtitleUrlOverlay,
  type ExternalSubtitleUrlOverlayProps,
} from './ExternalSubtitleUrlOverlay';
import { FloatingMiniPlayerChrome, useMiniPlayerController } from './FloatingMiniPlayerChrome';
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
import type { WaveF7aPlayerPreferences } from './usePlayerDisplayAndAudioSync';

/** Props of `PlayerScreen`. */
export interface PlayerScreenProps extends WaveF7aPlayerPreferences {
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
        | 'resolveCatchupStream'
        | 'reportStreamOutcome'
      >
    > & {
      readonly epgNowNext?: CatalogService['nowNext'];
    };
  videoHost: VideoHost;
  target: PlayTarget;
  playbackGuard?: PlaybackGuard;
  /** Optional connection-limit gate for cross-source Rung-4 failover alternates (`#157`, `#87`). */
  canAcquireAlternate?: (accountKey: string, maxConnections: number) => boolean;
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
  onPersistTrackLanguagePatch?: (patch: PreferencesPatch) => void;
  subtitleFontFamily?: AccessibilityFontFamily;
  subtitleStyle?: SubtitleStyleConfig;
  onPersistSubtitleStyle?: (style: SubtitleStyleConfig) => void;
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
  /** Presentation mode (`'full'` fullscreen player vs `'mini'` floating corner mini-player, `#233`). */
  viewMode?: 'full' | 'mini';
  /** Auto-enter OS Picture-in-Picture when leaving the app during playback (`#34`). */
  autoEnterPip?: boolean;
  /** True when the host supports launching Multi-View from the active player (`#34`, `#232`). */
  multiViewSupported?: boolean;
  /** Monotonic token bumped on desktop window restore from tray to unhide cursor/OSD (`#158`). */
  restoreCursorToken?: number;
  /** When `true`, TV hardware Back/Menu minimizes live playback to mini-player instead of exiting (`#233`). */
  tvBackMinimizesLive?: boolean;
  /** Minimizes active playback into the floating corner mini-player without tearing down the stream (`#233`). */
  onMinimizeToMiniPlayer?: () => void;
  /** Restores the floating corner mini-player back to fullscreen (`#233`). */
  onExpandMiniPlayer?: () => void;
  /** Launches Multi-View seeded with the currently playing channel (`#34`). */
  onEnterMultiView?: (target: PlayTarget) => void;
  /** Detaches active playback into the standalone Desktop Popout window (`#158`). */
  onPopoutPlayer?: (target: PlayTarget, positionMs?: number) => void;
  /** Registers an async stop callback so `AppShell` can stop active playback cleanly before Multi-View/Popout handoff without wiping catalog caches. */
  onRegisterStopActivePlayer?: (stop: (() => Promise<void>) | null) => void;
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
  readonly isMini?: boolean;
  readonly externalPlaybackActive?: boolean;
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
  readonly externalSubtitleOverlay?: Pick<
    ExternalSubtitleUrlOverlayProps,
    'visible' | 'onSubmit' | 'onClose'
  >;
  readonly externalSubtitleFeedback?: 'loaded' | 'failed' | null;
  readonly passthroughFallbackVisible?: boolean;
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
  readonly onExpandMiniPlayer?: (() => void) | undefined;
  readonly onCloseMiniPlayer?: (() => void) | undefined;
  readonly onPinchMinimize?: (() => void) | undefined;
  readonly resizeMode?: VideoResizeMode | undefined;
  readonly aspectToastNonce?: number | undefined;
  readonly reduceMotion?: boolean | undefined;
}

const ASPECT_TOAST_HOLD_MS = 1_100;
const ASPECT_TOAST_FADE_MS = 400;

function formatResizeModeLabel(mode: VideoResizeMode, i18n: AppI18n): string {
  if (mode === 'fill') return i18n.t('player.aspect.fill');
  if (mode === 'stretch') return i18n.t('player.aspect.stretch');
  return i18n.t('player.aspect.fit');
}

function AspectModeToast({
  resizeMode,
  nonce,
  reduceMotion,
  topInset,
  i18n,
}: {
  readonly resizeMode: VideoResizeMode;
  readonly nonce: number;
  readonly reduceMotion: boolean;
  readonly topInset: number;
  readonly i18n: AppI18n;
}): ReactElement | null {
  const theme = useTheme();
  const [visible, setVisible] = useState(false);
  const opacityRef = useRef<Animated.Value | null>(null);
  if (opacityRef.current === null) {
    opacityRef.current = new Animated.Value(0);
  }
  const opacity = opacityRef.current;
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeAnimRef = useRef<Animated.CompositeAnimation | null>(null);
  const effectiveReduceMotion = reduceMotion || theme.reduceMotion;

  useEffect(() => {
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    fadeAnimRef.current?.stop();
    fadeAnimRef.current = null;

    if (nonce <= 0) {
      opacity.setValue(0);
      setVisible(false);
      return;
    }

    opacity.setValue(1);
    setVisible(true);
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      if (effectiveReduceMotion) {
        opacity.setValue(0);
        setVisible(false);
        return;
      }
      const anim = Animated.timing(opacity, {
        toValue: 0,
        duration: ASPECT_TOAST_FADE_MS,
        useNativeDriver: false,
      });
      fadeAnimRef.current = anim;
      anim.start(({ finished }) => {
        if (fadeAnimRef.current === anim) fadeAnimRef.current = null;
        if (finished) setVisible(false);
      });
    }, ASPECT_TOAST_HOLD_MS);

    return () => {
      if (holdTimerRef.current !== null) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      fadeAnimRef.current?.stop();
      fadeAnimRef.current = null;
    };
  }, [effectiveReduceMotion, nonce, opacity]);

  if (!visible) return null;

  return (
    <Animated.View
      testID="player-aspect-toast"
      pointerEvents="none"
      style={[
        stageStyles.aspectToastWrap,
        {
          top: topInset,
          opacity,
        },
      ]}
    >
      <View
        style={[
          stageStyles.aspectToastPill,
          {
            backgroundColor: theme.colors.glassBg,
            borderColor: theme.colors.glassBorder,
            borderRadius: theme.radius.pill,
          },
          webBackdropBlur(16),
        ]}
      >
        <Icon name="aspect" size={16} color={theme.colors.accent} />
        <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
          {formatResizeModeLabel(resizeMode, i18n)}
        </Text>
      </View>
    </Animated.View>
  );
}

/**
 * Presentational root layout of `PlayerScreen`, separating floating cinema scrims (`overlayMode: 'floating'`)
 * from native child-HWND flex-safe docked desktop layout (`overlayMode: 'docked'`), while keeping
 * `surfaceNode` mounted at a stable React tree position across `'full' <-> 'mini'` transitions (`#233`).
 */
export function PlayerScreenStage(p: PlayerScreenStageProps): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const { pinDialog, profilePickerOpen } = useProfile();
  const hasExternalOverlay = pinDialog !== null || profilePickerOpen;
  const isMini = p.isMini === true;
  const suppressChrome = p.inPip || isMini;
  const osdNode = <PlayerOsd {...p.osdProps} />;
  const miniController = useMiniPlayerController({
    enabled: isMini,
    isTv: p.isTv,
    reduceMotion: p.reduceMotion === true || theme.reduceMotion,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    formFactor: viewport.formFactor,
    orientation: viewport.orientation,
    safeArea: viewport.safeArea,
    overscan: viewport.overscan,
  });

  return (
    <View
      testID="player-screen"
      pointerEvents={isMini ? 'box-none' : 'auto'}
      style={
        isMini
          ? stageStyles.miniRoot
          : [
              playerStyles.root,
              { backgroundColor: theme.colors.bgCanvas },
              p.hideDesktopCursor ? HIDE_CURSOR_WEB_STYLE : undefined,
            ]
      }
      {...(!isMini ? p.desktopFallbackKeyProps : {})}
      {...(!isMini ? p.touchHoverProps : {})}
      {...(!isMini ? p.desktopWebProps : {})}
    >
      {p.isTv && !suppressChrome ? (
        <TvFocusAnchor
          testID="player-tv-focus-anchor"
          hasTVPreferredFocus={
            !p.anySheetOpen && !p.locked && !p.stillWatchingVisible && !hasExternalOverlay
          }
        />
      ) : null}

      <Animated.View
        testID={isMini ? 'floating-mini-player' : 'player-stage-frame'}
        {...(isMini ? { accessibilityLabel: p.i18n.t('player.miniPlayer.activeLabel') } : {})}
        style={
          isMini
            ? [
                stageStyles.miniFrame,
                {
                  width: miniController.width,
                  height: miniController.height,
                  left: miniController.animPos.x,
                  top: miniController.animPos.y,
                  backgroundColor: theme.colors.bgElevated,
                  borderColor: theme.colors.glassBorder,
                  borderRadius: theme.radius.card,
                  shadowColor: theme.colors.bgCanvas,
                },
                webBackdropBlur(16),
              ]
            : playerStyles.flex1
        }
      >
        {!suppressChrome && p.useDockedDesktopLayout && !p.osdHidden ? (
          <DesktopDockedTopBar {...p.osdProps} />
        ) : null}
        <View
          testID={
            p.useDockedDesktopLayout && !isMini ? 'player-desktop-stage' : 'player-surface-host'
          }
          {...(isMini
            ? { focusable: false, accessible: false, pointerEvents: 'none' as const }
            : {})}
          style={
            p.useDockedDesktopLayout && !isMini ? playerStyles.desktopStageRow : playerStyles.flex1
          }
        >
          {!suppressChrome && p.useDockedDesktopLayout ? p.channelDrawerNode : null}
          {p.surfaceNode}
        </View>
        {isMini ? (
          <FloatingMiniPlayerChrome
            title={p.osdProps.title}
            subtitle={p.osdProps.subtitle}
            isLive={!p.isVod}
            isTv={p.isTv}
            corner={miniController.corner}
            i18n={p.i18n}
            onExpand={p.onExpandMiniPlayer ?? (() => undefined)}
            onClose={p.onCloseMiniPlayer ?? (() => undefined)}
            onDragStart={miniController.startDrag}
            onResizeStart={miniController.startResize}
            shouldSuppressExpand={miniController.shouldSuppressExpand}
          />
        ) : null}
      </Animated.View>

      {!suppressChrome && p.externalPlaybackActive === true ? (
        <ExternalDisplayCard i18n={p.i18n} />
      ) : null}

      {!suppressChrome && !p.isTv && !p.isDesktop && p.brightness < 1 ? (
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

      {!suppressChrome && p.showTouchGestures ? (
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
          {...(p.onPinchMinimize !== undefined ? { onPinchMinimize: p.onPinchMinimize } : {})}
        />
      ) : null}

      {!suppressChrome && p.holdSpeedActive && !p.showTouchGestures ? (
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

      {!suppressChrome && p.aspectToastNonce !== undefined && p.aspectToastNonce > 0 ? (
        <AspectModeToast
          resizeMode={p.resizeMode ?? 'fit'}
          nonce={p.aspectToastNonce}
          reduceMotion={p.reduceMotion === true}
          topInset={28 + viewport.safeArea.top + viewport.overscan.y}
          i18n={p.i18n}
        />
      ) : null}

      <PlayerStatsHud
        visible={!suppressChrome && p.statsVisible}
        osdVisible={!p.osdHidden}
        service={p.activeService}
        clock={p.clock}
        i18n={p.i18n}
        isDesktop={p.isDesktop}
        docked={p.useDockedDesktopLayout}
      />

      {suppressChrome ? null : p.useDockedDesktopLayout ? (
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

      {!suppressChrome &&
      p.externalSubtitleFeedback !== undefined &&
      p.externalSubtitleFeedback !== null ? (
        <View
          pointerEvents="none"
          style={[
            playerStyles.holdSpeedWrap,
            { top: 20 + viewport.safeArea.top + viewport.overscan.y },
          ]}
        >
          <MicroPill
            testID="player-external-subtitle-feedback"
            label={p.i18n.t(
              p.externalSubtitleFeedback === 'loaded'
                ? 'player.externalSubtitle.loaded'
                : 'player.externalSubtitle.failed',
            )}
            tone="accent"
          />
        </View>
      ) : null}

      {!suppressChrome && p.passthroughFallbackVisible === true ? (
        <View
          pointerEvents="none"
          style={[
            playerStyles.holdSpeedWrap,
            { top: 20 + viewport.safeArea.top + viewport.overscan.y },
          ]}
        >
          <MicroPill
            testID="player-passthrough-fallback-notice"
            label={p.i18n.t('player.audio.passthroughFallbackNotice')}
            tone="neutral"
            icon="audio"
          />
        </View>
      ) : null}

      {!suppressChrome && p.externalSubtitleOverlay !== undefined ? (
        <ExternalSubtitleUrlOverlay
          visible={p.externalSubtitleOverlay.visible}
          isTv={p.isTv}
          i18n={p.i18n}
          onSubmit={p.externalSubtitleOverlay.onSubmit}
          onClose={p.externalSubtitleOverlay.onClose}
        />
      ) : null}

      <StillWatchingPrompt
        visible={!suppressChrome && p.stillWatchingVisible}
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

const stageStyles = StyleSheet.create({
  miniRoot: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  miniFrame: {
    position: 'absolute',
    borderWidth: 1,
    overflow: 'hidden',
    shadowOpacity: 0.42,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  aspectToastWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 40,
  },
  aspectToastPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderWidth: 1,
  },
});
