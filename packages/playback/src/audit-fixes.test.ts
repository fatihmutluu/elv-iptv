import { ok, type Result } from '@elv/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { positionAt } from './clock';
import type { StreamRequest } from './engine';
import {
  error,
  failed,
  last,
  live,
  play,
  playing,
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

describe('C1: ended status lifecycle', () => {
  it('freezes the clock anchor on ended and transitions back to playing on seek + play', async () => {
    const r = rig({ movie: [] });
    const t = await playing(r, vod('movie'));
    r.engine.emit({
      attempt: t,
      type: 'clock',
      anchor: { positionMs: 59000, atMs: Date.now(), rate: 1, durationMs: 60000 },
    });
    await tick(1000);
    state(r, 'ended');
    expect(status(r)).toEqual({ kind: 'ended' });
    const frozen = r.service.getState().anchor;
    expect(frozen).toEqual({ positionMs: 60000, atMs: Date.now(), rate: 0, durationMs: 60000 });
    await tick(5000);
    if (frozen === undefined) throw new Error('expected frozen anchor');
    expect(positionAt(frozen, Date.now())).toBe(60000);

    r.service.seek(30000);
    r.service.play();
    expect(status(r)).toEqual({ kind: 'tuning' });
    play(r);
    expect(status(r)).toEqual({ kind: 'playing' });
    expect(r.service.getState().staleEventsDropped).toBe(0);
  });

  it('stops the engine and clears the anchor when stop() runs after ended', async () => {
    const r = rig({ movie: [] });
    await playing(r, vod('movie'));
    r.engine.emit({
      attempt: r.service.getState().attempt,
      type: 'clock',
      anchor: { positionMs: 10000, atMs: Date.now(), rate: 1 },
    });
    state(r, 'ended');
    expect(status(r)).toEqual({ kind: 'ended' });
    r.service.stop();
    expect(status(r)).toEqual({ kind: 'idle' });
    expect(last(r)?.name).toBe('stop');
    expect(r.engine.openMedias()).toBe(0);
    expect(r.service.getState().anchor).toBeUndefined();
  });

  it('reloads VOD from 0 when retry() runs after ended, even if initially tuned at startMs > 0', async () => {
    const r = rig({ movie: [] });
    await playing(r, vod('movie', { startMs: 45000 }));
    state(r, 'ended');
    expect(status(r)).toEqual({ kind: 'ended' });
    r.service.retry();
    await tick(0);
    expect(r.loads).toHaveLength(2);
    expect(r.loads.at(-1)).toMatchObject({ url: 'movie', kind: 'vod', startMs: 0 });
    expect(status(r)).toEqual({ kind: 'tuning' });
  });

  it('re-tunes a live stream when retry() runs after ended', async () => {
    const r = rig({ chan: [] });
    await playing(r, live('chan'));
    state(r, 'ended');
    state(r, 'ended');
    expect(status(r)).toEqual({ kind: 'ended' });
    r.service.retry();
    await tick(0);
    expect(r.loads).toHaveLength(3);
    expect(r.loads.at(-1)).toMatchObject({ url: 'chan', kind: 'live' });
  });
});

describe('C2.3: dispose stops open engine media', () => {
  it.each([
    ['tuning after load', async () => {}],
    ['playing', async (r: ReturnType<typeof rig>) => void play(r)],
    [
      'paused',
      async (r: ReturnType<typeof rig>) => {
        play(r);
        r.service.pause();
        state(r, 'paused');
      },
    ],
    [
      'ended',
      async (r: ReturnType<typeof rig>) => {
        play(r);
        state(r, 'ended');
        state(r, 'ended');
        expect(status(r)).toEqual({ kind: 'ended' });
      },
    ],
    [
      'recovering',
      async (r: ReturnType<typeof rig>) => {
        play(r);
        error(r, 'network');
      },
    ],
  ])('sends engine.stop on dispose while %s', async (_, prepare) => {
    const r = rig({ chan: [] });
    r.service.tune(live('chan'));
    await tick(0);
    await prepare(r);
    expect(r.engine.openMedias()).toBe(1);
    r.service.dispose();
    expect(last(r)?.name).toBe('stop');
    expect(r.engine.openMedias()).toBe(0);
  });

  it('stops the previous media on dispose during a new tune resolve', async () => {
    const r = rig({ a: [] });
    await playing(r, live('a'));
    r.service.tune(live('b', { resolve: () => new Promise(() => {}) }));
    expect(r.engine.openMedias()).toBe(1);
    r.service.dispose();
    expect(last(r)?.name).toBe('stop');
    expect(r.engine.openMedias()).toBe(0);
  });
});

describe('I2: pause/play races and deferred VOD recovery', () => {
  it('fences a late paused event queued before play() on a buffering stream', async () => {
    const r = rig({ chan: [] });
    r.service.tune(live('chan'));
    await tick(0);
    r.service.pause();
    const pausedToken = r.service.getState().attempt;
    r.service.play();
    r.engine.emit({ attempt: pausedToken, type: 'state', state: 'paused' });
    expect(status(r)).toEqual({ kind: 'tuning' });
    expect(r.service.getState().staleEventsDropped).toBe(1);
  });

  it('transitions buffering/ready state events out of paused', async () => {
    const r = rig({ chan: [] });
    await playing(r, live('chan'));
    state(r, 'paused');
    expect(status(r)).toEqual({ kind: 'paused' });
    state(r, 'buffering');
    expect(status(r)).toEqual({ kind: 'tuning' });
  });

  it('preserves VOD reconnectVod and shifts window across user pause duration', async () => {
    const r = rig({ movie: [] });
    const t = await playing(r, vod('movie'));
    r.engine.emit({
      attempt: t,
      type: 'clock',
      anchor: { positionMs: 30000, atMs: Date.now(), rate: 1 },
    });
    await tick(500);
    r.service.pause();
    state(r, 'paused');
    error(r, 'network');
    // Stay paused for 5 minutes (> 120s vodReconnectWindowMs) while Wi-Fi is down
    await tick(300_000);
    expect(status(r)).toEqual({ kind: 'paused' });
    r.service.play();
    expect(status(r)).toEqual(recovering(2, 2000));
    await tick(2000);
    expect(r.loads.at(-1)).toMatchObject({ url: 'movie', kind: 'vod', startMs: 30500 });
  });

  it('shifts an already-started VOD reconnect window across a user pause', async () => {
    const r = rig({ movie: [] });
    await playing(r, vod('movie', { startMs: 12000 }));
    error(r, 'network');
    expect(status(r)).toEqual(recovering(2, 2000));
    r.service.pause();
    await tick(300_000);
    r.service.play();
    expect(status(r)).toEqual(recovering(2, 2000));
    await tick(2000);
    expect(r.loads.at(-1)).toMatchObject({ url: 'movie', kind: 'vod', startMs: 12000 });
  });

  it('handles http-404 arriving while paused with one rung-2 load on play', async () => {
    const r = rig({ chan: [] });
    await playing(r, live('chan'));
    r.service.pause();
    state(r, 'paused');
    error(r, 'http-404');
    r.service.play();
    expect(status(r)).toEqual(recovering(2, 1000));
    await tick(1000);
    expect(r.loads).toHaveLength(2);
    error(r, 'http-404');
    expect(status(r)).toEqual(failed('http-404'));
  });
});

describe('I3 & S2: ClockAnchor freezing, VOD resumePosition, and firstFrameAt', () => {
  it('freezes state.anchor on paused, recovering, limited, failed, and surface-lost, and clears on stop', async () => {
    const r = rig({ chan: [] });
    const t = await playing(r, live('chan'));
    r.engine.emit({
      attempt: t,
      type: 'clock',
      anchor: { positionMs: 10000, atMs: Date.now(), rate: 1 },
    });
    await tick(500);
    error(r, 'network');
    const frozen = r.service.getState().anchor;
    expect(frozen).toEqual({ positionMs: 10500, atMs: Date.now(), rate: 0 });
    await tick(3000);
    if (frozen === undefined) throw new Error('expected frozen anchor');
    expect(positionAt(frozen, Date.now())).toBe(10500);

    play(r);
    r.engine.emit({
      attempt: r.service.getState().attempt,
      type: 'clock',
      anchor: { positionMs: 20000, atMs: Date.now(), rate: 1 },
    });
    await tick(250);
    r.engine.surface('destroyed');
    error(r, 'surface-lost');
    expect(r.service.getState().anchor).toEqual({ positionMs: 20250, atMs: Date.now(), rate: 0 });

    r.engine.surface('created');
    play(r);
    r.engine.emit({
      attempt: r.service.getState().attempt,
      type: 'clock',
      anchor: { positionMs: 30000, atMs: Date.now(), rate: 1 },
    });
    await tick(200);
    error(r, 'http-509');
    expect(r.service.getState().anchor).toEqual({ positionMs: 30200, atMs: Date.now(), rate: 0 });

    r.service.stop();
    expect(r.service.getState().anchor).toBeUndefined();
  });

  it('does not overwrite VOD resumePosition with an initial positionMs=0 anchor from a failed reload', async () => {
    const r = rig({ movie: [] });
    const t = await playing(r, vod('movie'));
    r.engine.emit({
      attempt: t,
      type: 'clock',
      anchor: { positionMs: 60000, atMs: Date.now(), rate: 1 },
    });
    await tick(500);
    error(r, 'network');
    await tick(2000);
    expect(r.loads.at(-1)).toMatchObject({ startMs: 60500 });

    // During tuning of reload 1, engine emits initial anchor at 0 before failing again
    r.engine.emit({
      attempt: r.service.getState().attempt,
      type: 'clock',
      anchor: { positionMs: 0, atMs: Date.now(), rate: 0 },
    });
    error(r, 'network');
    await tick(4000);
    expect(r.loads.at(-1)).toMatchObject({ startMs: 60500 });
  });

  it('updates VOD resumePosition on explicit seek even before a new playing clock arrives', async () => {
    const r = rig({ movie: [] });
    const t = await playing(r, vod('movie'));
    r.engine.emit({
      attempt: t,
      type: 'clock',
      anchor: { positionMs: 10000, atMs: Date.now(), rate: 1 },
    });
    r.service.seek(90000);
    error(r, 'network');
    await tick(2000);
    expect(r.loads.at(-1)).toMatchObject({ startMs: 90000 });
  });

  it('uses native firstFrame.atMs within [tuneAt, now] and clamps out-of-range stamps', async () => {
    const r = rig({ chan: [] });
    const t = r.service.tune(live('chan'));
    await tick(300); // now = 1300, tuneAt = 1000
    r.engine.emit({ attempt: t, type: 'firstFrame', atMs: 1280 });
    expect(r.service.getState().firstFrameAt).toBe(1280);
    // Later firstFrame on the same tune keeps the original firstFrameAt
    await tick(100);
    r.engine.emit({ attempt: t, type: 'firstFrame', atMs: 1390 });
    expect(r.service.getState().firstFrameAt).toBe(1280);

    const t2 = r.service.tune(live('chan'));
    await tick(200); // now = 1600, tuneAt = 1400
    r.engine.emit({ attempt: t2, type: 'firstFrame', atMs: 0 });
    expect(r.service.getState().firstFrameAt).toBe(1600);
  });
});

describe('I5 (#81): silent live ladder bounded to ~10 s', () => {
  it('fails a completely silent live tune in 9,000 ms without alternates', async () => {
    const r = rig({ silent: [] });
    r.service.tune(live('silent'));
    await tick(8999);
    expect(status(r).kind).not.toBe('failed');
    await tick(1);
    expect(status(r)).toEqual(failed('network'));
    expect(r.engine.commands.map((c) => c.name)).toEqual([
      'load',
      'load',
      'recreate',
      'load',
      'stop',
    ]);
    expect(r.engine.openMedias()).toBe(0);
  });

  it('fails a completely silent live tune in 11,000 ms with alternates and stops rung 3 before awaiting alternate', async () => {
    const r = rig({ silent: [], alt: [] });
    let settleAlt!: (res: Result<StreamRequest>) => void;
    const asyncAlt = () =>
      new Promise<Result<StreamRequest>>((res) => {
        settleAlt = res;
      });
    r.service.tune(live('silent', { alternates: [asyncAlt] }));
    await tick(9000);
    expect(status(r)).toEqual(recovering(4, 0));
    // Rung 3 socket must already be closed while asyncAlt is pending!
    expect(r.engine.openMedias()).toBe(0);
    expect(last(r)?.name).toBe('stop');
    await tick(100);
    settleAlt(ok(req('alt')));
    await tick(0);
    expect(r.loads.at(-1)?.url).toBe('alt');
    await tick(1899);
    expect(status(r).kind).not.toBe('failed');
    await tick(1);
    expect(status(r)).toEqual(failed('network'));
    expect(r.engine.openMedias()).toBe(0);
  });

  it('keeps VOD startTimeoutMs at 8,000 ms', async () => {
    const r = rig({ movie: [] });
    r.service.tune(vod('movie'));
    await tick(7999);
    expect(status(r)).toEqual({ kind: 'tuning' });
    await tick(1);
    expect(status(r)).toEqual(recovering(1, 0));
  });

  it('bounds a mid-stream silent stall to 10,000 ms without alternates and 12,000 ms with alternates', async () => {
    const r1 = rig({ silent: [] });
    await playing(r1, live('silent'));
    stall(r1, 'start');
    await tick(9999);
    expect(status(r1).kind).not.toBe('failed');
    await tick(1);
    expect(status(r1)).toEqual(failed('network'));

    const r2 = rig({ silent: [], alt: [] });
    await playing(r2, live('silent', { alternates: [resolved('alt')] }));
    stall(r2, 'start');
    await tick(11999);
    expect(status(r2).kind).not.toBe('failed');
    await tick(1);
    expect(status(r2)).toEqual(failed('network'));
  });
});
