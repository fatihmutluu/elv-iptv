import { describe, expect, it } from 'vitest';
import { createRenderCoalescer } from './render-coalescer.ts';

describe('createRenderCoalescer (#207)', () => {
  it('coalesces a burst of requestRender calls into one scheduled flush and one onRender', () => {
    const flushes: Array<() => void> = [];
    let renders = 0;
    const coalescer = createRenderCoalescer({
      scheduleFlush: (flush) => {
        flushes.push(flush);
      },
      onRender: () => {
        renders += 1;
      },
    });

    expect(coalescer.pending).toBe(false);
    for (let i = 0; i < 25; i += 1) coalescer.requestRender();

    expect(coalescer.pending).toBe(true);
    expect(flushes).toHaveLength(1);
    expect(renders).toBe(0);

    flushes[0]?.();
    expect(coalescer.pending).toBe(false);
    expect(renders).toBe(1);

    // Calling the same stale flush callback twice is a no-op
    flushes[0]?.();
    expect(renders).toBe(1);
  });

  it('supports re-scheduling if requestRender arrives synchronously during onRender', () => {
    const flushes: Array<() => void> = [];
    let renders = 0;
    const coalescer = createRenderCoalescer({
      scheduleFlush: (flush) => {
        flushes.push(flush);
      },
      onRender: () => {
        renders += 1;
        if (renders === 1) {
          // Multiple re-entrant requests coalesce into one follow-up flush
          coalescer.requestRender();
          coalescer.requestRender();
        }
      },
    });

    coalescer.requestRender();
    expect(flushes).toHaveLength(1);

    flushes[0]?.();
    expect(renders).toBe(1);
    expect(coalescer.pending).toBe(true);
    expect(flushes).toHaveLength(2);

    flushes[1]?.();
    expect(renders).toBe(2);
    expect(coalescer.pending).toBe(false);
  });

  it('cancels a pending flush on dispose and ignores later requestRender or stale flush calls', () => {
    const flushes: Array<() => void> = [];
    let cancels = 0;
    let renders = 0;
    const coalescer = createRenderCoalescer({
      scheduleFlush: (flush) => {
        flushes.push(flush);
        return () => {
          cancels += 1;
        };
      },
      onRender: () => {
        renders += 1;
      },
    });

    coalescer.requestRender();
    expect(coalescer.pending).toBe(true);

    coalescer.dispose();
    coalescer.dispose();
    expect(coalescer.pending).toBe(false);
    expect(cancels).toBe(1);

    // Even if the host ignores cancellation and invokes flush anyway, onRender must not run
    flushes[0]?.();
    coalescer.requestRender();
    expect(flushes).toHaveLength(1);
    expect(renders).toBe(0);
  });

  it('handles synchronous scheduleFlush execution and dispose inside onRender cleanly', () => {
    let cancels = 0;
    let renders = 0;
    const coalescer = createRenderCoalescer({
      scheduleFlush: (flush) => {
        flush();
        return () => {
          cancels += 1;
        };
      },
      onRender: () => {
        renders += 1;
        coalescer.dispose();
        coalescer.requestRender();
      },
    });

    coalescer.requestRender();
    expect(renders).toBe(1);
    expect(coalescer.pending).toBe(false);
    expect(cancels).toBe(1);
  });

  it('resets pending guard when scheduleFlush throws synchronously', () => {
    let fail = true;
    const flushes: Array<() => void> = [];
    let renders = 0;
    const coalescer = createRenderCoalescer({
      scheduleFlush: (flush) => {
        if (fail) throw new Error('scheduler unavailable');
        flushes.push(flush);
      },
      onRender: () => {
        renders += 1;
      },
    });

    expect(() => coalescer.requestRender()).toThrow('scheduler unavailable');
    expect(coalescer.pending).toBe(false);

    fail = false;
    coalescer.requestRender();
    expect(coalescer.pending).toBe(true);
    flushes[0]?.();
    expect(renders).toBe(1);
  });

  it('never lets an outer synchronous scheduleFlush cancel overwrite an inner async re-entrant cancel (#207)', () => {
    let call = 0;
    let cancel1Calls = 0;
    let cancel2Calls = 0;
    let asyncFlush: (() => void) | undefined;
    let renders = 0;

    const coalescer = createRenderCoalescer({
      scheduleFlush: (flush) => {
        call += 1;
        if (call === 1) {
          flush();
          return () => {
            cancel1Calls += 1;
          };
        }
        asyncFlush = flush;
        return () => {
          cancel2Calls += 1;
        };
      },
      onRender: () => {
        renders += 1;
        if (renders === 1) coalescer.requestRender();
      },
    });

    coalescer.requestRender();
    expect(renders).toBe(1);
    expect(coalescer.pending).toBe(true);
    expect(asyncFlush).toBeDefined();

    coalescer.dispose();
    expect(cancel1Calls).toBe(0);
    expect(cancel2Calls).toBe(1);

    asyncFlush?.();
    expect(renders).toBe(1);
  });
});
