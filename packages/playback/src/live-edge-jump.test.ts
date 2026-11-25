import { ok } from '@elv/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamRequest } from './engine';
import { createPlaybackService } from './service';
import { createFakePlayerEngine, type FakePlayerEngine } from './testing';
import type { PlaybackService, TuneRequest } from './types';

const req = (url: string): StreamRequest => ({ url, headers: {} });

function setup(): { engine: FakePlayerEngine; service: PlaybackService } {
  const engine = createFakePlayerEngine({
    scripts: {},
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});

afterEach(() => vi.useRealTimers());

describe('PlaybackService.jumpToLiveEdge (#141)', () => {
  it('seeks to liveEdgeMs - 1_000 on live MPEG-TS streams lagging > 15s behind live edge and returns true', async () => {
    const { engine, service } = setup();
    const t = service.tune(tuneReq('http://provider.invalid/live/1.ts', { kind: 'live' }));
    await vi.advanceTimersByTimeAsync(300);

    engine.emit({
      attempt: t,
      type: 'clock',
      anchor: {
        positionMs: 10_000,
        atMs: Date.now(),
        rate: 1,
        liveEdgeMs: 30_000,
        isLiveTs: true,
      },
    });

    expect(service.jumpToLiveEdge()).toBe(true);
    expect(service.getState().anchor?.positionMs).toBe(29_000);
    expect(service.getState().anchor?.isLiveTs).toBe(true);
    expect(service.getState().atLiveEdge).toBe(true);
    expect(engine.commands.at(-1)).toEqual({ name: 'seek', attempt: t, positionMs: 29_000 });

    // Immediate second call is now within 15s of live edge -> returns false (no-op)
    const countBefore = engine.commands.length;
    expect(service.jumpToLiveEdge()).toBe(false);
    expect(engine.commands.length).toBe(countBefore);
  });

  it('works while paused on a live MPEG-TS stream and unpauses cleanly on the same attempt', async () => {
    const { engine, service } = setup();
    const t = service.tune(tuneReq('http://provider.invalid/live/2.ts', { kind: 'live' }));
    await vi.advanceTimersByTimeAsync(300);

    service.pause();
    const pausedToken = service.getState().attempt;
    engine.emit({ attempt: pausedToken, type: 'state', state: 'paused' });
    engine.emit({
      attempt: pausedToken,
      type: 'clock',
      anchor: {
        positionMs: 5_000,
        atMs: Date.now(),
        rate: 0,
        liveEdgeMs: 25_000,
        isLiveTs: true,
      },
    });

    expect(service.jumpToLiveEdge()).toBe(true);
    expect(service.getState().attempt).toBe(pausedToken);
    expect(service.getState().status.kind).toBe('tuning');
    expect(service.getState().anchor?.positionMs).toBe(24_000);
    expect(engine.commands.slice(-2)).toEqual([
      { name: 'seek', attempt: pausedToken, positionMs: 24_000 },
      { name: 'play', attempt: pausedToken },
    ]);
    expect(pausedToken).toBeGreaterThan(t);
  });

  it('returns false (no-op) for HLS live streams (isLiveTs false or omitted) and VOD streams', async () => {
    const { engine, service } = setup();

    // Live HLS (isLiveTs omitted)
    const tHls = service.tune(tuneReq('http://provider.invalid/live/1.m3u8', { kind: 'live' }));
    await vi.advanceTimersByTimeAsync(300);
    engine.emit({
      attempt: tHls,
      type: 'clock',
      anchor: { positionMs: 10_000, atMs: Date.now(), rate: 1, liveEdgeMs: 60_000 },
    });
    expect(service.jumpToLiveEdge()).toBe(false);

    // Live HLS (isLiveTs explicitly false)
    engine.emit({
      attempt: tHls,
      type: 'clock',
      anchor: {
        positionMs: 10_000,
        atMs: Date.now(),
        rate: 1,
        liveEdgeMs: 60_000,
        isLiveTs: false,
      },
    });
    expect(service.jumpToLiveEdge()).toBe(false);

    // VOD stream (even if anchor somehow sets isLiveTs: true)
    const tVod = service.tune(tuneReq('http://provider.invalid/movie/1.mp4', { kind: 'vod' }));
    await vi.advanceTimersByTimeAsync(300);
    engine.emit({
      attempt: tVod,
      type: 'clock',
      anchor: {
        positionMs: 10_000,
        atMs: Date.now(),
        rate: 1,
        durationMs: 120_000,
        liveEdgeMs: 120_000,
        isLiveTs: true,
      },
    });
    expect(service.jumpToLiveEdge()).toBe(false);
    expect(engine.commands.filter((c) => c.name === 'seek')).toHaveLength(0);
  });

  it('returns false when liveEdgeMs is absent, <= 15_000, non-finite, already within 15s, or idle/disposed', async () => {
    const { engine, service } = setup();

    // Idle
    expect(service.jumpToLiveEdge()).toBe(false);

    const t = service.tune(tuneReq('http://provider.invalid/live/3.ts', { kind: 'live' }));
    await vi.advanceTimersByTimeAsync(300);

    // Missing liveEdgeMs
    engine.emit({
      attempt: t,
      type: 'clock',
      anchor: { positionMs: 10_000, atMs: Date.now(), rate: 1, isLiveTs: true },
    });
    expect(service.jumpToLiveEdge()).toBe(false);

    // liveEdgeMs <= 15_000
    engine.emit({
      attempt: t,
      type: 'clock',
      anchor: { positionMs: 0, atMs: Date.now(), rate: 1, liveEdgeMs: 15_000, isLiveTs: true },
    });
    expect(service.jumpToLiveEdge()).toBe(false);

    // Non-finite liveEdgeMs
    engine.emit({
      attempt: t,
      type: 'clock',
      anchor: {
        positionMs: 0,
        atMs: Date.now(),
        rate: 1,
        liveEdgeMs: Number.POSITIVE_INFINITY,
        isLiveTs: true,
      },
    });
    expect(service.jumpToLiveEdge()).toBe(false);

    // Already within 15s of live edge (18_000 vs 30_000 -> lag = 12_000 <= 15_000)
    engine.emit({
      attempt: t,
      type: 'clock',
      anchor: {
        positionMs: 18_000,
        atMs: Date.now(),
        rate: 1,
        liveEdgeMs: 30_000,
        isLiveTs: true,
      },
    });
    expect(service.jumpToLiveEdge()).toBe(false);

    // Extrapolated position catches up within 15s after clock advances
    engine.emit({
      attempt: t,
      type: 'clock',
      anchor: {
        positionMs: 10_000,
        atMs: Date.now(),
        rate: 1,
        liveEdgeMs: 30_000,
        isLiveTs: true,
      },
    });
    vi.setSystemTime(Date.now() + 7_000);
    expect(service.jumpToLiveEdge()).toBe(false);

    // Disposed
    service.dispose();
    expect(service.jumpToLiveEdge()).toBe(false);
    expect(engine.commands.filter((c) => c.name === 'seek')).toHaveLength(0);
  });
});
