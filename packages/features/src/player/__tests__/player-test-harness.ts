import type { AndroidKeyEvent, AndroidKeySource } from '@elv/ui-kit';

export function createManualClock() {
  let current = 1_000;
  const tasks = new Map<number, { runAt: number; fn: () => void }>();
  let nextId = 1;

  return {
    now: () => current,
    schedule(fn: () => void, ms: number): number {
      const id = nextId++;
      tasks.set(id, { runAt: current + Math.max(0, ms), fn });
      return id;
    },
    cancel(handle: unknown): void {
      tasks.delete(handle as number);
    },
    advance(ms: number): void {
      const target = current + ms;
      while (true) {
        let earliestId: number | undefined;
        let earliestAt = Number.POSITIVE_INFINITY;
        for (const [id, task] of tasks) {
          if (task.runAt <= target && task.runAt < earliestAt) {
            earliestAt = task.runAt;
            earliestId = id;
          }
        }
        if (earliestId === undefined) break;
        const entry = tasks.get(earliestId);
        tasks.delete(earliestId);
        current = earliestAt;
        entry?.fn();
      }
      current = target;
    },
  };
}

export function createFakeAndroidKeys() {
  let listener: ((e: AndroidKeyEvent) => void) | undefined;
  const source: AndroidKeySource = {
    addListener: (l) => {
      listener = l;
      return {
        remove: () => {
          listener = undefined;
        },
      };
    },
  };
  return {
    source,
    down(keyCode: number, ageMs = 0) {
      listener?.({ action: 'down', keyCode, canceled: false, ageMs });
    },
    up(keyCode: number, ageMs = 0) {
      listener?.({ action: 'up', keyCode, canceled: false, ageMs });
    },
    tap(keyCode: number) {
      listener?.({ action: 'down', keyCode, canceled: false, ageMs: 0 });
      listener?.({ action: 'up', keyCode, canceled: false, ageMs: 10 });
    },
  };
}
