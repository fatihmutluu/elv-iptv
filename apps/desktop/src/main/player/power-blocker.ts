/** Minimal subset of Electron's `powerSaveBlocker` module used to keep the display awake while playing. */
export interface PowerSaveBlockerLike {
  start(type: 'prevent-display-sleep'): number;
  stop(id: number): boolean;
  isStarted?(id: number): boolean;
}

/** Reference-counted display-sleep guard keyed by active playing engine IDs (#135). */
export interface PowerBlocker {
  readonly activeCount: number;
  acquire(key: string): void;
  release(key: string): void;
  releaseAll(): void;
}

/** Creates an idempotent, reference-counted `PowerBlocker` over `prevent-display-sleep`. */
export function createPowerBlocker(blocker: PowerSaveBlockerLike): PowerBlocker {
  const activeKeys = new Set<string>();
  let blockerId: number | undefined;

  const stopBlocker = (): void => {
    if (blockerId === undefined) return;
    const id = blockerId;
    blockerId = undefined;
    try {
      blocker.stop(id);
    } catch {
      // ignore shutdown race
    }
  };

  return {
    get activeCount() {
      return activeKeys.size;
    },
    acquire(key) {
      activeKeys.add(key);
      if (blockerId === undefined) {
        try {
          blockerId = blocker.start('prevent-display-sleep');
        } catch {
          // ignore headless/unavailable blocker error
        }
      }
    },
    release(key) {
      if (!activeKeys.delete(key)) return;
      if (activeKeys.size === 0) stopBlocker();
    },
    releaseAll() {
      activeKeys.clear();
      stopBlocker();
    },
  };
}
