import {
  type ClockAnchor,
  type PlaybackClock,
  type PlaybackService,
  positionAt,
} from '@elv/playback';
import { TABULAR_NUMS_STYLE, useTheme, webCursorPointer, webTransition } from '@elv/ui-kit';
import { type ReactElement, useRef } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { usePlaybackTicker } from './usePlaybackTicker';

/** Formats a millisecond playback timestamp as `m:ss` or `h:mm:ss`. */
export function formatPlaybackPosition(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms / 1000));
  const seconds = String(clamped % 60).padStart(2, '0');
  const minutes = Math.floor(clamped / 60);
  if (minutes < 60) return `${minutes}:${seconds}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`;
}

/** Props of {@link VodProgressBar}. */
export interface VodProgressBarProps {
  readonly service: PlaybackService | null;
  readonly clock: PlaybackClock;
  readonly isTv: boolean;
  readonly tvFocused?: boolean;
  readonly label: string;
  readonly previewPositionMs?: number | undefined;
  readonly dimmed?: boolean;
  readonly onSeekRatio: (ratio: number) => void;
}

interface ProgressSnapshot {
  readonly timeText: string;
  readonly fillPercent: number;
  readonly positionSec: number;
  readonly durationSec: number;
  readonly durationMs: number | undefined;
  readonly hasDuration: boolean;
}

function readSnapshot(anchor: ClockAnchor | undefined, nowMs: number): ProgressSnapshot {
  if (anchor === undefined) {
    return {
      timeText: '0:00 / --:--',
      fillPercent: 0,
      positionSec: 0,
      durationSec: 0,
      durationMs: undefined,
      hasDuration: false,
    };
  }
  const rawPos = positionAt(anchor, nowMs);
  const durationMs = anchor.durationMs;
  const hasDuration = durationMs !== undefined && Number.isFinite(durationMs) && durationMs > 0;
  const clampedPos = hasDuration ? Math.min(Math.max(0, rawPos), durationMs) : Math.max(0, rawPos);
  const ratio = hasDuration ? clampedPos / durationMs : 0;
  const fillPercent = Math.round(Math.max(0, Math.min(1, ratio)) * 1000) / 10;
  const timeText = `${formatPlaybackPosition(clampedPos)} / ${
    hasDuration ? formatPlaybackPosition(durationMs) : '--:--'
  }`;
  return {
    timeText,
    fillPercent,
    positionSec: Math.floor(clampedPos / 1000),
    durationSec: hasDuration ? Math.floor(durationMs / 1000) : 0,
    durationMs: hasDuration ? durationMs : undefined,
    hasDuration,
  };
}

function sameSnapshot(a: ProgressSnapshot, b: ProgressSnapshot): boolean {
  return a.timeText === b.timeText && a.fillPercent === b.fillPercent;
}

function previewSnapshot(live: ProgressSnapshot, previewPositionMs: number): ProgressSnapshot {
  return readSnapshot(
    {
      positionMs: previewPositionMs,
      atMs: 0,
      rate: 0,
      ...(live.durationMs === undefined ? {} : { durationMs: live.durationMs }),
    },
    0,
  );
}

interface PressGeometry {
  readonly nativeEvent: { locationX?: number; offsetX?: number; clientX?: number };
  readonly currentTarget: {
    blur?: () => void;
    clientWidth?: number;
    getBoundingClientRect?: () => { left: number; width: number };
  } | null;
}

function pressRatio(event: PressGeometry, layoutWidth: number): number | undefined {
  const target = event.currentTarget;
  if ((Platform.OS as string) === 'web') {
    target?.blur?.();
    const rect = target?.getBoundingClientRect?.();
    const clientX = event.nativeEvent.clientX;
    if (rect !== undefined && typeof clientX === 'number' && rect.width > 0) {
      return (clientX - rect.left) / rect.width;
    }
  }
  const x = event.nativeEvent.locationX ?? event.nativeEvent.offsetX;
  const width = layoutWidth > 0 ? layoutWidth : (target?.clientWidth ?? 0);
  if (typeof x !== 'number' || width <= 0) return undefined;
  return x / width;
}

/**
 * Leaf VOD progress bar that extrapolates elapsed time and fill ratio from `ClockAnchor` on a gated
 * ticker (no frames while paused or before an anchor), shows a pending scrub preview when given,
 * and supports touch/mouse seek presses with live Cinema Quietude theme tokens.
 */
export function VodProgressBar({
  service,
  clock,
  isTv,
  tvFocused = false,
  label,
  previewPositionMs,
  dimmed = false,
  onSeekRatio,
}: VodProgressBarProps): ReactElement {
  const theme = useTheme();
  const live = usePlaybackTicker({
    service,
    clock,
    mode: 'frame',
    derive: readSnapshot,
    isEqual: sameSnapshot,
  });
  const snapshot =
    previewPositionMs === undefined ? live : previewSnapshot(live, previewPositionMs);
  const widthRef = useRef(0);

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
          const ratio = pressRatio(event as unknown as PressGeometry, widthRef.current);
          if (!live.hasDuration || ratio === undefined || !Number.isFinite(ratio)) return;
          onSeekRatio(Math.max(0, Math.min(1, ratio)));
        }}
        style={[styles.trackHitBox, !isTv ? webCursorPointer() : undefined]}
      >
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
              backgroundColor: theme.colors.bgCard,
              borderColor: theme.colors.surfaceBorder,
            },
          ]}
        >
          <View
            testID="player-progress-fill"
            style={[
              styles.trackFill,
              {
                width: `${snapshot.fillPercent}%`,
                backgroundColor: theme.colors.accent,
              },
            ]}
          />
        </View>
        <View
          testID="player-progress-thumb"
          pointerEvents="none"
          style={[
            styles.trackThumb,
            tvFocused ? styles.trackThumbFocused : null,
            {
              left: `${snapshot.fillPercent}%`,
              backgroundColor: theme.colors.textPrimary,
              borderColor: theme.colors.bgCanvas,
              opacity: snapshot.hasDuration ? 1 : 0.45,
            },
            webTransition(theme, 'transform, opacity', theme.motion.fastMs),
          ]}
        />
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  trackHitBox: {
    position: 'relative',
    flex: 1,
    paddingVertical: 10,
    justifyContent: 'center',
  },
  focusRing: {
    position: 'absolute',
    left: -4,
    right: -4,
    top: 3,
    bottom: 3,
  },
  trackRail: {
    height: 5,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  trackFill: {
    height: '100%',
  },
  trackThumb: {
    position: 'absolute',
    width: 12,
    height: 12,
    marginLeft: -6,
    borderRadius: 6,
    borderWidth: 1.5,
  },
  trackThumbFocused: {
    width: 18,
    height: 18,
    marginLeft: -9,
    borderRadius: 9,
    borderWidth: 2,
  },
  timeText: {
    fontWeight: '600',
  },
});
