import type { EngineEvent } from '@elv/playback';
import {
  createFakePlayerEngine,
  ENGINE_CONTRACT_CASES,
  type EngineContractHarness,
} from '@elv/playback/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isPlayerAreaMessage,
  isPlayerCommandMessage,
  type PlayerBridge,
  type PlayerEventMessage,
  type PlayerUiMessage,
} from '../../../src/shared/player-ipc.ts';
import { createDesktopEngine } from './desktop-engine.ts';

/** The main clock runs 5,000 ms ahead of the renderer's. */
const MAIN_SHIFT_MS = 5000;

/**
 * An in-memory bridge whose main side validates like the real one and wraps a fake engine on the shifted clock,
 * so the proxy has to map `atMs` back to pass the same contract as any engine.
 */
function memoryBridge() {
  const engine = createFakePlayerEngine({
    scripts: {
      'http://sim/missing': [{ afterMs: 50, emit: 'error', error: { code: 'http-404' } }],
    },
    now: () => Date.now() + MAIN_SHIFT_MS,
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    anchorOnPlayPause: true,
  });
  const eventListeners = new Set<(m: PlayerEventMessage) => void>();
  const uiListeners = new Set<(m: PlayerUiMessage) => void>();
  engine.subscribe((event) => {
    for (const l of [...eventListeners]) l({ engineId: 'mem-1', event });
  });
  const bridge: PlayerBridge = {
    open: async () => ({ engineId: 'mem-1', mainNowMs: Date.now() + MAIN_SHIFT_MS }),
    close: async () => undefined,
    send: (m) => {
      expect(isPlayerCommandMessage(m)).toBe(true);
      const c = m.command;
      switch (c.name) {
        case 'load':
          return engine.load(c.cmd);
        case 'retry':
        case 'play':
        case 'pause':
        case 'stop':
        case 'recreate':
          return engine[c.name](c.attempt);
        case 'seek':
          return engine.seek(c.attempt, c.positionMs);
        case 'release':
          return engine.release();
        case 'fullscreen':
          return;
      }
    },
    setArea: (m) => void expect(isPlayerAreaMessage(m)).toBe(true),
    onEvent: (l) => {
      eventListeners.add(l);
      return () => eventListeners.delete(l);
    },
    onUi: (l) => {
      uiListeners.add(l);
      return () => uiListeners.delete(l);
    },
    reportGate: () => undefined,
  };
  return { bridge, engine };
}

async function proxyHarness(): Promise<EngineContractHarness> {
  const { bridge, engine: main } = memoryBridge();
  const engine = await createDesktopEngine(bridge, () => Date.now());
  return {
    engine,
    urls: {
      plays: 'http://sim/plays',
      playsToo: 'http://sim/plays-too',
      notFound: 'http://sim/missing',
    },
    settle: async () => {
      await vi.advanceTimersByTimeAsync(1000);
    },
    maxConcurrentMedias: () => main.maxConcurrentMedias(),
    dispose: async () => engine.release(),
  };
}

describe('desktop engine proxy against the engine contract', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  for (const c of ENGINE_CONTRACT_CASES) {
    it(c.name, async () => {
      const h = await proxyHarness();
      try {
        await c.run(h);
      } finally {
        await h.dispose();
      }
    });
  }

  it('hands the renderer clock times for firstFrame', async () => {
    const h = await proxyHarness();
    const events: EngineEvent[] = [];
    h.engine.subscribe((e) => events.push(e));
    h.engine.load({ attempt: 1, url: h.urls.plays, headers: {}, kind: 'live' });
    const before = Date.now();
    await h.settle();
    const frame = events.find((e) => e.type === 'firstFrame');
    expect(frame?.type === 'firstFrame' && frame.atMs).toBeGreaterThanOrEqual(before);
    expect(frame?.type === 'firstFrame' && frame.atMs).toBeLessThanOrEqual(Date.now());
    await h.dispose();
  });
});
