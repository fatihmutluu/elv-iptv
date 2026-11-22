import type { AppI18n } from '@elv/i18n';
import { TABULAR_NUMS_STYLE, useTheme, webBackdropBlur } from '@elv/ui-kit';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { formatPlaybackPosition } from './vod-progress-helpers';

/** System gesture exclusion inset on all 4 screen edges (px). */
export const EDGE_EXCLUSION_PX = 24;
const VERTICAL_SWIPE_THRESHOLD_PX = 16;
const HORIZONTAL_SWIPE_THRESHOLD_PX = 18;
const DOUBLE_TAP_WINDOW_MS = 280;
const DOUBLE_TAP_SEEK_MS = 10_000;
/** Stationary hold duration before activating temporary 2x playback speed (ms). */
export const HOLD_SPEED_DELAY_MS = 500;
const SCRUB_FULL_WIDTH_MS = 90_000;
const HOLD_MOVE_SLOP_PX = 10;

/** Classification returned by {@link classifyTouchGesture}. */
export type TouchGestureKind = 'none' | 'edge-excluded' | 'brightness' | 'volume' | 'scrub';

/** Props of {@link PlayerTouchGestures}. */
export interface PlayerTouchGesturesProps {
  readonly isVod: boolean;
  readonly volume: number;
  readonly brightness: number;
  readonly durationMs?: number | undefined;
  readonly positionMs?: number | undefined;
  readonly i18n: AppI18n;
  readonly onTouchActivity: () => void;
  readonly onSingleTap: () => void;
  readonly onDoubleTapSeek?: (deltaMs: number) => void;
  readonly onVolumeChange: (nextVolume: number) => void;
  readonly onBrightnessChange: (nextBrightness: number) => void;
  readonly onScrubPreview?: (deltaMs: number | undefined) => void;
  readonly onScrubCommit?: (deltaMs: number) => void;
  readonly onHoldSpeedStart?: () => void;
  readonly onHoldSpeedEnd?: () => void;
}

interface TouchPointEvent {
  readonly nativeEvent?: {
    readonly locationX?: number;
    readonly locationY?: number;
    readonly pageX?: number;
    readonly pageY?: number;
  };
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1);
const clampVol = (v: number): number =>
  Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 0;

/** Returns `true` when `(x, y)` falls inside the 24 px edge exclusion zone of `(width, height)`. */
export function isInEdgeExclusionZone(
  x: number,
  y: number,
  width: number,
  height: number,
  inset = EDGE_EXCLUSION_PX,
): boolean {
  if (width <= 0 || height <= 0) return false;
  return x < inset || x > width - inset || y < inset || y > height - inset;
}

/** Pure touch gesture classifier for left brightness, right volume, and VOD horizontal scrub. */
export function classifyTouchGesture(input: {
  readonly startX: number;
  readonly startY: number;
  readonly dx: number;
  readonly dy: number;
  readonly width: number;
  readonly height: number;
  readonly isVod: boolean;
}): TouchGestureKind {
  const { startX, startY, dx, dy, width, height, isVod } = input;
  if (isInEdgeExclusionZone(startX, startY, width, height)) return 'edge-excluded';
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  if (absY > VERTICAL_SWIPE_THRESHOLD_PX && absY > absX) {
    return startX < width / 2 ? 'brightness' : 'volume';
  }
  if (isVod && absX > HORIZONTAL_SWIPE_THRESHOLD_PX && absX >= absY) return 'scrub';
  return 'none';
}

/** Converts horizontal drag distance `dx` into a clamped VOD scrub delta (`±90s` per screen width). */
export function computeScrubDeltaMs(
  dx: number,
  width: number,
  positionMs?: number,
  durationMs?: number,
): number {
  if (!Number.isFinite(dx) || !Number.isFinite(width) || width <= 0) return 0;
  const raw = Math.round((dx / width) * SCRUB_FULL_WIDTH_MS);
  if (
    positionMs !== undefined &&
    durationMs !== undefined &&
    Number.isFinite(positionMs) &&
    Number.isFinite(durationMs) &&
    durationMs > 0
  ) {
    return Math.round(Math.max(0, Math.min(durationMs, positionMs + raw)) - positionMs);
  }
  return raw;
}

/** Classifies tap x-coordinate into left 40% (`-1`), center 20% (`0`), or right 40% (`+1`). */
export function classifyDoubleTapSide(x: number, width: number): -1 | 0 | 1 {
  if (!Number.isFinite(x) || !Number.isFinite(width) || width <= 0) return 0;
  if (x < width * 0.4) return -1;
  if (x > width * 0.6) return 1;
  return 0;
}

/** Formats a signed millisecond scrub delta such as `+0:15` or `-0:30`. */
function formatScrubDelta(deltaMs: number): string {
  const roundedMs = Math.round(Math.abs(deltaMs) / 1000) * 1000;
  return `${deltaMs < 0 ? '-' : '+'}${formatPlaybackPosition(roundedMs)}`;
}

function readPoint(event: TouchPointEvent | undefined): { x: number; y: number } | null {
  const n = event?.nativeEvent;
  const x = n?.locationX ?? n?.pageX;
  const y = n?.locationY ?? n?.pageY;
  return typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)
    ? { x, y }
    : null;
}

/**
 * Mobile/tablet Cinema Quietude v2 touch gesture surface (`#114`):
 * `24px` system edge exclusion, left-half brightness swipe + visual dim fallback,
 * right-half volume swipe, VOD horizontal scrub preview/commit, double-tap `±10s`,
 * `500ms` stationary hold-to-2x speed, and single-tap OSD toggle.
 */
export function PlayerTouchGestures(props: PlayerTouchGesturesProps): ReactElement {
  const theme = useTheme();
  const [feedbackText, setFeedbackText] = useState<string | null>(null);
  const [holdSpeedActive, setHoldSpeedActive] = useState(false);

  const layoutRef = useRef({ width: 0, height: 0 });
  const gestureRef = useRef<{
    startX: number;
    startY: number;
    startVolume: number;
    startBrightness: number;
    kind: TouchGestureKind;
    lastScrubDeltaMs: number;
    holdActive: boolean;
  } | null>(null);

  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const singleTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTapRef = useRef<{ atMs: number; side: -1 | 1 } | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  const stopHoldTimer = (): void => {
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };
  const stopTapTimer = (): void => {
    if (singleTapTimerRef.current !== null) {
      clearTimeout(singleTapTimerRef.current);
      singleTapTimerRef.current = null;
    }
  };

  useEffect(
    () => () => {
      if (holdTimerRef.current !== null) clearTimeout(holdTimerRef.current);
      if (singleTapTimerRef.current !== null) clearTimeout(singleTapTimerRef.current);
      const active = gestureRef.current;
      if (active?.holdActive) propsRef.current.onHoldSpeedEnd?.();
      if (active?.kind === 'scrub') propsRef.current.onScrubPreview?.(undefined);
    },
    [],
  );

  const handleGrant = (event: TouchPointEvent): void => {
    const p = propsRef.current;
    p.onTouchActivity();
    const pt = readPoint(event);
    if (pt === null) return;
    const { width, height } = layoutRef.current;
    const edgeExcluded = isInEdgeExclusionZone(pt.x, pt.y, width, height);
    gestureRef.current = {
      startX: pt.x,
      startY: pt.y,
      startVolume: clampVol(p.volume),
      startBrightness: clamp01(p.brightness),
      kind: edgeExcluded ? 'edge-excluded' : 'none',
      lastScrubDeltaMs: 0,
      holdActive: false,
    };
    if (edgeExcluded) return;
    stopHoldTimer();
    if (p.isVod && p.onHoldSpeedStart !== undefined) {
      holdTimerRef.current = setTimeout(() => {
        holdTimerRef.current = null;
        const g = gestureRef.current;
        if (g === null || g.kind !== 'none') return;
        stopTapTimer();
        lastTapRef.current = null;
        g.holdActive = true;
        setHoldSpeedActive(true);
        propsRef.current.onHoldSpeedStart?.();
      }, HOLD_SPEED_DELAY_MS);
    }
  };

  const handleMove = (event: TouchPointEvent): void => {
    const g = gestureRef.current;
    if (g === null || g.kind === 'edge-excluded' || g.holdActive) return;
    const pt = readPoint(event);
    if (pt === null) return;
    const dx = pt.x - g.startX;
    const dy = pt.y - g.startY;
    if (Math.hypot(dx, dy) > HOLD_MOVE_SLOP_PX) stopHoldTimer();

    const p = propsRef.current;
    const { width, height } = layoutRef.current;
    if (g.kind === 'none') {
      const classified = classifyTouchGesture({
        startX: g.startX,
        startY: g.startY,
        dx,
        dy,
        width,
        height,
        isVod: p.isVod,
      });
      if (classified === 'none' || classified === 'edge-excluded') return;
      g.kind = classified;
      stopTapTimer();
      lastTapRef.current = null;
    }

    const span = Math.max(160, height * 0.6);
    if (g.kind === 'brightness') {
      const next = clamp01(g.startBrightness - dy / span);
      p.onBrightnessChange(next);
      setFeedbackText(`${p.i18n.t('player.brightness')} ${Math.round(next * 100)}%`);
    } else if (g.kind === 'volume') {
      const next = clampVol(g.startVolume - (dy / span) * 100);
      p.onVolumeChange(next);
      setFeedbackText(`${p.i18n.t('player.volume')} ${next}%`);
    } else if (g.kind === 'scrub') {
      const deltaMs = computeScrubDeltaMs(dx, width, p.positionMs, p.durationMs);
      g.lastScrubDeltaMs = deltaMs;
      p.onScrubPreview?.(deltaMs);
      setFeedbackText(formatScrubDelta(deltaMs));
    }
  };

  const handleRelease = (): void => {
    stopHoldTimer();
    const g = gestureRef.current;
    gestureRef.current = null;
    setFeedbackText(null);
    if (g === null || g.kind === 'edge-excluded') return;

    const p = propsRef.current;
    if (g.holdActive) {
      setHoldSpeedActive(false);
      p.onHoldSpeedEnd?.();
      return;
    }
    if (g.kind === 'scrub') {
      p.onScrubPreview?.(undefined);
      p.onScrubCommit?.(g.lastScrubDeltaMs);
      return;
    }
    if (g.kind === 'brightness' || g.kind === 'volume') return;

    const side =
      p.isVod && p.onDoubleTapSeek !== undefined
        ? classifyDoubleTapSide(g.startX, layoutRef.current.width)
        : 0;
    if (side === 0) {
      stopTapTimer();
      lastTapRef.current = null;
      p.onSingleTap();
      return;
    }

    const now = Date.now();
    const prev = lastTapRef.current;
    if (prev !== null && prev.side === side && now - prev.atMs <= DOUBLE_TAP_WINDOW_MS) {
      stopTapTimer();
      lastTapRef.current = null;
      p.onDoubleTapSeek?.(side * DOUBLE_TAP_SEEK_MS);
      return;
    }
    lastTapRef.current = { atMs: now, side };
    stopTapTimer();
    singleTapTimerRef.current = setTimeout(() => {
      singleTapTimerRef.current = null;
      lastTapRef.current = null;
      propsRef.current.onSingleTap();
    }, DOUBLE_TAP_WINDOW_MS);
  };

  const handleTerminate = (): void => {
    stopHoldTimer();
    const g = gestureRef.current;
    gestureRef.current = null;
    setFeedbackText(null);
    if (g?.holdActive) {
      setHoldSpeedActive(false);
      propsRef.current.onHoldSpeedEnd?.();
    }
    if (g?.kind === 'scrub') propsRef.current.onScrubPreview?.(undefined);
  };

  const dimOpacity = Math.max(0, Math.min(0.7, (1 - clamp01(props.brightness)) * 0.7));

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <View
        testID="player-brightness-dim-overlay"
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: theme.colors.bgCanvas, opacity: dimOpacity },
        ]}
      />
      <View
        testID="player-touch-gestures"
        style={StyleSheet.absoluteFill}
        onLayout={(e) => {
          layoutRef.current = {
            width: e.nativeEvent.layout.width,
            height: e.nativeEvent.layout.height,
          };
        }}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        onResponderGrant={handleGrant}
        onResponderMove={handleMove}
        onResponderRelease={handleRelease}
        onResponderTerminate={handleTerminate}
      />
      {holdSpeedActive ? (
        <View pointerEvents="none" style={styles.holdPillWrap}>
          <View
            testID="player-touch-hold-speed-pill"
            style={[
              styles.holdPill,
              {
                backgroundColor: theme.colors.glassBg,
                borderColor: theme.colors.glassBorder,
                borderRadius: theme.radius.pill,
              },
              webBackdropBlur(16),
            ]}
          >
            <Text
              style={[
                theme.typography.caption,
                TABULAR_NUMS_STYLE,
                styles.pillText,
                { color: theme.colors.textPrimary },
              ]}
            >
              {props.i18n.t('player.holdSpeedActive')}
            </Text>
          </View>
        </View>
      ) : null}
      {feedbackText !== null ? (
        <View pointerEvents="none" style={styles.feedbackWrap}>
          <View
            testID="player-touch-feedback-pill"
            style={[
              styles.feedbackPill,
              {
                backgroundColor: theme.colors.glassBg,
                borderColor: theme.colors.glassBorder,
                borderRadius: theme.radius.modal,
              },
              webBackdropBlur(16),
            ]}
          >
            <Text
              style={[
                theme.typography.title,
                TABULAR_NUMS_STYLE,
                styles.pillText,
                { color: theme.colors.textPrimary },
              ]}
            >
              {feedbackText}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  holdPillWrap: { position: 'absolute', top: 20, left: 0, right: 0, alignItems: 'center' },
  holdPill: { borderWidth: 1, paddingHorizontal: 14, paddingVertical: 6 },
  feedbackWrap: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  feedbackPill: { borderWidth: 1, paddingHorizontal: 18, paddingVertical: 10 },
  pillText: { fontWeight: '700' },
});
