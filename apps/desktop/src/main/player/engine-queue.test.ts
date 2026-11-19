import { describe, expect, it } from 'vitest';
import { createEngineQueue, type QueuedOp } from './engine-queue.ts';

describe('createEngineQueue', () => {
  it('purges queued load AND queued command ops when superseded by load, stop or recreate', async () => {
    let unblockFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((r) => {
      firstStarted = r;
    });
    const executed: string[] = [];

    const queue = createEngineQueue<{ id: string }>({
      isReleased: () => false,
      async run(op: QueuedOp<{ id: string }>) {
        if (op.type === 'load' && op.slot.id === 'A') {
          executed.push('load:A');
          firstStarted();
          await new Promise<void>((r) => {
            unblockFirst = r;
          });
          return;
        }
        if (op.type === 'load') executed.push(`load:${op.slot.id}`);
        else if (op.type === 'command')
          executed.push(`cmd:${String(op.command[0])}:${String(op.command[1])}`);
        else executed.push(op.type);
      },
    });

    const slotA = { id: 'A' };
    const slotB = { id: 'B' };
    const slotC = { id: 'C' };

    queue.enqueueLoad(slotA);
    await started;

    // Queued while load:A is running:
    queue.enqueueCommand(['set_property', 'aid', 2], slotA);
    queue.enqueueLoad(slotB);
    queue.enqueueCommand(['seek', 10, 'absolute'], slotB);
    // Supersede slotB + its seek command with recreate -> load:C -> pause:
    queue.enqueueRecreate();
    queue.enqueueLoad(slotC);
    queue.enqueueCommand(['set', 'pause', 'yes'], slotC);

    unblockFirst();
    await new Promise((r) => setTimeout(r, 20));

    expect(executed).toEqual(['load:A', 'recreate', 'load:C', 'cmd:set:pause']);
  });

  it('preserves stop barrier ahead of a subsequent load while purging pre-stop commands', async () => {
    let unblockFirst!: () => void;
    const executed: string[] = [];
    const queue = createEngineQueue<{ id: string }>({
      isReleased: () => false,
      async run(op) {
        if (op.type === 'load' && op.slot.id === '1') {
          executed.push('load:1');
          await new Promise<void>((r) => {
            unblockFirst = r;
          });
          return;
        }
        executed.push(op.type === 'load' ? `load:${op.slot.id}` : op.type);
      },
    });

    queue.enqueueLoad({ id: '1' });
    await new Promise((r) => setImmediate(r));
    queue.enqueueCommand(['set_property', 'sid', 'no']);
    queue.enqueueStop();
    queue.enqueueLoad({ id: '2' });

    unblockFirst();
    await new Promise((r) => setTimeout(r, 20));
    expect(executed).toEqual(['load:1', 'stop', 'load:2']);
  });
});
