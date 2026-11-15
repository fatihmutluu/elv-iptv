import { elvError, err, ok, type Result } from '@elv/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAYBACK_CONFIG } from './config';
import type { StreamRequest } from './engine';
import { nextLimitDelay } from './recovery';
import {
  error,
  errorAt,
  failed,
  last,
  live,
  play,
  playing,
  type Rig,
  recovering,
  req,
  resolved,
  rig,
  stall,
  state,
  status,
  tick,
  vod,
} from './recovery-test-helpers';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});
afterEach(() => vi.useRealTimers());

describe('nextLimitDelay', () => {
  const c = DEFAULT_PLAYBACK_CONFIG;
  it('backs off 2, 4, 8, then 15 seconds', () => {
    expect([0, 1, 2, 3, 4, 9].map((a) => nextLimitDelay(0, a, c))).toEqual([
      2000, 4000, 8000, 15000, 15000, 15000,
    ]);
  });
  it('gives up when the next attempt would pass 60 seconds', () => {
    expect(nextLimitDelay(45000, 5, c)).toBe(15000);
    expect(nextLimitDelay(45001, 5, c)).toBeUndefined();
    expect(nextLimitDelay(0, 0, { ...c, limitBackoffMs: [] })).toBeUndefined();
  });
});

describe('live ladder', () => {
  it('leaves a stall shorter than 4,000 ms to the engine', async () => {
    const r = rig({ dead: [] });
    await playing(r, live('dead'));
    stall(r, 'start');
    await tick(3999);
    stall(r, 'end');
    await tick(20000);
    expect(r.engine.commands.map((c) => c.name)).toEqual(['load']);
    expect(status(r)).toEqual({ kind: 'playing' });
  });

  it('climbs rungs 1 to 4 on a silent stalled stream within 8 s of ladder time, then fails with a stop', async () => {
    const r = rig({ dead: [], alt: [] });
    const t = await playing(r, live('dead', { alternates: [resolved('alt')] }));
    stall(r, 'start');
    await tick(4000);
    expect(status(r)).toEqual(recovering(1, 0));
    expect(last(r)).toEqual({ name: 'retry', attempt: t + 1 });
    await tick(2000);
    expect(status(r)).toEqual(recovering(2, 0));
    expect(last(r)).toEqual({ name: 'load', attempt: t + 2, url: 'dead' });
    await tick(2000);
    expect(status(r)).toEqual(recovering(3, 0));
    expect(r.engine.commands.slice(-2)).toEqual([
      { name: 'recreate', attempt: t + 3 },
      { name: 'load', attempt: t + 3, url: 'dead' },
    ]);
    await tick(2000);
    expect(status(r)).toEqual(recovering(4, 0));
    expect(r.engine.commands.slice(-2)).toEqual([
      { name: 'stop', attempt: t + 4 },
      { name: 'load', attempt: t + 4, url: 'alt' },
    ]);
    await tick(2000);
    expect(status(r)).toEqual(failed('network'));
    expect(last(r)).toEqual({ name: 'stop', attempt: t + 4 });
    expect(r.engine.maxConcurrentMedias()).toBe(1);
  });

  it('keeps ladder gaps 0, 1, 2 and 4 s on fast-failing errors', async () => {
    const r = rig({ dead: [], alt: [] });
    const t = await playing(r, live('dead', { alternates: [resolved('alt')] }));
    error(r, 'network');
    expect(status(r)).toEqual(recovering(1, 0));
    expect(last(r)).toEqual({ name: 'retry', attempt: t + 1 });
    error(r, 'network');
    expect(status(r)).toEqual(recovering(2, 1000));
    await tick(999);
    expect(last(r)?.name).toBe('retry');
    await tick(1);
    expect(last(r)).toEqual({ name: 'load', attempt: t + 2, url: 'dead' });
    error(r, 'network');
    expect(status(r)).toEqual(recovering(3, 2000));
    await tick(2000);
    expect(r.engine.commands.slice(-2)).toEqual([
      { name: 'recreate', attempt: t + 3 },
      { name: 'load', attempt: t + 3, url: 'dead' },
    ]);
    error(r, 'network');
    expect(status(r)).toEqual(recovering(4, 4000));
    await tick(4000);
    expect(last(r)).toEqual({ name: 'load', attempt: t + 4, url: 'alt' });
    error(r, 'network');
    expect(status(r)).toEqual(failed('network'));
  });

  it('skips rung 1 and enters rung 2 when a live tune shows no first frame within 4,000 ms', async () => {
    const r = rig({ dead: [] });
    const t = r.service.tune(live('dead'));
    await tick(3999);
    expect(status(r)).toEqual({ kind: 'tuning' });
    await tick(1);
    expect(status(r)).toEqual(recovering(2, 0));
    expect(last(r)).toEqual({ name: 'load', attempt: t + 1, url: 'dead' });
  });

  it('enters rung 1 when a first frame is not followed by playing within 4,000 ms', async () => {
    const r = rig({ dead: [] });
    const t = r.service.tune(live('dead'));
    await tick(300);
    r.engine.emit({ attempt: t, type: 'firstFrame', atMs: Date.now() });
    state(r, 'buffering');
    stall(r, 'start');
    await tick(3699);
    expect(r.engine.commands.map((c) => c.name)).toEqual(['load']);
    expect(status(r)).toEqual({ kind: 'tuning' });
    await tick(1);
    expect(status(r)).toEqual(recovering(1, 0));
    expect(last(r)).toEqual({ name: 'retry', attempt: t + 1 });
  });

  it('enters on a recoverable error and skips rung 4 when nothing is left to try', async () => {
    const r = rig({ dead: [] });
    const t = await playing(r, live('dead'));
    error(r, 'decoder');
    expect(status(r)).toEqual(recovering(1, 0));
    expect(last(r)).toEqual({ name: 'retry', attempt: t + 1 });
    error(r, 'decoder');
    expect(status(r)).toEqual(recovering(2, 1000));
    await tick(1000);
    expect(last(r)).toEqual({ name: 'load', attempt: t + 2, url: 'dead' });
    error(r, 'decoder');
    await tick(2000);
    expect(last(r)).toEqual({ name: 'load', attempt: t + 3, url: 'dead' });
    error(r, 'decoder');
    expect(status(r)).toEqual(failed('decoder'));
    expect(last(r)).toEqual({ name: 'stop', attempt: t + 3 });
  });

  it('uses software audio as rung 4 after a decoder error when the engine has it', async () => {
    const r = rig({ dead: [], next: [] }, { softwareAudioFallback: true, recreate: false });
    const t = await playing(r, live('dead', { alternates: [resolved('alt')] }));
    error(r, 'decoder');
    error(r, 'decoder');
    await tick(1000);
    error(r, 'decoder');
    await tick(2000);
    expect(r.engine.commands.map((c) => c.name)).not.toContain('recreate');
    error(r, 'decoder');
    expect(status(r)).toEqual(recovering(4, 4000));
    await tick(4000);
    const soft = { url: 'dead', options: { softwareAudio: true } };
    expect(r.loads.at(-1)).toMatchObject({ attempt: t + 4, ...soft });
    play(r);
    await tick(30000);
    error(r, 'network');
    error(r, 'network');
    await tick(1000);
    expect(r.loads.at(-1)).toMatchObject({ attempt: t + 6, ...soft });
    await playing(r, live('next'));
    expect(r.loads.at(-1)?.url).toBe('next');
    expect(r.loads.at(-1)).not.toHaveProperty('options');
  });

  it('fails when the alternate cannot be resolved', async () => {
    const r = rig({ dead: [] });
    const broken = () => Promise.resolve(err(elvError('network', 'resolve-failed')));
    await playing(r, live('dead', { alternates: [broken, () => Promise.reject(new Error('x'))] }));
    for (const gap of [0, 1000, 2000, 4000]) {
      error(r, 'http-other');
      await tick(gap);
    }
    expect(status(r)).toEqual(failed('http-other'));
    await playing(r, live('dead', { alternates: [() => Promise.reject(new Error('x'))] }));
    for (const gap of [0, 1000, 2000, 4000]) {
      error(r, 'unknown');
      await tick(gap);
    }
    expect(status(r)).toEqual(failed('unknown'));
  });

  it('skips the rung-3 load when recreate fails synchronously', async () => {
    const r = rig({ dead: [] });
    const recreate = r.engine.recreate.bind(r.engine);
    vi.spyOn(r.engine, 'recreate').mockImplementation((attempt) => {
      recreate(attempt);
      r.engine.emit({ attempt, type: 'error', error: { code: 'engine-wedged' } });
    });
    const t = await playing(r, live('dead'));
    error(r, 'network');
    error(r, 'network');
    await tick(1000);
    error(r, 'network');
    await tick(2000);
    expect(r.loads.map((l) => l.attempt)).toEqual([t, t + 2]);
    expect(status(r)).toEqual(failed('engine-wedged'));
  });
});

describe('budget', () => {
  it('restores the budget after 30,000 ms of playing', async () => {
    const r = rig({ dead: [] });
    const t = await playing(r, live('dead'));
    stall(r, 'start');
    await tick(4000);
    play(r);
    await tick(30000);
    stall(r, 'start');
    await tick(4000);
    expect(status(r)).toEqual(recovering(1, 0));
    expect(last(r)).toEqual({ name: 'retry', attempt: t + 2 });
  });

  it('continues at the next rung when trouble returns sooner', async () => {
    const r = rig({ dead: [] });
    await playing(r, live('dead'));
    stall(r, 'start');
    await tick(4000);
    play(r);
    await tick(29999);
    stall(r, 'start');
    await tick(4000);
    expect(status(r)).toEqual(recovering(2, 0));
  });

  it('a late playing during a gap cancels the pending rung', async () => {
    const r = rig({ dead: [] });
    await playing(r, live('dead'));
    error(r, 'network');
    error(r, 'network');
    state(r, 'buffering');
    play(r);
    await tick(10000);
    expect(r.engine.commands.map((c) => c.name)).toEqual(['load', 'retry']);
    expect(status(r)).toEqual({ kind: 'playing' });
  });
});

describe('error classes', () => {
  it.each(['http-401', 'http-403', 'unsupported-format', 'drm'] as const)(
    '%s fails at once with a stop',
    async (code) => {
      const r = rig({ dead: [] });
      const t = await playing(r, live('dead'));
      error(r, code);
      expect(status(r)).toEqual(failed(code));
      expect(last(r)).toEqual({ name: 'stop', attempt: t });
      await tick(60000);
      expect(r.engine.commands.map((c) => c.name)).toEqual(['load', 'stop']);
    },
  );

  it('http-404 gets one rung-2 load, then fails', async () => {
    const r = rig({ gone: [errorAt(50, 'http-404')] });
    const t = r.service.tune(live('gone'));
    await tick(50);
    expect(status(r)).toEqual(recovering(2, 1000));
    await tick(1000);
    expect(r.loads.map((l) => l.attempt)).toEqual([t, t + 1]);
    await tick(50);
    expect(status(r)).toEqual(failed('http-404'));
    expect(last(r)).toEqual({ name: 'stop', attempt: t + 1 });
  });

  it('http-404 followed by a silent rung 2 fails when the rung times out, without rungs 3 and 4', async () => {
    const r = rig({ gone: [], alt: [] });
    const t = r.service.tune(live('gone', { alternates: [resolved('alt')] }));
    await tick(0);
    error(r, 'http-404');
    await tick(1000);
    expect(r.loads.map((l) => l.attempt)).toEqual([t, t + 1]);
    await tick(2000);
    expect(status(r)).toEqual(failed('http-404'));
    expect(r.engine.commands.map((c) => c.name)).toEqual(['load', 'load', 'stop']);
  });

  it('http-404 after the ladder reached rung 2 fails at once', async () => {
    const r = rig({ dead: [] });
    await playing(r, live('dead'));
    error(r, 'network');
    error(r, 'network');
    await tick(1000);
    error(r, 'http-404');
    expect(status(r)).toEqual(failed('http-404'));
  });

  it('a terminal error during a gap still fails at once', async () => {
    const r = rig({ dead: [] });
    await playing(r, live('dead'));
    error(r, 'network');
    error(r, 'network');
    error(r, 'http-404');
    expect(status(r)).toEqual(recovering(2, 1000));
    error(r, 'http-403');
    expect(status(r)).toEqual(failed('http-403'));
  });
});

describe('connection limit', () => {
  it('stops, backs off and gives up with connection-limit within 60,000 ms', async () => {
    const r = rig({ busy: [errorAt(100, 'http-509')] });
    let failedAt = 0;
    r.service.subscribe((s) => {
      if (s.status.kind === 'failed' && failedAt === 0) failedAt = Date.now();
    });
    r.service.tune(live('busy'));
    await tick(100);
    const firstError = Date.now();
    expect(r.engine.commands.map((c) => c.name)).toEqual(['load', 'stop']);
    expect(r.engine.openMedias()).toBe(0);
    expect(status(r)).toEqual({ kind: 'limited', nextAtMs: Date.now() + 2000 });
    await tick(1999);
    expect(r.loads).toHaveLength(1);
    await tick(1);
    expect(r.loads).toHaveLength(2);
    await tick(100);
    expect(status(r)).toEqual({ kind: 'limited', nextAtMs: Date.now() + 4000 });
    await tick(60000);
    expect(status(r)).toEqual(failed('connection-limit'));
    expect(failedAt - firstError).toBeLessThanOrEqual(60000);
    const first = r.loadAt[0] ?? 0;
    expect(r.loadAt.map((at) => at - first)).toEqual([0, 2100, 6200, 14300, 29400, 44500, 59600]);
    expect(r.engine.commands.map((c) => c.name)).toEqual(
      Array.from({ length: 7 }, () => ['load', 'stop']).flat(),
    );
    expect(r.engine.maxConcurrentMedias()).toBe(1);
  });

  it.each(['http-429', 'connection-limit'] as const)('%s takes the limit path', async (code) => {
    const r = rig({ dead: [] });
    await playing(r, live('dead'));
    error(r, code);
    expect(status(r)).toEqual({ kind: 'limited', nextAtMs: Date.now() + 2000 });
    expect(last(r)?.name).toBe('stop');
  });

  it('reloads after the backoff and plays on', async () => {
    const r = rig({ busy: [] });
    const t = await playing(r, live('busy'));
    error(r, 'http-509');
    await tick(2000);
    expect(last(r)).toEqual({ name: 'load', attempt: t + 1, url: 'busy' });
    expect(status(r)).toEqual({ kind: 'tuning' });
    play(r);
    expect(status(r)).toEqual({ kind: 'playing' });
  });

  it('holds a same-account zap until the backoff ends, then loads it with its token', async () => {
    const r = rig({ busy: [errorAt(0, 'http-509')], next: [] });
    r.service.tune(live('busy'));
    await tick(0);
    const held = status(r);
    await tick(500);
    const tb = r.service.tune(live('next'));
    await tick(0);
    expect(status(r)).toEqual(held);
    expect(r.service.getState()).toMatchObject({ attempt: tb, item: 'next' });
    await tick(1499);
    expect(r.loads).toHaveLength(1);
    await tick(1);
    expect(r.loads.at(-1)).toMatchObject({ attempt: tb, url: 'next' });
    expect(status(r)).toEqual({ kind: 'tuning' });
  });

  it('loads a held zap whose resolve settles after the backoff', async () => {
    const r = rig({ busy: [errorAt(0, 'http-509')], next: [] });
    r.service.tune(live('busy'));
    await tick(0);
    let settle!: (v: Result<StreamRequest>) => void;
    const pending = new Promise<Result<StreamRequest>>((res) => {
      settle = res;
    });
    const tb = r.service.tune(live('next', { resolve: () => pending }));
    await tick(3000);
    expect(r.loads).toHaveLength(1);
    settle(ok(req('next')));
    await tick(0);
    expect(r.loads.at(-1)).toMatchObject({ attempt: tb, url: 'next' });
  });

  it('a held zap whose resolve fails ends the backoff', async () => {
    const r = rig({ busy: [errorAt(0, 'http-509')] });
    r.service.tune(live('busy'));
    await tick(0);
    r.service.tune(live('next', { resolve: () => Promise.resolve(err(elvError('auth', 'x'))) }));
    await tick(10000);
    expect(status(r)).toEqual({ kind: 'failed', error: { category: 'auth', code: 'x' } });
    expect(r.loads).toHaveLength(1);
  });

  it('a zap to another account loads at once and ends the backoff', async () => {
    const r = rig({ busy: [errorAt(0, 'http-509')] });
    r.service.tune(live('busy'));
    await tick(0);
    const tc = r.service.tune(live('other', { accountKey: 'acc-2' }));
    await tick(0);
    expect(r.loads.at(-1)).toMatchObject({ attempt: tc, url: 'other' });
    await tick(10000);
    expect(r.loads).toHaveLength(2);
    expect(status(r)).toEqual({ kind: 'playing' });
  });

  const lateEvents: [string, (r: Rig) => void][] = [
    ['a network error', (r) => error(r, 'network')],
    ['a paused state', (r) => state(r, 'paused')],
    ['the http-509 behind a provider notice', (r) => error(r, 'http-509')],
    ['an http-404', (r) => error(r, 'http-404')],
  ];
  it.each(lateEvents)('ignores %s from the stopped media during the backoff', async (_, late) => {
    const r = rig({ busy: [] });
    const t = await playing(r, live('busy'));
    error(r, 'connection-limit');
    const limited = { kind: 'limited', nextAtMs: Date.now() + 2000 };
    late(r);
    expect(status(r)).toEqual(limited);
    await tick(1999);
    expect(r.engine.commands.map((c) => c.name)).toEqual(['load', 'stop']);
    expect(status(r)).toEqual(limited);
    await tick(1);
    expect(last(r)).toEqual({ name: 'load', attempt: t + 1, url: 'busy' });
  });
});

describe('vod', () => {
  it('reconnects at the last anchored position with backoff for up to 120,000 ms', async () => {
    const r = rig({ movie: [errorAt(1000, 'network')] });
    const t = r.service.tune(vod('movie'));
    await tick(500);
    r.engine.emit({
      attempt: t,
      type: 'clock',
      anchor: { positionMs: 60000, atMs: Date.now(), rate: 1 },
    });
    await tick(500);
    const firstError = Date.now();
    expect(status(r)).toEqual(recovering(2, 2000));
    expect(last(r)?.name).toBe('load');
    await tick(2000);
    expect(r.loads.at(-1)).toMatchObject({
      attempt: t + 1,
      url: 'movie',
      kind: 'vod',
      startMs: 60500,
    });
    await tick(200000);
    expect(status(r)).toEqual({ kind: 'failed', error: { category: 'playback', code: 'network' } });
    const reloads = r.loadAt.slice(1).map((at) => at - firstError);
    expect(reloads).toEqual([2000, 7000, 16000, 32000, 48000, 64000, 80000, 96000, 112000]);
    expect(r.loads.slice(1).every((l) => l.startMs === 60500)).toBe(true);
    expect(r.engine.maxConcurrentMedias()).toBe(1);
  });

  it('reloads a 404 at the position the failure happened', async () => {
    const r = rig({ movie: [] });
    const t = await playing(r, vod('movie'));
    r.engine.emit({
      attempt: t,
      type: 'clock',
      anchor: { positionMs: 60000, atMs: Date.now(), rate: 1 },
    });
    await tick(500);
    error(r, 'http-404');
    await tick(1000);
    expect(r.loads.at(-1)).toMatchObject({ attempt: t + 1, startMs: 60500 });
  });

  it('reconnects when a reload does not reach playing and resumes from the tune start', async () => {
    const r = rig({ movie: [] });
    const t = r.service.tune(vod('movie', { startMs: 9000 }));
    await tick(0);
    play(r);
    error(r, 'network');
    await tick(2000);
    expect(r.loads.at(-1)).toMatchObject({ attempt: t + 1, startMs: 9000 });
    await tick(2000);
    expect(status(r)).toEqual(recovering(2, 4000));
  });

  it('a seek disarms the stall watchdog until the next playing', async () => {
    const r = rig({ movie: [] });
    const t = await playing(r, vod('movie'));
    r.service.seek(30000);
    stall(r, 'start');
    await tick(10000);
    expect(last(r)).toEqual({ name: 'seek', attempt: t, positionMs: 30000 });
    stall(r, 'end');
    state(r, 'playing');
    stall(r, 'start');
    await tick(4000);
    expect(status(r)).toEqual(recovering(1, 0));
    expect(last(r)).toEqual({ name: 'retry', attempt: t + 1 });
  });
});

describe('surface', () => {
  it('surface loss recovers with retry when the surface returns', async () => {
    const r = rig({ dead: [] });
    const t = await playing(r, live('dead'));
    r.engine.surface('destroyed');
    error(r, 'surface-lost');
    error(r, 'surface-lost');
    stall(r, 'start');
    await tick(10000);
    expect(r.engine.commands.map((c) => c.name)).toEqual(['load']);
    r.engine.surface('created');
    expect(status(r)).toEqual(recovering(1, 0));
    expect(last(r)).toEqual({ name: 'retry', attempt: t + 1 });
    play(r);
    stall(r, 'start');
    await tick(4000);
    expect(status(r)).toEqual(recovering(2, 0));
  });

  it('surface-lost with the surface present retries at once', async () => {
    const r = rig({ dead: [] });
    const t = await playing(r, live('dead'));
    r.engine.surface('destroyed');
    r.engine.surface('created');
    error(r, 'surface-lost');
    expect(last(r)).toEqual({ name: 'retry', attempt: t + 1 });
  });
});

describe('lifecycle', () => {
  it('dispose during recovery sends nothing afterwards', async () => {
    const r = rig({ dead: [] });
    await playing(r, live('dead'));
    error(r, 'network');
    error(r, 'network');
    r.service.dispose();
    const n = r.engine.commands.length;
    await tick(120000);
    expect(r.engine.commands).toHaveLength(n);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('dispose while limited sends nothing afterwards', async () => {
    const r = rig({ busy: [errorAt(0, 'http-509')] });
    r.service.tune(live('busy'));
    await tick(0);
    r.service.dispose();
    await tick(120000);
    expect(r.engine.commands.map((c) => c.name)).toEqual(['load', 'stop']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('dispose while an alternate resolves sends nothing afterwards', async () => {
    const r = rig({ dead: [] });
    let settle!: (v: Result<StreamRequest>) => void;
    const alt = () =>
      new Promise<Result<StreamRequest>>((res) => {
        settle = res;
      });
    await playing(r, live('dead', { alternates: [alt] }));
    for (const gap of [0, 1000, 2000, 4000]) {
      error(r, 'network');
      await tick(gap);
    }
    expect(status(r)).toEqual({ kind: 'recovering', rung: 4, nextAtMs: Date.now() });
    r.service.dispose();
    const n = r.engine.commands.length;
    settle(ok(req('alt')));
    await tick(10000);
    expect(r.engine.commands).toHaveLength(n);
  });

  it('stop and the end of the media cancel pending rungs', async () => {
    const r = rig({ dead: [] });
    await playing(r, live('dead'));
    error(r, 'network');
    error(r, 'network');
    r.service.stop();
    await tick(10000);
    expect(r.engine.commands.map((c) => c.name)).toEqual(['load', 'retry', 'stop']);
    await playing(r, live('dead'));
    error(r, 'network');
    state(r, 'ended');
    expect(status(r)).toEqual({ kind: 'ended' });
    await tick(10000);
    expect(r.engine.commands.map((c) => c.name)).toEqual([
      'load',
      'retry',
      'stop',
      'load',
      'retry',
    ]);
  });

  it('a new tune cancels pending rungs and starts with a fresh budget', async () => {
    const r = rig({ dead: [] });
    await playing(r, live('dead'));
    error(r, 'network');
    error(r, 'network');
    const t = await playing(r, live('dead'));
    await tick(10000);
    expect(r.engine.commands.map((c) => c.name)).toEqual(['load', 'retry', 'load']);
    error(r, 'network');
    expect(last(r)).toEqual({ name: 'retry', attempt: t + 1 });
  });

  it('a user retry during recovery starts over with a fresh budget', async () => {
    const r = rig({ dead: [] });
    const t = await playing(r, live('dead'));
    error(r, 'network');
    error(r, 'network');
    r.service.retry();
    expect(last(r)).toEqual({ name: 'retry', attempt: t + 2 });
    await tick(4000);
    expect(status(r)).toEqual(recovering(1, 0));
    expect(last(r)).toEqual({ name: 'retry', attempt: t + 3 });
    expect(r.loads).toHaveLength(1);
  });
});
