import type { PlaybackClock } from './types';

/** One quality level on the adaptive bitrate ladder (`#176`). */
export interface AbrQualityRung {
  readonly id: string;
  readonly bitrateBps: number;
  readonly label?: string;
}

/** Tunable hysteresis thresholds and cooldown timings for {@link createAbrHysteresisController}. */
export interface AbrHysteresisConfig {
  readonly downgradeSafetyFactor?: number;
  readonly upgradeSafetyFactor?: number;
  readonly stepDownCooldownMs?: number;
  readonly stepUpCooldownMs?: number;
  readonly sustainedRecoverySamples?: number;
  readonly sustainedRecoveryWindowMs?: number;
}

/** Inputs for {@link createAbrHysteresisController}. */
export interface AbrHysteresisDeps {
  readonly rungs: readonly AbrQualityRung[];
  readonly clock: PlaybackClock;
  readonly initialIndex?: number;
  readonly config?: AbrHysteresisConfig;
}

/** Reason tag explaining why an ABR decision held, stepped down, or stepped up. */
export type AbrDecisionReason =
  | 'stable'
  | 'insufficient-rungs'
  | 'invalid-sample'
  | 'cooldown'
  | 'insufficient-recovery'
  | 'rebuffer-blocked'
  | 'low-bandwidth'
  | 'rebuffer'
  | 'severe-rebuffer'
  | 'sustained-recovery';

/** Result of evaluating a throughput sample or rebuffer event. */
export interface AbrDecision {
  readonly action: 'hold' | 'step-down' | 'step-up';
  readonly fromIndex: number;
  readonly toIndex: number;
  readonly rung: AbrQualityRung;
  readonly reason: AbrDecisionReason;
}

/** Anti-oscillation ABR rung selector with asymmetric hysteresis, cooldowns, and lifecycle resets (`#176`). */
export interface AbrHysteresisController {
  getCurrentIndex(): number;
  getCurrentRung(): AbrQualityRung;
  getRungs(): readonly AbrQualityRung[];
  onThroughputSample(bandwidthBps: number): AbrDecision;
  onRebuffer(opts?: { readonly severe?: boolean }): AbrDecision;
  onPause(): void;
  onBackground(): void;
  onTune(initialIndex?: number): void;
  reset(initialIndex?: number): void;
}

/** Default hysteresis timings and safety factors for {@link createAbrHysteresisController}. */
export const DEFAULT_ABR_HYSTERESIS_CONFIG: Required<AbrHysteresisConfig> = {
  downgradeSafetyFactor: 0.85,
  upgradeSafetyFactor: 1.35,
  stepDownCooldownMs: 5_000,
  stepUpCooldownMs: 20_000,
  sustainedRecoverySamples: 3,
  sustainedRecoveryWindowMs: 15_000,
};

function positiveNumber(value: number | undefined, fallback: number, min: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, value);
}

function resolveConfig(config?: AbrHysteresisConfig): Required<AbrHysteresisConfig> {
  return {
    downgradeSafetyFactor: positiveNumber(
      config?.downgradeSafetyFactor,
      DEFAULT_ABR_HYSTERESIS_CONFIG.downgradeSafetyFactor,
      0.01,
    ),
    upgradeSafetyFactor: positiveNumber(
      config?.upgradeSafetyFactor,
      DEFAULT_ABR_HYSTERESIS_CONFIG.upgradeSafetyFactor,
      1,
    ),
    stepDownCooldownMs: positiveNumber(
      config?.stepDownCooldownMs,
      DEFAULT_ABR_HYSTERESIS_CONFIG.stepDownCooldownMs,
      0,
    ),
    stepUpCooldownMs: positiveNumber(
      config?.stepUpCooldownMs,
      DEFAULT_ABR_HYSTERESIS_CONFIG.stepUpCooldownMs,
      0,
    ),
    sustainedRecoverySamples: Math.max(
      1,
      Math.floor(
        positiveNumber(
          config?.sustainedRecoverySamples,
          DEFAULT_ABR_HYSTERESIS_CONFIG.sustainedRecoverySamples,
          1,
        ),
      ),
    ),
    sustainedRecoveryWindowMs: positiveNumber(
      config?.sustainedRecoveryWindowMs,
      DEFAULT_ABR_HYSTERESIS_CONFIG.sustainedRecoveryWindowMs,
      0,
    ),
  };
}

function normalizeRungs(rungs: readonly AbrQualityRung[]): readonly AbrQualityRung[] {
  if (rungs.length === 0) {
    throw new RangeError('ABR hysteresis controller requires at least one quality rung.');
  }
  for (const rung of rungs) {
    if (!Number.isFinite(rung.bitrateBps) || rung.bitrateBps <= 0) {
      throw new RangeError(`ABR rung "${rung.id}" must have a finite positive bitrateBps.`);
    }
  }
  return [...rungs].sort((a, b) => a.bitrateBps - b.bitrateBps);
}

/**
 * Creates a pure, clock-injected anti-oscillation ABR hysteresis controller (`#176`):
 * - Steps down conservatively when bandwidth falls below `current.bitrateBps * downgradeSafetyFactor`
 *   and `stepDownCooldownMs` has elapsed (or immediately on a severe rebuffer).
 * - Steps up by at most one rung only after `stepUpCooldownMs`, zero rebuffers since the last
 *   switch/reset, and `sustainedRecoverySamples` consecutive samples above
 *   `next.bitrateBps * upgradeSafetyFactor` spanning at least `sustainedRecoveryWindowMs`.
 * - Clears sample windows and re-anchors cooldowns on `onPause()`, `onBackground()`, `onTune()`, and `reset()`.
 */
export function createAbrHysteresisController(deps: AbrHysteresisDeps): AbrHysteresisController {
  const ordered = normalizeRungs(deps.rungs);
  const cfg = resolveConfig(deps.config);
  const clampIndex = (idx: number): number => {
    const whole = Number.isFinite(idx) ? Math.floor(idx) : 0;
    return Math.max(0, Math.min(ordered.length - 1, whole));
  };
  const rungAt = (idx: number): AbrQualityRung => ordered[idx] as AbrQualityRung;

  const defaultInitialIndex = clampIndex(deps.initialIndex ?? 0);
  let currentIndex = defaultInitialIndex;
  let lastSwitchAt = deps.clock.now();
  let lastRebufferAt: number | null = null;
  let streakCount = 0;
  let streakStartAt: number | null = null;

  const clearStreak = () => {
    streakCount = 0;
    streakStartAt = null;
  };

  const reanchor = () => {
    clearStreak();
    lastRebufferAt = null;
    lastSwitchAt = deps.clock.now();
  };

  const hold = (reason: AbrDecisionReason): AbrDecision => ({
    action: 'hold',
    fromIndex: currentIndex,
    toIndex: currentIndex,
    rung: rungAt(currentIndex),
    reason,
  });

  const commitSwitch = (
    action: 'step-down' | 'step-up',
    toIndex: number,
    reason: AbrDecisionReason,
    now: number,
  ): AbrDecision => {
    const fromIndex = currentIndex;
    currentIndex = toIndex;
    lastSwitchAt = now;
    lastRebufferAt = null;
    clearStreak();
    return { action, fromIndex, toIndex, rung: rungAt(toIndex), reason };
  };

  return {
    getCurrentIndex: () => currentIndex,
    getCurrentRung: () => rungAt(currentIndex),
    getRungs: () => ordered,

    onThroughputSample(bandwidthBps: number): AbrDecision {
      if (ordered.length <= 1) return hold('insufficient-rungs');
      if (!Number.isFinite(bandwidthBps) || bandwidthBps <= 0) return hold('invalid-sample');

      const now = deps.clock.now();
      const current = rungAt(currentIndex);

      if (currentIndex > 0 && bandwidthBps < current.bitrateBps * cfg.downgradeSafetyFactor) {
        clearStreak();
        if (now - lastSwitchAt < cfg.stepDownCooldownMs) return hold('cooldown');
        const maxSupportedBitrate = bandwidthBps / cfg.downgradeSafetyFactor;
        let targetIndex = 0;
        for (let i = currentIndex - 1; i >= 0; i -= 1) {
          if (rungAt(i).bitrateBps <= maxSupportedBitrate) {
            targetIndex = i;
            break;
          }
        }
        return commitSwitch('step-down', targetIndex, 'low-bandwidth', now);
      }

      if (currentIndex >= ordered.length - 1) {
        clearStreak();
        return hold('stable');
      }

      const next = rungAt(currentIndex + 1);
      if (bandwidthBps < next.bitrateBps * cfg.upgradeSafetyFactor) {
        clearStreak();
        return hold('stable');
      }

      if (streakCount === 0) streakStartAt = now;
      streakCount += 1;

      if (lastRebufferAt !== null && now - lastRebufferAt < cfg.stepUpCooldownMs) {
        return hold('rebuffer-blocked');
      }
      if (now - lastSwitchAt < cfg.stepUpCooldownMs) return hold('cooldown');
      const spanMs = streakStartAt === null ? 0 : now - streakStartAt;
      if (streakCount < cfg.sustainedRecoverySamples || spanMs < cfg.sustainedRecoveryWindowMs) {
        return hold('insufficient-recovery');
      }

      return commitSwitch('step-up', currentIndex + 1, 'sustained-recovery', now);
    },

    onRebuffer(opts?: { readonly severe?: boolean }): AbrDecision {
      clearStreak();
      if (ordered.length <= 1) return hold('insufficient-rungs');

      const severe = opts?.severe === true;
      const now = deps.clock.now();

      if (currentIndex === 0) {
        lastRebufferAt = now;
        return hold(severe ? 'severe-rebuffer' : 'rebuffer');
      }

      if (severe || now - lastSwitchAt >= cfg.stepDownCooldownMs) {
        return commitSwitch(
          'step-down',
          currentIndex - 1,
          severe ? 'severe-rebuffer' : 'rebuffer',
          now,
        );
      }

      lastRebufferAt = now;
      return hold('cooldown');
    },

    onPause(): void {
      reanchor();
    },

    onBackground(): void {
      reanchor();
    },

    onTune(initialIndex?: number): void {
      currentIndex = clampIndex(initialIndex ?? defaultInitialIndex);
      reanchor();
    },

    reset(initialIndex?: number): void {
      currentIndex = clampIndex(initialIndex ?? defaultInitialIndex);
      reanchor();
    },
  };
}
