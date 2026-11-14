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
const STEP_KEYS: ReadonlySet<Key> = new Set<Key>([...ARROW_KEYS, 'channelUp', 'channelDown']);

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
 * Step keys (the arrows, `channelUp`, `channelDown`) emit their `press` on the earliest input that shows it: on `down`,
 * stamped with the down time, and then their `up` emits nothing; an `up` without a `down` (Android TV delivers a tap
 * only on release) is one `press` at its time. Every other key emits one `press` on an `up` that comes before
 * `LONG_PRESS_MS` (or without a `down`), so `long` stays distinguishable. A long-capable key
 * held that long emits one `long` (stamped `downAt + LONG_PRESS_MS`, from `tick`, or from `up` if no tick saw it) and
 * no `press` on release; an `up` of a key whose `long` `tick` already fired emits nothing whatever its time (a
 * back-dated release can land just under the threshold). A `cancel` input drops the held key and emits nothing. Repeat keys then emit `repeat` every 1000/REPEAT_START_HZ ms, switching to
 * 1000/REPEAT_FAST_HZ ms for repeats due at or after `downAt + LONG_PRESS_MS + REPEAT_RAMP_MS`. The first repeat is
 * one interval after the threshold. A key that only repeats (no `long`) still starts at the threshold.
 * A tick that finds several repeats overdue emits at most one and skips to the first future slot; a non-finite `now`
 * is ignored. A `long` action (native long press) is passed through as one `long` (a digit becomes a `press`).
 * While a repeat is unacknowledged, later due repeats of that key are dropped, never queued. A repeated `down` for a
 * held key is ignored.
 */
export function createKeyInterpreter(opts: KeyInterpreterOptions = {}): KeyInterpreter {
  const longKeys = new Set<Key>(
    (opts.longKeys ?? ['select', 'back', ...ARROW_KEYS]).filter((k) => !isDigitKey(k)),
  );
  const repeatKeys = new Set<Key>(
    (opts.repeatKeys ?? [...ARROW_KEYS, 'channelUp', 'channelDown']).filter((k) => !isDigitKey(k)),
  );
  const held = new Map<Key, Held>();

  function input(k: KeyInput): KeyEvent[] {
    const { key, time } = k;
    if (k.action === 'press') return [{ key, kind: 'press', time }];
    if (k.action === 'long') return [{ key, kind: isDigitKey(key) ? 'press' : 'long', time }];
    if (k.action === 'down') {
      if (held.has(key)) return [];
      held.set(key, {
        downAt: time,
        longFired: false,
        nextRepeatAt: repeatKeys.has(key)
          ? time + LONG_PRESS_MS + SLOW_INTERVAL_MS
          : Number.POSITIVE_INFINITY,
        pending: false,
      });
      return STEP_KEYS.has(key) ? [{ key, kind: 'press', time }] : [];
    }
    const h = held.get(key);
    held.delete(key);
    if (k.action === 'cancel') return [];
    if (h === undefined) return [{ key, kind: 'press', time }];
    const capable = longKeys.has(key) || repeatKeys.has(key);
    if (!capable || (!h.longFired && time - h.downAt < LONG_PRESS_MS)) {
      return STEP_KEYS.has(key) ? [] : [{ key, kind: 'press', time }];
    }
    if (longKeys.has(key) && !h.longFired)
      return [{ key, kind: 'long', time: h.downAt + LONG_PRESS_MS }];
    return [];
  }

  function advancePast(h: Held, now: number): void {
    const rampEnd = h.downAt + LONG_PRESS_MS + REPEAT_RAMP_MS;
    let t = h.nextRepeatAt;
    while (t <= now && t < rampEnd) t += SLOW_INTERVAL_MS;
    if (t <= now) t += (Math.floor((now - t) / FAST_INTERVAL_MS) + 1) * FAST_INTERVAL_MS;
    if (t <= now) t += FAST_INTERVAL_MS;
    h.nextRepeatAt = t;
  }

  function tick(now: number): KeyEvent[] {
    if (!Number.isFinite(now)) return [];
    const out: KeyEvent[] = [];
    for (const [key, h] of held) {
      if (now - h.downAt < LONG_PRESS_MS) continue;
      if (!h.longFired) {
        h.longFired = true;
        if (longKeys.has(key)) out.push({ key, kind: 'long', time: h.downAt + LONG_PRESS_MS });
      }
      if (h.nextRepeatAt <= now) {
        if (!h.pending) {
          out.push({ key, kind: 'repeat', time: h.nextRepeatAt });
          h.pending = true;
        }
        advancePast(h, now);
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
