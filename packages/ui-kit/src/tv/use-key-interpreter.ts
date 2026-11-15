import {
  createKeyInterpreter,
  type Key,
  type KeyEvent,
  type KeyInput,
  type KeyInterpreterOptions,
} from '@elv/focus-core';
import { useCallback, useContext, useEffect, useRef } from 'react';
import { useTvKeySource } from './key-source';
import { TextEntryContext } from './text-entry';

const TICK_MS = 16;
const STALL_GUARD_MS = 100;

/** Options for {@link useKeyInterpreter}. */
export interface UseKeyInterpreterOptions extends KeyInterpreterOptions {
  /** Monotonic clock in ms; defaults to `() => performance.now()`. */
  now?: () => number;
  /** Underlying key source hook; defaults to {@link useTvKeySource}. */
  keySource?: (onInput: (input: KeyInput) => void) => void;
}

/**
 * Shared TV key interpreter hook connecting {@link useTvKeySource} to `createKeyInterpreter`.
 *
 * - Tracks `pendingKeys: Set<Key>` and acknowledges repeats on the next animation frame so edge/non-moving repeats
 *   and simultaneous holds never deadlock `h.pending`.
 * - Applies a 1-turn stall guard (`now - lastTickAt > 100` skips `tick` once) so queued `up` events drain before an
 *   overdue interval fires a false `long`.
 * - Integrates with {@link TextEntryBoundary} / {@link TvTextInput} and cleans up timers, rAF, and held keys on unmount.
 */
export function useKeyInterpreter(
  onEvent: (event: KeyEvent) => void,
  options?: UseKeyInterpreterOptions,
): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const nowRef = useRef(options?.now);
  nowRef.current = options?.now;
  const textEntry = useContext(TextEntryContext);

  const interpreterRef = useRef<ReturnType<typeof createKeyInterpreter> | null>(null);
  if (interpreterRef.current === null) {
    interpreterRef.current = createKeyInterpreter({
      longKeys: options?.longKeys,
      repeatKeys: options?.repeatKeys,
    });
  }
  const interpreter = interpreterRef.current;

  const heldKeys = useRef(new Set<Key>());
  const pendingKeys = useRef(new Set<Key>());
  const ticker = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const ackFrame = useRef<number | undefined>(undefined);
  const lastTickAt = useRef(0);

  const readNow = useCallback(() => (nowRef.current ? nowRef.current() : performance.now()), []);

  const scheduleAck = useCallback(() => {
    if (ackFrame.current !== undefined || pendingKeys.current.size === 0) return;
    ackFrame.current = requestAnimationFrame(() => {
      ackFrame.current = undefined;
      for (const key of pendingKeys.current) interpreter.acknowledge(key);
      pendingKeys.current.clear();
    });
  }, [interpreter]);

  const deliver = useCallback(
    (event: KeyEvent) => {
      if (textEntry.isActive()) {
        if (event.key !== 'back') return;
        if (event.kind === 'press') {
          textEntry.exit();
          return;
        }
      }
      if (event.kind === 'repeat') {
        pendingKeys.current.add(event.key);
        scheduleAck();
      }
      onEventRef.current(event);
    },
    [textEntry, scheduleAck],
  );

  const stopTicker = useCallback(() => {
    if (ticker.current !== undefined) {
      clearInterval(ticker.current);
      ticker.current = undefined;
    }
  }, []);

  const onInput = useCallback(
    (k: KeyInput) => {
      if (k.action === 'down') {
        heldKeys.current.add(k.key);
        if (ticker.current === undefined) {
          lastTickAt.current = readNow();
          ticker.current = setInterval(() => {
            const t = readNow();
            if (t - lastTickAt.current > STALL_GUARD_MS) {
              lastTickAt.current = t;
              return;
            }
            lastTickAt.current = t;
            for (const e of interpreter.tick(t)) deliver(e);
          }, TICK_MS);
        }
      } else if (k.action === 'up' || k.action === 'cancel') {
        heldKeys.current.delete(k.key);
        pendingKeys.current.delete(k.key);
        if (heldKeys.current.size === 0) stopTicker();
      }
      for (const e of interpreter.input(k)) deliver(e);
    },
    [interpreter, deliver, readNow, stopTicker],
  );

  useEffect(
    () => () => {
      stopTicker();
      if (ackFrame.current !== undefined) {
        cancelAnimationFrame(ackFrame.current);
        ackFrame.current = undefined;
      }
      heldKeys.current.clear();
      pendingKeys.current.clear();
      interpreter.reset();
    },
    [interpreter, stopTicker],
  );

  const useSource = options?.keySource ?? useTvKeySource;
  useSource(onInput);
}
