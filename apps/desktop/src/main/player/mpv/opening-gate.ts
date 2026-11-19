/** Timer callbacks used by `OpeningGate`. */
export interface GateTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Zap-coalescing state machine gating rapid `load` commands until the in-flight stream opens or fails. */
export interface OpeningGate<TSlot extends { entryId?: number }> {
  readonly maxHoldMs: number;
  begin(slot: TSlot): void;
  arm(ms: number, onTimeout: () => void): void;
  onStarted(entryId: number, openWaitMs: number): void;
  onFileLoaded(currentEntryId: number | undefined): void;
  onEnded(entryId: number): void;
  finish(): void;
  isOpening(): boolean;
  needsStartTimeout(slot: TSlot): boolean;
  waitUntilClear(shouldWait: () => boolean): Promise<void>;
  wake(): void;
}

interface ActiveOpening<TSlot> {
  slot: TSlot;
  started: boolean;
  timer?: unknown;
  done: Promise<void>;
  resolveDone(): void;
}

/** Creates a zap-coalescing `OpeningGate`. */
export function createOpeningGate<TSlot extends { entryId?: number }>(opts: {
  now(): number;
  timers: GateTimers;
}): OpeningGate<TSlot> {
  const { now, timers } = opts;
  let current: ActiveOpening<TSlot> | undefined;
  let wakePending: (() => void) | undefined;
  let maxHoldMs = 0;

  const superseded = (): Promise<void> =>
    new Promise<void>((resolve) => {
      wakePending = resolve;
    });

  const finish = (): void => {
    const active = current;
    if (!active) return;
    current = undefined;
    timers.clearTimeout(active.timer);
    active.resolveDone();
  };

  const arm = (ms: number, onTimeout: () => void): void => {
    const active = current;
    if (!active) return;
    timers.clearTimeout(active.timer);
    active.timer = timers.setTimeout(() => {
      if (current === active) onTimeout();
    }, ms);
  };

  return {
    get maxHoldMs() {
      return maxHoldMs;
    },
    begin(slot) {
      finish();
      let resolveDone = (): void => undefined;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      current = { slot, started: false, done, resolveDone };
    },
    arm,
    onStarted(entryId, openWaitMs) {
      if (current?.slot.entryId === entryId) {
        current.started = true;
        arm(openWaitMs, finish);
      }
    },
    onFileLoaded(currentEntryId) {
      if (
        current?.started &&
        currentEntryId !== undefined &&
        currentEntryId === current.slot.entryId
      ) {
        finish();
      }
    },
    onEnded(entryId) {
      if (current?.slot.entryId === entryId) finish();
    },
    finish,
    isOpening: () => current !== undefined,
    needsStartTimeout: (slot) => current?.slot === slot && !current.started,
    async waitUntilClear(shouldWait) {
      const heldAt = now();
      while (current !== undefined && shouldWait()) {
        await Promise.race([current.done, superseded()]);
      }
      if (shouldWait()) {
        maxHoldMs = Math.max(maxHoldMs, now() - heldAt);
      }
    },
    wake() {
      const resolve = wakePending;
      wakePending = undefined;
      resolve?.();
    },
  };
}
