import type { EngineEvent } from '@elv/playback';
import {
  createFakePlayerEngine,
  type FakePlayerEngine,
  type FakeStep,
} from '@elv/playback/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGateRun, createZapDriver } from './driver.ts';
import type { PlayerMetrics } from './metrics.ts';
import { type GateParams, parseGateParams, streamUrl, vodUrl } from './params.ts';

const PLAY: readonly FakeStep[] = [
  { afterMs: 0, emit: 'state', state: 'opening' },
  { afterMs: 200, emit: 'firstFrame' },
  { afterMs: 200, emit: 'state', state: 'playing' },
];
const failWith = (code: 'http-404' | 'http-509' | 'connection-limit'): readonly FakeStep[] => [
  { afterMs: 0, emit: 'state', state: 'opening' },
  { afterMs: 100, emit: 'error', error: { code } },
];

function harness(query: string, scripts: (p: GateParams) => Record<string, readonly FakeStep[]>) {
  const params = parseGateParams(`elv-gate=player&${query}`) as GateParams;
  const engine: FakePlayerEngine = createFakePlayerEngine({
    scripts: scripts(params),
    now: () => Date.now(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  const run = createGateRun({
    engine,
    params,
    now: () => Date.now(),
    later: (fn, ms) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
  });
  let result: PlayerMetrics | undefined;
  let prints = 0;
  void run.start().then((m) => {
    prints += 1;
    result = m;
  });
  return {
    engine,
    run,
    result: () => result,
    prints: () => prints,
    state: () => run.service.getState(),
  };
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createZapDriver', () => {
  it('tunes channel 0 at once, then zaps in order at the rate', () => {
    const calls: Array<[number, boolean]> = [];
    const queue: Array<() => void> = [];
    const driver = createZapDriver((i, zap) => calls.push([i, zap]), {
      channels: 3,
      zaps: 4,
      rate: 2,
      schedule: (fn, ms) => {
        expect(ms).toBe(500);
        queue.push(fn);
      },
    });
    let done = false;
    void driver.start().then(() => {
      done = true;
    });
    expect(calls).toEqual([[0, false]]);
    for (let i = 0; i < 4; i += 1) queue.shift()?.();
    expect(calls.map((c) => c[0])).toEqual([0, 1, 2, 0, 1]);
    return Promise.resolve().then(() => expect(done).toBe(true));
  });

  it('dispatches nothing after stop and resolves start', async () => {
    const calls: number[] = [];
    const queue: Array<() => void> = [];
    const driver = createZapDriver((i) => calls.push(i), {
      channels: 2,
      zaps: 5,
      rate: 1,
      schedule: (fn) => void queue.push(fn),
    });
    const started = driver.start();
    driver.stop();
    await started;
    queue.shift()?.();
    expect(calls).toEqual([0]);
  });
});

describe('createGateRun', () => {
  it('prints exactly one result per run, with the spans and counters of the zaps', async () => {
    const h = harness('channels=1,2,3&zaps=4&rate=1', (p) => ({
      [streamUrl(p, 0)]: PLAY,
      [streamUrl(p, 1)]: PLAY,
      [streamUrl(p, 2)]: PLAY,
    }));
    h.engine.surface('created');
    await advance(30_000);
    expect(h.prints()).toBe(1);
    const m = h.result();
    expect(m).toBeDefined();
    expect(m?.zaps).toBe(4);
    expect(m?.ttffColdMs).toBe(200);
    expect(m?.ttffWarmMs.p50).toBe(200);
    expect(m?.zapMs.max).toBe(200);
    expect(m?.surfaceCreated).toBe(1);
    expect(m?.staleEventsApplied).toBe(0);
    expect(m?.failures).toBe(0);
    expect(m?.fault).toBe('');
    expect(m?.faultOutcome).toBeNull();
    expect(m?.vod).toBeNull();
    await advance(60_000);
    expect(h.prints()).toBe(1);
    expect(h.engine.commands.filter((c) => c.name === 'load')).toHaveLength(5);
  });

  it('ends when the last tune that never plays fails after the silent ladder, within 15 s', async () => {
    const h = harness('channels=1,2&zaps=1&rate=1', (p) => ({
      [streamUrl(p, 0)]: PLAY,
      [streamUrl(p, 1)]: [{ afterMs: 0, emit: 'state', state: 'opening' }],
    }));
    await advance(4000);
    expect(h.result()).toBeUndefined();
    await advance(11_000);
    expect(h.result()).toMatchObject({ zaps: 1, failures: 1 });
  });

  it('counts engine-wedged errors the engine reported', async () => {
    const h = harness('channels=1,2&zaps=1&rate=1', (p) => ({ [streamUrl(p, 0)]: PLAY }));
    await advance(300);
    h.engine.emit({
      attempt: h.state().attempt,
      type: 'error',
      error: { code: 'engine-wedged' },
    } satisfies EngineEvent);
    await advance(30_000);
    expect(h.result()?.engineWedged).toBeGreaterThanOrEqual(1);
  });

  it('records a drop that recovers on the first rung as recovered', async () => {
    const h = harness('channels=1,2&zaps=1&rate=0.1&fault=drop5', (p) => ({
      [streamUrl(p, 0)]: PLAY,
    }));
    await advance(2000);
    h.engine.emit({ attempt: h.state().attempt, type: 'error', error: { code: 'network' } });
    await advance(30_000);
    expect(h.result()?.faultOutcome).toBe('recovered');
    expect(h.result()?.recoveries['1']).toBe(1);
  });

  it('records a 404 as failed-in-time', async () => {
    const h = harness('channels=1,2&zaps=1&rate=0.1&fault=404', (p) => ({
      [streamUrl(p, 0)]: failWith('http-404'),
    }));
    await advance(40_000);
    expect(h.result()?.faultOutcome).toBe('failed-in-time');
    expect(h.result()?.failures).toBe(1);
  });

  it.each([
    ['509', 'http-509'],
    ['notice', 'connection-limit'],
  ] as const)('records a %s fault as limited-backoff', async (fault, code) => {
    const h = harness(`channels=1,2&zaps=1&rate=0.1&fault=${fault}`, (p) => ({
      [streamUrl(p, 0)]: failWith(code),
    }));
    await advance(40_000);
    expect(h.result()?.faultOutcome).toBe('limited-backoff');
  });

  it('records the vod part: playing, pause, play, seek to 60 s and playing again', async () => {
    const h = harness('channels=1,2&zaps=1&rate=1&vod=900', (p) => ({
      [streamUrl(p, 0)]: PLAY,
      [streamUrl(p, 1)]: PLAY,
      [vodUrl(p)]: PLAY,
    }));
    const names = () => h.engine.commands.map((c) => c.name);
    for (let i = 0; i < 100 && !names().includes('pause'); i += 1) await advance(100);
    expect(names().at(-1)).toBe('pause');
    expect(h.result()).toBeUndefined();
    await advance(850);
    expect(names().at(-1)).toBe('pause');
    await advance(200);
    expect(names().slice(-2)).toEqual(['play', 'seek']);
    expect(h.engine.commands.at(-1)?.positionMs).toBe(60_000);
    h.engine.emit({
      attempt: h.state().attempt,
      type: 'clock',
      anchor: { positionMs: 60_100, atMs: Date.now(), rate: 1 },
    });
    await advance(100);
    expect(h.result()?.vod).toEqual({ playing: true, seeked: true });
    expect(h.result()?.zaps).toBe(1);
  });

  it('records seeked false when the position never reaches the target', async () => {
    const h = harness('channels=1&zaps=1&rate=5&vod=900', (p) => ({
      [streamUrl(p, 0)]: PLAY,
      [vodUrl(p)]: PLAY,
    }));
    await advance(60_000);
    expect(h.result()?.vod).toEqual({ playing: true, seeked: false });
  });

  it('records playing false and skips the rest when the vod never plays', async () => {
    const h = harness('channels=1&zaps=1&rate=5&vod=900', (p) => ({
      [streamUrl(p, 0)]: PLAY,
      [vodUrl(p)]: failWith('http-404'),
    }));
    await advance(60_000);
    expect(h.result()?.vod).toEqual({ playing: false, seeked: false });
    expect(h.engine.commands.some((c) => c.name === 'seek')).toBe(false);
  });

  it('does not count the vod tune as a stale event or a warm tune', async () => {
    const h = harness('channels=1&zaps=1&rate=5&vod=900', (p) => ({
      [streamUrl(p, 0)]: PLAY,
      [vodUrl(p)]: PLAY,
    }));
    await advance(60_000);
    expect(h.result()?.staleEventsApplied).toBe(0);
    expect(h.result()?.ttffWarmMs.p50).toBe(200);
  });

  it('zapBy moves one channel from the current one and counts as a zap', async () => {
    const h = harness('channels=1,2,3&zaps=1&rate=0.1', (p) => ({ [streamUrl(p, 0)]: PLAY }));
    await advance(1000);
    h.run.zapBy(1);
    expect(h.state().item).toBe('2');
    h.run.zapBy(-2);
    expect(h.state().item).toBe('3');
    await advance(60_000);
    expect(h.result()?.zaps).toBe(3);
  });

  it('stop dispatches nothing more and resolves with what was measured', async () => {
    const h = harness('channels=1,2&zaps=50&rate=0.5', () => ({}));
    await advance(3000);
    h.run.stop();
    await advance(60_000);
    expect(h.engine.commands.filter((c) => c.name === 'load').length).toBeLessThanOrEqual(3);
    expect(h.result()).toBeDefined();
  });

  it('stop as the vod pauses skips the pause sleep, play and seek and leaves no timer', async () => {
    const h = harness('channels=1&zaps=1&rate=5&vod=900', (p) => ({
      [streamUrl(p, 0)]: PLAY,
      [vodUrl(p)]: PLAY,
    }));
    let playingAttempt: number | undefined;
    h.run.service.subscribe((state) => {
      if (state.item !== '900') return;
      if (playingAttempt === undefined && state.status.kind === 'playing')
        playingAttempt = state.attempt;
      else if (playingAttempt !== undefined && state.attempt > playingAttempt) h.run.stop();
    });
    for (let i = 0; i < 100 && h.result() === undefined; i += 1) await advance(100);
    expect(h.result()?.vod).toEqual({ playing: true, seeked: false });
    const names = h.engine.commands.map((c) => c.name);
    expect(names).toContain('pause');
    expect(names).not.toContain('play');
    expect(names).not.toContain('seek');
    h.run.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
