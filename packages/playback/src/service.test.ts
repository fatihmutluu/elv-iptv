import { elvError, err, ok, type Result } from '@elv/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAYBACK_CONFIG } from './config';
import type { StreamRequest } from './engine';
import {
  createPlaybackService,
  type PlaybackService,
  type PlaybackState,
  type RecoveryHooks,
  type TuneRequest,
} from './service';
import { createFakePlayerEngine, type FakePlayerEngine } from './testing';

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

function setup(hooks?: RecoveryHooks): { engine: FakePlayerEngine; service: PlaybackService } {
  const engine = createFakePlayerEngine({
    now: () => Date.now(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  const service = createPlaybackService({
    engine,
    clock: { now: () => Date.now() },
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
    config: { startTimeoutMs: 8000 },
    ...(hooks ? { recovery: () => hooks } : {}),
  });
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
afterEach(() => vi.useRealTimers());

describe('config', () => {
  it('has the spec defaults', () => {
    expect(DEFAULT_PLAYBACK_CONFIG).toEqual({
      liveStallWindowMs: 4000,
      startTimeoutMs: 8000,
      rungTimeoutMs: 4000,
      ladderGapsMs: [0, 1000, 2000, 4000],
      stableRestoreMs: 30000,
      limitBackoffMs: [2000, 4000, 8000, 15000],
      limitTotalMs: 60000,
      vodReconnectWindowMs: 120000,
    });
  });
});

describe('tune', () => {
  it('returns a new token, sets tuning and tuneAt', () => {
    const { service } = setup();
    expect(service.getState().status).toEqual({ kind: 'idle' });
    const t1 = service.tune(tuneReq('http://a/1'));
    const t2 = service.tune(tuneReq('http://a/2'));
    expect(t2).toBeGreaterThan(t1);
    const s = service.getState();
    expect(s.status).toEqual({ kind: 'tuning' });
    expect(s.attempt).toBe(t2);
    expect(s.tuneAt).toBe(1000);
    expect(s.item).toBe('item-http://a/2');
    expect(s.accountKey).toBe('acc');
  });

  it('sends exactly one load after resolve', async () => {
    const { engine, service } = setup();
    const t = service.tune(tuneReq('http://a/1', { startMs: 5, kind: 'vod' }));
    expect(loads(engine)).toHaveLength(0);
    await flush();
    expect(loads(engine)).toEqual([{ name: 'load', attempt: t, url: 'http://a/1' }]);
  });

  it('passes headers, kind and startMs to the engine', async () => {
    const { service } = setup();
    const seen: unknown[] = [];
    const engine = createFakePlayerEngine({
      now: Date.now,
      schedule: setTimeout,
      cancel: (h) => clearTimeout(h as never),
    });
    const spy = vi.spyOn(engine, 'load').mockImplementation((c) => void seen.push(c));
    const s2 = createPlaybackService({
      engine,
      clock: { now: Date.now },
      timers: {
        setTimeout: (f, m) => setTimeout(f, m),
        clearTimeout: (h) => clearTimeout(h as never),
      },
    });
    const t = s2.tune(tuneReq('http://a/1', { startMs: 5, kind: 'vod' }));
    await flush();
    expect(spy).toHaveBeenCalledOnce();
    expect(seen[0]).toEqual({
      attempt: t,
      url: 'http://a/1',
      headers: { 'x-a': 'b' },
      kind: 'vod',
      startMs: 5,
    });
    expect(service.getState().status.kind).toBe('idle');
  });

  it('omits startMs when not given', async () => {
    const engine = createFakePlayerEngine({
      now: Date.now,
      schedule: setTimeout,
      cancel: (h) => clearTimeout(h as never),
    });
    const seen: object[] = [];
    vi.spyOn(engine, 'load').mockImplementation((c) => void seen.push(c));
    const s = createPlaybackService({
      engine,
      clock: { now: Date.now },
      timers: {
        setTimeout: (f, m) => setTimeout(f, m),
        clearTimeout: (h) => clearTimeout(h as never),
      },
    });
    s.tune(tuneReq('http://a/1'));
    await flush();
    expect('startMs' in (seen[0] as object)).toBe(false);
  });

  it('loads only the newest tune when resolves settle out of order', async () => {
    const { engine, service } = setup();
    const a = deferred();
    const b = deferred();
    const c = deferred();
    service.tune(tuneReq('A', { resolve: () => a.promise }));
    service.tune(tuneReq('B', { resolve: () => b.promise }));
    const tc = service.tune(tuneReq('C', { resolve: () => c.promise }));
    c.settle(ok(req('C')));
    await flush();
    a.settle(ok(req('A')));
    await flush();
    b.settle(ok(req('B')));
    await flush();
    expect(loads(engine)).toEqual([{ name: 'load', attempt: tc, url: 'C' }]);
  });

  it('ignores a failed resolve of a superseded tune', async () => {
    const { service } = setup();
    const a = deferred();
    service.tune(tuneReq('A', { resolve: () => a.promise }));
    service.tune(tuneReq('B', { resolve: () => new Promise(() => {}) }));
    a.settle(err(elvError('network', 'timeout')));
    await flush();
    expect(service.getState().status).toEqual({ kind: 'tuning' });
  });

  it('fails the tune without loading when resolve fails', async () => {
    const { engine, service } = setup();
    service.tune(
      tuneReq('A', { resolve: () => Promise.resolve(err(elvError('auth', 'expired'))) }),
    );
    await flush();
    expect(service.getState().status).toEqual({
      kind: 'failed',
      error: { category: 'auth', code: 'expired' },
    });
    expect(loads(engine)).toHaveLength(0);
  });

  it('fails the tune when resolve rejects', async () => {
    const { engine, service } = setup();
    service.tune(tuneReq('A', { resolve: () => Promise.reject(new Error('boom')) }));
    await flush();
    expect(service.getState().status).toEqual({
      kind: 'failed',
      error: { category: 'network', code: 'resolve-failed' },
    });
    expect(loads(engine)).toHaveLength(0);
  });
});

describe('engine events', () => {
  it('tracks firstFrame, playing and clock anchors', async () => {
    const { service } = setup();
    service.tune(tuneReq('A'));
    await vi.advanceTimersByTimeAsync(300);
    const s = service.getState();
    expect(s.firstFrameAt).toBe(1300);
    await vi.advanceTimersByTimeAsync(0);
    expect(service.getState().status).toEqual({ kind: 'playing' });
  });

  it('keeps tuning on opening, buffering and ready', async () => {
    const { engine, service } = setup();
    const t = service.tune(tuneReq('A'));
    await flush();
    for (const state of ['opening', 'buffering', 'ready'] as const) {
      engine.emit({ attempt: t, type: 'state', state });
      expect(service.getState().status).toEqual({ kind: 'tuning' });
    }
  });

  it('follows paused and ended states', async () => {
    const { engine, service } = setup();
    const t = service.tune(tuneReq('A'));
    await flush();
    engine.emit({ attempt: t, type: 'state', state: 'paused' });
    expect(service.getState().status).toEqual({ kind: 'paused' });
    engine.emit({ attempt: t, type: 'state', state: 'playing' });
    expect(service.getState().status).toEqual({ kind: 'playing' });
    engine.emit({ attempt: t, type: 'state', state: 'ended' });
    expect(service.getState().status).toEqual({ kind: 'idle' });
  });

  it('stores the latest clock anchor as sent', async () => {
    const { engine, service } = setup();
    const t = service.tune(tuneReq('A'));
    await flush();
    const anchor = { positionMs: 10, atMs: 5, rate: 1, durationMs: 100 };
    engine.emit({ attempt: t, type: 'clock', anchor });
    expect(service.getState().anchor).toEqual(anchor);
  });

  it('drops events with an older token and counts them', async () => {
    const { engine, service } = setup();
    const t1 = service.tune(tuneReq('A'));
    const t2 = service.tune(tuneReq('B'));
    await flush();
    engine.emit({ attempt: t1, type: 'state', state: 'playing' });
    engine.emit({ attempt: t1, type: 'error', error: { code: 'network' } });
    const s = service.getState();
    expect(s.attempt).toBe(t2);
    expect(s.status).toEqual({ kind: 'tuning' });
    expect(s.staleEventsDropped).toBe(2);
  });

  it('does not notify subscribers for dropped events', async () => {
    const { engine, service } = setup();
    const t1 = service.tune(tuneReq('A'));
    service.tune(tuneReq('B'));
    await flush();
    const listener = vi.fn();
    service.subscribe(listener);
    engine.emit({ attempt: t1, type: 'state', state: 'playing' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('ignores surface events and events after idle or failure', async () => {
    const { engine, service } = setup();
    const t = service.tune(tuneReq('A'));
    await flush();
    engine.surface('destroyed');
    expect(service.getState().status).toEqual({ kind: 'tuning' });
    service.stop();
    engine.emit({ attempt: t, type: 'state', state: 'playing' });
    expect(service.getState().status).toEqual({ kind: 'idle' });
  });
});

describe('failures', () => {
  it('an engine error fails with the playback error and stops', async () => {
    const { engine, service } = setup();
    const t = service.tune(tuneReq('A'));
    await flush();
    engine.emit({ attempt: t, type: 'error', error: { code: 'http-404', detail: 'x' } });
    expect(service.getState().status).toEqual({
      kind: 'failed',
      error: { category: 'playback', code: 'http-404', detail: 'x' },
    });
    expect(engine.commands.at(-1)).toEqual({ name: 'stop', attempt: t });
  });

  it('start timeout fails with network and stops', async () => {
    const { engine, service } = setup();
    const t = service.tune(tuneReq('slow'));
    await flush();
    engine.emit({ attempt: t, type: 'state', state: 'opening' });
    // default script gives firstFrame at 300 ms, so use a scripted silence instead
    service.stop();
    const e2 = createFakePlayerEngine({
      now: Date.now,
      schedule: setTimeout,
      cancel: (h) => clearTimeout(h as never),
      scripts: { silent: [] },
    });
    const s2 = createPlaybackService({
      engine: e2,
      clock: { now: Date.now },
      timers: {
        setTimeout: (f, m) => setTimeout(f, m),
        clearTimeout: (h) => clearTimeout(h as never),
      },
    });
    const t2 = s2.tune(tuneReq('silent'));
    await vi.advanceTimersByTimeAsync(7999);
    expect(s2.getState().status).toEqual({ kind: 'tuning' });
    await vi.advanceTimersByTimeAsync(1);
    expect(s2.getState().status).toEqual({
      kind: 'failed',
      error: { category: 'playback', code: 'network' },
    });
    expect(e2.commands.at(-1)).toEqual({ name: 'stop', attempt: t2 });
    expect(engine.commands.filter((c) => c.name === 'stop')).toHaveLength(1);
  });

  it('firstFrame cancels the start timeout', async () => {
    const { service } = setup();
    service.tune(tuneReq('A'));
    await vi.advanceTimersByTimeAsync(20000);
    expect(service.getState().status).toEqual({ kind: 'playing' });
  });

  it('a new tune cancels the pending start timeout', async () => {
    const e = createFakePlayerEngine({
      now: Date.now,
      schedule: setTimeout,
      cancel: (h) => clearTimeout(h as never),
      scripts: { silent: [] },
    });
    const s = createPlaybackService({
      engine: e,
      clock: { now: Date.now },
      timers: {
        setTimeout: (f, m) => setTimeout(f, m),
        clearTimeout: (h) => clearTimeout(h as never),
      },
    });
    s.tune(tuneReq('silent'));
    await vi.advanceTimersByTimeAsync(5000);
    s.tune(tuneReq('other'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.getState().status).toEqual({ kind: 'playing' });
  });
});

describe('commands', () => {
  it('stop sends stop with the current token and sets idle', async () => {
    const { engine, service } = setup();
    const t = service.tune(tuneReq('A'));
    await flush();
    service.stop();
    expect(engine.commands.at(-1)).toEqual({ name: 'stop', attempt: t });
    expect(service.getState().status).toEqual({ kind: 'idle' });
  });

  it('stop during resolve prevents the load', async () => {
    const { engine, service } = setup();
    const d = deferred();
    service.tune(tuneReq('A', { resolve: () => d.promise }));
    service.stop();
    d.settle(ok(req('A')));
    await flush();
    expect(loads(engine)).toHaveLength(0);
  });

  it('stop while idle is a no-op', () => {
    const { engine, service } = setup();
    service.stop();
    expect(engine.commands).toHaveLength(0);
  });

  it('pause, play and seek forward with the current token', async () => {
    const { engine, service } = setup();
    const t = service.tune(tuneReq('A'));
    await flush();
    service.pause();
    service.play();
    service.seek(4200);
    expect(engine.commands.slice(-3)).toEqual([
      { name: 'pause', attempt: t },
      { name: 'play', attempt: t },
      { name: 'seek', attempt: t, positionMs: 4200 },
    ]);
  });

  it('pause, play and seek do nothing while nothing is loaded', () => {
    const { engine, service } = setup();
    service.pause();
    service.play();
    service.seek(1);
    service.retry();
    expect(engine.commands).toHaveLength(0);
  });

  it('retry on loaded media takes a new token and re-arms the start timeout', async () => {
    const { engine, service } = setup();
    const t = service.tune(tuneReq('A'));
    await vi.advanceTimersByTimeAsync(300);
    service.retry();
    const s = service.getState();
    expect(s.attempt).toBe(t + 1);
    expect(s.status).toEqual({ kind: 'tuning' });
    expect(engine.commands.at(-1)).toEqual({ name: 'retry', attempt: t + 1 });
  });

  it('retry after a failure tunes the last request again', async () => {
    const { engine, service } = setup();
    const t = service.tune(tuneReq('A'));
    await flush();
    engine.emit({ attempt: t, type: 'error', error: { code: 'network' } });
    service.retry();
    await flush();
    expect(service.getState().attempt).toBe(t + 1);
    expect(loads(engine).map((c) => c.attempt)).toEqual([t, t + 1]);
  });
});

describe('zap window', () => {
  it('pause, seek and retry during the resolve of a zap do not reach the old media', async () => {
    const { engine, service } = setup();
    service.tune(tuneReq('A'));
    await vi.advanceTimersByTimeAsync(400);
    const d = deferred();
    service.tune(tuneReq('B', { resolve: () => d.promise }));
    const before = engine.commands.length;
    service.pause();
    service.play();
    service.seek(10);
    service.retry();
    const names = engine.commands.slice(before).map((c) => c.name);
    expect(names).not.toContain('pause');
    expect(names).not.toContain('play');
    expect(names).not.toContain('seek');
    expect(names).not.toContain('retry');
    expect(service.getState().item).toBe('item-B');
  });

  it('B still loads after a pause during its resolve', async () => {
    const { engine, service } = setup();
    service.tune(tuneReq('A'));
    await vi.advanceTimersByTimeAsync(400);
    const d = deferred();
    const tb = service.tune(tuneReq('B', { resolve: () => d.promise }));
    service.pause();
    d.settle(ok(req('B')));
    await flush();
    expect(loads(engine).map((c) => c.url)).toEqual(['A', 'B']);
    expect(loads(engine).at(-1)?.attempt).toBe(tb);
  });
});

describe('subscription and dispose', () => {
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
});

describe('recovery hooks', () => {
  it('routes error, stall and start timeout to the hooks instead of failing', async () => {
    const calls: string[] = [];
    const hooks: RecoveryHooks = {
      onError: (e) => calls.push(`error:${e.code}`),
      onStall: (p) => calls.push(`stall:${p}`),
      onStartTimeout: () => calls.push('start-timeout'),
      onSurface: (c) => calls.push(`surface:${c}`),
      onDispose: () => calls.push('dispose'),
    };
    const e = createFakePlayerEngine({
      now: Date.now,
      schedule: setTimeout,
      cancel: (h) => clearTimeout(h as never),
      scripts: { silent: [] },
    });
    const s = createPlaybackService({
      engine: e,
      clock: { now: Date.now },
      timers: {
        setTimeout: (f, m) => setTimeout(f, m),
        clearTimeout: (h) => clearTimeout(h as never),
      },
      recovery: () => hooks,
    });
    const t = s.tune(tuneReq('silent'));
    await vi.advanceTimersByTimeAsync(8000);
    e.emit({ attempt: t, type: 'error', error: { code: 'network' } });
    e.emit({ attempt: t, type: 'stall', phase: 'start', atMs: 0 });
    e.surface('created');
    s.dispose();
    expect(calls).toEqual([
      'start-timeout',
      'error:network',
      'stall:start',
      'surface:created',
      'dispose',
    ]);
    expect(s.getState().status).toEqual({ kind: 'tuning' });
  });

  it('leaves exactly one start timeout after A, B and C are tuned', async () => {
    let timeouts = 0;
    const e = createFakePlayerEngine({
      now: Date.now,
      schedule: setTimeout,
      cancel: (h) => clearTimeout(h as never),
      scripts: { A: [], B: [], C: [] },
    });
    const s = createPlaybackService({
      engine: e,
      clock: { now: Date.now },
      timers: {
        setTimeout: (f, m) => setTimeout(f, m),
        clearTimeout: (h) => clearTimeout(h as never),
      },
      recovery: () => ({
        onStartTimeout: () => {
          timeouts += 1;
        },
      }),
    });
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

  it('lets hooks drive the service through the control surface', async () => {
    let ctl!: Parameters<NonNullable<Parameters<typeof createPlaybackService>[0]['recovery']>>[0];
    const e = createFakePlayerEngine({
      now: Date.now,
      schedule: setTimeout,
      cancel: (h) => clearTimeout(h as never),
    });
    const s = createPlaybackService({
      engine: e,
      clock: { now: Date.now },
      timers: {
        setTimeout: (f, m) => setTimeout(f, m),
        clearTimeout: (h) => clearTimeout(h as never),
      },
      recovery: (c) => {
        ctl = c;
        return {};
      },
    });
    const t = s.tune(tuneReq('A'));
    await flush();
    const t2 = ctl.nextAttempt();
    expect(t2).toBe(t + 1);
    expect(ctl.currentAttempt()).toBe(t2);
    ctl.setStatus({ kind: 'recovering', rung: 1, nextAtMs: 5 });
    expect(s.getState().status).toEqual({ kind: 'recovering', rung: 1, nextAtMs: 5 });
    ctl.engine.retry(t2);
    ctl.armStartTimeout(100);
    ctl.fail({ category: 'playback', code: 'x' });
    expect(s.getState().status.kind).toBe('failed');
    ctl.armStartTimeout(100);
    ctl.clearStartTimeout();
    expect(ctl.config.limitTotalMs).toBe(60000);
    expect(ctl.now()).toBe(Date.now());
    expect(ctl.getState().attempt).toBe(t2);
    const h = ctl.setTimer(() => {}, 10);
    ctl.clearTimer(h);
  });
});
