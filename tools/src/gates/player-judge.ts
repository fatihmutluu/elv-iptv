import type { BudgetMode, CompareOutcome } from './compare.ts';
import type { GateTarget } from './gate-device.ts';
import { median } from './import-gate.ts';

/** The simulator account every player gate run uses (one connection allowed). */
export const ACCOUNT = 'demo';

const TOLERANCE = 1.1;
const SLACK_MS = 50;

/** Soak limits (owner decision 27). */
const SOAK_POSITION_SLACK_MS = 2000;
const MEMORY_WARN_MB = 32;
const MEMORY_FAIL_MB = 100;

type Nullable = number | null;

/** The `soak` block of a soak run's line. */
export interface SoakBlock {
  minutes: number;
  /** First frame to the line. */
  playedMs: number;
  /** How far the media position moved over the same span. */
  positionAdvancedMs: number;
  stalls: number;
  longestStallMs: number;
  ended: boolean;
  durationMs: Nullable;
}

type FinalStatus = 'playing' | 'failed' | 'limited' | 'other';

/** The `ELV_GATE_PLAYER` line (mirror of `apps/tv-mobile/src/gate/player/player-metrics.ts`; tools never import the app). */
export interface PlayerLine {
  ttffColdMs: Nullable;
  ttffWarmMs: { p50: Nullable; p95: Nullable };
  zapMs: { p50: Nullable; p95: Nullable; max: Nullable };
  surfaceCreated: number;
  staleEventsApplied: number;
  staleEventsDropped: number;
  failures: number;
  recoveries: Record<'1' | '2' | '3' | '4', number>;
  fault: string;
  faultOutcome: string | null;
  zaps: number;
  /** Null outside soak runs, and for app builds that predate them. */
  soak: SoakBlock | null;
  /** `other` for app builds that predate the field. */
  final: FinalStatus;
}

/** Measured numbers of the zap runs: medians of the times, the worst run of the counters. */
export interface PlayerResult {
  zaps: number;
  /** Initial live TS burst seconds (`0` for real time). */
  burstSec: number;
  ttffColdMs: Nullable;
  ttffWarmMs: { p50: Nullable; p95: Nullable };
  zapMs: { p50: Nullable; p95: Nullable; max: Nullable };
  surfaceCreated: number;
  staleEventsApplied: number;
  staleEventsDropped: number;
  failures: number;
  /** Connection-limit answers on account `demo` during the zap runs (simulator log). */
  limitResponses: number;
  /** Time two TS streams of account `demo` were open together (simulator log), worst run. */
  overlapMs: number;
}

/** Findings of a judge: failures fail the gate, warnings are reported only. */
export interface Verdict {
  failures: string[];
  warnings: string[];
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isNullable = (value: unknown): value is Nullable => value === null || isNumber(value);
const obj = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
const FINALS: ReadonlySet<unknown> = new Set(['playing', 'failed', 'limited', 'other']);

function readSoak(value: unknown): SoakBlock | null | undefined {
  if (value === undefined || value === null) return null;
  const s = obj(value);
  if (s === undefined || typeof s.ended !== 'boolean' || !isNullable(s.durationMs))
    return undefined;
  for (const key of ['minutes', 'playedMs', 'positionAdvancedMs', 'stalls', 'longestStallMs']) {
    if (!isNumber(s[key])) return undefined;
  }
  return s as unknown as SoakBlock;
}

function readLine(v: Record<string, unknown>): PlayerLine | undefined {
  const warm = obj(v.ttffWarmMs);
  const zap = obj(v.zapMs);
  const rec = obj(v.recoveries);
  if (
    !isNullable(v.ttffColdMs) ||
    warm === undefined ||
    !isNullable(warm.p50) ||
    !isNullable(warm.p95) ||
    zap === undefined ||
    !isNullable(zap.p50) ||
    !isNullable(zap.p95) ||
    !isNullable(zap.max) ||
    rec === undefined ||
    typeof v.fault !== 'string' ||
    !(v.faultOutcome === null || typeof v.faultOutcome === 'string')
  ) {
    return undefined;
  }
  for (const key of [
    'surfaceCreated',
    'staleEventsApplied',
    'staleEventsDropped',
    'failures',
    'zaps',
  ]) {
    if (!isNumber(v[key])) return undefined;
  }
  for (const key of ['1', '2', '3', '4']) if (!isNumber(rec[key])) return undefined;
  const soak = readSoak(v.soak);
  const final = v.final ?? 'other';
  if (soak === undefined || !FINALS.has(final)) return undefined;
  return { ...(v as unknown as PlayerLine), soak, final: final as FinalStatus };
}

/** The last well-formed `ELV_GATE_PLAYER {json}` line in a log dump, or undefined when there is none. */
export function parsePlayerLine(log: string): PlayerLine | undefined {
  let found: PlayerLine | undefined;
  const tag = 'ELV_GATE_PLAYER {';
  for (const line of log.split(/\r?\n/)) {
    const at = line.indexOf(tag);
    const end = line.lastIndexOf('}');
    if (at < 0 || end < at) continue;
    try {
      const parsed = obj(JSON.parse(line.slice(at + tag.length - 1, end + 1)));
      found = (parsed && readLine(parsed)) ?? found;
    } catch {
      // a truncated or foreign line: keep the previous one
    }
  }
  return found;
}

const medianOrNull = (values: Nullable[]): Nullable => {
  const known = values.filter(isNumber);
  return known.length === 0 ? null : median(known);
};
const worst = (values: number[]): number => Math.max(...values);

/** Combines the zap runs: median times, worst counters and overlap. `stats` holds the simulator numbers of each run. */
export function aggregateRuns(
  lines: readonly PlayerLine[],
  stats: readonly { limitResponses: number; overlapMs: number }[],
  burstSec = 0,
): PlayerResult {
  const pick = <T>(f: (l: PlayerLine) => T): T[] => lines.map(f);
  return {
    zaps: (lines[0] as PlayerLine).zaps,
    burstSec,
    ttffColdMs: medianOrNull(pick((l) => l.ttffColdMs)),
    ttffWarmMs: {
      p50: medianOrNull(pick((l) => l.ttffWarmMs.p50)),
      p95: medianOrNull(pick((l) => l.ttffWarmMs.p95)),
    },
    zapMs: {
      p50: medianOrNull(pick((l) => l.zapMs.p50)),
      p95: medianOrNull(pick((l) => l.zapMs.p95)),
      max: medianOrNull(pick((l) => l.zapMs.max)),
    },
    surfaceCreated: worst(pick((l) => l.surfaceCreated)),
    staleEventsApplied: worst(pick((l) => l.staleEventsApplied)),
    staleEventsDropped: worst(pick((l) => l.staleEventsDropped)),
    failures: worst(pick((l) => l.failures)),
    limitResponses: worst(stats.map((s) => s.limitResponses)),
    overlapMs: worst(stats.map((s) => s.overlapMs)),
  };
}

/** Absolute time budgets of a zap run. */
export interface PlayerBudgets {
  coldMs: number;
  warmP50Ms: number;
  zapP95Ms: number;
}

const SPEC_BUDGETS: PlayerBudgets = { coldMs: 2000, warmP50Ms: 1000, zapP95Ms: 2000 };
const APPLE_REALTIME_BUDGETS: PlayerBudgets = { coldMs: 4000, warmP50Ms: 3000, zapP95Ms: 4000 };

/** Selects the absolute time budgets for a target and live TS burst profile. */
export function budgetsFor(target: GateTarget, burstSec: number): PlayerBudgets {
  return target === 'android-tv' || burstSec > 0 ? SPEC_BUDGETS : APPLE_REALTIME_BUDGETS;
}

const TIMES: readonly [string, (r: PlayerResult) => Nullable][] = [
  ['cold start', (r) => r.ttffColdMs],
  ['warm start p50', (r) => r.ttffWarmMs.p50],
  ['warm start p95', (r) => r.ttffWarmMs.p95],
  ['zap p50', (r) => r.zapMs.p50],
  ['zap p95', (r) => r.zapMs.p95],
  ['zap max', (r) => r.zapMs.max],
];

/**
 * Compares a result with the baseline. Absolute budgets (spec 7 by default: cold under 2,000 ms, warm p50 under
 * 1,000 ms, zap p95 at most 2,000 ms) are only warnings with `budgets: 'warn'`; an unmeasured time, `surfaceCreated`
 * other than 1, a stale event applied, a failed tune and any limit response on `demo` always fail. Overlap above 0
 * warns, and so does a time one of `runs` did not measure while the result has it from the others (the median hides
 * that run). Against a baseline each time may grow 10 % (plus 50 ms slack); runs with another zap count are not
 * comparable.
 */
export function comparePlayer(
  result: PlayerResult,
  baseline: PlayerResult | undefined,
  opts: {
    budgets?: BudgetMode;
    runs?: readonly PlayerResult[];
    limits?: PlayerBudgets;
    target?: GateTarget;
  } = {},
): CompareOutcome {
  const failures: string[] = [];
  const warnings: string[] = [];
  const soft = opts.budgets === 'warn';
  const resultBurst = result.burstSec ?? 0;
  const limits = opts.limits ?? budgetsFor(opts.target ?? 'android-tv', resultBurst);

  const time = (
    name: string,
    value: Nullable,
    base: Nullable | undefined,
    max: number,
    strict: boolean,
  ) => {
    if (value === null) {
      failures.push(`${name} was not measured`);
      return;
    }
    if (strict ? value >= max : value > max) {
      const text = `${name} ${value} ms ${strict ? 'is not under' : 'exceeds'} the absolute budget of ${max} ms`;
      if (soft) warnings.push(`${text} (--budgets warn: reported only)`);
      else failures.push(text);
    }
    if (typeof base === 'number') {
      const limit = Math.max(base * TOLERANCE, base + SLACK_MS);
      if (value > limit) {
        failures.push(
          `${name} ${value} ms exceeds the limit ${Math.round(limit * 100) / 100} ms (baseline ${base} ms)`,
        );
      }
    }
  };

  if (baseline === undefined) {
    warnings.push('no baseline: only the absolute budgets and the counters were checked');
  } else if (baseline.zaps !== result.zaps) {
    failures.push(`not comparable: ${result.zaps} zaps, baseline has ${baseline.zaps}`);
    baseline = undefined;
  } else if ((baseline.burstSec ?? 0) !== resultBurst) {
    failures.push(`not comparable: burst ${resultBurst}, baseline has ${baseline.burstSec ?? 0}`);
    baseline = undefined;
  }
  time('cold start', result.ttffColdMs, baseline?.ttffColdMs, limits.coldMs, true);
  time('warm start p50', result.ttffWarmMs.p50, baseline?.ttffWarmMs.p50, limits.warmP50Ms, true);
  time('zap p95', result.zapMs.p95, baseline?.zapMs.p95, limits.zapP95Ms, false);
  if (result.surfaceCreated !== 1)
    failures.push(`surfaceCreated ${result.surfaceCreated}, expected 1`);
  if (result.staleEventsApplied !== 0) {
    failures.push(`staleEventsApplied ${result.staleEventsApplied}, expected 0`);
  }
  if (result.failures !== 0) failures.push(`${result.failures} tunes failed during the zap runs`);
  if (result.limitResponses !== 0) {
    failures.push(`limitResponses ${result.limitResponses} on account ${ACCOUNT}, expected 0`);
  }
  if (result.overlapMs > 0) {
    warnings.push(`two ${ACCOUNT} streams were open together for ${result.overlapMs} ms`);
  }
  (opts.runs ?? []).forEach((run, i) => {
    for (const [name, value] of TIMES) {
      if (value(run) === null && value(result) !== null) {
        warnings.push(`run ${i + 1}: ${name} was not measured; the result uses the other runs`);
      }
    }
  });
  return { ok: failures.length === 0, failures, warnings };
}

/** One failure naming the crash reports a run left, or none. */
export function crashFailures(crashes: readonly string[]): string[] {
  return crashes.length === 0 ? [] : [`crash reports newer than the run: ${crashes.join(', ')}`];
}

/** Resident memory samples of a soak run: the first after the first frame and the last; null where unknown. */
export interface MemorySamples {
  firstMb: Nullable;
  lastMb: Nullable;
}

/**
 * Judges a soak run (owner decision 27): no failed tune, no stall, no recovery rung, no crash; live media
 * (`ts`, `hls`) must advance its position as far as it played (2,000 ms slack); a movie (`vod`) must end with its
 * position within 2,000 ms of its duration. Memory growth warns above 32 MB and fails above 100 MB.
 */
export function judgeSoak(
  line: PlayerLine,
  opts: { stream: 'ts' | 'hls' | 'vod'; crashes: readonly string[]; memory: MemorySamples },
): Verdict {
  const failures: string[] = [];
  const warnings: string[] = [];
  const soak = line.soak;
  if (soak === null) {
    failures.push('soak: the line carries no soak block; the app build predates soak runs');
    return { failures, warnings };
  }
  if (line.failures !== 0) failures.push(`soak: ${line.failures} tunes failed`);
  if (soak.stalls !== 0) {
    failures.push(`soak: ${soak.stalls} stalls (longest ${soak.longestStallMs} ms), expected 0`);
  }
  for (const [rung, count] of Object.entries(line.recoveries)) {
    if (count !== 0)
      failures.push(`soak: recovery rung ${rung} entered ${count} times, expected 0`);
  }
  if (opts.stream === 'vod') {
    if (soak.durationMs === null) failures.push('soak: the movie reported no duration');
    else if (!soak.ended) failures.push('soak: the movie did not play to its end');
    else if (soak.positionAdvancedMs < soak.durationMs - SOAK_POSITION_SLACK_MS) {
      failures.push(
        `soak: position advanced ${soak.positionAdvancedMs} ms of the ${soak.durationMs} ms movie (at least ${soak.durationMs - SOAK_POSITION_SLACK_MS} ms)`,
      );
    }
  } else {
    const off = Math.round(Math.abs(soak.playedMs - soak.positionAdvancedMs));
    if (off > SOAK_POSITION_SLACK_MS) {
      failures.push(
        `soak: position advanced ${soak.positionAdvancedMs} ms in ${soak.playedMs} ms played, off by ${off} ms (limit ${SOAK_POSITION_SLACK_MS} ms)`,
      );
    }
  }
  failures.push(...crashFailures(opts.crashes));
  const { firstMb, lastMb } = opts.memory;
  if (firstMb !== null && lastMb !== null) {
    const grew = Math.round((lastMb - firstMb) * 10) / 10;
    const text = `soak: memory grew ${grew} MB (${firstMb} MB to ${lastMb} MB)`;
    if (grew > MEMORY_FAIL_MB) failures.push(`${text}, limit ${MEMORY_FAIL_MB} MB`);
    else if (grew > MEMORY_WARN_MB) warnings.push(`${text}, warning above ${MEMORY_WARN_MB} MB`);
  }
  return { failures, warnings };
}

/** One stress run: its line, the simulator's numbers and the crash reports it left. */
export interface StressRun {
  line: PlayerLine;
  limitResponses: number;
  overlapMs: number;
  crashes: readonly string[];
}

/**
 * Judges stress runs on counters only (times are not judged): per run no failed tune, no stale event applied, one
 * surface, no limit answer on `demo`, the requested zaps, no crash, and `final` `playing` (the last zap showed a
 * frame). Overlap warns.
 */
export function judgeStress(runs: readonly StressRun[], zaps: number): Verdict {
  const failures: string[] = [];
  const warnings: string[] = [];
  runs.forEach((run, i) => {
    const at = `run ${i + 1}:`;
    const { line } = run;
    if (line.final !== 'playing') {
      failures.push(
        `${at} final status ${line.final}, expected playing (the last zap showed no frame)`,
      );
    }
    if (line.failures !== 0) failures.push(`${at} ${line.failures} tunes failed`);
    if (line.staleEventsApplied !== 0) {
      failures.push(`${at} staleEventsApplied ${line.staleEventsApplied}, expected 0`);
    }
    if (line.surfaceCreated !== 1) {
      failures.push(`${at} surfaceCreated ${line.surfaceCreated}, expected 1`);
    }
    if (run.limitResponses !== 0) {
      failures.push(`${at} limitResponses ${run.limitResponses} on account ${ACCOUNT}, expected 0`);
    }
    if (line.zaps < zaps)
      failures.push(`${at} the screen made ${line.zaps} zaps, requested ${zaps}`);
    for (const crash of crashFailures(run.crashes)) failures.push(`${at} ${crash}`);
    if (run.overlapMs > 0) {
      warnings.push(`${at} two ${ACCOUNT} streams were open together for ${run.overlapMs} ms`);
    }
  });
  return { failures, warnings };
}
