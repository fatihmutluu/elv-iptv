/** Digit keys of a remote control. */
export const DIGIT_KEYS = [
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
] as const;

/** The four directional keys. */
export const ARROW_KEYS = ['up', 'down', 'left', 'right'] as const;

/** Logical remote-control keys, independent of the runtime that reports them. */
export type Key =
  | (typeof ARROW_KEYS)[number]
  | 'select'
  | 'back'
  | 'menu'
  | 'playPause'
  | 'channelUp'
  | 'channelDown'
  | (typeof DIGIT_KEYS)[number];

/**
 * Raw key input from a runtime key source; `press` and native `long` are for runtimes that report no down/up.
 * `cancel` releases a held key without any event, for a release the runtime reports as canceled. Times are in ms.
 */
export interface KeyInput {
  key: Key;
  action: 'down' | 'up' | 'press' | 'long' | 'cancel';
  time: number;
}

/** Interpreted key event. `time` is the moment the event became due, not when it was observed. */
export interface KeyEvent {
  key: Key;
  kind: 'press' | 'long' | 'repeat';
  time: number;
}

/** Hold time in ms after which a long-capable key fires `long`. */
export const LONG_PRESS_MS = 500;
/** Repeat rate right after the long threshold. */
export const REPEAT_START_HZ = 8;
/** Repeat rate once the key has been held `REPEAT_RAMP_MS` beyond the long threshold. */
export const REPEAT_FAST_HZ = 24;
/** Time in ms beyond `LONG_PRESS_MS` after which repeats switch from the start to the fast rate. */
export const REPEAT_RAMP_MS = 1500;

/** Turns key inputs and clock ticks into events. Time always comes from the caller. */
export interface KeyInterpreter {
  /** Feeds one raw input and returns the events it completes. */
  input(k: KeyInput): KeyEvent[];
  /** Advances the clock to `now` and returns the `long` and `repeat` events that became due. */
  tick(now: number): KeyEvent[];
  /** Tells the interpreter the UI handled the last `repeat` of `key`, so the next one may be emitted. */
  acknowledge(key: Key): void;
  /** Forgets all held keys and pending repeats. */
  reset(): void;
}

/** Whether `key` is one of the ten digit keys. */
export function isDigitKey(key: Key): boolean {
  return (DIGIT_KEYS as readonly string[]).includes(key);
}
