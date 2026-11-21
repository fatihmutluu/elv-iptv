import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAYBACK_CONFIG } from './config';
import { type ClockAnchor, EMPTY_TRACKS } from './engine';
import { createRecovery } from './recovery';
import {
  failed,
  last,
  live,
  play,
  playing,
  type Rig,
  recovering,
  resolved,
  rig,
  state,
  status,
  tick,
  vod,
} from './recovery-test-helpers';
import type { ServiceControl } from './seam';
import { createPlaybackService } from './service';
import { createFakePlayerEngine } from './testing';
import type { PlaybackState, PlaybackStatus } from './types';

const emitClock = (r: Rig, anchor: ClockAnchor): void => {
  r.engine.emit({ attempt: r.service.getState().attempt, type: 'clock', anchor });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
});
afterEach(() => vi.useRealTimers());

describe('#284: 5-second live-edge grace window tolerance', () => {
  it('holds atLiveEdge true across 0..5000 ms drift, flips false at 5001 ms, and recovers on catch-up', async () => {
    const r = rig({ chan: [] });
    await playing(r, live('chan'));

    const edgeHistory: Array<boolean | undefined> = [];
    r.service.subscribe((s) => edgeHistory.push(s.atLiveEdge));

    emitClock(r, { positionMs: 60_000, atMs: Date.now(), rate: 1, liveEdgeMs: 60_000 });
    expect(r.service.getState().atLiveEdge).toBe(true);

    await tick(1000);
    emitClock(r, { positionMs: 59_000, atMs: Date.now(), rate: 1, liveEdgeMs: 61_000 });
    expect(r.service.getState().atLiveEdge).toBe(true);

    await tick(1000);
    emitClock(r, { positionMs: 57_001, atMs: Date.now(), rate: 1, liveEdgeMs: 62_000 });
    expect(r.service.getState().atLiveEdge).toBe(true);

    await tick(1000);
    emitClock(r, { positionMs: 58_000, atMs: Date.now(), rate: 1, liveEdgeMs: 63_000 });
    expect(r.service.getState().atLiveEdge).toBe(true);

    // Every update within the 5-second grace window kept atLiveEdge strictly true (zero flicker).
    expect(edgeHistory).toEqual([true, true, true, true]);

    await tick(1000);
    emitClock(r, { positionMs: 58_999, atMs: Date.now(), rate: 1, liveEdgeMs: 64_000 });
    expect(r.service.getState().atLiveEdge).toBe(false);

    await tick(1000);
    emitClock(r, { positionMs: 60_000, atMs: Date.now(), rate: 1, liveEdgeMs: 65_000 });
    expect(r.service.getState().atLiveEdge).toBe(true);
  });

  it('marks unbounded live streams (no liveEdgeMs) as atLiveEdge true and omits it on VOD and stop', async () => {
    const r = rig({ chan: [], movie: [] });
    await playing(r, live('chan'));
    emitClock(r, { positionMs: 5_000, atMs: Date.now(), rate: 1 });
    expect(r.service.getState().atLiveEdge).toBe(true);

    r.service.stop();
    expect(r.service.getState().atLiveEdge).toBeUndefined();

    await playing(r, vod('movie'));
    emitClock(r, { positionMs: 5_000, atMs: Date.now(), rate: 1, durationMs: 120_000 });
    expect(r.service.getState().atLiveEdge).toBeUndefined();
  });

  it('clears atLiveEdge on a new tune and respects custom liveEdgeToleranceMs', async () => {
    const engine = createFakePlayerEngine({
      scripts: { chan: [], movie: [] },
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
      config: { liveEdgeToleranceMs: 2_000 },
    });

    const t1 = service.tune(live('chan'));
    await tick(0);
    engine.emit({ attempt: t1, type: 'state', state: 'playing' });
    engine.emit({
      attempt: t1,
      type: 'clock',
      anchor: { positionMs: 58_000, atMs: Date.now(), rate: 1, liveEdgeMs: 60_000 },
    });
    expect(service.getState().atLiveEdge).toBe(true);

    engine.emit({
      attempt: t1,
      type: 'clock',
      anchor: { positionMs: 57_999, atMs: Date.now(), rate: 1, liveEdgeMs: 60_000 },
    });
    expect(service.getState().atLiveEdge).toBe(false);

    service.tune(vod('movie'));
    expect(service.getState().atLiveEdge).toBeUndefined();
  });

  it('updates atLiveEdge on live timeshift seek and suppresses duplicate clock notifications', async () => {
    const r = rig({ chan: [] });
    await playing(r, live('chan'));
    const anchor: ClockAnchor = {
      positionMs: 60_000,
      atMs: Date.now(),
      rate: 1,
      liveEdgeMs: 60_000,
    };
    emitClock(r, anchor);

    const seen: PlaybackState[] = [];
    r.service.subscribe((s) => seen.push(s));
    emitClock(r, { ...anchor });
    expect(seen).toHaveLength(0);

    r.service.seek(30_000);
    expect(r.service.getState().atLiveEdge).toBe(false);
    expect(seen).toHaveLength(1);

    // Pre-seek clock tick rejected by seek coalescer still updates liveEdgeMs metadata and atLiveEdge.
    emitClock(r, { positionMs: 59_000, atMs: Date.now(), rate: 1, liveEdgeMs: 65_000 });
    expect(r.service.getState().anchor?.liveEdgeMs).toBe(65_000);
    expect(r.service.getState().atLiveEdge).toBe(false);
  });
});

describe('#148: single-attempt live clean-end reconnect', () => {
  it('intercepts the first unexpected ended on live, reloads cleanly without emitting ended, and recovers', async () => {
    const r = rig({ chan: [] });
    const t1 = await playing(r, live('chan'));

    const statuses: PlaybackState['status']['kind'][] = [];
    r.service.subscribe((s) => statuses.push(s.status.kind));

    state(r, 'ended');
    expect(statuses).toEqual(['tuning']);
    expect(status(r)).toEqual({ kind: 'tuning' });
    expect(r.service.getState().attempt).toBe(t1 + 1);
    expect(r.loads).toHaveLength(2);
    expect(r.loads.at(-1)).toMatchObject({ attempt: t1 + 1, url: 'chan', kind: 'live' });

    play(r);
    expect(status(r)).toEqual({ kind: 'playing' });
    await tick(10_000);
    expect(r.loads).toHaveLength(2);
  });

  it('arms liveStartTimeoutMs on clean-end reconnect and escalates if the reconnect hangs', async () => {
    const r = rig({ chan: [] });
    await playing(r, live('chan'));

    state(r, 'ended');
    expect(status(r)).toEqual({ kind: 'tuning' });
    await tick(4999);
    expect(status(r)).toEqual({ kind: 'tuning' });
    await tick(1);
    expect(status(r)).toEqual(recovering(1, 0));
  });

  it('never loops infinitely: a second clean ended on the same tune transitions to ended', async () => {
    const r = rig({ chan: [] });
    await playing(r, live('chan'));

    state(r, 'ended');
    expect(status(r)).toEqual({ kind: 'tuning' });
    expect(r.loads).toHaveLength(2);

    // Reconnect immediately ends cleanly again -> must NOT reconnect a second time.
    state(r, 'ended');
    expect(status(r)).toEqual({ kind: 'ended' });
    expect(r.loads).toHaveLength(2);

    // Duplicate ended events after retry exhaustion must stay ended (no unbounded loop).
    state(r, 'ended');
    state(r, 'ended');
    expect(status(r)).toEqual({ kind: 'ended' });
    expect(r.loads).toHaveLength(2);

    await tick(20_000);
    expect(status(r)).toEqual({ kind: 'ended' });
    expect(r.loads).toHaveLength(2);
  });

  it('resets the single clean-end reconnect allowance on explicit user retry(), new tune(), or stop()', async () => {
    const r = rig({ chan: [], chan2: [] });
    await playing(r, live('chan'));

    state(r, 'ended');
    state(r, 'ended');
    expect(status(r)).toEqual({ kind: 'ended' });

    // Explicit user retry() starts a fresh tune and restores the single reconnect allowance.
    r.service.retry();
    await tick(0);
    play(r);
    state(r, 'ended');
    expect(status(r)).toEqual({ kind: 'tuning' });
    expect(r.loads).toHaveLength(4);

    // New tune() restores it too.
    await playing(r, live('chan2'));
    state(r, 'ended');
    expect(status(r)).toEqual({ kind: 'tuning' });
    expect(r.loads).toHaveLength(6);

    // stop() + tune() restores it too.
    r.service.stop();
    await playing(r, live('chan'));
    state(r, 'ended');
    expect(status(r)).toEqual({ kind: 'tuning' });
    expect(r.loads).toHaveLength(8);
  });

  it('does not auto-reconnect when paused (even on duplicate ended) or on VOD ended', async () => {
    const r = rig({ chan: [], movie: [] });
    await playing(r, live('chan'));
    r.service.pause();
    state(r, 'paused');
    state(r, 'ended');
    state(r, 'ended');
    expect(status(r)).toEqual({ kind: 'ended' });
    expect(r.loads).toHaveLength(1);

    await playing(r, vod('movie'));
    state(r, 'ended');
    expect(status(r)).toEqual({ kind: 'ended' });
    expect(r.loads).toHaveLength(2);
  });

  it('returns false and avoids stranding in tuning when ctl.load() returns false without ctl.stream', () => {
    let curStatus: PlaybackStatus = { kind: 'playing' };
    let attempt = 1;
    const armStartTimeout = vi.fn();
    const engine = createFakePlayerEngine({
      now: () => Date.now(),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    const ctl: ServiceControl = {
      engine,
      config: DEFAULT_PLAYBACK_CONFIG,
      now: () => Date.now(),
      getState: () => ({
        status: curStatus,
        attempt,
        tracks: EMPTY_TRACKS,
        staleEventsDropped: 0,
      }),
      request: () => live('chan'),
      startTimeoutMs: () => 5000,
      nextAttempt: () => {
        attempt += 1;
        return attempt;
      },
      setStatus: (s) => {
        curStatus = s;
      },
      freezeAnchor: () => {},
      load: () => false,
      stopMedia: () => {},
      fail: () => {},
      armStartTimeout,
      clearStartTimeout: () => {},
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    const hooks = createRecovery(ctl);
    expect(hooks.onLiveEnded?.()).toBe(false);
    expect(curStatus).toEqual({ kind: 'playing' });
    expect(armStartTimeout).not.toHaveBeenCalled();
  });
});

describe('#148: frame-silence / frozen-clock stall reset on live', () => {
  it('reloads live edge once when playing clock stays frozen for liveStallWindowMs, then escalates if it freezes again', async () => {
    const r = rig({ chan: [], alt: [] });
    const t1 = await playing(r, live('chan', { alternates: [resolved('alt')] }));

    // Initial clock baseline.
    emitClock(r, { positionMs: 20_000, atMs: Date.now(), rate: 1 });
    await tick(3999);
    emitClock(r, { positionMs: 20_000, atMs: Date.now(), rate: 1 });
    expect(status(r)).toEqual({ kind: 'playing' });
    expect(r.loads).toHaveLength(1);

    // At 4000 ms of non-advancing clock -> single live-edge reload reset.
    await tick(1);
    emitClock(r, { positionMs: 20_000, atMs: Date.now(), rate: 1 });
    expect(status(r)).toEqual({ kind: 'tuning' });
    expect(r.service.getState().attempt).toBe(t1 + 1);
    expect(r.loads).toHaveLength(2);

    // Stream resumes playing, then freezes AGAIN for 4000 ms -> escalates into recovery ladder.
    play(r);
    emitClock(r, { positionMs: 25_000, atMs: Date.now(), rate: 1 });
    await tick(4000);
    emitClock(r, { positionMs: 25_000, atMs: Date.now(), rate: 1 });
    expect(status(r)).toEqual(recovering(1, 0));
    expect(last(r)).toEqual({ name: 'retry', attempt: t1 + 2 });

    // Climbing the ladder exhausts cleanly into failed.
    await tick(2000);
    expect(status(r)).toEqual(recovering(2, 0));
    await tick(2000);
    expect(status(r)).toEqual(recovering(3, 0));
    await tick(2000);
    expect(status(r)).toEqual(recovering(4, 0));
    await tick(2000);
    expect(status(r)).toEqual(failed('network'));
  });

  it('resets the frozen-clock tracker whenever positionMs advances', async () => {
    const r = rig({ chan: [] });
    await playing(r, live('chan'));

    emitClock(r, { positionMs: 10_000, atMs: Date.now(), rate: 1 });
    await tick(3000);
    emitClock(r, { positionMs: 10_000, atMs: Date.now(), rate: 1 });
    expect(status(r)).toEqual({ kind: 'playing' });

    // Position advances -> resets frozen window.
    await tick(500);
    emitClock(r, { positionMs: 10_500, atMs: Date.now(), rate: 1 });
    await tick(3500);
    emitClock(r, { positionMs: 10_500, atMs: Date.now(), rate: 1 });
    expect(status(r)).toEqual({ kind: 'playing' });
    expect(r.loads).toHaveLength(1);
  });

  it('produces zero false positives when paused, rate === 0, seeking, VOD, or before firstFrameAt', async () => {
    const r = rig({ chan: [], movie: [] });

    // 1) Before firstFrameAt on live.
    r.service.tune(live('chan'));
    await tick(0);
    state(r, 'playing');
    emitClock(r, { positionMs: 1_000, atMs: Date.now(), rate: 1 });
    await tick(5_000);
    emitClock(r, { positionMs: 1_000, atMs: Date.now(), rate: 1 });
    expect(status(r)).toEqual({ kind: 'playing' });
    expect(r.loads).toHaveLength(1);

    // 2) With firstFrameAt, rate === 0 (paused/frozen rate).
    play(r);
    emitClock(r, { positionMs: 5_000, atMs: Date.now(), rate: 0 });
    await tick(5_000);
    emitClock(r, { positionMs: 5_000, atMs: Date.now(), rate: 0 });
    expect(status(r)).toEqual({ kind: 'playing' });
    expect(r.loads).toHaveLength(1);

    // 3) Seeking (seekSettling, including stalledDuringSeek clock ticks).
    emitClock(r, { positionMs: 10_000, atMs: Date.now(), rate: 1 });
    await tick(3_000);
    r.service.seek(8_000);
    r.engine.emit({
      attempt: r.service.getState().attempt,
      type: 'stall',
      phase: 'start',
      atMs: Date.now(),
    });
    await tick(3_000);
    emitClock(r, { positionMs: 8_000, atMs: Date.now(), rate: 1 });
    r.engine.emit({
      attempt: r.service.getState().attempt,
      type: 'stall',
      phase: 'end',
      atMs: Date.now(),
    });
    expect(status(r)).toEqual({ kind: 'playing' });
    expect(r.loads).toHaveLength(1);

    // 3b) Backwards wall-clock jump resets frozenSinceMs instead of triggering early.
    const tNow = Date.now();
    emitClock(r, { positionMs: 11_000, atMs: tNow, rate: 1 });
    emitClock(r, { positionMs: 11_000, atMs: tNow - 1_000, rate: 1 });
    emitClock(r, { positionMs: 11_000, atMs: tNow + 2_000, rate: 1 });
    expect(status(r)).toEqual({ kind: 'playing' });
    expect(r.loads).toHaveLength(1);

    // 4) Paused via service.pause() before engine confirms paused state.
    emitClock(r, { positionMs: 12_000, atMs: Date.now(), rate: 1 });
    r.service.pause();
    await tick(5_000);
    emitClock(r, { positionMs: 12_000, atMs: Date.now(), rate: 1 });
    expect(r.loads).toHaveLength(1);

    // 5) VOD never triggers live frozen-clock reload.
    await playing(r, vod('movie'));
    emitClock(r, { positionMs: 30_000, atMs: Date.now(), rate: 1, durationMs: 120_000 });
    await tick(6_000);
    emitClock(r, { positionMs: 30_000, atMs: Date.now(), rate: 1, durationMs: 120_000 });
    expect(status(r)).toEqual({ kind: 'playing' });
    expect(r.loads).toHaveLength(2);
  });

  it('handles live backwards PTS discontinuity resets and NaN rate without false reloads', async () => {
    const r = rig({ chan: [] });
    await playing(r, live('chan'));

    // NaN rate never triggers frozen-clock detection.
    emitClock(r, { positionMs: 120_000, atMs: Date.now(), rate: Number.NaN });
    await tick(5_000);
    emitClock(r, { positionMs: 120_000, atMs: Date.now(), rate: Number.NaN });
    expect(status(r)).toEqual({ kind: 'playing' });
    expect(r.loads).toHaveLength(1);

    // Backwards discontinuity (120_000 -> 1_000 -> 2_000 -> 3_000 -> 4_000 -> 5_000) advances cleanly.
    emitClock(r, { positionMs: 120_000, atMs: Date.now(), rate: 1 });
    for (const pos of [1_000, 2_000, 3_000, 4_000, 5_000]) {
      await tick(1_000);
      emitClock(r, { positionMs: pos, atMs: Date.now(), rate: 1 });
    }
    expect(status(r)).toEqual({ kind: 'playing' });
    expect(r.loads).toHaveLength(1);

    // Freezing at 5_000 for 4000 ms after the discontinuity still triggers the reload.
    await tick(4_000);
    emitClock(r, { positionMs: 5_000, atMs: Date.now(), rate: 1 });
    expect(status(r)).toEqual({ kind: 'tuning' });
    expect(r.loads).toHaveLength(2);
  });
});
