import { ok } from '@elv/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeekCoalescer } from './seek-coalescer';
import { createPlaybackService } from './service';
import {
  clampPlaybackSpeed,
  createSpeedCoalescer,
  DEFAULT_SPEED_SETTLE_MS,
  MAX_PLAYBACK_SPEED,
  MIN_PLAYBACK_SPEED,
} from './speed-coalescer';
import { createFakePlayerEngine } from './testing';
import type { PlaybackTimers } from './types';

function fakeTimers(): PlaybackTimers {
  return {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('clampPlaybackSpeed', () => {
  it('clamps finite positive speeds into [0.25, 4.0]', () => {
    expect(MIN_PLAYBACK_SPEED).toBe(0.25);
    expect(MAX_PLAYBACK_SPEED).toBe(4.0);
    expect(clampPlaybackSpeed(0.1)).toBe(0.25);
    expect(clampPlaybackSpeed(0.25)).toBe(0.25);
    expect(clampPlaybackSpeed(1.5)).toBe(1.5);
    expect(clampPlaybackSpeed(4.0)).toBe(4.0);
    expect(clampPlaybackSpeed(10)).toBe(4.0);
  });

  it('rejects non-finite and non-positive speeds', () => {
    expect(clampPlaybackSpeed(0)).toBeUndefined();
    expect(clampPlaybackSpeed(-1.5)).toBeUndefined();
    expect(clampPlaybackSpeed(Number.NaN)).toBeUndefined();
    expect(clampPlaybackSpeed(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(clampPlaybackSpeed(Number.NEGATIVE_INFINITY)).toBeUndefined();
  });
});

describe('createSpeedCoalescer', () => {
  it('applies immediately when idle and coalesces rapid bursts to only the latest speed', () => {
    const applied: number[] = [];
    const coalescer = createSpeedCoalescer({
      timers: fakeTimers(),
      isSeekPending: () => false,
      apply: (rate) => applied.push(rate),
    });

    expect(coalescer.request(1.25)).toBe(1.25);
    expect(applied).toEqual([1.25]);
    expect(coalescer.isPending()).toBe(true);

    expect(coalescer.request(1.5)).toBe(1.5);
    expect(coalescer.request(1.75)).toBe(1.75);
    expect(coalescer.request(2.0)).toBe(2.0);
    expect(applied).toEqual([1.25]);
    expect(coalescer.pendingSpeed()).toBe(2.0);

    vi.advanceTimersByTime(DEFAULT_SPEED_SETTLE_MS);
    expect(applied).toEqual([1.25, 2.0]);
    expect(coalescer.pendingSpeed()).toBeUndefined();

    vi.advanceTimersByTime(DEFAULT_SPEED_SETTLE_MS);
    expect(coalescer.isPending()).toBe(false);
  });

  it('defers speed changes while a seek is pending and flushes only the latest once settled', () => {
    const applied: number[] = [];
    let seeking = true;
    const coalescer = createSpeedCoalescer({
      timers: fakeTimers(),
      isSeekPending: () => seeking,
      apply: (rate) => applied.push(rate),
    });

    coalescer.request(1.25);
    coalescer.request(1.5);
    coalescer.request(3.0);
    expect(applied).toEqual([]);
    expect(coalescer.pendingSpeed()).toBe(3.0);
    expect(coalescer.isPending()).toBe(true);

    // Flushing while seek is still pending does not dispatch
    coalescer.flush();
    expect(applied).toEqual([]);

    seeking = false;
    coalescer.flush();
    expect(applied).toEqual([3.0]);
    expect(coalescer.pendingSpeed()).toBeUndefined();
  });

  it('ignores invalid rates without disturbing pending speed', () => {
    const applied: number[] = [];
    let seeking = true;
    const coalescer = createSpeedCoalescer({
      timers: fakeTimers(),
      isSeekPending: () => seeking,
      apply: (rate) => applied.push(rate),
    });

    expect(coalescer.request(Number.NaN)).toBeUndefined();
    expect(coalescer.request(-2)).toBeUndefined();
    expect(coalescer.request(0)).toBeUndefined();
    expect(coalescer.request(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(coalescer.isPending()).toBe(false);

    expect(coalescer.request(10)).toBe(4.0);
    expect(coalescer.request(Number.NaN)).toBeUndefined();
    seeking = false;
    coalescer.flush();
    expect(applied).toEqual([4.0]);
  });

  it('clears queued speed and timers cleanly on reset()', () => {
    const applied: number[] = [];
    const coalescer = createSpeedCoalescer({
      timers: fakeTimers(),
      isSeekPending: () => true,
      apply: (rate) => applied.push(rate),
    });

    coalescer.request(2.0);
    coalescer.reset();
    expect(coalescer.isPending()).toBe(false);
    expect(coalescer.pendingSpeed()).toBeUndefined();

    vi.advanceTimersByTime(1000);
    coalescer.flush();
    expect(applied).toEqual([]);
  });

  it('integrates with SeekCoalescer.isPending() across coalesce window, clock confirmation, and guard timeout', () => {
    const clock = { now: () => Date.now() };
    const timers = fakeTimers();
    const applied: number[] = [];
    let speedCoalescer!: ReturnType<typeof createSpeedCoalescer>;
    const seekCoalescer = createSeekCoalescer(clock, timers, 80, () => speedCoalescer.flush());
    speedCoalescer = createSpeedCoalescer({
      timers,
      isSeekPending: () => seekCoalescer.isPending(),
      apply: (rate) => applied.push(rate),
      settleMs: 80,
    });

    expect(seekCoalescer.isPending()).toBe(false);
    seekCoalescer.request(20_000, () => undefined);
    expect(seekCoalescer.isPending()).toBe(true);

    speedCoalescer.request(1.5);
    speedCoalescer.request(2.5);
    expect(applied).toEqual([]);

    // Seek confirmed by clock within coalesce window: still pending until 80ms window clears
    expect(seekCoalescer.shouldAcceptClock({ positionMs: 20_000, atMs: Date.now(), rate: 1 })).toBe(
      true,
    );
    expect(seekCoalescer.isPending()).toBe(true);
    vi.advanceTimersByTime(80);
    expect(seekCoalescer.isPending()).toBe(false);
    expect(applied).toEqual([2.5]);

    // Second seek with no clock confirmation ever arriving -> flushes after stale-clock guard (400ms)
    vi.advanceTimersByTime(80);
    seekCoalescer.request(40_000, () => undefined);
    speedCoalescer.request(1.25);
    expect(applied).toEqual([2.5]);
    vi.advanceTimersByTime(399);
    expect(seekCoalescer.isPending()).toBe(true);
    expect(applied).toEqual([2.5]);
    vi.advanceTimersByTime(100);
    expect(seekCoalescer.isPending()).toBe(false);
    expect(applied).toEqual([2.5, 1.25]);
  });

  it('bounds automatic timer retries when isSeekPending stays permanently true', () => {
    const applied: number[] = [];
    const coalescer = createSpeedCoalescer({
      timers: fakeTimers(),
      isSeekPending: () => true,
      apply: (rate) => applied.push(rate),
      settleMs: 50,
    });

    coalescer.request(1.75);
    vi.runAllTimers();
    expect(applied).toEqual([]);
    expect(coalescer.pendingSpeed()).toBe(1.75);
  });

  it('notifySettled clears in-flight state and immediately flushes pending speed', () => {
    const applied: number[] = [];
    const coalescer = createSpeedCoalescer({
      timers: fakeTimers(),
      isSeekPending: () => false,
      apply: (rate) => applied.push(rate),
      settleMs: 100,
    });

    coalescer.request(1.25);
    coalescer.request(2.0);
    expect(applied).toEqual([1.25]);
    coalescer.notifySettled();
    expect(applied).toEqual([1.25, 2.0]);
  });

  it('drops a queued service.setSpeed across seek when recovery rung 1 or ended supersedes the attempt', async () => {
    const engine = createFakePlayerEngine({
      now: () => Date.now(),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    const speeds: Array<{ attempt: number; rate: number }> = [];
    engine.setSpeed = (attempt, rate) => speeds.push({ attempt, rate });
    const service = createPlaybackService({
      engine,
      clock: { now: () => Date.now() },
      timers: fakeTimers(),
    });

    const t1 = service.tune({
      item: 'vod-1',
      accountKey: 'acc',
      kind: 'vod',
      resolve: () => Promise.resolve(ok({ url: 'http://cdn.test/v.mp4', headers: {} })),
    });
    await vi.advanceTimersByTimeAsync(300);

    // Queue speed during seek, then transition to ended before seek settles
    service.seek(15_000);
    service.setSpeed(2.0);
    engine.emit({ attempt: t1, type: 'state', state: 'ended' });
    await vi.advanceTimersByTimeAsync(500);
    expect(speeds).toEqual([]);

    // Resume live stream, queue speed during seek, then trigger recovery rung 1 (retry)
    const t2 = service.tune({
      item: 'live-1',
      accountKey: 'acc',
      kind: 'live',
      resolve: () => Promise.resolve(ok({ url: 'http://cdn.test/live.ts', headers: {} })),
    });
    await vi.advanceTimersByTimeAsync(300);
    service.seek(10_000);
    service.setSpeed(1.5);
    engine.emit({ attempt: t2, type: 'error', error: { code: 'network' } });
    expect(service.getState().attempt).toBeGreaterThan(t2);
    await vi.advanceTimersByTimeAsync(500);
    expect(speeds).toEqual([]);

    service.dispose();
  });
});
