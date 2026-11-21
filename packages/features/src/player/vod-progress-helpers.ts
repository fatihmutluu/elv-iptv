import { type ClockAnchor, positionAt } from '@elv/playback';
import { Platform } from 'react-native';

/** Formats a millisecond playback timestamp as `m:ss` or `h:mm:ss`. */
export function formatPlaybackPosition(ms: number): string {
  if (!Number.isFinite(ms)) return '0:00';
  const clamped = Math.max(0, Math.floor(ms / 1000));
  const seconds = String(clamped % 60).padStart(2, '0');
  const minutes = Math.floor(clamped / 60);
  if (minutes < 60) return `${minutes}:${seconds}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`;
}

export interface ProgressSnapshot {
  readonly timeText: string;
  readonly fillPercent: number;
  readonly positionSec: number;
  readonly durationSec: number;
  readonly durationMs: number | undefined;
  readonly hasDuration: boolean;
}

export interface TrackRect {
  readonly left: number;
  readonly width: number;
}

export interface PressGeometry {
  readonly nativeEvent?: {
    locationX?: number;
    offsetX?: number;
    clientX?: number;
    button?: number;
  };
  readonly clientX?: number;
  readonly button?: number;
  readonly currentTarget?: {
    blur?: () => void;
    clientWidth?: number;
    getBoundingClientRect?: () => TrackRect;
  } | null;
}

export function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function readProgressSnapshot(
  anchor: ClockAnchor | undefined,
  nowMs: number,
): ProgressSnapshot {
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
  const fillPercent = Math.round(clampRatio(ratio) * 1000) / 10;
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

export function sameProgressSnapshot(a: ProgressSnapshot, b: ProgressSnapshot): boolean {
  return a.timeText === b.timeText && a.fillPercent === b.fillPercent;
}

export function previewProgressSnapshot(
  live: ProgressSnapshot,
  previewPositionMs: number,
): ProgressSnapshot {
  return readProgressSnapshot(
    {
      positionMs: previewPositionMs,
      atMs: 0,
      rate: 0,
      ...(live.durationMs === undefined ? {} : { durationMs: live.durationMs }),
    },
    0,
  );
}

export function readTrackRect(
  target: PressGeometry['currentTarget'],
  layoutWidth: number,
): TrackRect | null {
  const rect = target?.getBoundingClientRect?.();
  if (rect !== undefined && rect.width > 0) return rect;
  const width = layoutWidth > 0 ? layoutWidth : (target?.clientWidth ?? 0);
  return width > 0 ? { left: 0, width } : null;
}

export function readEventRatio(
  event: PressGeometry,
  layoutWidth: number,
  blurTarget: boolean,
): number | undefined {
  const target = event.currentTarget;
  if (blurTarget && (Platform.OS as string) === 'web') target?.blur?.();
  const clientX = event.nativeEvent?.clientX ?? event.clientX;
  const rect = target?.getBoundingClientRect?.();
  if (rect !== undefined && typeof clientX === 'number' && rect.width > 0) {
    return clampRatio((clientX - rect.left) / rect.width);
  }
  const x = event.nativeEvent?.locationX ?? event.nativeEvent?.offsetX;
  const width = layoutWidth > 0 ? layoutWidth : (target?.clientWidth ?? 0);
  if (typeof x !== 'number' || width <= 0) return undefined;
  return clampRatio(x / width);
}
