import type { PlaybackTimers } from '@elv/playback';
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';

/** Manages the bounded OSD auto-hide timeout and activity re-arming for `usePlayerOverlayState`. */
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
  const [osdActivitySeq, setOsdActivitySeq] = useState(0);
  const autoHideHandleRef = useRef<unknown>(undefined);
  const onAutoHideRef = useRef(onAutoHide);
  onAutoHideRef.current = onAutoHide;

  const clearAutoHide = useCallback(() => {
    if (autoHideHandleRef.current !== undefined) {
      timersRef.current.clearTimeout(autoHideHandleRef.current);
      autoHideHandleRef.current = undefined;
    }
  }, [timersRef]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: osdActivitySeq and itemKey intentionally re-arm the auto-hide timer
  useEffect(() => {
    clearAutoHide();
    if (autoHideOsdMs === undefined || autoHideOsdMs <= 0 || !active) {
      return clearAutoHide;
    }
    autoHideHandleRef.current = timersRef.current.setTimeout(() => {
      autoHideHandleRef.current = undefined;
      onAutoHideRef.current();
    }, autoHideOsdMs);
    return clearAutoHide;
  }, [active, autoHideOsdMs, clearAutoHide, itemKey, osdActivitySeq, timersRef]);

  const notifyOsdActivity = useCallback((): void => {
    const wasArmed = autoHideHandleRef.current !== undefined;
    clearAutoHide();
    if (wasArmed) setOsdActivitySeq((n) => n + 1);
  }, [clearAutoHide]);

  return { clearAutoHide, notifyOsdActivity };
}
