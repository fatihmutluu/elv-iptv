import type { Key, KeyInput } from '@elv/focus-core';

/** A raw Android key event from the native key module, or a window blur that ends every hold. */
export type AndroidKeyEvent =
  | { action: 'down' | 'up'; keyCode: number; canceled: boolean; ageMs: number }
  | { action: 'blur' };

/** The native side of the Android key path: a subscription to raw key events. */
export interface AndroidKeySource {
  addListener(listener: (event: AndroidKeyEvent) => void): { remove(): void };
}

const MAX_BACKDATE_MS = 100;

const KEY_CODES = new Map<number, Key>([
  [19, 'up'],
  [20, 'down'],
  [21, 'left'],
  [22, 'right'],
  [23, 'select'],
  [66, 'select'],
  [160, 'select'],
  [96, 'select'],
  [4, 'back'],
  [97, 'back'],
  [111, 'back'],
  [82, 'menu'],
  [85, 'playPause'],
  [126, 'play'],
  [127, 'pause'],
  [89, 'rewind'],
  [90, 'fastForward'],
  [166, 'channelUp'],
  [92, 'channelUp'],
  [167, 'channelDown'],
  [93, 'channelDown'],
]);

const DIGITS: readonly Key[] = [
  'digit0',
  'digit1',
  'digit2',
  'digit3',
  'digit4',
  'digit5',
  'digit6',
  'digit7',
  'digit8',
  'digit9',
];
DIGITS.forEach((key, i) => {
  KEY_CODES.set(7 + i, key);
  KEY_CODES.set(144 + i, key);
});

/** Maps an Android `KeyEvent` key code to a focus-core `Key`, or `undefined` for keys the app ignores. */
export function mapAndroidKeyCode(keyCode: number): Key | undefined {
  return KEY_CODES.get(keyCode);
}

interface HeldKeyState {
  codes: Set<number>;
  rawDownAt: number;
  reportedDownAt: number;
}

/**
 * Creates a stateful adapter from raw Android key events to focus-core inputs.
 * `now` is the caller's clock (`performance.now()`); a down is back-dated by the event's age, capped at 100 ms, while
 * its release preserves the un-capped raw hold duration (`reportedDownAt + rawHold`) so JS stalls never turn a short
 * tap into `long` or crush a real hold into `press`. Held state tracks active `keyCode`s per mapped `Key`, ignoring
 * orphan releases of unheld codes and keeping a `Key` held until its last held `keyCode` lifts. A canceled final
 * release becomes `cancel`; `blur` cancels every held key.
 */
export function createAndroidKeyAdapter(): (event: AndroidKeyEvent, now: number) => KeyInput[] {
  const held = new Map<Key, HeldKeyState>();
  return (event, now) => {
    if (event.action === 'blur') {
      const out = [...held.keys()].map((key): KeyInput => ({ key, action: 'cancel', time: now }));
      held.clear();
      return out;
    }
    const key = mapAndroidKeyCode(event.keyCode);
    if (key === undefined) return [];
    const safeAge = Math.max(0, event.ageMs);
    const rawAt = now - safeAge;
    if (event.action === 'down') {
      const existing = held.get(key);
      if (existing !== undefined) {
        existing.codes.add(event.keyCode);
        return [];
      }
      const reportedDownAt = now - Math.min(safeAge, MAX_BACKDATE_MS);
      held.set(key, { codes: new Set([event.keyCode]), rawDownAt: rawAt, reportedDownAt });
      return [{ key, action: 'down', time: reportedDownAt }];
    }
    const existing = held.get(key);
    if (existing === undefined || !existing.codes.delete(event.keyCode)) return [];
    if (existing.codes.size > 0) return [];
    held.delete(key);
    const time = existing.reportedDownAt + Math.max(0, rawAt - existing.rawDownAt);
    return [{ key, action: event.canceled ? 'cancel' : 'up', time }];
  };
}
