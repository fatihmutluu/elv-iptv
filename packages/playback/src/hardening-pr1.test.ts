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
  rig,
  stall,
  state,
  status,
  tick,
  vod,
} from './recovery-test-helpers';
import type { PlaybackState } from './types';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});
afterEach(() => vi.useRealTimers());

describe('PR 1 Playback Core Hardening', () => {
  it('service.play() on ended VOD replays from 0 instead of calling engine.play()', async () => {
    const r = rig({ movie: [] });
    const t = await playing(r, vod('movie', { startMs: 40_000 }));
    r.engine.emit({
      attempt: t,
      type: 'clock',
      anchor: { positionMs: 60_000, atMs: Date.now(), rate: 1, durationMs: 60_000 },
    });
    state(r, 'ended');
    expect(status(r)).toEqual({ kind: 'ended' });

    r.service.play();
    await tick(0);
    expect(r.engine.commands.map((c) => c.name)).toEqual(['load', 'load']);
    expect(r.loads.at(-1)).toMatchObject({ url: 'movie', kind: 'vod', startMs: 0 });
    expect(status(r)).toEqual({ kind: 'tuning' });
  });

  it('service.seek() guards non-positive/NaN durationMs and avoids reloading ended/recovering VOD at EOF', async () => {
    const r = rig({ movie: [] });
    const t = await playing(r, vod('movie'));
    // durationMs = 0 should not clamp seeks to 0
    r.engine.emit({
      attempt: t,
      type: 'clock',
      anchor: { positionMs: 1000, atMs: Date.now(), rate: 1, durationMs: 0 },
    });
    r.service.seek(25_000);
    expect(r.service.getState().anchor?.positionMs).toBe(25_000);

    // Seeking >= durationMs while ended stays ended without reloading
    await tick(100);
    r.engine.emit({
      attempt: t,
      type: 'clock',
      anchor: { positionMs: 60_000, atMs: Date.now(), rate: 1, durationMs: 60_000 },
    });
    state(r, 'ended');
    const loadsBefore = r.loads.length;
    r.service.seek(60_000);
    expect(status(r)).toEqual({ kind: 'ended' });
    expect(r.loads).toHaveLength(loadsBefore);

    // Seeking >= durationMs while recovering clamps reload below durationMs
    r.service.seek(30_000);
    play(r);
    r.engine.emit({
      attempt: r.service.getState().attempt,
      type: 'clock',
      anchor: { positionMs: 30_000, atMs: Date.now(), rate: 1, durationMs: 60_000 },
    });
    error(r, 'network');
    expect(status(r)).toEqual(recovering(2, 2000));
    r.service.seek(60_000);
    expect(r.loads.at(-1)?.startMs).toBeLessThan(60_000);
  });

  it('service.retry() freezes anchor before reset and recovery preserves 0 ms VOD anchor', async () => {
    const r = rig({ movie: [] });
    const t = await playing(r, vod('movie', { startMs: 30_000 }));
    r.engine.emit({
      attempt: t,
      type: 'clock',
      anchor: { positionMs: 10_000, atMs: Date.now(), rate: 1 },
    });
    await tick(500);
    r.service.retry();
    const frozen = r.service.getState().anchor;
    expect(frozen).toEqual({ positionMs: 10_500, atMs: Date.now(), rate: 0 });
    await tick(2000);
    if (frozen === undefined) throw new Error('expected anchor');
    expect(positionAt(frozen, Date.now())).toBe(10_500);

    // Seek to 0 while paused, retry on loaded media, then fail -> recovery must reload at 0, not 30_000!
    play(r);
    r.service.pause();
    state(r, 'paused');
    r.service.seek(0);
    await tick(100);
    r.service.retry();
    error(r, 'network');
    await tick(2000);
    expect(r.loads.at(-1)).toMatchObject({ startMs: 0 });
  });

  it('pause/play during unloaded rung 4 does not dispatch engine pause/play or giveUp prematurely', async () => {
    const r = rig({ dead: [], alt: [] });
    let settleCount = 0;
    let settle!: (v: Result<StreamRequest>) => void;
    const alt = () =>
      new Promise<Result<StreamRequest>>((res) => {
        settleCount += 1;
        settle = res;
      });
    await playing(r, live('dead', { alternates: [alt] }));
    for (const gap of [0, 1000, 2000, 4000]) {
      error(r, 'network');
      await tick(gap);
    }
    expect(settleCount).toBe(1);
    const cmdsBeforePause = r.engine.commands.length;
    r.service.pause();
    expect(status(r)).toEqual({ kind: 'paused' });
    // Unloaded engine must not receive pause()
    expect(r.engine.commands).toHaveLength(cmdsBeforePause);

    r.service.play();
    // Must re-enter rung 4 instead of calling giveUp() or engine.play() on unloaded engine!
    expect(status(r).kind).toBe('recovering');
    await tick(4000);
    expect(settleCount).toBe(2);
    settle(ok(req('alt')));
    await tick(0);
    expect(r.loads.at(-1)?.url).toBe('alt');
  });

  it('limitTimer does not arm startTimeout prematurely while a held tune is still resolving', async () => {
    const r = rig({ busy: [], slow: [] });
    r.service.tune(live('busy'));
    await tick(0);
    error(r, 'http-509');
    expect(status(r).kind).toBe('limited');

    let resolveHeld!: (res: Result<StreamRequest>) => void;
    r.service.tune(
      live('slow', {
        resolve: () =>
          new Promise<Result<StreamRequest>>((res) => {
            resolveHeld = res;
          }),
      }),
    );
    // Limit wait (2,000 ms) ends while held tune is still resolving (resolveTimeoutMs = 5,000 ms)
    await tick(2000);
    expect(r.loads).toHaveLength(1);
    // Resolve settles 2,500 ms later (4,500 ms after tune); must still get a full 5,000 ms startTimeout!
    await tick(2500);
    resolveHeld(ok(req('slow')));
    await tick(0);
    expect(r.loads.at(-1)?.url).toBe('slow');
    await tick(4999);
    expect(status(r)).toEqual({ kind: 'tuning' });
    await tick(1);
    expect(status(r).kind).toBe('recovering');
  });

  it('batches multi-field state updates atomically and isolates throwing subscribers (#224)', async () => {
    const r = rig({ chan: [] });
    await playing(r, live('chan'));
    r.engine.emit({
      attempt: r.service.getState().attempt,
      type: 'clock',
      anchor: { positionMs: 5000, atMs: Date.now(), rate: 1 },
    });
    await tick(200);

    const snapshots: PlaybackState[] = [];
    r.service.subscribe(() => {
      throw new Error('bad subscriber');
    });
    r.service.subscribe((s) => snapshots.push(s));

    // onState('paused') freezes anchor + sets status=paused in ONE atomic notification
    state(r, 'paused');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      status: { kind: 'paused' },
      anchor: { positionMs: 5200, rate: 0 },
    });

    // Terminal error triggers fail() in ONE atomic notification even when first subscriber throws
    snapshots.length = 0;
    error(r, 'http-401');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.status).toEqual(failed('http-401'));
  });

  it('coalesces rapid seeks (~80ms) and guards against stale pre-seek clock anchors (#108)', async () => {
    const r = rig({ movie: [] });
    const t = await playing(r, vod('movie'));
    r.engine.emit({
      attempt: t,
      type: 'clock',
      anchor: { positionMs: 10_000, atMs: Date.now(), rate: 1, durationMs: 300_000 },
    });

    r.service.seek(50_000); // leading edge -> immediate engine.seek(50_000)
    r.service.seek(60_000);
    r.service.seek(70_000);
    r.service.seek(90_000);
    expect(r.service.getState().anchor?.positionMs).toBe(90_000);
    expect(r.engine.commands.filter((c) => c.name === 'seek')).toEqual([
      { name: 'seek', attempt: t, positionMs: 50_000 },
    ]);

    // Stale pre-seek clock tick at 10,250 ms arrives 20 ms later -> must NOT revert optimistic 90,000 ms!
    await tick(20);
    r.engine.emit({
      attempt: t,
      type: 'clock',
      anchor: { positionMs: 10_250, atMs: Date.now(), rate: 1, durationMs: 300_000 },
    });
    expect(r.service.getState().anchor?.positionMs).toBe(90_000);

    // After 80 ms coalesce window expires, single trailing seek(90_000) is dispatched
    await tick(60);
    expect(r.engine.commands.filter((c) => c.name === 'seek')).toEqual([
      { name: 'seek', attempt: t, positionMs: 50_000 },
      { name: 'seek', attempt: t, positionMs: 90_000 },
    ]);
  });

  it('re-arms stall watchdog on in-buffer seek clock and escalates stalled seek on deadline (#108)', async () => {
    const r1 = rig({ movie: [] });
    const t1 = await playing(r1, vod('movie'));
    // In-buffer seek: no stall('end') or state('playing'), only clock(rate=1)
    r1.service.seek(20_000);
    await tick(200);
    r1.engine.emit({
      attempt: t1,
      type: 'clock',
      anchor: { positionMs: 20_200, atMs: Date.now(), rate: 1 },
    });
    stall(r1, 'start');
    await tick(4000);
    expect(status(r1)).toEqual(recovering(1, 0));

    // Stalled seek that never recovers escalates when bounded seekSettleTimeoutMs expires
    const r2 = rig({ movie: [] });
    await playing(r2, vod('movie'));
    r2.service.seek(80_000);
    stall(r2, 'start');
    await tick(12_000);
    expect(status(r2)).toEqual(recovering(1, 0));
  });

  it('reloads live stream at live edge when resumed after >= liveStalePauseMs (#190)', async () => {
    const r = rig({ chan: [] });
    await playing(r, live('chan'));
    r.service.pause();
    state(r, 'paused');
    await tick(25_000);
    r.service.play();
    expect(status(r)).toEqual({ kind: 'tuning' });
    expect(r.loads).toHaveLength(2);
    expect(r.engine.commands.at(-1)?.name).toBe('load');
  });

  it('falls back between .ts and .m3u8 on pre-playback live failure and caches working format (#200)', async () => {
    const ts1 = 'http://panel.example/live/u/p/101.ts';
    const hls1 = 'http://panel.example/live/u/p/101.m3u8';
    const ts2 = 'http://panel.example/live/u/p/102.ts';
    const hls2 = 'http://panel.example/live/u/p/102.m3u8';
    const r = rig({
      [ts1]: [{ afterMs: 50, emit: 'error', error: { code: 'http-404', httpStatus: 404 } }],
      [hls1]: [
        { afterMs: 100, emit: 'firstFrame' },
        { afterMs: 100, emit: 'state', state: 'playing' },
      ],
      [hls2]: [
        { afterMs: 100, emit: 'firstFrame' },
        { afterMs: 100, emit: 'state', state: 'playing' },
      ],
    });

    r.service.tune(live(ts1, { accountKey: 'acc-1' }));
    await tick(2000);
    expect(status(r)).toEqual({ kind: 'playing' });
    expect(r.loads.map((l) => l.url)).toEqual([ts1, ts1, hls1]);

    // Subsequent zap on same accountKey immediately opens .m3u8 from session working-format cache!
    r.service.tune(live(ts2, { accountKey: 'acc-1' }));
    await tick(200);
    expect(status(r)).toEqual({ kind: 'playing' });
    expect(r.loads.at(-1)?.url).toBe(hls2);
  });

  it('parks paused session in awaitingSurface on surface-lost and defers revalidation until play() (#280)', async () => {
    const r = rig({ chan: [] });
    const t = await playing(r, live('chan'));
    r.service.pause();
    state(r, 'paused');

    // Background destroys surface and emits surface-lost while paused
    r.engine.surface('destroyed');
    error(r, 'surface-lost');
    expect(status(r)).toEqual({ kind: 'paused' });

    // Foreground recreates surface while still paused -> must stay paused without burning rungs
    r.engine.surface('created');
    await tick(5000);
    expect(status(r)).toEqual({ kind: 'paused' });
    expect(r.engine.commands.map((c) => c.name)).toEqual(['load', 'pause']);

    // Explicit play() triggers rung 1 retry revalidation without skipping to rung 2
    r.service.play();
    expect(status(r)).toEqual(recovering(1, 0));
    expect(last(r)).toEqual({ name: 'retry', attempt: t + 3 });
  });
});
