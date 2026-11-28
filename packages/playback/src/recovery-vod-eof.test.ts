import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAYBACK_CONFIG } from './config';
import { type ClockAnchor, EMPTY_TRACKS } from './engine';
import { createRecovery, isUnexpectedVodEarlyEof } from './recovery';
import {
  live,
  play,
  playing,
  type Rig,
  recovering,
  rig,
  state,
  status,
  tick,
  vod,
} from './recovery-test-helpers';
import type { ServiceControl } from './seam';
import type { PlaybackStatus } from './types';

const emitClock = (r: Rig, anchor: ClockAnchor): void => {
  r.engine.emit({ attempt: r.service.getState().attempt, type: 'clock', anchor });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
});
afterEach(() => vi.useRealTimers());

describe('isUnexpectedVodEarlyEof', () => {
  it('returns false for non-finite or non-positive positionMs/durationMs', () => {
    expect(isUnexpectedVodEarlyEof(0, 7_200_000)).toBe(false);
    expect(isUnexpectedVodEarlyEof(-1_000, 7_200_000)).toBe(false);
    expect(isUnexpectedVodEarlyEof(Number.NaN, 7_200_000)).toBe(false);
    expect(isUnexpectedVodEarlyEof(Number.POSITIVE_INFINITY, 7_200_000)).toBe(false);
    expect(isUnexpectedVodEarlyEof(30_000, 0)).toBe(false);
    expect(isUnexpectedVodEarlyEof(30_000, -100)).toBe(false);
    expect(isUnexpectedVodEarlyEof(30_000, Number.NaN)).toBe(false);
    expect(isUnexpectedVodEarlyEof(30_000, Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('uses max(10_000 ms, 1% of duration) remaining threshold', () => {
    // Short clip (5s): threshold is 10s -> never early EOF
    expect(isUnexpectedVodEarlyEof(4_500, 5_000)).toBe(false);
    expect(isUnexpectedVodEarlyEof(1_000, 8_000)).toBe(false);

    // 2-minute clip (120s): 1% is 1.2s -> threshold is 10s
    expect(isUnexpectedVodEarlyEof(110_000, 120_000)).toBe(false);
    expect(isUnexpectedVodEarlyEof(109_999, 120_000)).toBe(true);

    // 2-hour movie (7,200s): 1% is 72s -> threshold is 72s
    expect(isUnexpectedVodEarlyEof(7_128_000, 7_200_000)).toBe(false);
    expect(isUnexpectedVodEarlyEof(7_127_999, 7_200_000)).toBe(true);
    expect(isUnexpectedVodEarlyEof(3_600_000, 7_200_000)).toBe(true);
  });
});

describe('mid-movie VOD premature EOF recovery', () => {
  it('intercepts mid-movie VOD ended, clears queued next episode, preserves position, and reconnects without emitting ended', async () => {
    const r = rig({ movie: [] });
    const clearQueuedNext = vi.fn();
    r.engine.clearQueuedNext = clearQueuedNext;
    const t = await playing(r, vod('movie'));

    emitClock(r, { positionMs: 1_200_000, atMs: Date.now(), rate: 1, durationMs: 5_400_000 });
    await tick(5_000);

    const seenStatuses: PlaybackStatus['kind'][] = [];
    r.service.subscribe((s) => seenStatuses.push(s.status.kind));

    // Unexpected mid-movie EOF at 1,205,000 ms of 5,400,000 ms
    state(r, 'ended');

    expect(seenStatuses).toEqual(['recovering']);
    expect(seenStatuses).not.toContain('ended');
    expect(status(r)).toEqual(recovering(2, 2_000));
    expect(clearQueuedNext).toHaveBeenCalledTimes(1);
    expect(r.service.getState().anchor).toMatchObject({
      positionMs: 1_205_000,
      rate: 0,
      durationMs: 5_400_000,
    });

    // Duplicate trailing ended from the same dead stream during backoff must not abort recovery
    state(r, 'ended');
    expect(status(r)).toEqual(recovering(2, 2_000));
    expect(clearQueuedNext).toHaveBeenCalledTimes(1);

    await tick(2_000);
    expect(r.loads).toHaveLength(2);
    expect(r.loads.at(-1)).toMatchObject({
      attempt: t + 1,
      url: 'movie',
      kind: 'vod',
      startMs: 1_205_000,
    });

    play(r);
    expect(status(r)).toEqual({ kind: 'playing' });
  });

  it('prevents infinite loops when a truncated file hits EOF again within 5s time or within 5s of recovery position', async () => {
    const r = rig({ truncated: [] });
    const clearQueuedNext = vi.fn();
    r.engine.clearQueuedNext = clearQueuedNext;
    await playing(r, vod('truncated'));

    emitClock(r, { positionMs: 1_200_000, atMs: Date.now(), rate: 1, durationMs: 5_400_000 });
    state(r, 'ended');
    expect(status(r)).toEqual(recovering(2, 2_000));
    expect(clearQueuedNext).toHaveBeenCalledTimes(1);

    // Reload happens at +2s and starts playing within rungTimeoutMs
    await tick(2_000);
    expect(r.loads).toHaveLength(2);
    await tick(500);
    play(r);

    // Wall-clock passes 5s cooldown (total 8s since EOF #1), but position only reached 1,202,000 (within 5s position tolerance) -> hits truncation again
    await tick(5_500);
    emitClock(r, { positionMs: 1_202_000, atMs: Date.now(), rate: 1, durationMs: 5_400_000 });
    state(r, 'ended');

    expect(status(r)).toEqual({ kind: 'ended' });
    expect(r.loads).toHaveLength(2);
    expect(clearQueuedNext).toHaveBeenCalledTimes(1);

    // Further ended events stay ended and never schedule extra reloads
    await tick(20_000);
    expect(status(r)).toEqual({ kind: 'ended' });
    expect(r.loads).toHaveLength(2);
  });

  it('blocks a second early EOF within 5s wall-clock cooldown even if position shifted slightly past 5s', async () => {
    const r = rig({ truncated: [] });
    await playing(r, vod('truncated'));

    emitClock(r, { positionMs: 1_000_000, atMs: Date.now(), rate: 1, durationMs: 5_400_000 });
    state(r, 'ended');
    expect(status(r)).toEqual(recovering(2, 2_000));

    await tick(2_000);
    play(r);
    // Only 3s elapsed since first EOF (< 5s cooldown), position at 1_006_000 (< 10s advance reset)
    await tick(1_000);
    emitClock(r, { positionMs: 1_006_000, atMs: Date.now(), rate: 1, durationMs: 5_400_000 });
    state(r, 'ended');

    expect(status(r)).toEqual({ kind: 'ended' });
    expect(r.loads).toHaveLength(2);
  });

  it('resets anti-loop guard once playback advances >= 10s past the recovery point and on new media load / seek', async () => {
    const r = rig({ movie: [], movie2: [] });
    await playing(r, vod('movie'));

    emitClock(r, { positionMs: 1_200_000, atMs: Date.now(), rate: 1, durationMs: 5_400_000 });
    state(r, 'ended');
    expect(status(r)).toEqual(recovering(2, 2_000));

    await tick(2_000);
    play(r);
    // Playback advances 10_000 ms past 1_200_000 -> resets early-EOF anti-loop guard
    await tick(10_000);
    emitClock(r, { positionMs: 1_210_000, atMs: Date.now(), rate: 1, durationMs: 5_400_000 });

    // A later transient disconnect at 1,800,000 ms recovers again (2nd VOD backoff step = 4s since < 30s stable restore)
    await tick(10_000);
    emitClock(r, { positionMs: 1_800_000, atMs: Date.now(), rate: 1, durationMs: 5_400_000 });
    state(r, 'ended');
    expect(status(r)).toEqual(recovering(2, 4_000));

    await tick(4_000);
    expect(r.loads).toHaveLength(3);
    expect(r.loads.at(-1)).toMatchObject({ startMs: 1_800_000 });

    // Seeking >= 10s away from recovery point also resets anti-loop guard (and seek resets VOD backoff to 2s)
    play(r);
    r.service.seek(2_400_000);
    await tick(100);
    emitClock(r, { positionMs: 2_400_000, atMs: Date.now(), rate: 1, durationMs: 5_400_000 });
    state(r, 'ended');
    expect(status(r)).toEqual(recovering(2, 2_000));

    // New media load resets guard and backoff immediately
    await playing(r, vod('movie2'));
    emitClock(r, { positionMs: 1_800_000, atMs: Date.now(), rate: 1, durationMs: 5_400_000 });
    state(r, 'ended');
    expect(status(r)).toEqual(recovering(2, 2_000));
  });

  it('does not intercept genuine VOD end, unknown duration, paused state, or live streams', async () => {
    const r = rig({ movie: [], chan: [] });
    const clearQueuedNext = vi.fn();
    r.engine.clearQueuedNext = clearQueuedNext;

    // 1. Genuine end within final 1% of 2-hour movie
    await playing(r, vod('movie'));
    emitClock(r, { positionMs: 7_150_000, atMs: Date.now(), rate: 1, durationMs: 7_200_000 });
    state(r, 'ended');
    expect(status(r)).toEqual({ kind: 'ended' });
    expect(clearQueuedNext).not.toHaveBeenCalled();

    // 2. Unknown duration (durationMs omitted)
    await playing(r, vod('movie'));
    emitClock(r, { positionMs: 500_000, atMs: Date.now(), rate: 1 });
    state(r, 'ended');
    expect(status(r)).toEqual({ kind: 'ended' });
    expect(clearQueuedNext).not.toHaveBeenCalled();

    // 3. Paused mid-movie
    await playing(r, vod('movie'));
    emitClock(r, { positionMs: 500_000, atMs: Date.now(), rate: 1, durationMs: 5_400_000 });
    r.service.pause();
    state(r, 'paused');
    state(r, 'ended');
    expect(status(r)).toEqual({ kind: 'ended' });
    expect(clearQueuedNext).not.toHaveBeenCalled();

    // 4. Live stream does not invoke VOD early-EOF path
    await playing(r, live('chan'));
    state(r, 'ended');
    expect(status(r)).toEqual({ kind: 'tuning' });
    expect(clearQueuedNext).not.toHaveBeenCalled();
  });

  it('returns false when awaiting surface or stream is missing', () => {
    const makeControl = (overrides: Partial<ServiceControl> = {}): ServiceControl => ({
      engine: {
        capabilities: {
          mpegTsOverHttp: true,
          hls: true,
          liveSeek: false,
          softwareAudioFallback: false,
          recreate: true,
          audioTrackSelection: true,
          subtitleTrackSelection: true,
        },
        load: vi.fn(),
        retry: vi.fn(),
        play: vi.fn(),
        pause: vi.fn(),
        seek: vi.fn(),
        stop: vi.fn(),
        recreate: vi.fn(),
        release: vi.fn(),
        subscribe: () => () => {},
      },
      config: DEFAULT_PLAYBACK_CONFIG,
      now: () => Date.now(),
      getState: () => ({
        status: { kind: 'playing' },
        attempt: 1,
        tracks: EMPTY_TRACKS,
        staleEventsDropped: 0,
        surfaceRecreationToken: 0,
        anchor: { positionMs: 600_000, atMs: Date.now(), rate: 1, durationMs: 5_400_000 },
      }),
      request: () => vod('movie'),
      stream: () => undefined,
      startTimeoutMs: () => 8_000,
      nextAttempt: () => 2,
      setStatus: vi.fn(),
      freezeAnchor: vi.fn(),
      load: vi.fn(() => true),
      stopMedia: vi.fn(),
      fail: vi.fn(),
      armStartTimeout: vi.fn(),
      clearStartTimeout: vi.fn(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      ...overrides,
    });

    // Missing stream
    const hooksNoStream = createRecovery(makeControl({ stream: () => undefined }));
    expect(hooksNoStream.onVodEnded?.()).toBe(false);

    // Awaiting surface after surface-lost
    const hooksSurface = createRecovery(
      makeControl({ stream: () => ({ url: 'movie', headers: {} }) }),
    );
    hooksSurface.onSurface?.('destroyed');
    hooksSurface.onError?.({ code: 'surface-lost' });
    expect(hooksSurface.onVodEnded?.()).toBe(false);
  });

  it('swallows trailing ended during error-initiated VOD recovery backoff without restarting reconnectVod or clobbering lastError, and clears queued next on VOD network error', async () => {
    const r = rig({ movie: [] });
    const clearQueuedNext = vi.fn();
    r.engine.clearQueuedNext = clearQueuedNext;
    const t = await playing(r, vod('movie'));

    emitClock(r, { positionMs: 1_200_000, atMs: Date.now(), rate: 1, durationMs: 5_400_000 });

    // Network error initiates VOD recovery backoff (2,000 ms) and clears any gapless next-episode slot
    r.engine.emit({
      attempt: t,
      type: 'error',
      error: { code: 'network', detail: 'socket-reset' },
    });
    const expectedNextAtMs = Date.now() + 2_000;
    expect(status(r)).toEqual({ kind: 'recovering', rung: 2, nextAtMs: expectedNextAtMs });
    expect(clearQueuedNext).toHaveBeenCalledTimes(1);

    // 500 ms into the 2,000 ms backoff, a trailing ended arrives from the same dead stream
    await tick(500);
    state(r, 'ended');

    // Must swallow trailing ended without restarting the timer (nextAtMs stays at original 2,000 ms deadline)
    // and without calling clearQueuedNext a second time
    expect(status(r)).toEqual({ kind: 'recovering', rung: 2, nextAtMs: expectedNextAtMs });
    expect(clearQueuedNext).toHaveBeenCalledTimes(1);
    expect(r.loads).toHaveLength(1);

    // Original timer fires at remaining 1,500 ms (NOT delayed by another 2,000 ms)
    await tick(1_500);
    expect(r.loads).toHaveLength(2);
    expect(r.loads.at(-1)).toMatchObject({ attempt: t + 1, startMs: 1_200_000 });

    // Exhausting the 120s VOD reconnect window must preserve the original error detail ('socket-reset', NOT 'vod-premature-eof')
    await tick(130_000);
    expect(status(r)).toEqual({
      kind: 'failed',
      error: { category: 'playback', code: 'network', detail: 'socket-reset' },
    });
  });
});
