import { describe, expect, it } from 'vitest';
import {
  type AbrQualityRung,
  createAbrHysteresisController,
  DEFAULT_ABR_HYSTERESIS_CONFIG,
} from './index';

const RUNGS: readonly AbrQualityRung[] = [
  { id: '360p', bitrateBps: 500_000, label: '360p' },
  { id: '480p', bitrateBps: 1_500_000, label: '480p' },
  { id: '720p', bitrateBps: 3_000_000, label: '720p' },
  { id: '1080p', bitrateBps: 6_000_000, label: '1080p' },
];

function makeClock(initial = 0) {
  let t = initial;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
      return t;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

describe('createAbrHysteresisController (#176)', () => {
  it('validates rungs, orders them ascending by bitrate, clamps initialIndex, and handles single-rung ladders', () => {
    const clock = makeClock(1_000);
    expect(() => createAbrHysteresisController({ rungs: [], clock })).toThrow(RangeError);
    expect(() =>
      createAbrHysteresisController({ rungs: [{ id: 'bad', bitrateBps: 0 }], clock }),
    ).toThrow(RangeError);
    expect(() =>
      createAbrHysteresisController({ rungs: [{ id: 'bad', bitrateBps: Number.NaN }], clock }),
    ).toThrow(RangeError);

    // Unsorted rungs are normalized ascending.
    const unsorted = [RUNGS[3], RUNGS[1], RUNGS[0], RUNGS[2]].filter(
      (r): r is AbrQualityRung => r !== undefined,
    );
    const ctrl = createAbrHysteresisController({ rungs: unsorted, clock, initialIndex: 99 });
    expect(ctrl.getRungs().map((r) => r.id)).toEqual(['360p', '480p', '720p', '1080p']);
    expect(ctrl.getCurrentIndex()).toBe(3);
    expect(ctrl.getCurrentRung().id).toBe('1080p');

    // Negative initialIndex clamps to 0.
    const low = createAbrHysteresisController({ rungs: RUNGS, clock, initialIndex: -5 });
    expect(low.getCurrentIndex()).toBe(0);

    // Single-rung ladder always holds.
    const single = createAbrHysteresisController({ rungs: RUNGS.slice(0, 1), clock });
    expect(single.onThroughputSample(10_000_000)).toMatchObject({
      action: 'hold',
      reason: 'insufficient-rungs',
      toIndex: 0,
    });
    expect(single.onRebuffer({ severe: true })).toMatchObject({
      action: 'hold',
      reason: 'insufficient-rungs',
      toIndex: 0,
    });
  });

  it('rejects invalid samples and steps down to the highest supported rung only after stepDownCooldownMs', () => {
    const clock = makeClock(0);
    const ctrl = createAbrHysteresisController({ rungs: RUNGS, clock, initialIndex: 3 });

    expect(DEFAULT_ABR_HYSTERESIS_CONFIG).toEqual({
      downgradeSafetyFactor: 0.85,
      upgradeSafetyFactor: 1.35,
      stepDownCooldownMs: 5_000,
      stepUpCooldownMs: 20_000,
      sustainedRecoverySamples: 3,
      sustainedRecoveryWindowMs: 15_000,
    });

    // Invalid bandwidth samples (including 0 bps uninitialized telemetry) hold without altering rung or streak.
    expect(ctrl.onThroughputSample(-1)).toMatchObject({ action: 'hold', reason: 'invalid-sample' });
    expect(ctrl.onThroughputSample(0)).toMatchObject({ action: 'hold', reason: 'invalid-sample' });
    expect(ctrl.onThroughputSample(Number.NaN)).toMatchObject({
      action: 'hold',
      reason: 'invalid-sample',
    });
    clock.advance(5_000);
    expect(ctrl.onThroughputSample(0)).toMatchObject({
      action: 'hold',
      fromIndex: 3,
      toIndex: 3,
      reason: 'invalid-sample',
    });
    expect(ctrl.getCurrentIndex()).toBe(3);

    // Re-anchor so cooldown test starts fresh from t = 0 relative to lastSwitchAt.
    ctrl.reset(3);
    // At 1080p (6 Mbps), downgrade threshold is 6M * 0.85 = 5.1 Mbps.
    // Within 5s cooldown, even very low bandwidth holds.
    clock.advance(4_999);
    expect(ctrl.onThroughputSample(2_000_000)).toMatchObject({
      action: 'hold',
      fromIndex: 3,
      toIndex: 3,
      reason: 'cooldown',
    });

    // At 5,000 ms, 2.0 Mbps -> maxSupported = 2.0M / 0.85 = 2.35M -> drops directly to 480p (1.5 Mbps, index 1).
    clock.advance(1);
    const drop1 = ctrl.onThroughputSample(2_000_000);
    expect(drop1).toEqual({
      action: 'step-down',
      fromIndex: 3,
      toIndex: 1,
      rung: RUNGS[1],
      reason: 'low-bandwidth',
    });
    expect(ctrl.getCurrentIndex()).toBe(1);

    // At 480p (1.5 Mbps), 1.3 Mbps >= 1.275 Mbps stays stable.
    clock.advance(5_000);
    expect(ctrl.onThroughputSample(1_300_000)).toMatchObject({
      action: 'hold',
      toIndex: 1,
      reason: 'stable',
    });

    // Extremely low bandwidth drops to rung 0 (360p).
    expect(ctrl.onThroughputSample(100_000)).toEqual({
      action: 'step-down',
      fromIndex: 1,
      toIndex: 0,
      rung: RUNGS[0],
      reason: 'low-bandwidth',
    });
  });

  it('prevents oscillation on jittery bandwidth and upshifts by at most 1 rung only after sustained recovery + stepUpCooldownMs', () => {
    const clock = makeClock(0);
    const ctrl = createAbrHysteresisController({ rungs: RUNGS, clock, initialIndex: 1 }); // 480p (1.5 Mbps)
    // Next rung is 720p (3.0 Mbps) -> upgrade threshold = 3.0M * 1.35 = 4.05 Mbps.
    // Downgrade threshold for 480p = 1.5M * 0.85 = 1.275 Mbps.

    // Jittery bandwidth hovering in the deadband and dipping intermittently -> ZERO switches!
    const jitterSamples = [
      4_500_000, 3_200_000, 4_600_000, 4_700_000, 3_900_000, 4_800_000, 2_000_000, 5_000_000,
    ];
    for (const bw of jitterSamples) {
      clock.advance(8_000);
      const decision = ctrl.onThroughputSample(bw);
      expect(decision.action).toBe('hold');
      expect(ctrl.getCurrentIndex()).toBe(1);
    }

    // Reset clock anchor cleanly to test exact sustained recovery thresholds.
    ctrl.reset(1);
    // 3 high samples spanning 15s BEFORE 20s stepUpCooldownMs -> still held by cooldown!
    clock.advance(1_000);
    expect(ctrl.onThroughputSample(50_000_000)).toMatchObject({
      action: 'hold',
      reason: 'cooldown',
    });
    clock.advance(8_000); // t + 9s
    expect(ctrl.onThroughputSample(50_000_000)).toMatchObject({
      action: 'hold',
      reason: 'cooldown',
    });
    clock.advance(8_000); // t + 17s (3 samples over 16s, but cooldown 20s not met)
    expect(ctrl.onThroughputSample(50_000_000)).toMatchObject({
      action: 'hold',
      reason: 'cooldown',
    });

    // At t + 20s, cooldown met + >= 3 samples spanning >= 15s -> upshifts by ONLY 1 rung (480p -> 720p), NOT 1080p!
    clock.advance(3_000);
    const up1 = ctrl.onThroughputSample(50_000_000);
    expect(up1).toEqual({
      action: 'step-up',
      fromIndex: 1,
      toIndex: 2,
      rung: RUNGS[2],
      reason: 'sustained-recovery',
    });

    // Next rung (1080p) requires fresh 20s cooldown AND >= 3 samples spanning >= 15s.
    // Even after 25s cooldown, 2 samples or < 15s window must NOT upshift.
    clock.advance(25_000);
    expect(ctrl.onThroughputSample(50_000_000)).toMatchObject({
      action: 'hold',
      reason: 'insufficient-recovery',
    });
    clock.advance(5_000);
    expect(ctrl.onThroughputSample(50_000_000)).toMatchObject({
      action: 'hold',
      reason: 'insufficient-recovery',
    });
    clock.advance(5_000); // 3 samples, but span is only 10s (< 15s)
    expect(ctrl.onThroughputSample(50_000_000)).toMatchObject({
      action: 'hold',
      reason: 'insufficient-recovery',
    });
    clock.advance(5_000); // 4 samples spanning 15s -> step up to 1080p!
    expect(ctrl.onThroughputSample(50_000_000)).toEqual({
      action: 'step-up',
      fromIndex: 2,
      toIndex: 3,
      rung: RUNGS[3],
      reason: 'sustained-recovery',
    });

    // Already at top rung -> stays stable.
    clock.advance(30_000);
    expect(ctrl.onThroughputSample(100_000_000)).toMatchObject({
      action: 'hold',
      toIndex: 3,
      reason: 'stable',
    });
  });

  it('handles severe and normal rebuffers with time-bounded cooldown recovery without deadlocking upshifts', () => {
    const clock = makeClock(0);
    const ctrl = createAbrHysteresisController({ rungs: RUNGS, clock, initialIndex: 2 });

    // Severe rebuffer bypasses stepDownCooldownMs immediately!
    clock.advance(1_000); // t = 1_000
    expect(ctrl.onRebuffer({ severe: true })).toEqual({
      action: 'step-down',
      fromIndex: 2,
      toIndex: 1,
      rung: RUNGS[1],
      reason: 'severe-rebuffer',
    });

    // Non-severe rebuffer inside 5s stepDownCooldownMs holds, clears streak, and restarts 20s stepUpCooldownMs.
    clock.advance(2_000); // t = 3_000 (lastRebufferAt = 3_000)
    expect(ctrl.onRebuffer()).toMatchObject({
      action: 'hold',
      fromIndex: 1,
      toIndex: 1,
      reason: 'cooldown',
    });

    // At t = 22_000 (21s after switch, but only 19s after rebuffer at t=3_000), upshift is still rebuffer-blocked!
    clock.advance(4_000); // t = 7_000
    expect(ctrl.onThroughputSample(50_000_000)).toMatchObject({
      action: 'hold',
      toIndex: 1,
      reason: 'rebuffer-blocked',
    });
    // Zero-bps sample mid-streak returns invalid-sample and does NOT break the accumulated recovery streak.
    expect(ctrl.onThroughputSample(0)).toMatchObject({
      action: 'hold',
      toIndex: 1,
      reason: 'invalid-sample',
    });
    clock.advance(8_000); // t = 15_000
    expect(ctrl.onThroughputSample(50_000_000)).toMatchObject({
      action: 'hold',
      toIndex: 1,
      reason: 'rebuffer-blocked',
    });
    clock.advance(7_000); // t = 22_000 (19s since rebuffer < 20s)
    expect(ctrl.onThroughputSample(50_000_000)).toMatchObject({
      action: 'hold',
      toIndex: 1,
      reason: 'rebuffer-blocked',
    });

    // At t = 23_000 (20s after rebuffer, >= 3 clean samples spanning 16s >= 15s) -> upshifts cleanly to rung 2!
    clock.advance(1_000); // t = 23_000
    expect(ctrl.onThroughputSample(50_000_000)).toEqual({
      action: 'step-up',
      fromIndex: 1,
      toIndex: 2,
      rung: RUNGS[2],
      reason: 'sustained-recovery',
    });

    // Normal rebuffer outside stepDownCooldownMs steps down 1 rung (2 -> 1 -> 0).
    clock.advance(5_000);
    expect(ctrl.onRebuffer()).toEqual({
      action: 'step-down',
      fromIndex: 2,
      toIndex: 1,
      rung: RUNGS[1],
      reason: 'rebuffer',
    });
    clock.advance(5_000);
    expect(ctrl.onRebuffer()).toEqual({
      action: 'step-down',
      fromIndex: 1,
      toIndex: 0,
      rung: RUNGS[0],
      reason: 'rebuffer',
    });

    // Rebuffer at rung 0 cannot step down further, restarts 20s stepUpCooldownMs, and later recovers to rung 1!
    clock.advance(10_000); // t = 43_000
    expect(ctrl.onRebuffer({ severe: true })).toMatchObject({
      action: 'hold',
      toIndex: 0,
      reason: 'severe-rebuffer',
    });
    clock.advance(5_000); // t = 48_000 (5s since rebuffer)
    expect(ctrl.onThroughputSample(50_000_000)).toMatchObject({
      action: 'hold',
      toIndex: 0,
      reason: 'rebuffer-blocked',
    });
    clock.advance(8_000); // t = 56_000 (13s since rebuffer)
    expect(ctrl.onThroughputSample(50_000_000)).toMatchObject({
      action: 'hold',
      toIndex: 0,
      reason: 'rebuffer-blocked',
    });
    clock.advance(7_000); // t = 63_000 (20s since rebuffer, 3 clean samples over 15s) -> recovers to rung 1!
    expect(ctrl.onThroughputSample(50_000_000)).toEqual({
      action: 'step-up',
      fromIndex: 0,
      toIndex: 1,
      rung: RUNGS[1],
      reason: 'sustained-recovery',
    });
  });

  it('clears sample windows and re-anchors cooldowns on onPause, onBackground, onTune, and reset', () => {
    const clock = makeClock(0);
    const ctrl = createAbrHysteresisController({ rungs: RUNGS, clock, initialIndex: 1 });

    // Accumulate a ready-to-upgrade streak before pause.
    clock.advance(20_000);
    ctrl.onThroughputSample(50_000_000);
    clock.advance(10_000);
    ctrl.onThroughputSample(50_000_000);

    // Pause clears the recovery streak and re-anchors cooldowns while keeping rung 1.
    clock.advance(10_000);
    ctrl.onPause();
    expect(ctrl.getCurrentIndex()).toBe(1);

    // Immediate post-resume samples MUST NOT upshift OR downshift spuriously.
    clock.advance(1_000);
    expect(ctrl.onThroughputSample(50_000_000)).toMatchObject({
      action: 'hold',
      reason: 'cooldown',
    });
    expect(ctrl.onThroughputSample(100_000)).toMatchObject({ action: 'hold', reason: 'cooldown' });

    // Background similarly clears rebuffer-blocked & re-anchors cooldowns while keeping current rung.
    ctrl.onRebuffer(); // inside cooldown -> sets rebuffer-blocked
    clock.advance(10_000);
    ctrl.onBackground();
    expect(ctrl.getCurrentIndex()).toBe(1);
    clock.advance(20_000);
    ctrl.onThroughputSample(50_000_000);
    clock.advance(8_000);
    ctrl.onThroughputSample(50_000_000);
    clock.advance(8_000);
    expect(ctrl.onThroughputSample(50_000_000)).toMatchObject({
      action: 'step-up',
      fromIndex: 1,
      toIndex: 2,
    });

    // onTune resets to specified rung (or initialIndex when omitted) and re-anchors cooldowns.
    ctrl.onTune(3);
    expect(ctrl.getCurrentIndex()).toBe(3);
    clock.advance(1_000);
    expect(ctrl.onThroughputSample(100_000)).toMatchObject({ action: 'hold', reason: 'cooldown' });

    ctrl.onTune();
    expect(ctrl.getCurrentIndex()).toBe(1);

    // Custom config thresholds are respected.
    const fast = createAbrHysteresisController({
      rungs: RUNGS,
      clock,
      initialIndex: 0,
      config: {
        upgradeSafetyFactor: 1.2,
        stepUpCooldownMs: 1_000,
        sustainedRecoverySamples: 2,
        sustainedRecoveryWindowMs: 500,
      },
    });
    clock.advance(1_000);
    expect(fast.onThroughputSample(1_800_000)).toMatchObject({
      action: 'hold',
      reason: 'insufficient-recovery',
    });
    clock.advance(500);
    expect(fast.onThroughputSample(1_800_000)).toMatchObject({
      action: 'step-up',
      fromIndex: 0,
      toIndex: 1,
    });
  });
});
