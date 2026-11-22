import { useTvKeySource } from '@elv/ui-kit';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import {
  createOledScreensaverController,
  type OledScreensaverController,
  type OledScreensaverSnapshot,
} from './screensaver-controller';

const INITIAL_SNAPSHOT: OledScreensaverSnapshot = {
  active: false,
  wakeSuppressed: false,
  driftIndex: 0,
  xPct: 50,
  yPct: 45,
};

/**
 * Wires {@link createOledScreensaverController} into `AppShell` (`#160`), listening for TV remote
 * keys and desktop web keyboard/pointer activity to reset the idle timer.
 */
export function useOledScreensaver(params: {
  readonly timeoutMin: number;
  readonly isBlocked: boolean;
}) {
  const { timeoutMin, isBlocked } = params;
  const [state, setState] = useState<OledScreensaverSnapshot>(INITIAL_SNAPSHOT);

  const timeoutMinRef = useRef(timeoutMin);
  timeoutMinRef.current = timeoutMin;
  const isBlockedRef = useRef(isBlocked);
  isBlockedRef.current = isBlocked;

  const ctrlRef = useRef<OledScreensaverController | null>(null);

  useEffect(() => {
    const ctrl = createOledScreensaverController({
      clock: { now: () => performance.now() },
      timers: {
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      },
      onChange: setState,
    });
    ctrlRef.current = ctrl;
    ctrl.setConfig({ timeoutMin: timeoutMinRef.current, isBlocked: isBlockedRef.current });
    return () => {
      ctrl.dispose();
      if (ctrlRef.current === ctrl) ctrlRef.current = null;
    };
  }, []);

  useEffect(() => {
    ctrlRef.current?.setConfig({ timeoutMin, isBlocked });
  }, [isBlocked, timeoutMin]);

  const recordActivity = useCallback((): boolean => {
    return ctrlRef.current?.recordActivity() ?? false;
  }, []);

  const wake = useCallback((): void => {
    ctrlRef.current?.recordActivity();
  }, []);

  // Reset idle timer on TV remote key presses without consuming keys while inactive
  useTvKeySource(() => {
    if (timeoutMin <= 0) return false;
    return ctrlRef.current?.recordActivity() ?? false;
  });

  // Reset idle timer on desktop web pointer/key events while screensaver is armed
  useEffect(() => {
    if (timeoutMin <= 0 || (Platform.OS as string) !== 'web') return;
    const win = (
      globalThis as {
        window?: {
          addEventListener?: (
            t: string,
            fn: () => void,
            opts?: boolean | { passive?: boolean },
          ) => void;
          removeEventListener?: (
            t: string,
            fn: () => void,
            opts?: boolean | { passive?: boolean },
          ) => void;
        };
      }
    ).window;
    if (!win?.addEventListener || !win.removeEventListener) return;
    const onActivity = (): void => {
      ctrlRef.current?.recordActivity();
    };
    win.addEventListener('pointerdown', onActivity, { passive: true });
    win.addEventListener('pointermove', onActivity, { passive: true });
    win.addEventListener('keydown', onActivity, { passive: true });
    return () => {
      win.removeEventListener?.('pointerdown', onActivity);
      win.removeEventListener?.('pointermove', onActivity);
      win.removeEventListener?.('keydown', onActivity);
    };
  }, [timeoutMin]);

  return {
    state,
    recordActivity,
    wake,
  };
}
