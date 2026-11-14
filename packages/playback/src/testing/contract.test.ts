import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENGINE_CONTRACT_CASES, type EngineContractHarness } from './contract';
import { createFakePlayerEngine } from './fake-engine';

function fakeHarness(): EngineContractHarness {
  const urls = {
    plays: 'http://sim/plays',
    playsToo: 'http://sim/plays-too',
    notFound: 'http://sim/missing',
  };
  const engine = createFakePlayerEngine({
    scripts: { [urls.notFound]: [{ afterMs: 50, emit: 'error', error: { code: 'http-404' } }] },
    now: () => Date.now(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  return {
    engine,
    urls,
    settle: async () => {
      await vi.advanceTimersByTimeAsync(1000);
    },
    maxConcurrentMedias: () => engine.maxConcurrentMedias(),
    dispose: async () => {
      engine.release();
    },
  };
}

describe('engine contract against the fake engine', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  for (const c of ENGINE_CONTRACT_CASES) {
    it(c.name, async () => {
      const h = fakeHarness();
      try {
        await c.run(h);
      } finally {
        await h.dispose();
      }
    });
  }

  it('lists the eight agreed cases', () => {
    expect(ENGINE_CONTRACT_CASES).toHaveLength(8);
  });
});
