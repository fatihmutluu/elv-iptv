import type { SleepTimerAction } from '@elv/domain';
import type { PlaybackClock, PlaybackTimers } from '@elv/playback';
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import {
  createSleepTimerController,
  type SleepTimerController,
  type SleepTimerSnapshot,
} from './sleep-timer';

/** Hook wiring {@link createSleepTimerController} into `PlayerScreen` (`#118`). */
export function useSleepTimer(params: {
  readonly defaultAction: SleepTimerAction;
  readonly clockRef: MutableRefObject<PlaybackClock>;
  readonly timersRef: MutableRefObject<PlaybackTimers>;
  readonly onExpire: (action: SleepTimerAction) => void;
  readonly onPersistAction?: ((action: SleepTimerAction) => void) | undefined;
}) {
  const { defaultAction, clockRef, timersRef, onExpire, onPersistAction } = params;
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;
  const onPersistActionRef = useRef(onPersistAction);
  onPersistActionRef.current = onPersistAction;

  const [snapshot, setSnapshot] = useState<SleepTimerSnapshot>({
    active: false,
    totalMinutes: 0,
    remainingMinutes: 0,
    remainingMs: 0,
    action: defaultAction,
  });

  const defaultActionRef = useRef(defaultAction);
  defaultActionRef.current = defaultAction;

  const ctrlRef = useRef<SleepTimerController | null>(null);

  useEffect(() => {
    const ctrl = createSleepTimerController({
      clock: { now: () => clockRef.current.now() },
      timers: {
        setTimeout: (fn, ms) => timersRef.current.setTimeout(fn, ms),
        clearTimeout: (h) => timersRef.current.clearTimeout(h),
      },
      initialAction: defaultActionRef.current,
      onExpire: (action) => onExpireRef.current(action),
      onChange: setSnapshot,
    });
    ctrlRef.current = ctrl;
    setSnapshot(ctrl.getState());
    return () => {
      ctrl.dispose();
      if (ctrlRef.current === ctrl) ctrlRef.current = null;
    };
  }, [clockRef, timersRef]);

  useEffect(() => {
    ctrlRef.current?.setAction(defaultAction);
  }, [defaultAction]);

  const selectMinutes = useCallback((minutes: number): void => {
    if (minutes <= 0) ctrlRef.current?.cancel();
    else ctrlRef.current?.start(minutes);
  }, []);

  const toggleAction = useCallback((): void => {
    const cur = ctrlRef.current?.getState().action ?? defaultAction;
    const next: SleepTimerAction = cur === 'stop' ? 'pause' : 'stop';
    ctrlRef.current?.setAction(next);
    onPersistActionRef.current?.(next);
  }, [defaultAction]);

  const cancel = useCallback((): void => {
    ctrlRef.current?.cancel();
  }, []);

  return {
    sleepTimer: snapshot,
    selectMinutes,
    toggleAction,
    cancel,
  };
}
