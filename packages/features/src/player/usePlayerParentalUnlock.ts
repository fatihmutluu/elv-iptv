import type { PlaybackStatus } from '@elv/playback';
import { useCallback, useEffect, useRef } from 'react';
import { useParental } from '../shared';

/** Returns true when a playback failure is caused by query-layer parental restrictions (`#31`). */
function isParentalLockedStatus(status: PlaybackStatus): boolean {
  return (
    status.kind === 'failed' &&
    status.error.category === 'auth' &&
    status.error.code === 'parental-locked'
  );
}

/**
 * Coordinates `auth/parental-locked` playback errors inside `PlayerScreen` (`#31`):
 * automatically opens `PinEntryOverlay` via {@link useParental} once per failure occurrence
 * and reloads the active stream immediately after a valid PIN unlock.
 */
export function usePlayerParentalUnlock(params: {
  readonly itemKey: string;
  readonly status: PlaybackStatus;
  readonly reloadActiveTarget: () => void;
  readonly fallbackRetry: () => void;
}): () => void {
  const { itemKey, status, reloadActiveTarget, fallbackRetry } = params;
  const { parentalUnlocked, requestParentalUnlock } = useParental();
  const promptedKeyRef = useRef<string | null>(null);
  const reloadRef = useRef(reloadActiveTarget);
  reloadRef.current = reloadActiveTarget;
  const locked = isParentalLockedStatus(status);

  useEffect(() => {
    if (!locked) {
      promptedKeyRef.current = null;
      return;
    }
    if (parentalUnlocked) {
      promptedKeyRef.current = null;
      reloadRef.current();
      return;
    }
    if (promptedKeyRef.current === itemKey) return;
    promptedKeyRef.current = itemKey;
    requestParentalUnlock(() => {
      reloadRef.current();
    });
  }, [itemKey, locked, parentalUnlocked, requestParentalUnlock]);

  return useCallback(() => {
    if (locked && !parentalUnlocked) {
      requestParentalUnlock(() => {
        reloadRef.current();
      });
      return;
    }
    fallbackRetry();
  }, [fallbackRetry, locked, parentalUnlocked, requestParentalUnlock]);
}
