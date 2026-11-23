import type { MpvCommand } from './mpv/codec.ts';

/** One serialized operation in `EngineQueue`, tagged with the queue generation at enqueue time. */
export type QueuedOp<TSlot> =
  | { type: 'load'; generation: number; slot: TSlot }
  | { type: 'command'; generation: number; slot: TSlot | undefined; command: MpvCommand }
  | { type: 'task'; generation: number; slot: TSlot | undefined; task: () => Promise<void> }
  | { type: 'stop'; generation: number }
  | { type: 'recreate'; generation: number };

/** Serialized async command queue that purges stale `load` and `command` ops on superseding lifecycle transitions. */
export interface EngineQueue<TSlot> {
  readonly generation: number;
  enqueueLoad(slot: TSlot): void;
  enqueueCommand(command: MpvCommand, slot?: TSlot): void;
  enqueueTask(task: () => Promise<void>, slot?: TSlot): void;
  enqueueStop(): void;
  enqueueRecreate(): void;
  clear(): void;
}

/** Creates an `EngineQueue`. */
export function createEngineQueue<TSlot>(opts: {
  isReleased(): boolean;
  run(op: QueuedOp<TSlot>): Promise<void>;
}): EngineQueue<TSlot> {
  const queue: QueuedOp<TSlot>[] = [];
  let generation = 0;
  let pumping = false;

  const purgeTransientOps = (): void => {
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      const kind = queue[i]?.type;
      if (kind === 'load' || kind === 'command' || kind === 'task') {
        queue.splice(i, 1);
      }
    }
  };

  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      for (let op = queue.shift(); op && !opts.isReleased(); op = queue.shift()) {
        try {
          await opts.run(op);
        } catch {
          // every step maps its own failures to events; nothing may stop the queue
        }
      }
    } finally {
      pumping = false;
    }
  };

  return {
    get generation() {
      return generation;
    },
    enqueueLoad(slot) {
      generation += 1;
      purgeTransientOps();
      queue.push({ type: 'load', generation, slot });
      void pump();
    },
    enqueueCommand(command, slot) {
      queue.push({ type: 'command', generation, slot, command });
      void pump();
    },
    enqueueTask(task, slot) {
      queue.push({ type: 'task', generation, slot, task });
      void pump();
    },
    enqueueStop() {
      generation += 1;
      purgeTransientOps();
      queue.push({ type: 'stop', generation });
      void pump();
    },
    enqueueRecreate() {
      generation += 1;
      purgeTransientOps();
      queue.push({ type: 'recreate', generation });
      void pump();
    },
    clear() {
      generation += 1;
      queue.length = 0;
    },
  };
}
