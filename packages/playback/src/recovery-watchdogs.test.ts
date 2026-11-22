import { elvError, err } from '@elv/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAYBACK_CONFIG } from './config';
import type { ClockAnchor } from './engine';
import {
  error,
  failed,
  last,
  live,
  play,
  playing,
  type Rig,
  recovering,
  resolved,
  rig,
  stall,
  state,
  status,
  tick,
  vod,
} from './recovery-test-helpers';

const emitClock = (r: Rig, anchor: ClockAnchor): void => {
  r.engine.emit({ attempt: r.service.getState().attempt, type: 'clock', anchor });
};

const emitVideoClock = (
  r: Rig,
  positionMs: number,
  decodedVideoFrames: number | undefined,
  hasVideoTrack = true,
  atMs = Date.now(),
): void =>
  emitClock(r, {
    positionMs,
    atMs,
    rate: 1,
    hasVideoTrack,
    ...(decodedVideoFrames === undefined ? {} : { decodedVideoFrames }),
  });

const emitProgress = (r: Rig, bytesReceived?: number, atMs = Date.now()): void => {
  r.engine.emit({
    attempt: r.service.getState().attempt,
    type: 'progress',
    ...(bytesReceived === undefined ? {} : { bytesReceived }),
    atMs,
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
});
afterEach(() => vi.useRealTimers());

describe('#433: live recovery flag reset after stableRestoreMs & Rung-4 alternate loop', () => {
  it('resets liveCleanEndRetried after 30 s of healthy playing so a later clean-end reloads again', async () => {
    const r = rig({ chan: [] });
    await playing(r, live('chan'));

    // First unexpected clean-end triggers a live-edge reload (budget.rung stays 0).
    state(r, 'ended');
    expect(status(r)).toEqual({ kind: 'tuning' });
    expect(r.loads).toHaveLength(2);

    // Recovers and plays for 29,999 ms -> still within window, so another clean-end ends playback.
    play(r);
    await tick(29_999);
    state(r, 'ended');
    expect(status(r)).toEqual({ kind: 'ended' });
    expect(r.loads).toHaveLength(2);

    // Fresh tune -> first clean-end reloads -> plays full 30,000 ms -> second clean-end reloads again!
    await playing(r, live('chan'));
    const before = r.loads.length;
    state(r, 'ended');
    expect(status(r)).toEqual({ kind: 'tuning' });
    expect(r.loads).toHaveLength(before + 1);

    play(r);
    await tick(DEFAULT_PLAYBACK_CONFIG.stableRestoreMs);
    state(r, 'ended');
    expect(status(r)).toEqual({ kind: 'tuning' });
    expect(r.loads).toHaveLength(before + 2);
  });

  it('resets liveFrozenResetTried after 30 s of healthy playing so a later frozen clock reloads again', async () => {
    const r = rig({ chan: [] });
    await playing(r, live('chan'));

    // First frozen clock triggers live-edge reload (budget.rung stays 0).
    emitClock(r, { positionMs: 10_000, atMs: Date.now(), rate: 1 });
    await tick(4_000);
    emitClock(r, { positionMs: 10_000, atMs: Date.now(), rate: 1 });
    expect(status(r)).toEqual({ kind: 'tuning' });
    expect(r.loads).toHaveLength(2);

    // Resumes playing for full 30,000 ms -> liveFrozenResetTried resets!
    play(r);
    await tick(DEFAULT_PLAYBACK_CONFIG.stableRestoreMs);

    // Second frozen clock hours later reloads cleanly instead of immediately escalating to ladder.
    emitClock(r, { positionMs: 50_000, atMs: Date.now(), rate: 1 });
    await tick(4_000);
    emitClock(r, { positionMs: 50_000, atMs: Date.now(), rate: 1 });
    expect(status(r)).toEqual({ kind: 'tuning' });
    expect(r.loads).toHaveLength(3);
  });

  it('advances past throwing/failing/rejected Rung-4 alternate resolvers to next alternate, then container fallback, then fail', async () => {
    const r = rig({
      'http://edge.example/live/1.ts': [],
      'http://backup.example/live/1.ts': [],
      'http://backup.example/live/1.m3u8': [],
    });
    // No firstFrame yet -> container fallback is eligible after alternates exhaust.
    r.service.tune(
      live('http://edge.example/live/1.ts', {
        alternates: [
          () => {
            throw new Error('sync-boom');
          },
          () => Promise.resolve(err(elvError('network', 'resolve-failed'))),
          () => Promise.reject(new Error('async-boom')),
          resolved('http://backup.example/live/1.ts'),
        ],
      }),
    );
    await tick(0);
    for (const gap of [0, 1000, 2000, 4000]) {
      error(r, 'network');
      await tick(gap);
    }
    expect(r.loads.at(-1)?.url).toBe('http://backup.example/live/1.ts');

    // Backup fails -> falls through to container fallback (.m3u8), then gives up.
    error(r, 'network');
    await tick(4000);
    expect(r.loads.at(-1)?.url).toBe('http://backup.example/live/1.m3u8');

    error(r, 'network');
    expect(status(r)).toEqual(failed('network'));
  });
});

describe('#314: byte-progress-aware VOD start timeout', () => {
  it('keeps strict 8,000 ms VOD start timeout when no progress or flat/zero bytes arrive', async () => {
    const r = rig({ movie: [] });
    r.service.tune(vod('movie'));
    await tick(0);
    emitProgress(r, 0);
    emitProgress(r, Number.NaN);
    await tick(4_000);
    emitProgress(r, 0);
    await tick(3_999);
    expect(status(r)).toEqual({ kind: 'tuning' });
    await tick(1);
    expect(status(r)).toEqual(recovering(1, 0));

    // Non-advancing bytes after one initial positive progress stop extending after 8,000 ms.
    const r2 = rig({ movie2: [] });
    r2.service.tune(vod('movie2'));
    await tick(0);
    await tick(3_000);
    emitProgress(r2, 65_536);
    await tick(5_000);
    emitProgress(r2, 65_536);
    await tick(2_999);
    expect(status(r2)).toEqual({ kind: 'tuning' });
    await tick(1);
    expect(status(r2)).toEqual(recovering(1, 0));
  });

  it('extends VOD start timeout while bytesReceived advances and succeeds when playing arrives before 30 s', async () => {
    const r = rig({ movie: [] });
    r.service.tune(vod('movie'));
    await tick(0);

    for (let i = 1; i <= 3; i += 1) {
      await tick(5_000);
      emitProgress(r, i * 100_000);
      expect(status(r)).toEqual({ kind: 'tuning' });
    }
    // 15,000 ms elapsed (> 8,000 ms default), still tuning cleanly -> playing succeeds!
    await tick(3_000);
    expect(status(r)).toEqual({ kind: 'tuning' });
    play(r);
    expect(status(r)).toEqual({ kind: 'playing' });
    await tick(30_000);
    expect(status(r)).toEqual({ kind: 'playing' });
  });

  it('enforces the hard vodStartMaxTimeoutMs (30,000 ms) ceiling even with continuous byte progress', async () => {
    const r = rig({ movie: [] });
    r.service.tune(vod('movie'));
    await tick(0);

    // Emit advancing progress every 5 s up to 25 s, plus again at 29 s -> must still fire at 30,000 ms.
    for (let i = 1; i <= 5; i += 1) {
      await tick(5_000);
      emitProgress(r, i * 65_536);
      expect(status(r)).toEqual({ kind: 'tuning' });
    }
    await tick(4_000);
    emitProgress(r, 6 * 65_536);
    await tick(999);
    expect(status(r)).toEqual({ kind: 'tuning' });
    await tick(1);
    expect(status(r)).toEqual(recovering(1, 0));
  });

  it('extends VOD tuning on byte-less progress signals up to ceiling and never extends live start timeout', async () => {
    const r = rig({ movie: [], chan: [] });
    r.service.tune(vod('movie'));
    await tick(0);
    await tick(6_000);
    emitProgress(r);
    await tick(6_000);
    expect(status(r)).toEqual({ kind: 'tuning' });
    play(r);
    expect(status(r)).toEqual({ kind: 'playing' });

    // Live keeps strict 5,000 ms liveStartTimeoutMs even when progress events arrive.
    r.service.tune(live('chan'));
    await tick(0);
    await tick(2_500);
    emitProgress(r, 65_536);
    await tick(2_499);
    expect(status(r)).toEqual({ kind: 'tuning' });
    await tick(1);
    expect(status(r)).toEqual(recovering(2, 0));
  });
});

describe('#321: zero-decoded-frame black-screen watchdog & bounded network-aware stall deferral', () => {
  it('escalates with decoder fault when hasVideoTrack is true, decodedVideoFrames stays 0, and positionMs advances across 4 s', async () => {
    const r = rig({ movie: [] }, { softwareAudioFallback: true, recreate: false });
    r.service.tune(vod('movie'));
    await tick(0);
    // Audio playing, NO firstFrame emitted (black screen!)
    state(r, 'playing');

    emitVideoClock(r, 1_000, 0);
    await tick(3_999);
    emitVideoClock(r, 4_999, 0);
    expect(status(r)).toEqual({ kind: 'playing' });

    await tick(1);
    emitVideoClock(r, 5_000, 0);
    expect(status(r)).toEqual(recovering(1, 0));

    // Climbing decoder faults reaches Rung 4 with softwareAudio + preferHevcOverDolbyVision (#189).
    error(r, 'decoder');
    await tick(1_000);
    error(r, 'decoder');
    await tick(2_000);
    error(r, 'decoder');
    await tick(4_000);
    expect(r.loads.at(-1)).toMatchObject({
      url: 'movie',
      options: { softwareAudio: true, preferHevcOverDolbyVision: true },
    });
  });

  it('produces zero false positives for radio/audio-only, missing frame telemetry, non-advancing pos, decoded frames > 0, or paused', async () => {
    const r = rig({ chan: [] });
    await playing(r, live('chan'));

    // 1) Audio-only / radio (hasVideoTrack: false)
    emitVideoClock(r, 1_000, 0, false);
    await tick(5_000);
    emitVideoClock(r, 6_000, 0, false);
    expect(status(r)).toEqual({ kind: 'playing' });

    // 2) decodedVideoFrames omitted (undefined)
    emitVideoClock(r, 7_000, undefined);
    await tick(5_000);
    emitVideoClock(r, 12_000, undefined);
    expect(status(r)).toEqual({ kind: 'playing' });

    // 3) Frame counter rises above 0 mid-window -> resets cleanly
    emitVideoClock(r, 13_000, 0);
    await tick(3_000);
    emitVideoClock(r, 16_000, 1);
    await tick(2_000);
    emitVideoClock(r, 18_000, 60);
    expect(status(r)).toEqual({ kind: 'playing' });

    // 4) Non-advancing positionMs on VOD with decodedVideoFrames: 0 does not trigger decoder stall
    await playing(r, vod('movie'));
    emitVideoClock(r, 1_000, 0);
    await tick(5_000);
    emitVideoClock(r, 1_000, 0);
    expect(status(r)).toEqual({ kind: 'playing' });

    // 5) Paused resets zero-frame tracker; backwards wall-clock jump resets zeroFrameSinceMs cleanly.
    const tBase = Date.now();
    emitVideoClock(r, 2_000, 0, true, tBase);
    emitVideoClock(r, 3_000, 0, true, tBase - 1_000);
    emitVideoClock(r, 4_000, 0, true, tBase + 2_000);
    expect(status(r)).toEqual({ kind: 'playing' });

    await tick(3_000);
    r.service.pause();
    await tick(2_000);
    emitVideoClock(r, 7_000, 0);
    expect(r.loads).toHaveLength(2);
  });

  it('defers stall escalation up to maxStallDeferrals (3) while progress arrives, then escalates strictly bounded', async () => {
    const r = rig({ chan: [] });
    const t = await playing(r, live('chan'));

    stall(r, 'start');
    // 3 deferrals across 12,000 ms while network bytes keep arriving
    for (let i = 1; i <= 3; i += 1) {
      await tick(2_000);
      emitProgress(r, i * 16_384);
      await tick(2_000);
      expect(status(r)).toEqual({ kind: 'playing' });
    }
    // 4th window hits maxStallDeferrals (3) -> escalates even if progress keeps arriving!
    await tick(2_000);
    emitProgress(r, 4 * 16_384);
    await tick(1_999);
    expect(status(r)).toEqual({ kind: 'playing' });
    await tick(1);
    expect(status(r)).toEqual(recovering(1, 0));
    expect(last(r)).toEqual({ name: 'retry', attempt: t + 1 });
  });

  it('escalates on next stall window when progress stops, and resets deferral budget on stall end', async () => {
    const r = rig({ chan: [] });
    await playing(r, live('chan'));

    // Progress arrives once -> 1 deferral -> then stall('end') recovers and resets deferrals.
    stall(r, 'start');
    await tick(3_000);
    emitProgress(r, 1024);
    await tick(1_000);
    expect(status(r)).toEqual({ kind: 'playing' });
    stall(r, 'end');

    // New stall: progress arrives once (1 deferral), then network goes silent -> escalates at 8,000 ms.
    stall(r, 'start');
    await tick(3_000);
    emitProgress(r, 2048);
    await tick(1_000);
    expect(status(r)).toEqual({ kind: 'playing' });
    // Zero bytes or non-finite atMs do not count as network activity
    await tick(2_000);
    emitProgress(r, 0);
    emitProgress(r, 4096, Number.NaN);
    await tick(1_999);
    expect(status(r)).toEqual({ kind: 'playing' });
    await tick(1);
    expect(status(r)).toEqual(recovering(1, 0));
  });

  it('ignores flat/non-advancing bytesReceived during a stall while deferring on strictly advancing bytes', async () => {
    const r = rig({ chan: [] });
    await playing(r, live('chan'));

    // Pre-stall baseline byte count -> identical bytes during stall never defer escalation.
    emitProgress(r, 8_192);
    stall(r, 'start');
    await tick(2_000);
    emitProgress(r, 8_192);
    await tick(1_999);
    expect(status(r)).toEqual({ kind: 'playing' });
    await tick(1);
    expect(status(r)).toEqual(recovering(1, 0));

    // Recover, then during a new stall: first positive byte count defers once, repeated identical value does not.
    play(r);
    stall(r, 'start');
    await tick(2_000);
    emitProgress(r, 4_096);
    await tick(2_000);
    expect(status(r)).toEqual({ kind: 'playing' });
    await tick(2_000);
    emitProgress(r, 4_096);
    await tick(1_999);
    expect(status(r)).toEqual({ kind: 'playing' });
    await tick(1);
    expect(status(r)).toEqual(recovering(2, 0));
  });
});

describe('#144, #147, #150, #222: surfaceRecreationToken, bufferPreset, rolling rebuffer, scrubbing', () => {
  it('forwards TuneRequest.bufferPreset to initial load and recovery reloads (#147)', async () => {
    const r = rig({ chan: [] });
    r.service.tune(live('chan', { bufferPreset: 'large' }));
    await tick(0);
    expect(r.loads[0]).toMatchObject({
      url: 'chan',
      options: { bufferPreset: 'large' },
    });

    // Rung 2 reload preserves bufferPreset
    error(r, 'network');
    await tick(0);
    error(r, 'network');
    await tick(1_000);
    expect(r.loads[1]).toMatchObject({
      url: 'chan',
      options: { bufferPreset: 'large' },
    });
  });

  it('increments surfaceRecreationToken only on Rung 3 recreate for decoder errors, never on normal zaps or network retries (#144)', async () => {
    const r = rig({ a: [], b: [] });
    const seenTokens: number[] = [];
    r.service.subscribe((s) => seenTokens.push(s.surfaceRecreationToken));
    expect(r.service.getState().surfaceRecreationToken).toBe(0);

    // Normal zaps never increment surfaceRecreationToken
    await playing(r, live('a'));
    await playing(r, live('b'));
    expect(r.service.getState().surfaceRecreationToken).toBe(0);

    // Rung 3 recreate after network errors does NOT increment surfaceRecreationToken
    error(r, 'network');
    await tick(0);
    error(r, 'network');
    await tick(1_000);
    error(r, 'network');
    await tick(2_000);
    expect(r.engine.commands.some((c) => c.name === 'recreate')).toBe(true);
    expect(r.service.getState().surfaceRecreationToken).toBe(0);

    // Fresh tune + Rung 3 recreate after decoder errors DOES increment surfaceRecreationToken
    await playing(r, live('a'));
    error(r, 'decoder');
    await tick(0);
    expect(r.service.getState().surfaceRecreationToken).toBe(0);
    error(r, 'decoder');
    await tick(1_000);
    expect(r.service.getState().surfaceRecreationToken).toBe(0);
    error(r, 'decoder');
    await tick(2_000);
    expect(r.service.getState().surfaceRecreationToken).toBe(1);
    expect(seenTokens).toContain(1);

    // Subsequent normal zap preserves token without incrementing or resetting
    await playing(r, live('b'));
    expect(r.service.getState().surfaceRecreationToken).toBe(1);
  });

  it('escalates cleanly to next alternate on 3 non-seek rebuffer stalls within 120 s and resets transient retries (#150)', async () => {
    expect(DEFAULT_PLAYBACK_CONFIG.rollingRebufferThreshold).toBe(3);
    expect(DEFAULT_PLAYBACK_CONFIG.rollingRebufferWindowMs).toBe(120_000);

    const r = rig({
      'http://primary.example/live/1.ts': [],
      'http://alt1.example/live/1.ts': [],
    });
    await playing(
      r,
      live('http://primary.example/live/1.ts', {
        alternates: [resolved('http://alt1.example/live/1.ts')],
      }),
    );

    // Stall 1 & recover
    stall(r, 'start');
    await tick(1_000);
    stall(r, 'end');
    await tick(20_000);

    // Stall 2 & recover
    stall(r, 'start');
    await tick(1_000);
    stall(r, 'end');
    await tick(20_000);

    expect(r.loads).toHaveLength(1);

    // Stall 3 within 120 s -> escalates immediately to alternate!
    stall(r, 'start');
    await tick(0);
    expect(r.loads.at(-1)?.url).toBe('http://alt1.example/live/1.ts');

    // New alternate gets a fresh transient retry budget (Rung 1 on network error)
    play(r);
    error(r, 'network');
    expect(status(r)).toEqual(recovering(1, 0));

    // Inline stream alternates also escalate on 3 rolling stalls within 120 s
    const rInline = rig({
      'http://p.example/live/1.ts': [],
      'http://inline-alt.example/live/1.ts': [],
    });
    await playing(
      rInline,
      live('http://p.example/live/1.ts', {
        resolve: () =>
          Promise.resolve({
            ok: true,
            value: {
              url: 'http://p.example/live/1.ts',
              headers: {},
              alternates: [{ url: 'http://inline-alt.example/live/1.ts', headers: {} }],
            },
          }),
      }),
    );
    for (let i = 0; i < 2; i += 1) {
      stall(rInline, 'start');
      await tick(1_000);
      stall(rInline, 'end');
      await tick(5_000);
    }
    stall(rInline, 'start');
    await tick(0);
    expect(rInline.loads.at(-1)?.url).toBe('http://inline-alt.example/live/1.ts');
  });

  it('prunes stalls outside 120 s window, clears rolling count on seek/tune, and ignores gracefully when no alternates remain (#150)', async () => {
    const r = rig({
      'http://primary.example/vod/1.mp4': [],
      'http://alt.example/vod/1.mp4': [],
    });
    await playing(
      r,
      vod('http://primary.example/vod/1.mp4', {
        alternates: [resolved('http://alt.example/vod/1.mp4')],
      }),
    );
    emitClock(r, { positionMs: 10_000, atMs: Date.now(), rate: 1, durationMs: 300_000 });

    // Stall 1 at t=0, Stall 2 at t=50s, then advance past 120s so Stall 1 expires
    stall(r, 'start');
    await tick(500);
    stall(r, 'end');
    await tick(50_000);

    stall(r, 'start');
    await tick(500);
    stall(r, 'end');
    await tick(80_000); // t=131s: Stall 1 (t=0) is > 120s old -> pruned!

    stall(r, 'start');
    await tick(500);
    stall(r, 'end');
    // Only 2 stalls in window -> still on primary!
    expect(r.loads).toHaveLength(1);

    // User seek clears rolling timestamps AND seek-settling stalls do not count
    r.service.seek(60_000);
    stall(r, 'start');
    await tick(500);
    stall(r, 'end');
    await tick(1_000);
    stall(r, 'start');
    await tick(500);
    stall(r, 'end');
    await tick(1_000);
    stall(r, 'start');
    await tick(500);
    stall(r, 'end');
    // Only 2 post-seek stalls -> still on primary!
    expect(r.loads).toHaveLength(1);

    // No alternates stream: 3 stalls within 120s must NOT cause an infinite restart loop
    const rNoAlt = rig({ 'http://only.example/live/1.ts': [] });
    await playing(rNoAlt, live('http://only.example/live/1.ts'));
    for (let i = 0; i < 4; i += 1) {
      stall(rNoAlt, 'start');
      await tick(1_000);
      stall(rNoAlt, 'end');
      await tick(5_000);
    }
    expect(rNoAlt.loads).toHaveLength(1);
    expect(status(rNoAlt)).toEqual({ kind: 'playing' });
  });

  it('forwards setScrubbing only for VOD and resets it to false on stop, tune, and dispose (#222)', async () => {
    const r = rig({ chan: [], movie: [], movie2: [] });

    // Live: setScrubbing is ignored
    await playing(r, live('chan'));
    r.service.setScrubbing?.(true);
    expect(r.engine.commands.filter((c) => c.name === 'setScrubbing')).toEqual([]);

    // VOD: setScrubbing toggles cleanly and is idempotent
    const vodAttempt = await playing(r, vod('movie'));
    r.service.setScrubbing?.(true);
    r.service.setScrubbing?.(true);
    r.service.setScrubbing?.(false);
    r.service.setScrubbing?.(false);
    expect(r.engine.commands.filter((c) => c.name === 'setScrubbing')).toEqual([
      { name: 'setScrubbing', attempt: vodAttempt, scrubbing: true },
      { name: 'setScrubbing', attempt: vodAttempt, scrubbing: false },
    ]);

    // stop() resets active scrubbing to false
    r.service.setScrubbing?.(true);
    r.service.stop();
    expect(r.engine.commands.filter((c) => c.name === 'setScrubbing').slice(-2)).toEqual([
      { name: 'setScrubbing', attempt: vodAttempt, scrubbing: true },
      { name: 'setScrubbing', attempt: vodAttempt, scrubbing: false },
    ]);

    // tune() resets active scrubbing to false
    const vod2Attempt = await playing(r, vod('movie'));
    r.service.setScrubbing?.(true);
    r.service.tune(vod('movie2'));
    await tick(0);
    expect(r.engine.commands.filter((c) => c.name === 'setScrubbing').slice(-2)).toEqual([
      { name: 'setScrubbing', attempt: vod2Attempt, scrubbing: true },
      { name: 'setScrubbing', attempt: vod2Attempt, scrubbing: false },
    ]);

    // retry() clears JS scrubbingActive so subsequent setScrubbing(true) is not stuck (#222)
    play(r);
    r.service.setScrubbing?.(true);
    r.service.retry();
    const afterRetryAttempt = r.service.getState().attempt;
    play(r);
    r.service.setScrubbing?.(true);
    expect(r.engine.commands.filter((c) => c.name === 'setScrubbing').at(-1)).toEqual({
      name: 'setScrubbing',
      attempt: afterRetryAttempt,
      scrubbing: true,
    });

    // Entering recovering (Rung 1/3) clears JS scrubbingActive so setScrubbing(true) works after recovery
    error(r, 'decoder');
    await tick(0);
    const rung1Attempt = r.service.getState().attempt;
    play(r);
    r.service.setScrubbing?.(true);
    expect(r.engine.commands.filter((c) => c.name === 'setScrubbing').at(-1)).toEqual({
      name: 'setScrubbing',
      attempt: rung1Attempt,
      scrubbing: true,
    });

    // VOD ended clears scrubbing and notifies engine(false)
    state(r, 'ended');
    expect(r.engine.commands.filter((c) => c.name === 'setScrubbing').at(-1)).toEqual({
      name: 'setScrubbing',
      attempt: rung1Attempt,
      scrubbing: false,
    });
  });
});
