import type { PlaybackClock, PlaybackService } from '@elv/playback';
import {
  TABULAR_NUMS_STYLE,
  useTheme,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { usePlaybackTicker } from './usePlaybackTicker';
import {
  attachWebProgressDrag,
  createTouchScrubResponder,
  formatPlaybackPosition,
  type PressGeometry,
  previewProgressSnapshot,
  readEventRatio,
  readProgressSnapshot,
  readTrackRect,
  sameProgressSnapshot,
} from './vod-progress-helpers';

export { formatPlaybackPosition };

/** Props of {@link VodProgressBar}. */
export interface VodProgressBarProps {
  readonly service: PlaybackService | null;
  readonly clock: PlaybackClock;
  readonly isTv: boolean;
  readonly tvFocused?: boolean;
  readonly docked?: boolean;
  readonly label: string;
  readonly previewPositionMs?: number | undefined;
  readonly dimmed?: boolean;
  readonly onSeekRatio: (ratio: number) => void;
  readonly onScrubbingChange?: (scrubbing: boolean) => void;
}

/**
 * Flagship Cinema Quietude VOD scrubber (`3px` resting -> `6px` hover/drag/TV-focus) with web
 * pointer drag-scrubbing, floating hover timecode preview pill, and TV D-pad seek-trap preview.
 */
export function VodProgressBar({
  service,
  clock,
  isTv,
  tvFocused = false,
  docked = false,
  label,
  previewPositionMs,
  dimmed = false,
  onSeekRatio,
  onScrubbingChange,
}: VodProgressBarProps): ReactElement {
  const theme = useTheme();
  const isWeb = (Platform.OS as string) === 'web';
  const live = usePlaybackTicker({
    service,
    clock,
    mode: 'frame',
    derive: readProgressSnapshot,
    isEqual: sameProgressSnapshot,
  });

  const [hovered, setHovered] = useState(false);
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);
  const [dragRatio, setDragRatio] = useState<number | null>(null);

  const widthRef = useRef(0);
  const hasDurationRef = useRef(live.hasDuration);
  hasDurationRef.current = live.hasDuration;
  const dragRatioRef = useRef<number | null>(null);
  const justDraggedRef = useRef(false);
  const dragResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cleanupDragRef = useRef<(() => void) | null>(null);
  const onSeekRatioRef = useRef(onSeekRatio);
  onSeekRatioRef.current = onSeekRatio;
  const onScrubbingChangeRef = useRef(onScrubbingChange);
  onScrubbingChangeRef.current = onScrubbingChange;

  useEffect(
    () => () => {
      cleanupDragRef.current?.();
      if (dragRatioRef.current !== null) onScrubbingChangeRef.current?.(false);
      if (dragResetTimerRef.current !== null) clearTimeout(dragResetTimerRef.current);
    },
    [],
  );

  const markDragEnded = (): void => {
    justDraggedRef.current = true;
    if (dragResetTimerRef.current !== null) clearTimeout(dragResetTimerRef.current);
    dragResetTimerRef.current = setTimeout(() => {
      justDraggedRef.current = false;
      dragResetTimerRef.current = null;
    }, 0);
  };

  const panResponderRef = useRef<ReturnType<typeof createTouchScrubResponder> | null>(null);
  panResponderRef.current ??= createTouchScrubResponder({
    canScrub: () => hasDurationRef.current,
    getWidth: () => widthRef.current,
    onStart: (r) => {
      dragRatioRef.current = r;
      setDragRatio(r);
      onScrubbingChangeRef.current?.(true);
    },
    onMove: (r) => {
      dragRatioRef.current = r;
      setDragRatio(r);
    },
    onCommit: (r) => {
      dragRatioRef.current = null;
      setDragRatio(null);
      onScrubbingChangeRef.current?.(false);
      markDragEnded();
      onSeekRatioRef.current(r);
    },
    onCancel: () => {
      dragRatioRef.current = null;
      setDragRatio(null);
      onScrubbingChangeRef.current?.(false);
    },
  });

  const isDragging = dragRatio !== null;
  const isActive = tvFocused || hovered || isDragging;
  const effectivePreviewMs =
    previewPositionMs !== undefined
      ? previewPositionMs
      : dragRatio !== null && live.hasDuration && live.durationMs !== undefined
        ? Math.round(dragRatio * live.durationMs)
        : undefined;
  const snapshot =
    effectivePreviewMs === undefined ? live : previewProgressSnapshot(live, effectivePreviewMs);

  const pillRatio = dragRatio ?? (hovered ? hoverRatio : null);
  const showHoverPill =
    !isTv &&
    (isWeb ? pillRatio !== null : dragRatio !== null) &&
    live.hasDuration &&
    live.durationMs !== undefined;
  const hoverTimeText =
    showHoverPill && pillRatio !== null && live.durationMs !== undefined
      ? formatPlaybackPosition(Math.round(pillRatio * live.durationMs))
      : null;
  const hoverPillLeftPct =
    pillRatio !== null ? Math.max(6, Math.min(94, Math.round(pillRatio * 1000) / 10)) : 50;

  const startWebDrag = (event: PressGeometry): void => {
    if (!isWeb || isTv || !live.hasDuration) return;
    const btn = event.nativeEvent?.button ?? event.button;
    if (typeof btn === 'number' && btn !== 0) return;
    justDraggedRef.current = false;
    const rect = readTrackRect(event.currentTarget, widthRef.current);
    const initial = readEventRatio(event, widthRef.current, true);
    if (rect === null || initial === undefined) return;
    cleanupDragRef.current?.();
    dragRatioRef.current = initial;
    setDragRatio(initial);
    onScrubbingChangeRef.current?.(true);
    cleanupDragRef.current = attachWebProgressDrag({
      rect,
      initial,
      getLastRatio: () => dragRatioRef.current,
      onMove: (next) => {
        dragRatioRef.current = next;
        setDragRatio(next);
      },
      onCommit: (finalRatio) => {
        cleanupDragRef.current = null;
        dragRatioRef.current = null;
        markDragEnded();
        setDragRatio(null);
        onScrubbingChangeRef.current?.(false);
        onSeekRatioRef.current(finalRatio);
      },
      onCancel: () => {
        cleanupDragRef.current = null;
        dragRatioRef.current = null;
        setDragRatio(null);
        onScrubbingChangeRef.current?.(false);
      },
    });
  };

  const webPointerProps =
    isWeb && !isTv
      ? ({
          onHoverIn: () => setHovered(true),
          onHoverOut: () => {
            setHovered(false);
            setHoverRatio(null);
          },
          onPointerMove: (e: PressGeometry) => {
            setHovered(true);
            const r = readEventRatio(e, widthRef.current, false);
            if (r !== undefined) setHoverRatio(r);
          },
          onPointerDown: startWebDrag,
        } as Record<string, unknown>)
      : undefined;

  const thumbOpacity = isActive
    ? snapshot.hasDuration
      ? 1
      : 0.45
    : isWeb && !isTv
      ? 0
      : snapshot.hasDuration
        ? 1
        : 0.45;

  return (
    <View
      testID="player-progress-row"
      style={[
        styles.row,
        { opacity: dimmed ? 0.2 : 1 },
        webTransition(theme, 'opacity', theme.motion.fastMs),
      ]}
    >
      <Pressable
        testID="player-progress-bar"
        focusable={!isTv}
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityState={{ selected: tvFocused }}
        accessibilityValue={{
          min: 0,
          max: snapshot.durationSec,
          now: snapshot.positionSec,
          text: snapshot.timeText,
        }}
        onLayout={(event) => {
          widthRef.current = event.nativeEvent.layout.width;
        }}
        onPress={(event) => {
          if (justDraggedRef.current) {
            justDraggedRef.current = false;
            return;
          }
          const ratio = readEventRatio(event as unknown as PressGeometry, widthRef.current, true);
          if (!live.hasDuration || ratio === undefined || !Number.isFinite(ratio)) return;
          onSeekRatio(ratio);
        }}
        {...webPointerProps}
        style={[
          styles.trackHitBox,
          docked ? styles.trackHitBoxDocked : null,
          !isTv ? webCursorPointer() : undefined,
        ]}
      >
        {hoverTimeText !== null ? (
          <View
            testID="player-progress-hover-pill"
            pointerEvents="none"
            style={[
              styles.hoverPill,
              docked ? styles.hoverPillDocked : styles.hoverPillFloating,
              {
                left: `${hoverPillLeftPct}%`,
                backgroundColor: theme.colors.glassBg,
                borderColor: theme.colors.glassBorder,
                borderRadius: theme.radius.button,
              },
              webBackdropBlur(16),
            ]}
          >
            <Text
              testID="player-progress-hover-time"
              style={[
                theme.typography.micro,
                TABULAR_NUMS_STYLE,
                styles.hoverPillText,
                { color: theme.colors.textPrimary },
              ]}
            >
              {hoverTimeText}
            </Text>
          </View>
        ) : null}
        {tvFocused ? (
          <View
            testID="player-progress-focus-ring"
            pointerEvents="none"
            style={[
              styles.focusRing,
              {
                borderColor: theme.colors.focusRingColor,
                borderWidth: theme.focus.ringWidth,
                borderRadius: theme.radius.pill,
              },
            ]}
          />
        ) : null}
        <View
          testID="player-progress-rail"
          pointerEvents="none"
          style={[
            styles.trackRail,
            {
              height: isActive ? 6 : 3,
              backgroundColor: theme.colors.bgCard,
              borderColor: theme.colors.surfaceBorder,
            },
            webTransition(theme, 'height', theme.motion.fastMs),
          ]}
        >
          <View
            testID="player-progress-fill"
            style={[
              styles.trackFill,
              { width: `${snapshot.fillPercent}%`, backgroundColor: theme.colors.accent },
            ]}
          />
        </View>
        <View
          testID="player-progress-thumb"
          pointerEvents="none"
          style={[
            styles.trackThumb,
            tvFocused ? styles.trackThumbFocused : isActive ? styles.trackThumbActive : null,
            {
              left: `${snapshot.fillPercent}%`,
              backgroundColor: theme.colors.textPrimary,
              borderColor: theme.colors.bgCanvas,
              opacity: thumbOpacity,
            },
            webTransition(theme, 'transform, opacity, width, height', theme.motion.fastMs),
          ]}
        />
        {!isWeb && !isTv ? (
          <View
            testID="player-progress-touch-scrubber"
            style={StyleSheet.absoluteFill}
            {...panResponderRef.current.panHandlers}
          />
        ) : null}
      </Pressable>
      <Text
        testID="player-progress-time"
        style={[
          theme.typography.caption,
          TABULAR_NUMS_STYLE,
          styles.timeText,
          { color: theme.colors.textSecondary },
        ]}
      >
        {snapshot.timeText}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  trackHitBox: {
    position: 'relative',
    flex: 1,
    paddingVertical: 10,
    justifyContent: 'center',
    direction: 'ltr',
  },
  trackHitBoxDocked: { paddingTop: 28, paddingBottom: 8 },
  hoverPill: {
    position: 'absolute',
    minWidth: 52,
    marginLeft: -26,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderWidth: 1,
    alignItems: 'center',
    zIndex: 10,
  },
  hoverPillFloating: { bottom: 24 },
  hoverPillDocked: { top: 2 },
  hoverPillText: { fontWeight: '700' },
  focusRing: { position: 'absolute', left: -4, right: -4, top: 3, bottom: 3 },
  trackRail: {
    height: 3,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    direction: 'ltr',
  },
  trackFill: { height: '100%' },
  trackThumb: {
    position: 'absolute',
    width: 12,
    height: 12,
    marginLeft: -6,
    borderRadius: 6,
    borderWidth: 1.5,
  },
  trackThumbActive: { width: 14, height: 14, marginLeft: -7, borderRadius: 7 },
  trackThumbFocused: { width: 18, height: 18, marginLeft: -9, borderRadius: 9, borderWidth: 2 },
  timeText: { fontWeight: '600' },
});
