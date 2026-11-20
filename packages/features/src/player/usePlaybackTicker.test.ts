import type { ClockAnchor } from '@elv/playback';
import { describe, expect, it } from 'vitest';
import { isPlaybackTicking, startPlaybackTicker, type TickerScheduler } from './usePlaybackTicker';

function createScheduler() {
  const frames = new Map<number, () => void>();
  const timeouts = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 1;
  const scheduler: TickerScheduler = {
    requestFrame: (cb) => {
      const id = nextId++;
      frames.set(id, cb);
      return id;
    },
    cancelFrame: (handle) => {
      frames.delete(handle as number);
    },
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timeouts.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (handle) => {
      timeouts.delete(handle as number);
    },
  };
  return {
    scheduler,
    frames,
    timeouts,
    runFrames(): void {
      const pending = [...frames.entries()];
      frames.clear();
      for (const [, cb] of pending) cb();
    },
    runTimeouts(): void {
      const pending = [...timeouts.entries()];
      timeouts.clear();
      for (const [, entry] of pending) entry.fn();
    },
  };
}

const playing: ClockAnchor = { positionMs: 12_250, atMs: 1_000, rate: 1, durationMs: 60_000 };

describe('isPlaybackTicking', () => {
  it('ticks only for an advancing anchor while active', () => {
    expect(isPlaybackTicking(undefined)).toBe(false);
    expect(isPlaybackTicking({ ...playing, rate: 0 })).toBe(false);
    expect(isPlaybackTicking({ ...playing, rate: -1 })).toBe(false);
    expect(isPlaybackTicking(playing)).toBe(true);
    expect(isPlaybackTicking(playing, false)).toBe(false);
    expect(isPlaybackTicking(playing, true)).toBe(true);
  });
});

describe('startPlaybackTicker', () => {
  it('schedules zero frames or timeouts when the anchor is paused or missing', () => {
    const fake = createScheduler();
    let ticks = 0;
    const stopPaused = startPlaybackTicker({
      anchor: { ...playing, rate: 0 },
      mode: 'frame',
      clock: { now: () => 1_000 },
      scheduler: fake.scheduler,
      onTick: () => {
        ticks += 1;
      },
    });
    const stopMissing = startPlaybackTicker({
      anchor: undefined,
      mode: 'second',
      clock: { now: () => 1_000 },
      scheduler: fake.scheduler,
      onTick: () => {
        ticks += 1;
      },
    });
    expect(fake.frames.size).toBe(0);
    expect(fake.timeouts.size).toBe(0);
    stopPaused();
    stopMissing();
    expect(ticks).toBe(0);
  });

  it('re-requests animation frames in frame mode until stopped', () => {
    const fake = createScheduler();
    let ticks = 0;
    const stop = startPlaybackTicker({
      anchor: playing,
      mode: 'frame',
      clock: { now: () => 1_000 },
      scheduler: fake.scheduler,
      onTick: () => {
        ticks += 1;
      },
    });
    expect(fake.frames.size).toBe(1);
    fake.runFrames();
    fake.runFrames();
    expect(ticks).toBe(2);
    expect(fake.frames.size).toBe(1);
    stop();
    expect(fake.frames.size).toBe(0);
    fake.runFrames();
    expect(ticks).toBe(2);
  });

  it('wakes on the next media-second boundary in second mode, scaled by rate', () => {
    const fake = createScheduler();
    let now = 1_000;
    let ticks = 0;
    const stop = startPlaybackTicker({
      anchor: playing,
      mode: 'second',
      clock: { now: () => now },
      scheduler: fake.scheduler,
      onTick: () => {
        ticks += 1;
      },
    });
    expect([...fake.timeouts.values()].map((t) => t.ms)).toEqual([751]);
    now = 1_751;
    fake.runTimeouts();
    expect(ticks).toBe(1);
    expect([...fake.timeouts.values()].map((t) => t.ms)).toEqual([1000]);
    stop();
    expect(fake.timeouts.size).toBe(0);

    const fast = createScheduler();
    const stopFast = startPlaybackTicker({
      anchor: { ...playing, rate: 2 },
      mode: 'second',
      clock: { now: () => 1_000 },
      scheduler: fast.scheduler,
      onTick: () => undefined,
    });
    expect([...fast.timeouts.values()].map((t) => t.ms)).toEqual([376]);
    stopFast();
  });
});
