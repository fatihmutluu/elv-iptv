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

/** Visibility and keypad dispatch controller returned by {@link useLiveNumpadOverlay}. */
export interface LiveNumpadOverlayState {
  readonly open: boolean;
  readonly pressDigit: (digit: string) => void;
  readonly clear: () => void;
  readonly close: () => void;
  readonly toggle: () => void;
  readonly submit: () => void;
  readonly pressKey: (key: string) => void;
  readonly notifyChannelResolved: () => void;
}

/**
 * Manages `LiveNumberPad` popover visibility, auto-close upon channel resolution, and keypad
 * dispatch (`C` / `↵` / `0–9`) cleanly outside `LiveScreen`.
 */
export function useLiveNumpadOverlay(
  jump: Pick<
    LiveNumberJumpState,
    'numberFeedback' | 'pressDigit' | 'clearNumber' | 'submitNumberJump'
  >,
): LiveNumpadOverlayState {
  const [open, setOpen] = useState(false);
  const pendingRef = useRef(false);

  useEffect(() => {
    if (jump.numberFeedback !== null) pendingRef.current = false;
  }, [jump.numberFeedback]);

  const clear = useCallback(() => {
    pendingRef.current = false;
    jump.clearNumber();
  }, [jump.clearNumber]);

  const close = useCallback(() => {
    clear();
    setOpen(false);
  }, [clear]);

  const toggle = useCallback(() => {
    setOpen((prev) => {
      if (prev) clear();
      return !prev;
    });
  }, [clear]);

  const pressDigit = useCallback(
    (digit: string) => {
      pendingRef.current = true;
      jump.pressDigit(digit);
    },
    [jump.pressDigit],
  );

  const submit = useCallback(() => {
    void jump.submitNumberJump();
  }, [jump.submitNumberJump]);

  const pressKey = useCallback(
    (key: string) => {
      if (key === 'C') clear();
      else if (key === '↵') submit();
      else pressDigit(key);
    },
    [clear, pressDigit, submit],
  );

  const notifyChannelResolved = useCallback(() => {
    if (pendingRef.current) {
      pendingRef.current = false;
      setOpen(false);
    }
  }, []);

  return useMemo<LiveNumpadOverlayState>(
    () => ({ open, pressDigit, clear, close, toggle, submit, pressKey, notifyChannelResolved }),
    [clear, close, notifyChannelResolved, open, pressDigit, pressKey, submit, toggle],
  );
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
