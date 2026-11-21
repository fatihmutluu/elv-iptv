/** Delay before a continuously held repeatable key begins auto-repeating. */
export const LONG_HOLD_MS = 350;

/** Minimum interval between auto-repeated key events after `LONG_HOLD_MS`. */
export const AUTOREPEAT_MS = 160;

const DEFAULT_IDLE_RESET_MS = 600;

const DEFAULT_REPEATABLE_KEYS: ReadonlySet<string> = new Set([
  'channel-up',
  'channel-down',
  'seek-back',
  'seek-forward',
  'seek-coarse-back',
  'seek-coarse-forward',
]);

/** Options for {@link createInputRepeatGate}. */
export interface InputRepeatGateOptions {
  now(): number;
  longHoldMs?: number;
  repeatIntervalMs?: number;
  idleResetMs?: number;
  repeatableKeys?: ReadonlySet<string> | readonly string[];
}

/** Rate limiter for repeated `mpv` `client-message` UI key events. */
export interface InputRepeatGate {
  allow(key: string): boolean;
  reset(): void;
}

/**
 * Creates a per-key hold and auto-repeat gate for `mpv` `client-message` UI keys.
 * Non-repeatable keys always pass immediately and reset hold state; repeatable keys pass on the initial press, drop
 * bursts during `longHoldMs`, and then emit at most once per `repeatIntervalMs` until the key changes or stays idle
 * for more than `idleResetMs`.
 */
export function createInputRepeatGate(opts: InputRepeatGateOptions): InputRepeatGate {
  const longHoldMs = opts.longHoldMs ?? LONG_HOLD_MS;
  const repeatIntervalMs = opts.repeatIntervalMs ?? AUTOREPEAT_MS;
  const idleResetMs = opts.idleResetMs ?? DEFAULT_IDLE_RESET_MS;
  const repeatable: ReadonlySet<string> =
    opts.repeatableKeys === undefined
      ? DEFAULT_REPEATABLE_KEYS
      : opts.repeatableKeys instanceof Set
        ? opts.repeatableKeys
        : new Set(opts.repeatableKeys);

  let activeKey: string | undefined;
  let holdStartMs = 0;
  let lastSeenMs = 0;
  let lastEmittedMs = 0;

  const reset = (): void => {
    activeKey = undefined;
    holdStartMs = 0;
    lastSeenMs = 0;
    lastEmittedMs = 0;
  };

  return {
    allow(key) {
      if (!repeatable.has(key)) {
        reset();
        return true;
      }
      const ts = opts.now();
      if (activeKey !== key || ts < lastSeenMs || ts - lastSeenMs > idleResetMs) {
        activeKey = key;
        holdStartMs = ts;
        lastSeenMs = ts;
        lastEmittedMs = ts;
        return true;
      }
      lastSeenMs = ts;
      if (ts - holdStartMs < longHoldMs) return false;
      if (ts - lastEmittedMs < repeatIntervalMs) return false;
      lastEmittedMs = ts;
      return true;
    },
    reset,
  };
}
