import type { PlaybackClock, PlaybackStatus, PlaybackTimers } from '@elv/playback';
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import {
  createStillWatchingController,
  STILL_WATCHING_COUNTDOWN_SEC,
  type StillWatchingController,
  type StillWatchingSnapshot,
} from './still-watching';

/** Hook wiring {@link createStillWatchingController} into `PlayerScreen` (`#118`). */
export function useStillWatching(params: {
  readonly timeoutMin: number;
  readonly statusKind: PlaybackStatus['kind'];
  readonly clockRef: MutableRefObject<PlaybackClock>;
  readonly timersRef: MutableRefObject<PlaybackTimers>;
  readonly onStop: () => void;
}) {
  const { timeoutMin, statusKind, clockRef, timersRef, onStop } = params;
  const onStopRef = useRef(onStop);
  onStopRef.current = onStop;

  const [snapshot, setSnapshot] = useState<StillWatchingSnapshot>({
    promptVisible: false,
    remainingSeconds: STILL_WATCHING_COUNTDOWN_SEC,
  });

  const timeoutMinRef = useRef(timeoutMin);
  timeoutMinRef.current = timeoutMin;
  const statusKindRef = useRef(statusKind);
  statusKindRef.current = statusKind;

  const ctrlRef = useRef<StillWatchingController | null>(null);

  useEffect(() => {
    const ctrl = createStillWatchingController({
      clock: { now: () => clockRef.current.now() },
      timers: {
        setTimeout: (fn, ms) => timersRef.current.setTimeout(fn, ms),
        clearTimeout: (h) => timersRef.current.clearTimeout(h),
      },
      onStop: () => onStopRef.current(),
      onChange: setSnapshot,
    });
    ctrlRef.current = ctrl;
    ctrl.setState({ timeoutMin: timeoutMinRef.current, statusKind: statusKindRef.current });
    return () => {
      ctrl.dispose();
      if (ctrlRef.current === ctrl) ctrlRef.current = null;
    };
  }, [clockRef, timersRef]);

  useEffect(() => {
    ctrlRef.current?.setState({ timeoutMin, statusKind });
  }, [statusKind, timeoutMin]);

  const recordUserActivity = useCallback((): void => {
    ctrlRef.current?.recordUserActivity();
  }, []);

  const keepWatching = useCallback((): void => {
    ctrlRef.current?.keepWatching();
  }, []);

  const stopNow = useCallback((): void => {
    ctrlRef.current?.stopNow();
  }, []);

  return {
    promptVisible: snapshot.promptVisible,
    remainingSeconds: snapshot.remainingSeconds,
    recordUserActivity,
    keepWatching,
    stopNow,
  };
}
