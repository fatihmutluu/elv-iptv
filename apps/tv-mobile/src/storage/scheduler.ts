import type { Scheduler } from '@elv/domain';

/** {@link Scheduler} that resolves on a `setTimeout(0)` macrotask, so renders and key events run between import batches. */
export function createMacrotaskScheduler(): Scheduler {
  return { yieldNow: () => new Promise<void>((resolve) => setTimeout(resolve, 0)) };
}
