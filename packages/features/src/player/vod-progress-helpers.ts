import { type ClockAnchor, positionAt } from '@elv/playback';
import { Platform } from 'react-native';
import {
  clampProgressRatio,
  formatPlaybackPosition,
  formatVodEndTimestamp,
  integrateFineScrubStep,
  type TouchScrubSensitivityTier,
} from './vod-progress-math';

export { formatPlaybackPosition, formatVodEndTimestamp, type TouchScrubSensitivityTier };

export interface ProgressSnapshot {
  readonly timeText: string;
  readonly currentText: string;
  readonly fillPercent: number;
  readonly positionMs: number;
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

export function readProgressSnapshot(
  anchor: ClockAnchor | undefined,
  nowMs: number,
): ProgressSnapshot {
  if (anchor === undefined) {
    return {
      timeText: '0:00 / --:--',
      currentText: '0:00',
      fillPercent: 0,
      positionMs: 0,
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
  const fillPercent = Math.round(clampProgressRatio(ratio) * 1000) / 10;
  const currentText = formatPlaybackPosition(clampedPos);
  const timeText = `${currentText} / ${hasDuration ? formatPlaybackPosition(durationMs) : '--:--'}`;
  return {
    timeText,
    currentText,
    fillPercent,
    positionMs: clampedPos,
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
    return clampProgressRatio((clientX - rect.left) / rect.width);
  }
  const x = event.nativeEvent?.locationX ?? event.nativeEvent?.offsetX;
  const width = layoutWidth > 0 ? layoutWidth : (target?.clientWidth ?? 0);
  if (typeof x !== 'number' || width <= 0) return undefined;
  return clampProgressRatio(x / width);
}

interface TouchResponderEvent {
  readonly nativeEvent?: {
    locationX?: number;
    locationY?: number;
    pageX?: number;
    pageY?: number;
  };
}

const ORIGIN_DEPART_RATIO = 0.02;
const ORIGIN_SNAP_TOLERANCE = 0.006;

/**
 * Creates native RN touch responder handlers for drag-scrubbing `VodProgressBar` with vertical
 * fine-scrubbing zoom tiers (`1×`, `0.25×`, `0.1×`, `#355`, `#440`).
 * Integrates incrementally so crossing vertical sensitivity boundaries never jumps the playhead.
 */
export function createTouchScrubResponder(hooks: {
  readonly canScrub: () => boolean;
  readonly getWidth: () => number;
  readonly onStart: (ratio: number) => void;
  readonly onMove: (ratio: number) => void;
  readonly onCommit: (ratio: number) => void;
  readonly onCancel: () => void;
  readonly onSensitivityChange?: (tier: TouchScrubSensitivityTier) => void;
  readonly onFineScrubHaptic?: (kind: 'tier' | 'origin') => void;
}) {
  let state: {
    startRatio: number;
    currentRatio: number;
    prevPageX: number | undefined;
    prevLocX: number | undefined;
    startPageY: number | undefined;
    tier: TouchScrubSensitivityTier;
    departedOrigin: boolean;
  } | null = null;

  const stepFromEvent = (evt: TouchResponderEvent): number | null => {
    if (state === null) return null;
    const width = hooks.getWidth();
    if (width <= 0) return state.currentRatio;

    const ne = evt?.nativeEvent;
    const pageX = ne?.pageX;
    const locX = ne?.locationX;
    const pageY = ne?.pageY ?? ne?.locationY;

    let dxDelta = 0;
    let axis: 'page' | 'loc' | 'none' = 'none';
    if (
      typeof pageX === 'number' &&
      Number.isFinite(pageX) &&
      state.prevPageX !== undefined &&
      Number.isFinite(state.prevPageX)
    ) {
      dxDelta = pageX - state.prevPageX;
      axis = 'page';
    } else if (
      typeof locX === 'number' &&
      Number.isFinite(locX) &&
      state.prevLocX !== undefined &&
      Number.isFinite(state.prevLocX)
    ) {
      dxDelta = locX - state.prevLocX;
      axis = 'loc';
    }

    const absDy =
      typeof pageY === 'number' &&
      Number.isFinite(pageY) &&
      state.startPageY !== undefined &&
      Number.isFinite(state.startPageY)
        ? Math.abs(pageY - state.startPageY)
        : 0;

    const prevRatio = state.currentRatio;
    const { nextRatio, tier } = integrateFineScrubStep({
      prevRatio,
      dxDelta,
      width,
      absDy,
    });

    // Always advance reference X to current pointer position since nextRatio is already clamped,
    // so reversing after overshooting 0% / 100% responds immediately with zero dead-zone debt.
    if (axis === 'page' && typeof pageX === 'number' && Number.isFinite(pageX)) {
      state.prevPageX = pageX;
    } else if (axis === 'loc' && typeof locX === 'number' && Number.isFinite(locX)) {
      state.prevLocX = locX;
    }

    if (tier !== state.tier) {
      state.tier = tier;
      hooks.onSensitivityChange?.(tier);
      hooks.onFineScrubHaptic?.('tier');
    }

    const distFromOrigin = Math.abs(nextRatio - state.startRatio);
    if (!state.departedOrigin && distFromOrigin >= ORIGIN_DEPART_RATIO) {
      state.departedOrigin = true;
    } else if (
      state.departedOrigin &&
      Math.abs(prevRatio - state.startRatio) > ORIGIN_SNAP_TOLERANCE &&
      distFromOrigin <= ORIGIN_SNAP_TOLERANCE
    ) {
      hooks.onFineScrubHaptic?.('origin');
    }

    state.currentRatio = nextRatio;
    return nextRatio;
  };

  return {
    panHandlers: {
      onStartShouldSetResponder: () => hooks.canScrub() && hooks.getWidth() > 0,
      onMoveShouldSetResponder: () => hooks.canScrub() && hooks.getWidth() > 0,
      onResponderTerminationRequest: () => false,
      onResponderGrant: (evt: TouchResponderEvent) => {
        const width = hooks.getWidth();
        if (!hooks.canScrub() || width <= 0) return;
        const ne = evt?.nativeEvent;
        const locX = ne?.locationX;
        if (typeof locX !== 'number' || !Number.isFinite(locX)) return;
        const initial = clampProgressRatio(locX / width);
        state = {
          startRatio: initial,
          currentRatio: initial,
          prevPageX: ne?.pageX,
          prevLocX: locX,
          startPageY: ne?.pageY ?? ne?.locationY,
          tier: 'normal',
          departedOrigin: false,
        };
        hooks.onSensitivityChange?.('normal');
        hooks.onStart(initial);
      },
      onResponderMove: (evt: TouchResponderEvent) => {
        const next = stepFromEvent(evt);
        if (next !== null) hooks.onMove(next);
      },
      onResponderRelease: (evt: TouchResponderEvent) => {
        const finalRatio = stepFromEvent(evt);
        state = null;
        hooks.onSensitivityChange?.('normal');
        if (finalRatio !== null) hooks.onCommit(finalRatio);
        else hooks.onCancel();
      },
      onResponderTerminate: () => {
        const hadActive = state !== null;
        state = null;
        if (hadActive) {
          hooks.onSensitivityChange?.('normal');
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
      ? clampProgressRatio((clientX - rect.left) / rect.width)
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
