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
  keySource?: (
    onInput: ((input: KeyInput) => boolean | undefined) | ((input: KeyInput) => void),
  ) => void;
}

/**
 * Shared TV key interpreter hook connecting {@link useTvKeySource} to `createKeyInterpreter`.
 *
 * - Tracks `pendingKeys: Set<Key>` and acknowledges repeats on the next animation frame so edge/non-moving repeats
 *   and simultaneous holds never deadlock `h.pending`.
 * - Applies a 1-turn stall guard (`now - lastTickAt > 100` skips `tick` once) so queued `up` events drain before an
 *   overdue interval fires a false `long`.
 * - Integrates with {@link TextEntryBoundary} / {@link TvTextInput} and cleans up timers, rAF, and held keys on unmount.
 * - Handlers may return `false` to indicate an event (such as root Android TV `back`) was not consumed (`#425`).
 */
export function useKeyInterpreter(
  onEvent: ((event: KeyEvent) => boolean | undefined) | ((event: KeyEvent) => void),
  options?: UseKeyInterpreterOptions,
): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const nowRef = useRef(options?.now);
  nowRef.current = options?.now;
  const textEntry = useContext(TextEntryContext);

  const longKeysSig = options?.longKeys ? options.longKeys.join(',') : '__default__';
  const repeatKeysSig = options?.repeatKeys ? options.repeatKeys.join(',') : '__default__';
  const interpreterSig = `${longKeysSig}|${repeatKeysSig}`;
  const interpreterSigRef = useRef<string | null>(null);
  const interpreterRef = useRef<ReturnType<typeof createKeyInterpreter> | null>(null);
  if (interpreterRef.current === null || interpreterSigRef.current !== interpreterSig) {
    interpreterRef.current?.reset();
    interpreterRef.current = createKeyInterpreter({
      longKeys: options?.longKeys,
      repeatKeys: options?.repeatKeys,
    });
    interpreterSigRef.current = interpreterSig;
  }

  const heldKeys = useRef(new Set<Key>());
  const pendingKeys = useRef(new Set<Key>());
  const ticker = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const ackFrame = useRef<number | undefined>(undefined);
  const lastTickAt = useRef(0);
  const longConsumedBack = useRef(false);

  const readNow = useCallback(() => (nowRef.current ? nowRef.current() : performance.now()), []);

  const scheduleAck = useCallback(() => {
    if (ackFrame.current !== undefined || pendingKeys.current.size === 0) return;
    ackFrame.current = requestAnimationFrame(() => {
      ackFrame.current = undefined;
      const current = interpreterRef.current;
      if (current !== null) {
        for (const key of pendingKeys.current) current.acknowledge(key);
      }
      pendingKeys.current.clear();
    });
  }, []);

  const deliver = useCallback(
    (event: KeyEvent): boolean => {
      if (textEntry.isActive()) {
        if (event.key !== 'back') return false;
        if (event.kind === 'press') {
          textEntry.exit();
          return true;
        }
      }
      if (event.kind === 'repeat') {
        pendingKeys.current.add(event.key);
        scheduleAck();
      }
      return onEventRef.current(event) !== false;
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
    (k: KeyInput): boolean => {
      const current = interpreterRef.current;
      if (current === null) return false;
      if (k.action === 'down') {
        if (k.key === 'back') longConsumedBack.current = false;
        heldKeys.current.add(k.key);
        if (ticker.current === undefined) {
          lastTickAt.current = readNow();
          ticker.current = setInterval(() => {
            const active = interpreterRef.current;
            if (active === null) return;
            const t = readNow();
            if (t - lastTickAt.current > STALL_GUARD_MS) {
              lastTickAt.current = t;
              return;
            }
            lastTickAt.current = t;
            for (const e of active.tick(t)) {
              const handled = deliver(e);
              if (handled && e.key === 'back' && e.kind === 'long') {
                longConsumedBack.current = true;
              }
            }
          }, TICK_MS);
        }
      } else if (k.action === 'up' || k.action === 'cancel') {
        if (k.key === 'back' && k.action === 'cancel') longConsumedBack.current = false;
        heldKeys.current.delete(k.key);
        pendingKeys.current.delete(k.key);
        if (heldKeys.current.size === 0) stopTicker();
      }
      const events = current.input(k);
      let consumed = false;
      for (let i = 0; i < events.length; i += 1) {
        if (deliver(events[i] as KeyEvent)) consumed = true;
      }
      if (!consumed && k.key === 'back' && k.action === 'up' && longConsumedBack.current) {
        longConsumedBack.current = false;
        return true;
      }
      return consumed;
    },
    [deliver, readNow, stopTicker],
  );

  useEffect(() => {
    void interpreterSig;
    stopTicker();
    if (ackFrame.current !== undefined) {
      cancelAnimationFrame(ackFrame.current);
      ackFrame.current = undefined;
    }
    heldKeys.current.clear();
    pendingKeys.current.clear();
    longConsumedBack.current = false;
  }, [interpreterSig, stopTicker]);

  useEffect(
    () => () => {
      stopTicker();
      if (ackFrame.current !== undefined) {
        cancelAnimationFrame(ackFrame.current);
        ackFrame.current = undefined;
      }
      heldKeys.current.clear();
      pendingKeys.current.clear();
      longConsumedBack.current = false;
      interpreterRef.current?.reset();
    },
    [stopTicker],
  );

  const useSource = options?.keySource ?? useTvKeySource;
  useSource(onInput);
}
