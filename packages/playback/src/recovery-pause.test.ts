import { ok, type Result } from '@elv/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamRequest } from './engine';
import {
  error,
  failed,
  last,
  live,
  play,
  playing,
  type Rig,
  recovering,
  req,
  rig,
  stall,
  state,
  status,
  tick,
} from './recovery-test-helpers';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});
afterEach(() => vi.useRealTimers());

describe('pause', () => {
  const names = (r: Rig) => r.engine.commands.map((c) => c.name);

  it('a pause stops the stall watchdog; play gives the media a fresh start window', async () => {
    const r = rig({ dead: [] });
    const t = await playing(r, live('dead'));
    stall(r, 'start');
    await tick(1000);
    r.service.pause();
    state(r, 'paused');
    await tick(5000);
    expect(names(r)).toEqual(['load', 'pause']);
    expect(status(r)).toEqual({ kind: 'paused' });
    r.service.play();
    expect(status(r)).toEqual({ kind: 'tuning' });
    await tick(4999);
    expect(names(r)).toEqual(['load', 'pause', 'play']);
    await tick(1);
    expect(status(r)).toEqual(recovering(1, 0));
    expect(last(r)).toEqual({ name: 'retry', attempt: t + 3 });
  });

  it('play without a pause, or before the pause took effect, arms nothing', async () => {
    const r = rig({ dead: [] });
    await playing(r, live('dead'));
    r.service.play();
    r.service.pause();
    r.service.play();
    await tick(20000);
    expect(names(r)).toEqual(['load', 'play', 'pause', 'play']);
    expect(status(r)).toEqual({ kind: 'playing' });
  });

  it('a stall reported after a user pause is not watched', async () => {
    const r = rig({ dead: [] });
    await playing(r, live('dead'));
    r.service.pause();
    stall(r, 'start');
    await tick(10000);
    expect(names(r)).toEqual(['load', 'pause']);
  });

  it('a paused state during a gap cancels the rung; play continues at the next rung', async () => {
    const r = rig({ dead: [] });
    const t = await playing(r, live('dead'));
    error(r, 'network');
    error(r, 'network');
    state(r, 'paused');
    await tick(10000);
    expect(names(r)).toEqual(['load', 'retry']);
    expect(status(r)).toEqual({ kind: 'paused' });
    r.service.play();
    expect(status(r)).toEqual(recovering(2, 1000));
    await tick(1000);
    expect(r.engine.commands.slice(-2)).toEqual([
      { name: 'play', attempt: t + 2 },
      { name: 'load', attempt: t + 3, url: 'dead' },
    ]);
  });

  it('a user pause during a rung shows paused and sends nothing until play', async () => {
    const r = rig({ dead: [] });
    const t = await playing(r, live('dead'));
    error(r, 'network');
    r.service.pause();
    expect(status(r)).toEqual({ kind: 'paused' });
    await tick(20000);
    expect(names(r)).toEqual(['load', 'retry', 'pause']);
    r.service.play();
    expect(status(r)).toEqual(recovering(2, 1000));
    await tick(1000);
    expect(last(r)).toEqual({ name: 'load', attempt: t + 4, url: 'dead' });
  });

  it('the restarted ladder keeps the budget it had', async () => {
    const r = rig({ dead: [] });
    await playing(r, live('dead'));
    error(r, 'http-404');
    r.service.pause();
    await tick(5000);
    expect(r.loads).toHaveLength(1);
    r.service.play();
    expect(status(r)).toEqual(recovering(2, 1000));
    await tick(1000);
    expect(r.loads).toHaveLength(2);
    error(r, 'http-404');
    expect(status(r)).toEqual(failed('http-404'));
  });

  it('recoverable errors while paused wait for play; limit and terminal errors act at once', async () => {
    const r = rig({ dead: [] });
    const t = await playing(r, live('dead'));
    r.service.pause();
    state(r, 'paused');
    error(r, 'network');
    await tick(10000);
    expect(names(r)).toEqual(['load', 'pause']);
    expect(status(r)).toEqual({ kind: 'paused' });
    r.service.play();
    expect(last(r)).toEqual({ name: 'retry', attempt: t + 3 });
    r.service.pause();
    error(r, 'http-509');
    expect(status(r)).toEqual({ kind: 'limited', nextAtMs: Date.now() + 2000 });
    expect(last(r)).toEqual({ name: 'stop', attempt: t + 4 });
    await tick(2000);
    play(r);
    r.service.pause();
    error(r, 'http-401');
    expect(status(r)).toEqual(failed('http-401'));
    expect(last(r)?.name).toBe('stop');
  });

  it('a pause before the first playing holds the start timeout until play', async () => {
    const r = rig({ dead: [] });
    const t = r.service.tune(live('dead'));
    await tick(0);
    r.service.pause();
    await tick(20000);
    expect(names(r)).toEqual(['load', 'pause']);
    r.service.play();
    await tick(5000);
    expect(status(r)).toEqual(recovering(2, 0));
    expect(last(r)).toEqual({ name: 'load', attempt: t + 3, url: 'dead' });
  });

  it('a surface that returns while paused waits for play', async () => {
    const r = rig({ dead: [] });
    const t = await playing(r, live('dead'));
    r.engine.surface('destroyed');
    error(r, 'surface-lost');
    r.service.pause();
    r.engine.surface('created');
    expect(names(r)).toEqual(['load', 'pause']);
    r.service.play();
    expect(last(r)).toEqual({ name: 'retry', attempt: t + 3 });
  });

  it('a pause while an alternate resolves drops its load', async () => {
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
    r.service.pause();
    settle(ok(req('alt')));
    await tick(10000);
    expect(names(r).at(-1)).toBe('stop');
    expect(r.loads.map((l) => l.url)).not.toContain('alt');
  });
});
