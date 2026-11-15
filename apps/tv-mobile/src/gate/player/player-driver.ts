/** Options of {@link createZapDriver}. */
export interface ZapDriverOptions {
  /** Number of channels to cycle through. */
  channels: number;
  /** Zaps after the first tune. */
  zaps: number;
  /** Zaps per second. */
  rate: number;
  /** Runs `fn` once after about `ms` milliseconds. */
  schedule: (fn: () => void, ms: number) => void;
}

/** Zaps through a channel list on a timer. */
export interface ZapDriver {
  /** Tunes channel 0 at once, then zaps; resolves after the last zap is dispatched, or when stopped. */
  start(): Promise<void>;
  /** Dispatches nothing more and resolves `start()`. */
  stop(): void;
}

/**
 * Creates a driver that dispatches the first tune (`zap` false) and then `zaps` zaps at `rate` per second, cycling
 * through the channels in order (zap `i` goes to channel `i mod channels`). Nothing is dispatched after `stop()`.
 */
export function createZapDriver(
  dispatch: (index: number, zap: boolean) => void,
  opts: ZapDriverOptions,
): ZapDriver {
  const interval = 1000 / opts.rate;
  let stopped = false;
  let finish: (() => void) | undefined;
  return {
    start() {
      return new Promise<void>((resolve) => {
        finish = resolve;
        let zap = 0;
        dispatch(0, false);
        const step = (): void => {
          if (stopped) return;
          zap += 1;
          dispatch(zap % opts.channels, true);
          if (zap >= opts.zaps) {
            stopped = true;
            resolve();
            return;
          }
          opts.schedule(step, interval);
        };
        opts.schedule(step, interval);
      });
    },
    stop() {
      stopped = true;
      finish?.();
    },
  };
}
