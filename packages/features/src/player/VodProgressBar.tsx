import type { AppI18n } from '@elv/i18n';
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
  formatVodEndAccessibilityLabel,
  formatVodEndTimestamp,
  type PressGeometry,
  previewProgressSnapshot,
  readEventRatio,
  readProgressSnapshot,
  readTrackRect,
  sameProgressSnapshot,
  type TouchScrubSensitivityTier,
  type VodEndTimeDisplayMode,
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
  readonly timeDisplayMode?: VodEndTimeDisplayMode | undefined;
  readonly i18n?: AppI18n | undefined;
  readonly onCycleTimeDisplayMode?: (() => void) | undefined;
  readonly onFineScrubHaptic?: ((kind: 'tier' | 'origin') => void) | undefined;
  readonly onSeekRatio: (ratio: number) => void;
  readonly onScrubbingChange?: (scrubbing: boolean) => void;
}

/**
 * Cinema Quietude VOD scrubber (`5px` resting -> `8px` hover/drag/TV-focus) flanked by
 * split left/right `14px` tabular timestamps (elapsed left, remaining/total right `#507`),
 * floating timecode pill, and touch fine-scrubbing zoom (`#355`).
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
  timeDisplayMode = 'remaining',
  i18n,
  onCycleTimeDisplayMode,
  onFineScrubHaptic,
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
  const [scrubTier, setScrubTier] = useState<TouchScrubSensitivityTier>('normal');

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
  const onFineScrubHapticRef = useRef(onFineScrubHaptic);
  onFineScrubHapticRef.current = onFineScrubHaptic;

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
      setScrubTier('normal');
      onScrubbingChangeRef.current?.(false);
      markDragEnded();
      onSeekRatioRef.current(r);
    },
    onCancel: () => {
      dragRatioRef.current = null;
      setDragRatio(null);
      setScrubTier('normal');
      onScrubbingChangeRef.current?.(false);
    },
    onSensitivityChange: setScrubTier,
    onFineScrubHaptic: (kind) => onFineScrubHapticRef.current?.(kind),
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
  const pillMs =
    showHoverPill && pillRatio !== null && live.durationMs !== undefined
      ? Math.round(pillRatio * live.durationMs)
      : null;
  const hoverTimeText = pillMs !== null ? formatPlaybackPosition(pillMs) : null;
  const scrubTierLabel =
    isDragging && !isWeb && scrubTier !== 'normal'
      ? scrubTier === 'fine'
        ? (i18n?.t('player.scrub.fine') ?? '0.1× · Ultra fine')
        : (i18n?.t('player.scrub.quarter') ?? '0.25× · Fine')
      : null;
  const hoverPillLeftPct =
    pillRatio !== null ? Math.max(8, Math.min(92, Math.round(pillRatio * 1000) / 10)) : 50;

  const endTimestampText = formatVodEndTimestamp(
    snapshot.positionMs,
    snapshot.durationMs,
    timeDisplayMode,
  );
  const endTimestampA11yLabel =
    i18n !== undefined
      ? formatVodEndAccessibilityLabel(
          snapshot.positionMs,
          snapshot.durationMs,
          timeDisplayMode,
          i18n,
        )
      : endTimestampText;

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
      <Text
        testID="player-progress-time-current"
        style={[
          theme.typography.caption,
          TABULAR_NUMS_STYLE,
          styles.currentTimeText,
          { color: theme.colors.textPrimary },
        ]}
      >
        {snapshot.currentText}
      </Text>

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
              numberOfLines={1}
              style={[
                theme.typography.micro,
                TABULAR_NUMS_STYLE,
                styles.hoverPillText,
                { color: theme.colors.textPrimary },
              ]}
            >
              {hoverTimeText}
            </Text>
            {scrubTierLabel !== null ? (
              <Text
                testID="player-progress-scrub-tier"
                numberOfLines={1}
                style={[
                  theme.typography.micro,
                  TABULAR_NUMS_STYLE,
                  { color: theme.colors.textSecondary },
                ]}
              >
                {scrubTierLabel}
              </Text>
            ) : null}
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
              height: isActive ? 8 : 5,
              backgroundColor: theme.colors.actionGlassBorder,
            },
            webTransition(theme, 'height', theme.motion.fastMs),
          ]}
        >
          {snapshot.hasBufferedRange &&
          snapshot.bufferedEndPercent > snapshot.bufferedStartPercent ? (
            <View
              testID="player-progress-buffered"
              pointerEvents="none"
              style={[
                styles.trackBuffered,
                {
                  left: `${snapshot.bufferedStartPercent}%`,
                  width: `${Math.max(0, snapshot.bufferedEndPercent - snapshot.bufferedStartPercent)}%`,
                  backgroundColor: theme.colors.textMuted,
                },
              ]}
            />
          ) : null}
          <View
            testID="player-progress-fill"
            style={[
              styles.trackFill,
              { width: `${snapshot.fillPercent}%`, backgroundColor: theme.colors.textPrimary },
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

      <Pressable
        testID="player-progress-time-end"
        disabled={onCycleTimeDisplayMode === undefined}
        focusable={false}
        accessibilityRole={onCycleTimeDisplayMode !== undefined ? 'button' : 'text'}
        accessibilityLabel={endTimestampA11yLabel}
        accessibilityHint={
          onCycleTimeDisplayMode !== undefined ? i18n?.t('player.timeDisplayToggleHint') : undefined
        }
        onPress={onCycleTimeDisplayMode}
        style={onCycleTimeDisplayMode !== undefined && !isTv ? webCursorPointer() : undefined}
      >
        <Text
          testID="player-progress-time"
          style={[
            theme.typography.caption,
            TABULAR_NUMS_STYLE,
            styles.endTimeText,
            { color: theme.colors.textSecondary },
          ]}
        >
          {endTimestampText}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', direction: 'ltr', alignItems: 'center', gap: 12 },
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
    minWidth: 56,
    maxWidth: 240,
    marginLeft: -28,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    alignItems: 'center',
    gap: 2,
    zIndex: 10,
  },
  hoverPillFloating: { bottom: 24 },
  hoverPillDocked: { top: 2 },
  hoverPillText: { fontWeight: '700' },
  focusRing: { position: 'absolute', left: -4, right: -4, top: 3, bottom: 3 },
  trackRail: {
    position: 'relative',
    height: 5,
    borderRadius: 999,
    overflow: 'hidden',
    direction: 'ltr',
  },
  trackBuffered: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    opacity: 0.35,
    borderRadius: 3,
  },
  trackFill: { position: 'relative', height: '100%' },
  trackThumb: {
    position: 'absolute',
    width: 16,
    height: 16,
    marginLeft: -8,
    borderRadius: 8,
    borderWidth: 1.5,
    zIndex: 3,
  },
  trackThumbActive: { width: 18, height: 18, marginLeft: -9, borderRadius: 9 },
  trackThumbFocused: { width: 20, height: 20, marginLeft: -10, borderRadius: 10, borderWidth: 2 },
  currentTimeText: { fontWeight: '700', fontSize: 14, minWidth: 42 },
  endTimeText: { fontWeight: '600', fontSize: 14, textAlign: 'right' },
});
