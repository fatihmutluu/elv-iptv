import type { Key, KeyEvent } from '@elv/focus-core';

/** Options of {@link createAutoDriver}. */
export interface AutoDriverOptions {
  /** Events per second. */
  rate: number;
  /** Scripted events to emit; an odd count is rounded down to keep the script balanced. */
  moves: number;
  now: () => number;
  /** Runs `fn` once after about `ms` milliseconds. */
  schedule: (fn: () => void, ms: number) => void;
}

/** Drives a focus store with a scripted key sequence. */
export interface AutoDriver {
  /** Emits the script; resolves after the last event, or when stopped. */
  start(): Promise<void>;
  /** Emits nothing more and resolves `start()`. */
  stop(): void;
}

interface Step {
  key: Key;
  kind: KeyEvent['kind'];
}

const HOLD_REPEATS = 39;
const PAGE_JUMPS = 5;
const SINGLE_PRESSES = 3;

function hold(key: Key): Step[] {
  return [
    { key, kind: 'long' },
    ...Array.from({ length: HOLD_REPEATS }, () => ({ key, kind: 'repeat' as const })),
  ];
}

function repeated(key: Key, count: number): Step[] {
  return Array.from({ length: count }, () => ({ key, kind: 'press' as const }));
}

const MIRROR: Partial<Record<Key, Key>> = {
  down: 'up',
  channelDown: 'channelUp',
};

/** One cycle of the forward script: a down-hold (page then single steps), page jumps, single presses. */
function forwardSegments(): Step[][] {
  return [hold('down'), repeated('channelDown', PAGE_JUMPS), repeated('down', SINGLE_PRESSES)];
}

/**
 * Builds the script: a forward half of `floor(moves / 2)` steps cycling through a down-hold, page jumps and single
 * presses, then its mirror (segments in reverse order, `down` to `up`, `channelDown` to `channelUp`). Every step moves
 * the same distance as its mirror, so the script ends at the start index, as long as the list is longer than the
 * deepest excursion and the run starts at index 0.
 */
function buildScript(moves: number): Step[] {
  const half = Math.floor(moves / 2);
  const segments: Step[][] = [];
  let used = 0;
  while (used < half) {
    for (const segment of forwardSegments()) {
      if (used >= half) break;
      const part = segment.slice(0, half - used);
      segments.push(part);
      used += part.length;
    }
  }
  const forward = segments.flat();
  const back = segments
    .slice()
    .reverse()
    .flatMap((segment) => segment.map((s) => ({ key: MIRROR[s.key] ?? s.key, kind: s.kind })));
  return [...forward, ...back];
}

/**
 * Creates an auto-driver that emits {@link KeyEvent}s at `rate` per second through `schedule`, stamped with `now()`.
 * The script goes down in holds (a `long` page then `repeat` steps), page jumps and single presses, and comes back
 * the same way, so a run from index 0 ends at index 0. Nothing is emitted after `stop()` or completion.
 */
export function createAutoDriver(
  dispatch: (event: KeyEvent) => void,
  opts: AutoDriverOptions,
): AutoDriver {
  const interval = 1000 / opts.rate;
  let stopped = false;
  let finish: (() => void) | undefined;

  return {
    start() {
      const script = buildScript(opts.moves);
      return new Promise<void>((resolve) => {
        let next = 0;
        finish = resolve;
        const step = (): void => {
          if (stopped) return;
          const s = script[next++];
          if (s === undefined) {
            stopped = true;
            resolve();
            return;
          }
          dispatch({ key: s.key, kind: s.kind, time: opts.now() });
          if (next >= script.length) {
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
