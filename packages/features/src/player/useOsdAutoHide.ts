import type { PlaybackTimers } from '@elv/playback';
import { type MutableRefObject, useCallback, useEffect, useReducer, useRef } from 'react';
import { type OsdTier, PROGRESS_OSD_AUTO_HIDE_MS } from './player-overlay-model';

/** Single atomic state governing OSD auto-hide timer arming and restarts (`#277`). */
export interface OsdAutoHideState {
  readonly armed: boolean;
  readonly restartCounter: number;
}

/** Reducer action for {@link osdAutoHideReducer}. */
export type OsdAutoHideAction =
  | { readonly type: 'arm' }
  | { readonly type: 'restart' }
  | { readonly type: 'disarm' };

/** Initial armed state for {@link useOsdAutoHide}. */
export function initialOsdAutoHideState(): OsdAutoHideState {
  return { armed: true, restartCounter: 0 };
}

/** Pure atomic transition function preventing split-effect auto-hide races (`#277`). */
export function osdAutoHideReducer(
  state: OsdAutoHideState,
  action: OsdAutoHideAction,
): OsdAutoHideState {
  switch (action.type) {
    case 'arm':
    case 'restart':
      return { armed: true, restartCounter: state.restartCounter + 1 };
    case 'disarm':
      return state.armed ? { armed: false, restartCounter: state.restartCounter } : state;
  }
}

/**
 * Resolves the effective auto-hide delay for the active {@link OsdTier} (`#391`):
 * - `'hidden'`: `undefined` (disarmed).
 * - `'progress'`: `Math.min(PROGRESS_OSD_AUTO_HIDE_MS, autoHideOsdMs ?? PROGRESS_OSD_AUTO_HIDE_MS)` unless explicitly disabled (`<= 0`).
 * - `'controls'` (or omitted): `autoHideOsdMs` when positive, else `undefined`.
 */
export function resolveOsdAutoHideDelayMs(
  osdTier: OsdTier | undefined,
  autoHideOsdMs: number | undefined,
): number | undefined {
  if (osdTier === 'hidden') return undefined;
  if (osdTier === 'progress') {
    if (autoHideOsdMs !== undefined && autoHideOsdMs <= 0) return undefined;
    return Math.min(PROGRESS_OSD_AUTO_HIDE_MS, autoHideOsdMs ?? PROGRESS_OSD_AUTO_HIDE_MS);
  }
  if (autoHideOsdMs === undefined || autoHideOsdMs <= 0) return undefined;
  return autoHideOsdMs;
}

/** Manages the bounded tier-aware OSD auto-hide timeout with single-state atomic re-arming (`#277`, `#391`). */
export function useOsdAutoHide(params: {
  readonly autoHideOsdMs: number | undefined;
  readonly osdTier?: OsdTier;
  readonly active: boolean;
  readonly itemKey: string;
  readonly timersRef: MutableRefObject<PlaybackTimers>;
  readonly onAutoHide: () => void;
}): {
  readonly clearAutoHide: () => void;
  readonly notifyOsdActivity: () => void;
} {
  const { autoHideOsdMs, osdTier, active, itemKey, timersRef, onAutoHide } = params;
  const delayMs = resolveOsdAutoHideDelayMs(osdTier, autoHideOsdMs);
  const [state, dispatch] = useReducer(osdAutoHideReducer, undefined, initialOsdAutoHideState);
  const autoHideHandleRef = useRef<unknown>(undefined);
  const onAutoHideRef = useRef(onAutoHide);
  onAutoHideRef.current = onAutoHide;

  const cancelPendingHandle = useCallback(() => {
    if (autoHideHandleRef.current !== undefined) {
      timersRef.current.clearTimeout(autoHideHandleRef.current);
      autoHideHandleRef.current = undefined;
    }
  }, [timersRef]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: restartCounter and itemKey intentionally re-arm the single timer
  useEffect(() => {
    cancelPendingHandle();
    if (!state.armed || delayMs === undefined || delayMs <= 0 || !active) {
      return cancelPendingHandle;
    }
    autoHideHandleRef.current = timersRef.current.setTimeout(() => {
      autoHideHandleRef.current = undefined;
      onAutoHideRef.current();
    }, delayMs);
    return cancelPendingHandle;
  }, [active, cancelPendingHandle, delayMs, itemKey, state.armed, state.restartCounter, timersRef]);

  const clearAutoHide = useCallback((): void => {
    cancelPendingHandle();
    dispatch({ type: 'disarm' });
  }, [cancelPendingHandle]);

  const notifyOsdActivity = useCallback((): void => {
    dispatch({ type: 'restart' });
  }, []);

  return { clearAutoHide, notifyOsdActivity };
}
