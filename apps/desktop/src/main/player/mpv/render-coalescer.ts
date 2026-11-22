/** Options for {@link createRenderCoalescer}. */
export interface RenderCoalescerOptions {
  /** Schedules `flush` for the next render turn; may return a cancellation callback. */
  scheduleFlush(flush: () => void): (() => void) | void;
  /** Runs at most once per scheduled frame when one or more renders were requested. */
  onRender(): void;
}

/** Coalesces bursts of render wakeups into at most one render pass per scheduled frame (#207). */
export interface RenderCoalescer {
  requestRender(): void;
  readonly pending: boolean;
  dispose(): void;
}

/**
 * Creates a pure render-update coalescer guarded by an atomic `scheduled` boolean flag.
 * Multiple `requestRender()` calls before the flush runs coalesce into a single `onRender()` call;
 * a `requestRender()` arriving during `onRender()` cleanly schedules one follow-up flush.
 */
export function createRenderCoalescer(opts: RenderCoalescerOptions): RenderCoalescer {
  let scheduled = false;
  let disposed = false;
  let scheduleGen = 0;
  let cancelScheduled: (() => void) | undefined;

  const flush = (): void => {
    if (disposed || !scheduled) return;
    scheduled = false;
    cancelScheduled = undefined;
    opts.onRender();
  };

  return {
    get pending() {
      return scheduled;
    },
    requestRender() {
      if (disposed || scheduled) return;
      scheduled = true;
      const gen = ++scheduleGen;
      let cancel: (() => void) | undefined;
      try {
        const result = opts.scheduleFlush(flush);
        if (typeof result === 'function') cancel = result;
      } catch (error) {
        if (gen === scheduleGen) scheduled = false;
        throw error;
      }
      if (disposed) {
        cancel?.();
      } else if (scheduled && gen === scheduleGen) {
        cancelScheduled = cancel;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      scheduled = false;
      const cancel = cancelScheduled;
      cancelScheduled = undefined;
      cancel?.();
    },
  };
}
