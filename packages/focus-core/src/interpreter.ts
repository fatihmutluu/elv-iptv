import {
  ARROW_KEYS,
  isDigitKey,
  type Key,
  type KeyEvent,
  type KeyInput,
  type KeyInterpreter,
  LONG_PRESS_MS,
  REPEAT_FAST_HZ,
  REPEAT_RAMP_MS,
  REPEAT_START_HZ,
} from './keys';

const SLOW_INTERVAL_MS = 1000 / REPEAT_START_HZ;
const FAST_INTERVAL_MS = 1000 / REPEAT_FAST_HZ;

/** Options choosing which keys can fire `long` and which repeat while held. Digits are always excluded. */
export interface KeyInterpreterOptions {
  /** Defaults to select, back and the arrows. */
  longKeys?: readonly Key[];
  /** Defaults to the arrows and the channel keys. */
  repeatKeys?: readonly Key[];
}

interface Held {
  downAt: number;
  longFired: boolean;
  nextRepeatAt: number;
  pending: boolean;
}

/**
 * Creates a key interpreter.
 *
 * A `down` then `up` before `LONG_PRESS_MS` is one `press`, emitted on the `up`. A long-capable key held that long
 * emits one `long` (stamped `downAt + LONG_PRESS_MS`, from `tick`, or from `up` if no tick saw it) and no `press` on
 * release. Repeat keys then emit `repeat` every 1000/REPEAT_START_HZ ms, switching to 1000/REPEAT_FAST_HZ ms for
 * repeats due at or after `downAt + LONG_PRESS_MS + REPEAT_RAMP_MS`. The first repeat is one interval after the
 * threshold. A key that only repeats (no `long`) still starts at the threshold and never presses on release after it.
 * While a repeat is unacknowledged, later due repeats of that key are dropped, never queued. A repeated `down` for a
 * held key is ignored; an `up` without a `down` counts as a `press`.
 */
export function createKeyInterpreter(opts: KeyInterpreterOptions = {}): KeyInterpreter {
  const longKeys = new Set<Key>(
    (opts.longKeys ?? ['select', 'back', ...ARROW_KEYS]).filter((k) => !isDigitKey(k)),
  );
  const repeatKeys = new Set<Key>(
    (opts.repeatKeys ?? [...ARROW_KEYS, 'channelUp', 'channelDown']).filter((k) => !isDigitKey(k)),
  );
  const held = new Map<Key, Held>();

  const intervalAt = (h: Held, due: number): number =>
    due - h.downAt >= LONG_PRESS_MS + REPEAT_RAMP_MS ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS;

  function input(k: KeyInput): KeyEvent[] {
    const { key, time } = k;
    if (k.action === 'press') return [{ key, kind: 'press', time }];
    if (k.action === 'down') {
      if (!held.has(key)) {
        const downAt = time;
        const repeats = repeatKeys.has(key);
        held.set(key, {
          downAt,
          longFired: false,
          nextRepeatAt: repeats
            ? downAt + LONG_PRESS_MS + SLOW_INTERVAL_MS
            : Number.POSITIVE_INFINITY,
          pending: false,
        });
      }
      return [];
    }
    const h = held.get(key);
    held.delete(key);
    if (!h) return [{ key, kind: 'press', time }];
    const capable = longKeys.has(key) || repeatKeys.has(key);
    if (!capable || time - h.downAt < LONG_PRESS_MS) return [{ key, kind: 'press', time }];
    if (longKeys.has(key) && !h.longFired)
      return [{ key, kind: 'long', time: h.downAt + LONG_PRESS_MS }];
    return [];
  }

  function tick(now: number): KeyEvent[] {
    const out: KeyEvent[] = [];
    for (const [key, h] of held) {
      if (now - h.downAt < LONG_PRESS_MS) continue;
      if (!h.longFired) {
        h.longFired = true;
        if (longKeys.has(key)) out.push({ key, kind: 'long', time: h.downAt + LONG_PRESS_MS });
      }
      while (h.nextRepeatAt <= now) {
        if (!h.pending) {
          out.push({ key, kind: 'repeat', time: h.nextRepeatAt });
          h.pending = true;
        }
        h.nextRepeatAt += intervalAt(h, h.nextRepeatAt);
      }
    }
    return out;
  }

  return {
    input,
    tick,
    acknowledge(key) {
      const h = held.get(key);
      if (h) h.pending = false;
    },
    reset() {
      held.clear();
    },
  };
}
