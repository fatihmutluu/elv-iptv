import { findFfmpeg } from '../sim/media.ts';
import { buildApk, type Exec, installApk, openDevice, POLL_MS, startGate } from './adb.ts';
import type { BudgetMode, CompareOutcome } from './compare.ts';
import { EMULATOR_HOST, median, type SimControl } from './import-gate.ts';
import { connectionStats, httpSimLog, type SimLog, type SimLogEntry, span } from './sim-log.ts';

const ACCOUNT = 'demo';
const CHANNELS = ['1001', '1002', '1003', '1004'];
const ZAP_RATE = 0.5;
/** A fault run needs one stay on the faulted channel; the lowest rate the screen accepts makes it 10 s long. */
const FAULT_RATE = 0.1;
const FAULT_ZAPS = 1;
const LINE_MARGIN_MS = 60_000;

const BUDGET_COLD_MS = 2000;
const BUDGET_WARM_P50_MS = 1000;
const BUDGET_ZAP_P95_MS = 2000;
const TOLERANCE = 1.1;
const SLACK_MS = 50;

/** Spec 7 fault windows. */
const DROP_RECOVERY_MS = 10_000;
const NOT_FOUND_FAIL_MS = 10_000;
const FIRST_BACKOFF_MS = 2000;
const CLOCK_ROUNDING_MS = 10;
const STREAM_PATH = /^\/(?:live|movie|series|timeshift)\/.+\.ts$/;

/** The faults a player gate run injects, with the outcome the screen must report for each. */
const FAULT_EXPECTED = {
  drop5: 'recovered',
  '404': 'failed-in-time',
  '509': 'limited-backoff',
} as const;
type Fault = keyof typeof FAULT_EXPECTED;
/** Fault names in run order. */
const FAULTS: Fault[] = ['drop5', '404', '509'];

type Nullable = number | null;

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
}

/** Measured numbers of the zap runs: medians of the times, the worst run of the counters. */
export interface PlayerResult {
  zaps: number;
  ttffColdMs: Nullable;
  ttffWarmMs: { p50: Nullable; p95: Nullable };
  zapMs: { p50: Nullable; p95: Nullable; max: Nullable };
  surfaceCreated: number;
  staleEventsApplied: number;
  staleEventsDropped: number;
  failures: number;
  /** Connection-limit answers on account `demo` during the zap runs (simulator log). */
  limitResponses: number;
  /** Time two TS streams of account `demo` were open together (simulator log), median over runs. */
  overlapMs: number;
}

/** Verdict on one fault run. */
export interface FaultReport {
  fault: Fault;
  line: PlayerLine;
  failures: string[];
  warnings: string[];
}

/** What {@link runPlayerGate} measured. */
export interface PlayerGateOutput {
  result: PlayerResult;
  runs: PlayerResult[];
  faults: FaultReport[];
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isNullable = (value: unknown): value is Nullable => value === null || isNumber(value);
const obj = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

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
  return v as unknown as PlayerLine;
}

/** The last well-formed `ELV_GATE_PLAYER {json}` line in a logcat dump, or undefined when there is none. */
export function parsePlayerLine(logcat: string): PlayerLine | undefined {
  let found: PlayerLine | undefined;
  const tag = 'ELV_GATE_PLAYER {';
  for (const line of logcat.split(/\r?\n/)) {
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

/** Combines the zap runs: median times, worst counters. `stats` holds the simulator numbers of each run. */
export function aggregateRuns(
  lines: readonly PlayerLine[],
  stats: readonly { limitResponses: number; overlapMs: number }[],
): PlayerResult {
  const pick = <T>(f: (l: PlayerLine) => T): T[] => lines.map(f);
  return {
    zaps: (lines[0] as PlayerLine).zaps,
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
    overlapMs: median(stats.map((s) => s.overlapMs)),
  };
}

/**
 * Compares a result with the baseline. Absolute budgets (cold under 2,000 ms, warm p50 under 1,000 ms, zap p95 at most
 * 2,000 ms) are only warnings with `budgets: 'warn'`; an unmeasured time, `surfaceCreated` other than 1, a stale event
 * applied, a failed tune and any limit response on `demo` always fail. Overlap above 0 warns. Against a baseline each
 * time may grow 10 % (plus 50 ms slack); runs with another zap count are not comparable.
 */
export function comparePlayer(
  result: PlayerResult,
  baseline: PlayerResult | undefined,
  opts: { budgets?: BudgetMode } = {},
): CompareOutcome {
  const failures: string[] = [];
  const warnings: string[] = [];
  const soft = opts.budgets === 'warn';

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
  }
  time('cold start', result.ttffColdMs, baseline?.ttffColdMs, BUDGET_COLD_MS, true);
  time('warm start p50', result.ttffWarmMs.p50, baseline?.ttffWarmMs.p50, BUDGET_WARM_P50_MS, true);
  time('zap p95', result.zapMs.p95, baseline?.zapMs.p95, BUDGET_ZAP_P95_MS, false);
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
  return { ok: failures.length === 0, failures, warnings };
}

/**
 * Judges one fault run against spec 7. The screen's `faultOutcome` must be the expected one (`missed` fails); the
 * windows come from the simulator log of the faulted channel: a dropped stream must be requested again within 10 s of
 * the drop, a 404 must have been answered for the last time within 10 s of the first request, and after a 509 the
 * next request may come only after the 2,000 ms backoff. The line carries no timestamps, so "back to playing",
 * "failed" and "limited" times are bounded through the requests only (reported as a gap in the task report).
 */
export function judgeFault(
  fault: Fault,
  line: PlayerLine,
  entries: readonly SimLogEntry[],
  channel: string,
): { failures: string[]; warnings: string[] } {
  const failures: string[] = [];
  const warnings: string[] = [];
  const expected = FAULT_EXPECTED[fault];
  if (line.fault !== (fault as string)) {
    failures.push(`the screen ran fault "${line.fault}", expected "${fault}"`);
  }
  if (line.faultOutcome === 'missed') {
    failures.push(
      `${fault}: the fault outcome is missed (the stay ended without the expected state)`,
    );
  } else if (line.faultOutcome !== expected) {
    failures.push(`${fault}: outcome ${line.faultOutcome ?? 'null'}, expected ${expected}`);
  }

  const own = entries
    .filter(
      (e) => e.account === ACCOUNT && String(e.streamId) === channel && STREAM_PATH.test(e.path),
    )
    .map((e) => ({ status: e.status, ...span(e) }))
    .sort((a, b) => a.start - b.start);
  const first = own[0];
  if (first === undefined) {
    failures.push(`${fault}: the simulator saw no request for channel ${channel}`);
    return { failures, warnings };
  }
  if (fault === 'drop5') {
    const again = own[1];
    if (again === undefined) failures.push('drop5: no reconnect request after the drop');
    else if (again.start - first.end > DROP_RECOVERY_MS) {
      failures.push(
        `drop5: reconnect came ${again.start - first.end} ms after the drop, limit ${DROP_RECOVERY_MS} ms`,
      );
    }
  } else if (fault === '404') {
    const notFound = own.filter((e) => e.status === 404);
    const last = notFound[notFound.length - 1];
    if (last === undefined) failures.push('404: the simulator answered no 404');
    else if (last.end - first.start > NOT_FOUND_FAIL_MS) {
      failures.push(
        `404: last 404 answered ${last.end - first.start} ms after the first request, limit ${NOT_FOUND_FAIL_MS} ms`,
      );
    }
  } else {
    const limited = own.filter((e) => e.status === 509);
    const [one, two] = limited;
    if (one === undefined) failures.push('509: the simulator answered no 509');
    else if (two === undefined) {
      warnings.push('509: no second request within the stay; the backoff was not verified');
    } else if (two.start - one.end < FIRST_BACKOFF_MS - CLOCK_ROUNDING_MS) {
      failures.push(
        `509: next request came ${two.start - one.end} ms after the 509, before the ${FIRST_BACKOFF_MS} ms backoff`,
      );
    }
  }
  return { failures, warnings };
}

/** Options of {@link runPlayerGate}. */
export interface PlayerGateOptions {
  exec: Exec;
  sim: SimControl;
  avd?: string;
  build?: boolean;
  /** Zaps per zap run (default 30). */
  zaps?: number;
  /** Zap runs; the result combines them (default 3, a first run is often slow). */
  runs?: number;
  /** Also run one run per fault. */
  faults?: boolean;
  root?: string;
  adb?: string;
  /** The simulator's request log (default: over HTTP on 127.0.0.1:7878). */
  log?: SimLog;
  /** FFmpeg lookup (default: the simulator's). The simulator generates its streams with it. */
  ffmpeg?: () => string | null;
  onRun?: (run: PlayerResult) => void;
  onFault?: (report: FaultReport) => void;
  onNote?: (note: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

const link = (zaps: number, rate: number, fault: string): string =>
  `elviptv://gate/player?host=${EMULATOR_HOST}&account=${ACCOUNT}&channels=${CHANNELS.join(',')}&zaps=${zaps}&rate=${rate}&fault=${fault}`;

/**
 * Builds (optional) and installs the development app, starts the stream simulator (or reuses a running one), opens
 * `elviptv://gate/player` for `runs` zap runs and, with `faults`, one run per fault, clearing the simulator log before
 * each. Fails at once without FFmpeg. The simulator it started is stopped afterwards. Every wait has a timeout;
 * failures throw a one-line `Error`.
 */
export async function runPlayerGate(opts: PlayerGateOptions): Promise<PlayerGateOutput> {
  const lookup = opts.ffmpeg ?? findFfmpeg;
  if (lookup() === null) {
    throw new Error(
      'gate: FFmpeg not found: set FFMPEG_PATH or install FFmpeg; the simulator needs it for live streams',
    );
  }
  const { exec } = opts;
  const adb = opts.adb ?? 'adb';
  const root = opts.root ?? '.';
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const zaps = opts.zaps ?? 30;
  const runs = Math.max(1, opts.runs ?? 3);
  const log = opts.log ?? httpSimLog('http://127.0.0.1:7878');

  if (opts.build === true) await buildApk(exec, root, adb);
  const sim = await opts.sim.ensure();
  try {
    if (sim.reused) opts.onNote?.('simulator already running on port 7878: reusing it');
    const device = await openDevice(exec, adb, opts.avd);
    await installApk(exec, adb, device.serial, root);

    const play = async (url: string, stayMs: number): Promise<PlayerLine> => {
      await log.clear();
      await startGate(device, sleep, url);
      const timeoutMs = stayMs + LINE_MARGIN_MS;
      for (let waited = 0; waited <= timeoutMs; waited += POLL_MS) {
        const line = parsePlayerLine(
          (await device.dev('logcat', '-d', '-s', 'ReactNativeJS:V')).output,
        );
        if (line !== undefined) return line;
        await sleep(POLL_MS);
      }
      throw new Error(
        `gate: no ELV_GATE_PLAYER line within ${Math.round(timeoutMs / 1000)} s; the run did not finish`,
      );
    };

    const lines: PlayerLine[] = [];
    const stats: { limitResponses: number; overlapMs: number }[] = [];
    for (let i = 0; i < runs; i++) {
      const line = await play(link(zaps, ZAP_RATE, ''), (zaps / ZAP_RATE) * 1000);
      const stat = connectionStats(await log.entries(), ACCOUNT);
      lines.push(line);
      stats.push(stat);
      opts.onRun?.(aggregateRuns([line], [stat]));
    }

    const faults: FaultReport[] = [];
    for (const fault of opts.faults === true ? FAULTS : []) {
      const line = await play(
        link(FAULT_ZAPS, FAULT_RATE, fault),
        (FAULT_ZAPS / FAULT_RATE) * 1000,
      );
      const verdict = judgeFault(fault, line, await log.entries(), CHANNELS[0] as string);
      const report = { fault, line, ...verdict };
      faults.push(report);
      opts.onFault?.(report);
    }
    const perRun = lines.map((l, i) => aggregateRuns([l], [stats[i] as (typeof stats)[number]]));
    return { result: aggregateRuns(lines, stats), runs: perRun, faults };
  } finally {
    await sim.stop();
  }
}
