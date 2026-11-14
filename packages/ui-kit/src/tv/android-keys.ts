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
  [126, 'playPause'],
  [127, 'playPause'],
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

/**
 * Creates a stateful adapter from raw Android key events to focus-core inputs.
 * `now` is the caller's clock (`performance.now()`); a down or up is back-dated by the event's age, capped at 100 ms.
 * Held state is tracked per mapped key, so a repeated down (also from a second code of the same key) and an up
 * without a seen down give nothing. A canceled up becomes `cancel`; `blur` cancels every held key.
 */
export function createAndroidKeyAdapter(): (event: AndroidKeyEvent, now: number) => KeyInput[] {
  const held = new Set<Key>();
  return (event, now) => {
    if (event.action === 'blur') {
      const out = [...held].map((key): KeyInput => ({ key, action: 'cancel', time: now }));
      held.clear();
      return out;
    }
    const key = mapAndroidKeyCode(event.keyCode);
    if (key === undefined) return [];
    const time = now - Math.min(Math.max(0, event.ageMs), MAX_BACKDATE_MS);
    if (event.action === 'down') {
      if (held.has(key)) return [];
      held.add(key);
      return [{ key, action: 'down', time }];
    }
    if (!held.delete(key)) return [];
    return [{ key, action: event.canceled ? 'cancel' : 'up', time }];
  };
}
