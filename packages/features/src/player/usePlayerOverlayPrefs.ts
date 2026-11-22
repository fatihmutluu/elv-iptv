import type { DefaultResizeModePref } from '@elv/domain';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { VideoResizeMode } from '../ports/video-host';

/**
 * Owns session-scoped player settings toggles (`resizeMode`, `statsVisible`), opt-in per-stream
 * `deinterlace` (reset on `itemKey` change to mirror mpv `--reset-on-next-file`), and native
 * orientation lock lifecycle.
 */
export function usePlayerOverlayPrefs(params: {
  itemKey: string;
  hasService: boolean;
  defaultResizeMode?: DefaultResizeModePref | undefined;
  onResizeModeChange?: ((mode: VideoResizeMode) => void) | undefined;
  onSetDeinterlace?: ((enabled: boolean) => void) | undefined;
  onSetOrientationLocked?: ((locked: boolean) => void) | undefined;
}) {
  const {
    itemKey,
    hasService,
    defaultResizeMode,
    onResizeModeChange,
    onSetDeinterlace,
    onSetOrientationLocked,
  } = params;
  const [resizeMode, setResizeModeState] = useState<VideoResizeMode>(
    () => defaultResizeMode ?? 'fit',
  );
  const [deinterlace, setDeinterlace] = useState(false);
  const [statsVisible, setStatsVisible] = useState(false);

  const defaultResizeModeRef = useRef<VideoResizeMode>(defaultResizeMode ?? 'fit');
  defaultResizeModeRef.current = defaultResizeMode ?? 'fit';
  const resizeModeRef = useRef(resizeMode);
  resizeModeRef.current = resizeMode;
  const onResizeModeChangeRef = useRef(onResizeModeChange);
  onResizeModeChangeRef.current = onResizeModeChange;
  const onSetDeinterlaceRef = useRef(onSetDeinterlace);
  onSetDeinterlaceRef.current = onSetDeinterlace;
  const deinterlaceRef = useRef(false);
  const onSetOrientationLockedRef = useRef(onSetOrientationLocked);
  onSetOrientationLockedRef.current = onSetOrientationLocked;
  const orientationLockedRef = useRef(false);

  const acquireOrientationLock = useCallback((): void => {
    orientationLockedRef.current = true;
    onSetOrientationLockedRef.current?.(true);
  }, []);

  const releaseOrientationLock = useCallback((): void => {
    if (!orientationLockedRef.current) return;
    orientationLockedRef.current = false;
    onSetOrientationLockedRef.current?.(false);
  }, []);

  useEffect(() => releaseOrientationLock, [releaseOrientationLock]);

  useEffect(() => {
    if (!hasService && deinterlaceRef.current) {
      deinterlaceRef.current = false;
      setDeinterlace(false);
    }
  }, [hasService]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset deinterlace & resizeMode UI state on item change so per-item resizeMode never bleeds across items
  useEffect(() => {
    deinterlaceRef.current = false;
    setDeinterlace(false);
    const fallback = defaultResizeModeRef.current;
    resizeModeRef.current = fallback;
    setResizeModeState(fallback);
  }, [itemKey]);

  const setResizeMode = useCallback((next: VideoResizeMode, notify = false): void => {
    resizeModeRef.current = next;
    setResizeModeState(next);
    if (notify) onResizeModeChangeRef.current?.(next);
  }, []);

  const toggleResizeMode = (): void => {
    const prev = resizeModeRef.current;
    const next: VideoResizeMode = prev === 'fit' ? 'fill' : prev === 'fill' ? 'stretch' : 'fit';
    resizeModeRef.current = next;
    setResizeModeState(next);
    onResizeModeChangeRef.current?.(next);
  };
  const toggleDeinterlace = (): void => {
    if (onSetDeinterlaceRef.current === undefined) return;
    const next = !deinterlaceRef.current;
    deinterlaceRef.current = next;
    setDeinterlace(next);
    onSetDeinterlaceRef.current(next);
  };
  const toggleStats = (): void => setStatsVisible((prev) => !prev);

  return {
    publicPrefs: {
      resizeMode,
      deinterlace,
      statsVisible,
      setResizeMode,
      toggleResizeMode,
      toggleDeinterlace,
      toggleStats,
    },
    acquireOrientationLock,
    releaseOrientationLock,
  };
}
