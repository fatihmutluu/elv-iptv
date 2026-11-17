import {
  type ClockAnchor,
  type PlaybackClock,
  type PlaybackService,
  positionAt,
} from '@elv/playback';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

/** Formats a millisecond playback timestamp as `m:ss` or `h:mm:ss`. */
export function formatPlaybackPosition(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms / 1000));
  const seconds = String(clamped % 60).padStart(2, '0');
  const minutes = Math.floor(clamped / 60);
  if (minutes < 60) return `${minutes}:${seconds}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`;
}

interface ProgressSnapshot {
  readonly timeText: string;
  readonly fillPercent: number;
  readonly positionSec: number;
  readonly durationSec: number;
  readonly hasDuration: boolean;
}

function readSnapshot(anchor: ClockAnchor | undefined, nowMs: number): ProgressSnapshot {
  if (anchor === undefined) {
    return {
      timeText: '0:00 / --:--',
      fillPercent: 0,
      positionSec: 0,
      durationSec: 0,
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
    hasDuration,
  };
}

function sameSnapshot(a: ProgressSnapshot, b: ProgressSnapshot): boolean {
  return a.timeText === b.timeText && a.fillPercent === b.fillPercent;
}

/**
 * Leaf VOD progress bar that extrapolates elapsed time and fill ratio directly from `ClockAnchor`
 * without frame-ticking `PlayerScreen`, and supports touch/mouse seek presses when laid out.
 */
export function VodProgressBar({
  service,
  clock,
  isTv,
  label,
  onSeekRatio,
}: {
  service: PlaybackService | null;
  clock: PlaybackClock;
  isTv: boolean;
  label: string;
  onSeekRatio: (ratio: number) => void;
}): ReactElement {
  const [snapshot, setSnapshot] = useState<ProgressSnapshot>(() =>
    readSnapshot(service?.getState().anchor, clock.now()),
  );
  const widthRef = useRef(0);

  useEffect(() => {
    const sync = (): void => {
      const next = readSnapshot(service?.getState().anchor, clock.now());
      setSnapshot((prev) => (sameSnapshot(prev, next) ? prev : next));
    };
    sync();
    if (service === null) return;

    const unsubscribe = service.subscribe(() => sync());
    let frame = 0;
    const tick = (): void => {
      sync();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      unsubscribe();
      cancelAnimationFrame(frame);
    };
  }, [clock, service]);

  return (
    <View style={styles.row}>
      <Pressable
        testID="player-progress-bar"
        {...(isTv ? { focusable: false } : {})}
        accessibilityRole="adjustable"
        accessibilityLabel={label}
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
          if ((Platform.OS as string) === 'web') {
            (event.currentTarget as unknown as { blur?: () => void })?.blur?.();
          }
          if (!snapshot.hasDuration) return;
          const native = event.nativeEvent as {
            locationX?: number;
            offsetX?: number;
          };
          const x = native.locationX ?? native.offsetX;
          const width =
            widthRef.current > 0
              ? widthRef.current
              : ((event.currentTarget as unknown as { clientWidth?: number })?.clientWidth ?? 0);
          if (typeof x !== 'number' || !Number.isFinite(x) || width <= 0) return;
          onSeekRatio(Math.max(0, Math.min(1, x / width)));
        }}
        style={styles.trackHitBox}
      >
        <View style={styles.trackRail}>
          <View
            testID="player-progress-fill"
            style={[styles.trackFill, { width: `${snapshot.fillPercent}%` }]}
          />
        </View>
      </Pressable>
      <Text testID="player-progress-time" style={styles.timeText}>
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
    flex: 1,
    paddingVertical: 6,
    justifyContent: 'center',
  },
  trackRail: {
    height: 6,
    borderRadius: 3,
    backgroundColor: '#2c2c38',
    overflow: 'hidden',
  },
  trackFill: {
    height: '100%',
    backgroundColor: '#f4f4f6',
  },
  timeText: {
    color: '#d4d7e0',
    fontSize: 13,
    fontWeight: '600',
  },
});
