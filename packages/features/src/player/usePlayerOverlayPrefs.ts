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
  onSetDeinterlace?: ((enabled: boolean) => void) | undefined;
  onSetOrientationLocked?: ((locked: boolean) => void) | undefined;
}) {
  const { itemKey, hasService, defaultResizeMode, onSetDeinterlace, onSetOrientationLocked } =
    params;
  const [resizeMode, setResizeMode] = useState<VideoResizeMode>(() => defaultResizeMode ?? 'fit');
  const [deinterlace, setDeinterlace] = useState(false);
  const [statsVisible, setStatsVisible] = useState(false);

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset deinterlace UI state on item change to mirror mpv --reset-on-next-file
  useEffect(() => {
    deinterlaceRef.current = false;
    setDeinterlace(false);
  }, [itemKey]);

  const toggleResizeMode = (): void =>
    setResizeMode((prev) => (prev === 'fit' ? 'fill' : prev === 'fill' ? 'stretch' : 'fit'));
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
      toggleResizeMode,
      toggleDeinterlace,
      toggleStats,
    },
    acquireOrientationLock,
    releaseOrientationLock,
  };
}
