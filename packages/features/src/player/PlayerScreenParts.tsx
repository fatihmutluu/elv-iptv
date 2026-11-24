import type { ItemRow } from '@elv/data';
import type { AccessibilityFontFamily } from '@elv/domain';
import type { AppI18n } from '@elv/i18n';
import {
  type PlaybackClock,
  type PlaybackService,
  type PlaybackStatus,
  type PlaybackTimers,
  positionAt,
} from '@elv/playback';
import { Scrim, useTheme, useViewport } from '@elv/ui-kit';
import { type ReactElement, type RefObject, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View, type ViewStyle } from 'react-native';
import type { PlayableEntry } from '../ports/play-target';
import type { OpenVideoEngine, VideoResizeMode } from '../ports/video-host';
import {
  DesktopCinemaBar,
  DesktopDockedTopBar,
  PlayerOsdBottomBar,
  type PlayerOsdProps,
  PlayerOsdTopBar,
} from './DesktopCinemaBar';
import { describePlaybackFailure } from './errors';
import { PlayerLockedOverlay } from './PlayerOsdButton';
import { FloatingPeekOsd } from './PlayerOsdChrome';
import { MIN_BRIGHTNESS } from './PlayerTouchGestures';

export { DesktopDockedTopBar, PlayerLockedOverlay, type PlayerOsdProps };

/** Renders the active native video surface layer when a host engine session is ready. */
export function PlayerSurfaceLayer(props: {
  readonly opened: OpenVideoEngine;
  readonly useDockedDesktopLayout: boolean;
  readonly statusText: string;
  readonly failed: boolean;
  readonly resizeMode: VideoResizeMode;
  readonly subtitleBottomInsetPx: number;
  readonly subtitleFontFamily: AccessibilityFontFamily | undefined;
  readonly surfaceRecreationToken: number;
  readonly useTextureView: boolean;
  readonly osdVisible: boolean;
}): ReactElement {
  return (
    <View
      testID="player-surface-layer"
      style={
        props.useDockedDesktopLayout ? playerStyles.surfaceLayerDesktop : playerStyles.surfaceLayer
      }
    >
      {props.opened.renderSurface({
        statusText: props.statusText,
        failed: props.failed,
        resizeMode: props.resizeMode,
        subtitleBottomInsetPx: props.subtitleBottomInsetPx,
        ...(props.subtitleFontFamily !== undefined
          ? { subtitleFontFamily: props.subtitleFontFamily }
          : {}),
        surfaceRecreationToken: props.surfaceRecreationToken,
        useTextureView: props.useTextureView,
        osdVisible: props.osdVisible,
        testID: 'player-surface',
      })}
    </View>
  );
}

/** Computes extra bottom inset (dp/px) to lift native subtitles above a visible OSD (`#136`). */
export function computeSubtitleBottomInsetPx(opts: {
  readonly useDockedDesktopLayout: boolean;
  readonly osdVisible: boolean;
  readonly isTv: boolean;
  readonly osdTier: string;
}): number {
  if (opts.useDockedDesktopLayout || !opts.osdVisible) return 0;
  if (opts.isTv) return 120;
  return opts.osdTier === 'progress' ? 64 : 96;
}

/** Web-only cursor style applied while desktop OSD is hidden during playback. */
export const HIDE_CURSOR_WEB_STYLE = { cursor: 'none' } as unknown as ViewStyle;

/** Builds desktop-web pointer/wheel event props for {@link PlayerScreen}. */
export function buildDesktopWebProps(
  enabled: boolean,
  onWheelVolume: (deltaY: number) => boolean,
  onActivity: () => void,
): Record<string, unknown> | undefined {
  if (!enabled) return undefined;
  return {
    onContextMenu: (e?: { preventDefault?: () => void }) => {
      e?.preventDefault?.();
    },
    onWheel: (e?: {
      deltaY?: number;
      nativeEvent?: { deltaY?: number };
      preventDefault?: () => void;
    }) => {
      if (onWheelVolume(e?.deltaY ?? e?.nativeEvent?.deltaY ?? 0)) {
        onActivity();
        e?.preventDefault?.();
      }
    },
  };
}
/** Default monotonic playback clock for {@link PlayerScreen}. */
export const DEFAULT_PLAYER_CLOCK: PlaybackClock = { now: () => performance.now() };
/** Default timeout scheduler for {@link PlayerScreen}. */
export const DEFAULT_PLAYER_TIMERS: PlaybackTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Maps `@elv/data` recent channel `ItemRow`s into `PlayableEntry` rows for `PlayerChannelDrawer`. */
export function mapRecentChannelRows(rows: readonly ItemRow[]): readonly PlayableEntry[] {
  return rows.map((r) => ({
    itemKey: r.key,
    sourceId: r.sourceId,
    kind: 'live' as const,
    title: r.name,
    ...(r.logo ? { logo: r.logo } : {}),
  }));
}

/** Formats localized OSD status text from `PlaybackStatus`. */
export function formatStatusLine(status: PlaybackStatus, i18n: AppI18n): string {
  switch (status.kind) {
    case 'idle':
      return i18n.t('player.status.idle');
    case 'tuning':
      return i18n.t('player.status.tuning');
    case 'playing':
      return i18n.t('player.status.playing');
    case 'paused':
      return i18n.t('player.status.paused');
    case 'ended':
      return i18n.t('player.status.ended');
    case 'recovering':
      return i18n.t('player.status.recovering', { rung: status.rung });
    case 'limited':
      return i18n.t('player.status.limited');
    case 'failed':
      return i18n.t(describePlaybackFailure(status.error).messageId);
  }
}

/**
 * Unified Minimalist Cinema Player OSD (`Product Decision #40`):
 * - Floating mode (default on TV, Phone, Tablet, and Desktop in-canvas): transparent borderless
 *   top/bottom scrim zones with 100% open unobstructed middle video canvas.
 * - Docked mode (`isDesktop && overlayMode === 'docked'`): legacy child-HWND non-overlapping flex bar.
 */
export function PlayerOsd(p: PlayerOsdProps): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const {
    i18n,
    isTv,
    isVod,
    service,
    osdTier = 'controls',
    muted = false,
    volume = 100,
    playbackSpeed = 1,
  } = p;
  const resolvedDesktop = p.isDesktop ?? viewport.formFactor === 'desktop';
  const overlayMode = p.overlayMode ?? 'floating';

  if (resolvedDesktop && overlayMode === 'docked') {
    return <DesktopCinemaBar {...p} />;
  }

  const padH = (isTv ? 48 : resolvedDesktop ? 28 : 16) + viewport.overscan.x;
  const padTop =
    (isTv ? 24 : resolvedDesktop ? 20 : 14) + viewport.safeArea.top + viewport.overscan.y;
  const padBottom =
    (isTv ? 24 : resolvedDesktop ? 20 : 14) + viewport.safeArea.bottom + viewport.overscan.y;
  const padLeft = padH + viewport.safeArea.left;
  const padRight = padH + viewport.safeArea.right;

  if (osdTier === 'progress') {
    return (
      <FloatingPeekOsd
        title={p.title}
        channelDigits={p.channelDigits}
        isVod={isVod}
        isTv={isTv}
        muted={muted}
        volume={volume}
        playbackSpeed={playbackSpeed}
        chapters={p.chapters}
        timeDisplayMode={p.timeDisplayMode}
        wallClock={p.wallClock}
        nowNext={p.nowNext}
        nowMs={p.nowMs}
        previewPositionMs={p.previewPositionMs}
        service={service}
        clock={p.clock}
        i18n={i18n}
        onCycleTimeDisplayMode={p.onCycleTimeDisplayMode}
        onSeekRatio={p.onSeekRatio}
        onScrubbingChange={p.onScrubbingChange}
        padBottom={padBottom}
        padLeft={padLeft}
        padRight={padRight}
      />
    );
  }

  return (
    <View testID="player-osd" pointerEvents="box-none" style={playerStyles.floatingOsd}>
      <View
        testID="player-osd-top"
        pointerEvents="box-none"
        style={[
          playerStyles.topZone,
          { paddingTop: padTop, paddingLeft: padLeft, paddingRight: padRight },
        ]}
      >
        <Scrim direction="top" intensity="default" />
        <PlayerOsdTopBar {...p} isDesktop={resolvedDesktop} />
      </View>

      <View pointerEvents="none" style={playerStyles.openCenterCanvas}>
        {p.isBuffering === true && p.failure === null ? (
          <ActivityIndicator
            testID="player-buffering-indicator"
            size="large"
            color={theme.colors.textPrimary}
          />
        ) : null}
      </View>

      <View
        testID="player-osd-bottom"
        pointerEvents="box-none"
        style={[
          playerStyles.bottomZone,
          { paddingBottom: padBottom, paddingLeft: padLeft, paddingRight: padRight },
        ]}
      >
        <Scrim direction="bottom" intensity="strong" />
        <PlayerOsdBottomBar {...p} isDesktop={resolvedDesktop} />
      </View>
    </View>
  );
}

/** Stores the latest render value in a stable React ref without re-creating callbacks. */
export function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** Syncs native resizeMode on target/status transitions and keeps preview OSD visible (`#432`). */
export function usePreviewOsdAndResizeSync(opts: {
  readonly openedEngine: OpenVideoEngine | undefined;
  readonly activeItemKey: string;
  readonly statusKind: PlaybackStatus['kind'];
  readonly resizeMode: VideoResizeMode;
  readonly previewActive: boolean;
  readonly osdHidden: boolean;
  readonly showOsd: () => void;
  readonly cancelPreview: () => void;
}): void {
  const { openedEngine, activeItemKey, statusKind, resizeMode, previewActive, osdHidden } = opts;
  const showOsdRef = useLatestRef(opts.showOsd);
  const prevOsdHiddenRef = useRef(osdHidden);
  const cancelPreview = opts.cancelPreview;

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-send resizeMode when activeItemKey changes so mpv --reset-on-next-file never reverts to fit
  useEffect(() => {
    if (openedEngine === undefined) return;
    if (statusKind === 'playing' || statusKind === 'paused') {
      openedEngine.setResizeMode?.(resizeMode);
    }
  }, [openedEngine, activeItemKey, statusKind, resizeMode]);

  useEffect(() => {
    if (previewActive) showOsdRef.current();
  }, [previewActive, showOsdRef]);

  useEffect(() => {
    const wasHidden = prevOsdHiddenRef.current;
    prevOsdHiddenRef.current = osdHidden;
    if (!wasHidden && osdHidden && previewActive) cancelPreview();
  }, [cancelPreview, osdHidden, previewActive]);
}

/** Manages touch-brightness clamping and relative touch-scrub preview/commit for {@link PlayerScreen}. */
export function usePlayerTouchScrubAndBrightness(opts: {
  readonly activeItemKey: string;
  readonly activeService: PlaybackService | null;
  readonly serviceRef: RefObject<PlaybackService | null>;
  readonly clock: PlaybackClock;
  readonly hostSetBrightness: ((value: number) => void) | undefined;
  readonly previewPositionMs: number | undefined;
  readonly osdHidden: boolean;
  readonly seekToRatio: (ratio: number) => void;
  readonly showProgressOsd: () => void;
  readonly recordUserActivity: () => void;
}) {
  const [brightness, setBrightness] = useState(1);
  const [touchScrubDeltaMs, setTouchScrubDeltaMs] = useState<number | undefined>(undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset transient scrub delta on item change
  useEffect(() => {
    setTouchScrubDeltaMs(undefined);
  }, [opts.activeItemKey]);

  const anchor = opts.activeService?.getState().anchor;
  const currentPosMs = anchor !== undefined ? positionAt(anchor, opts.clock.now()) : undefined;
  const durationMs = anchor?.durationMs;
  const effectivePreviewMs =
    touchScrubDeltaMs !== undefined && currentPosMs !== undefined && durationMs !== undefined
      ? Math.max(0, Math.min(durationMs, currentPosMs + touchScrubDeltaMs))
      : opts.previewPositionMs;

  const handleBrightnessChange = (next: number): void => {
    const clamped = Math.max(MIN_BRIGHTNESS, Math.min(1, next));
    setBrightness(clamped);
    opts.hostSetBrightness?.(clamped);
  };
  const handleTouchScrubCommit = (deltaMs: number): void => {
    opts.recordUserActivity();
    const latestAnchor = opts.serviceRef.current?.getState().anchor;
    const dur = latestAnchor?.durationMs;
    if (latestAnchor !== undefined && dur !== undefined && dur > 0) {
      const targetMs = Math.max(
        0,
        Math.min(dur, positionAt(latestAnchor, opts.clock.now()) + deltaMs),
      );
      opts.seekToRatio(targetMs / dur);
      if (opts.osdHidden) opts.showProgressOsd();
    }
  };

  return {
    brightness,
    currentPosMs,
    durationMs,
    effectivePreviewMs,
    setTouchScrubDeltaMs,
    handleBrightnessChange,
    handleTouchScrubCommit,
  };
}

export const playerStyles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  desktopStageRow: { flex: 1, flexDirection: 'row' },
  flex1: { flex: 1 },
  surfaceLayer: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  surfaceLayerDesktop: { flex: 1 },
  floatingOsd: { position: 'absolute', inset: 0, justifyContent: 'space-between' },
  topZone: { position: 'relative', paddingBottom: 24 },
  openCenterCanvas: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  bottomZone: { position: 'relative', paddingTop: 28 },
  holdSpeedWrap: {
    position: 'absolute',
    top: 20,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 25,
  },
  nextEpisodeOverlay: {
    position: 'absolute',
    right: 16,
    bottom: 96,
    zIndex: 15,
  },
  nextEpisodeOverlayTv: {
    position: 'absolute',
    right: 48,
    bottom: 112,
    zIndex: 15,
  },
});
