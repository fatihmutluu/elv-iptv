import type { CatalogService, ItemRow } from '@elv/data';
import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { appendNumberDigit, NUMBER_JUMP_TIMEOUT_MS, parseNumberBuffer } from './live-model';

/** Structured feedback displayed by `LiveNumberPad` when a direct channel number lookup misses. */
export interface LiveNumberFeedback {
  readonly kind: 'notFound';
  readonly number: number;
}

/** State and actions returned by {@link useLiveNumberJump}. */
export interface LiveNumberJumpState {
  readonly numberBuffer: string;
  readonly numberFeedback: LiveNumberFeedback | null;
  readonly pressDigit: (digit: string) => void;
  readonly clearNumber: () => void;
  readonly submitNumberJump: () => Promise<ItemRow | null>;
}

/**
 * Manages `0–9` channel number entry, debounced auto-tune (`NUMBER_JUMP_TIMEOUT_MS`), explicit
 * submit via `catalog.channelByNumber`, stale-request cancellation, and unmount timer cleanup.
 */
export function useLiveNumberJump(opts: {
  readonly catalog: CatalogService;
  readonly activeSourceIdRef: MutableRefObject<string | undefined>;
  readonly onResolved: (channel: ItemRow) => void;
}): LiveNumberJumpState {
  const { catalog, activeSourceIdRef, onResolved } = opts;
  const [numpad, setNumpad] = useState<{ buffer: string; feedback: LiveNumberFeedback | null }>({
    buffer: '',
    feedback: null,
  });

  const aliveRef = useRef(true);
  const onResolvedRef = useRef(onResolved);
  onResolvedRef.current = onResolved;
  const jumpRef = useRef<{
    buffer: string;
    timer: ReturnType<typeof setTimeout> | null;
    gen: number;
  }>({ buffer: '', timer: null, gen: 0 });

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (jumpRef.current.timer !== null) {
        clearTimeout(jumpRef.current.timer);
        jumpRef.current.timer = null;
      }
    };
  }, []);

  const clearNumber = useCallback(() => {
    if (jumpRef.current.timer !== null) clearTimeout(jumpRef.current.timer);
    jumpRef.current = { buffer: '', timer: null, gen: jumpRef.current.gen + 1 };
    setNumpad({ buffer: '', feedback: null });
  }, []);

  const executeNumberJump = useCallback(
    async (rawBuffer?: string): Promise<ItemRow | null> => {
      if (jumpRef.current.timer !== null) {
        clearTimeout(jumpRef.current.timer);
        jumpRef.current.timer = null;
      }
      const num = parseNumberBuffer(rawBuffer ?? jumpRef.current.buffer);
      jumpRef.current.buffer = '';
      setNumpad((prev) => ({ buffer: '', feedback: prev.feedback }));
      if (num === null || !catalog.channelByNumber) return null;

      const gen = ++jumpRef.current.gen;
      const found = await catalog.channelByNumber(num, activeSourceIdRef.current).catch(() => null);
      if (!aliveRef.current || jumpRef.current.gen !== gen) return null;

      if (found) {
        setNumpad({ buffer: '', feedback: null });
        onResolvedRef.current(found);
        return found;
      }
      setNumpad({ buffer: '', feedback: { kind: 'notFound', number: num } });
      return null;
    },
    [activeSourceIdRef, catalog],
  );

  const submitNumberJump = useCallback(() => executeNumberJump(), [executeNumberJump]);

  const pressDigit = useCallback(
    (digit: string) => {
      const next = appendNumberDigit(jumpRef.current.buffer, digit);
      if (next === jumpRef.current.buffer) return;
      jumpRef.current.buffer = next;
      setNumpad({ buffer: next, feedback: null });
      if (jumpRef.current.timer !== null) clearTimeout(jumpRef.current.timer);
      jumpRef.current.timer = setTimeout(() => {
        jumpRef.current.timer = null;
        void executeNumberJump(next);
      }, NUMBER_JUMP_TIMEOUT_MS);
    },
    [executeNumberJump],
  );

  return useMemo<LiveNumberJumpState>(
    () => ({
      numberBuffer: numpad.buffer,
      numberFeedback: numpad.feedback,
      pressDigit,
      clearNumber,
      submitNumberJump,
    }),
    [clearNumber, numpad.buffer, numpad.feedback, pressDigit, submitNumberJump],
  );
}
