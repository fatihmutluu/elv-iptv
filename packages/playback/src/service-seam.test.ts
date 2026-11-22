import { ok, type Result } from '@elv/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamRequest } from './engine';
import type { RecoveryHooks, ServiceControl } from './seam';
import { createPlaybackService, createPlaybackServiceWith } from './service';
import { createFakePlayerEngine, type FakePlayerEngine, type FakeStep } from './testing';
import type { PlaybackService, PlaybackState, TuneRequest } from './types';

const req = (url: string): StreamRequest => ({ url, headers: { 'x-a': 'b' } });

interface Deferred {
  promise: Promise<Result<StreamRequest>>;
  settle: (r: Result<StreamRequest>) => void;
}
function deferred(): Deferred {
  let settle!: (r: Result<StreamRequest>) => void;
  const promise = new Promise<Result<StreamRequest>>((res) => {
    settle = res;
  });
  return { promise, settle };
}

function setup(
  hooks?: RecoveryHooks,
  scripts: Record<string, readonly FakeStep[]> = {},
): { engine: FakePlayerEngine; service: PlaybackService } {
  const engine = createFakePlayerEngine({
    scripts,
    now: () => Date.now(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  const deps = {
    engine,
    clock: { now: () => Date.now() },
    timers: {
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
    config: { startTimeoutMs: 8000 },
  };
  const service = hooks
    ? createPlaybackServiceWith(deps, () => hooks)
    : createPlaybackService(deps);
  return { engine, service };
}

const tuneReq = (url: string, extra: Partial<TuneRequest> = {}): TuneRequest => ({
  item: `item-${url}`,
  accountKey: 'acc',
  kind: 'live',
  resolve: () => Promise.resolve(ok(req(url))),
  ...extra,
});

const loads = (e: FakePlayerEngine) => e.commands.filter((c) => c.name === 'load');
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('recovery hooks', () => {
  it('routes events and user actions to the hooks', async () => {
    const calls: string[] = [];
    const hooks: RecoveryHooks = {
      onTune: (r) => {
        calls.push(`tune:${r.item}`);
        return false;
      },
      onReset: () => calls.push('reset'),
      onSeek: (ms) => calls.push(`seek:${ms}`),
      onPause: () => calls.push('pause'),
      onPlay: () => calls.push('play'),
      onState: (s) => calls.push(`state:${s}`),
      onClock: () => calls.push('clock'),
      onError: (e) => calls.push(`error:${e.code}`),
      onStall: (p) => calls.push(`stall:${p}`),
      onProgress: (atMs, bytes) => calls.push(`progress:${atMs}:${bytes ?? 'none'}`),
      onStartTimeout: () => calls.push('start-timeout'),
      onSurface: (c) => calls.push(`surface:${c}`),
      onDispose: () => calls.push('dispose'),
    };
    const { engine: e, service: s } = setup(hooks, { silent: [] });
    const t = s.tune(tuneReq('silent'));
    await vi.advanceTimersByTimeAsync(8000);
    e.emit({ attempt: t, type: 'error', error: { code: 'network' } });
    e.emit({ attempt: t, type: 'stall', phase: 'start', atMs: 0 });
    e.emit({ attempt: t, type: 'progress', bytesReceived: 2048, atMs: 9000 });
    e.emit({ attempt: t, type: 'state', state: 'buffering' });
    e.emit({ attempt: t, type: 'clock', anchor: { positionMs: 1, atMs: 1000, rate: 1 } });
    e.surface('created');
    s.seek(5);
    s.pause();
    s.play();
    s.retry();
    s.stop();
    s.dispose();
    expect(calls).toEqual([
      'tune:item-silent',
      'start-timeout',
      'error:network',
      'stall:start',
      'progress:9000:2048',
      'state:buffering',
      'clock',
      'surface:created',
      'seek:5',
      'pause',
      'play',
      'reset',
      'reset',
      'dispose',
    ]);
    expect(s.getState().status).toEqual({ kind: 'idle' });
  });

  it('leaves exactly one start timeout after A, B and C are tuned', async () => {
    let timeouts = 0;
    const onStartTimeout = () => {
      timeouts += 1;
    };
    const { service: s } = setup({ onStartTimeout }, { A: [], B: [], C: [] });
    expect(vi.getTimerCount()).toBe(0);
    s.tune(tuneReq('A'));
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    s.tune(tuneReq('B'));
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    s.tune(tuneReq('C'));
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(20000);
    expect(timeouts).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a held tune keeps the status and loads only when the recovery says so', async () => {
    let ctl!: ServiceControl;
    let hold = false;
    const e = createFakePlayerEngine({
      now: Date.now,
      schedule: setTimeout,
      cancel: (h) => clearTimeout(h as never),
    });
    const deps = { engine: e, clock: { now: Date.now }, timers: { setTimeout, clearTimeout } };
    const s = createPlaybackServiceWith(deps, (c) => {
      ctl = c;
      return { onTune: () => hold };
    });
    const spy = vi.spyOn(e, 'load');
    s.tune(tuneReq('A'));
    await flush();
    ctl.setStatus({ kind: 'limited', nextAtMs: 9 });
    hold = true;
    const tb = s.tune(tuneReq('B', { startMs: 7 }));
    await flush();
    expect(s.getState().status).toEqual({ kind: 'limited', nextAtMs: 9 });
    expect(loads(e)).toHaveLength(1);
    expect(ctl.request()?.item).toBe('item-B');
    ctl.load({ startMs: 3, options: { softwareAudio: true } });
    expect(spy).toHaveBeenLastCalledWith({
      ...req('B'),
      attempt: tb,
      kind: 'live',
      startMs: 3,
      options: { softwareAudio: true },
    });
    ctl.load({ stream: req('C') });
    ctl.load();
    expect(spy).toHaveBeenLastCalledWith({ ...req('C'), attempt: tb, kind: 'live', startMs: 7 });
    expect(loads(e).map((c) => c.url)).toEqual(['A', 'B', 'C', 'C']);
    ctl.stopMedia();
    expect(e.commands.at(-1)).toEqual({ name: 'stop', attempt: tb });
    expect(e.openMedias()).toBe(0);
  });

  it('lets hooks drive the service through the control surface', async () => {
    let ctl!: ServiceControl;
    const e = createFakePlayerEngine({
      now: Date.now,
      schedule: setTimeout,
      cancel: (h) => clearTimeout(h as never),
    });
    const deps = { engine: e, clock: { now: Date.now }, timers: { setTimeout, clearTimeout } };
    const s2 = createPlaybackServiceWith(deps, (c) => {
      ctl = c;
      return {};
    });
    expect(ctl.request()).toBeUndefined();
    const t = s2.tune(tuneReq('A'));
    await flush();
    const t2 = ctl.nextAttempt();
    expect(t2).toBe(t + 1);
    ctl.setStatus({ kind: 'recovering', rung: 1, nextAtMs: 5 });
    expect(s2.getState().status).toEqual({ kind: 'recovering', rung: 1, nextAtMs: 5 });
    ctl.engine.retry(t2);
    ctl.armStartTimeout(100);
    ctl.fail({ category: 'playback', code: 'x' });
    expect(s2.getState().status.kind).toBe('failed');
    ctl.armStartTimeout(100);
    ctl.clearStartTimeout();
    expect(ctl.config.limitTotalMs).toBe(60000);
    expect(ctl.now()).toBe(Date.now());
    expect(ctl.getState().attempt).toBe(t2);
    const h = ctl.setTimer(() => {}, 10);
    ctl.clearTimer(h);
  });
});

describe('subscription, dispose and robustness', () => {
  it('notifies on every change and unsubscribes', async () => {
    const { service } = setup();
    const seen: PlaybackState[] = [];
    const off = service.subscribe((s) => seen.push(s));
    service.tune(tuneReq('A'));
    await vi.advanceTimersByTimeAsync(300);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]?.status.kind).toBe('tuning');
    off();
    const n = seen.length;
    service.stop();
    expect(seen).toHaveLength(n);
  });

  it('dispose detaches from the engine and turns later calls into no-ops', async () => {
    const { engine, service } = setup();
    const d = deferred();
    service.tune(tuneReq('A', { resolve: () => d.promise }));
    const listener = vi.fn();
    service.subscribe(listener);
    service.dispose();
    d.settle(ok(req('A')));
    await flush();
    expect(loads(engine)).toHaveLength(0);
    expect(service.tune(tuneReq('B'))).toBe(service.getState().attempt);
    service.pause();
    service.stop();
    service.retry();
    service.dispose();
    expect(engine.commands).toHaveLength(0);
    engine.emit({ attempt: 1, type: 'state', state: 'playing' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps a synchronous load error instead of a later start timeout', async () => {
    const { engine, service } = setup();
    const load = engine.load.bind(engine);
    vi.spyOn(engine, 'load').mockImplementation((cmd) => {
      load(cmd);
      engine.emit({ attempt: cmd.attempt, type: 'error', error: { code: 'http-401' } });
    });
    service.tune(tuneReq('A'));
    await vi.advanceTimersByTimeAsync(20000);
    expect(service.getState().status).toEqual({
      kind: 'failed',
      error: { category: 'playback', code: 'http-401' },
    });
    expect(engine.commands.filter((c) => c.name === 'stop')).toHaveLength(1);
  });

  it('keeps a synchronous retry error instead of a later start timeout', async () => {
    const { engine, service } = setup();
    service.tune(tuneReq('A'));
    await vi.advanceTimersByTimeAsync(400);
    const retry = engine.retry.bind(engine);
    vi.spyOn(engine, 'retry').mockImplementation((attempt) => {
      retry(attempt);
      engine.emit({ attempt, type: 'error', error: { code: 'http-401' } });
    });
    service.retry();
    await vi.advanceTimersByTimeAsync(20000);
    expect(service.getState().status).toEqual({
      kind: 'failed',
      error: { category: 'playback', code: 'http-401' },
    });
  });

  it('fails the tune when the resolver throws synchronously', async () => {
    const { engine, service } = setup();
    const throwing = tuneReq('A', {
      resolve: () => {
        throw new Error('boom');
      },
    });
    expect(() => service.tune(throwing)).not.toThrow();
    await flush();
    expect(service.getState().status).toEqual({
      kind: 'failed',
      error: { category: 'network', code: 'resolve-failed' },
    });
    expect(loads(engine)).toHaveLength(0);
  });

  it('delivers surface events tagged with the previous token to the hooks', async () => {
    const seen: string[] = [];
    const { engine, service } = setup({ onSurface: (c) => seen.push(c) });
    service.tune(tuneReq('A'));
    await flush();
    service.tune(tuneReq('B', { resolve: () => new Promise(() => {}) }));
    engine.surface('destroyed');
    expect(seen).toEqual(['destroyed']);
    expect(service.getState().staleEventsDropped).toBe(0);
  });
});
