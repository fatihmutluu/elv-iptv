import type { PlaybackTimers } from '@elv/playback';
import { type MutableRefObject, useCallback, useEffect, useReducer, useRef } from 'react';

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

/** Manages the bounded OSD auto-hide timeout with single-state atomic re-arming (`#277`). */
export function useOsdAutoHide(params: {
  readonly autoHideOsdMs: number | undefined;
  readonly active: boolean;
  readonly itemKey: string;
  readonly timersRef: MutableRefObject<PlaybackTimers>;
  readonly onAutoHide: () => void;
}): {
  readonly clearAutoHide: () => void;
  readonly notifyOsdActivity: () => void;
} {
  const { autoHideOsdMs, active, itemKey, timersRef, onAutoHide } = params;
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
    if (!state.armed || autoHideOsdMs === undefined || autoHideOsdMs <= 0 || !active) {
      return cancelPendingHandle;
    }
    autoHideHandleRef.current = timersRef.current.setTimeout(() => {
      autoHideHandleRef.current = undefined;
      onAutoHideRef.current();
    }, autoHideOsdMs);
    return cancelPendingHandle;
  }, [
    active,
    autoHideOsdMs,
    cancelPendingHandle,
    itemKey,
    state.armed,
    state.restartCounter,
    timersRef,
  ]);

  const clearAutoHide = useCallback((): void => {
    cancelPendingHandle();
    dispatch({ type: 'disarm' });
  }, [cancelPendingHandle]);

  const notifyOsdActivity = useCallback((): void => {
    dispatch({ type: 'restart' });
  }, []);

  return { clearAutoHide, notifyOsdActivity };
}
