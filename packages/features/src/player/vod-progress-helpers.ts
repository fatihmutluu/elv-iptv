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

function clampRatio(value: number): number {
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

/** Resolves a clamped `[0, 1]` drag ratio for a native touch responder event (`#440`). */
function resolveTouchDragRatio(params: {
  readonly startRatio: number;
  readonly startPageX: number | undefined;
  readonly width: number;
  readonly gestureDx: number | undefined;
  readonly nativeEvent?: { locationX?: number; pageX?: number } | undefined;
}): number {
  const { startRatio, startPageX, width, gestureDx, nativeEvent } = params;
  if (width <= 0) return startRatio;
  if (typeof gestureDx === 'number' && Number.isFinite(gestureDx) && gestureDx !== 0) {
    return clampRatio(startRatio + gestureDx / width);
  }
  const pageX = nativeEvent?.pageX;
  if (
    typeof pageX === 'number' &&
    Number.isFinite(pageX) &&
    typeof startPageX === 'number' &&
    Number.isFinite(startPageX)
  ) {
    return clampRatio(startRatio + (pageX - startPageX) / width);
  }
  const locX = nativeEvent?.locationX;
  if (typeof locX === 'number' && Number.isFinite(locX)) {
    return clampRatio(locX / width);
  }
  return startRatio;
}

interface TouchResponderEvent {
  readonly nativeEvent?: { locationX?: number; pageX?: number };
}

/** Creates native RN touch responder handlers for drag-scrubbing `VodProgressBar` (`#440`). */
export function createTouchScrubResponder(hooks: {
  readonly canScrub: () => boolean;
  readonly getWidth: () => number;
  readonly onStart: (ratio: number) => void;
  readonly onMove: (ratio: number) => void;
  readonly onCommit: (ratio: number) => void;
  readonly onCancel: () => void;
}) {
  let start: { ratio: number; pageX: number | undefined } | null = null;
  let lastRatio: number | null = null;
  return {
    panHandlers: {
      onStartShouldSetResponder: () => hooks.canScrub() && hooks.getWidth() > 0,
      onMoveShouldSetResponder: () => hooks.canScrub() && hooks.getWidth() > 0,
      onResponderTerminationRequest: () => false,
      onResponderGrant: (evt: TouchResponderEvent) => {
        const width = hooks.getWidth();
        if (!hooks.canScrub() || width <= 0) return;
        const locX = evt?.nativeEvent?.locationX;
        if (typeof locX !== 'number' || !Number.isFinite(locX)) return;
        const initial = clampRatio(locX / width);
        start = { ratio: initial, pageX: evt.nativeEvent?.pageX };
        lastRatio = initial;
        hooks.onStart(initial);
      },
      onResponderMove: (evt: TouchResponderEvent) => {
        if (start === null) return;
        const next = resolveTouchDragRatio({
          startRatio: start.ratio,
          startPageX: start.pageX,
          width: hooks.getWidth(),
          gestureDx: undefined,
          nativeEvent: evt?.nativeEvent,
        });
        lastRatio = next;
        hooks.onMove(next);
      },
      onResponderRelease: (evt: TouchResponderEvent) => {
        const curStart = start;
        const fallback = lastRatio;
        start = null;
        lastRatio = null;
        const finalRatio =
          curStart !== null
            ? resolveTouchDragRatio({
                startRatio: curStart.ratio,
                startPageX: curStart.pageX,
                width: hooks.getWidth(),
                gestureDx: undefined,
                nativeEvent: evt?.nativeEvent,
              })
            : fallback;
        if (finalRatio !== null) hooks.onCommit(finalRatio);
        else hooks.onCancel();
      },
      onResponderTerminate: () => {
        start = null;
        if (lastRatio !== null) {
          lastRatio = null;
          hooks.onCancel();
        }
      },
    },
  };
}

interface WebWindowLike {
  addEventListener?: (type: string, fn: (e: { clientX?: number }) => void) => void;
  removeEventListener?: (type: string, fn: (e: { clientX?: number }) => void) => void;
}

/** Attaches window-level web pointer drag listeners for `VodProgressBar`, returning a cleanup function. */
export function attachWebProgressDrag(params: {
  readonly rect: TrackRect;
  readonly initial: number;
  readonly getLastRatio: () => number | null;
  readonly onMove: (ratio: number) => void;
  readonly onCommit: (ratio: number) => void;
  readonly onCancel: () => void;
}): () => void {
  const { rect, initial, getLastRatio, onMove, onCommit, onCancel } = params;
  const win = (globalThis as unknown as { window?: WebWindowLike }).window;
  const ratioFromClientX = (clientX: number | undefined): number =>
    typeof clientX === 'number' && Number.isFinite(clientX) && rect.width > 0
      ? clampRatio((clientX - rect.left) / rect.width)
      : (getLastRatio() ?? initial);

  const handleMove = (e: { clientX?: number }): void => onMove(ratioFromClientX(e.clientX));
  const teardown = (): void => {
    win?.removeEventListener?.('pointermove', handleMove);
    win?.removeEventListener?.('pointerup', handleUp);
    win?.removeEventListener?.('pointercancel', handleCancel);
  };
  const handleUp = (e: { clientX?: number }): void => {
    teardown();
    onCommit(ratioFromClientX(e.clientX));
  };
  const handleCancel = (): void => {
    teardown();
    onCancel();
  };

  win?.addEventListener?.('pointermove', handleMove);
  win?.addEventListener?.('pointerup', handleUp);
  win?.addEventListener?.('pointercancel', handleCancel);
  return teardown;
}
