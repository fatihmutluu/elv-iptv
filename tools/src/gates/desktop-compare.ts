import type { BudgetMode, CompareOutcome } from './compare.ts';
import { median } from './import-gate.ts';
import { connectionStats, type SimLogEntry, STREAM_PATH, span } from './sim-log.ts';

const ACCOUNT = 'demo';
const BUDGET_COLD_MS = 2000;
const BUDGET_WARM_P50_MS = 1000;
const BUDGET_ZAP_P95_MS = 2000;
const COALESCE_CAP_MS = 1200;
const TOLERANCE = 1.1;
const SLACK_MS = 50;

const DROP_RECOVERY_MS = 10_000;
const NOT_FOUND_FAIL_MS = 10_000;
const SILENT_FAIL_MS = 12_000;
const LIMITED_WITHIN_MS = 2000;
const FIRST_BACKOFF_MS = 2000;
const CLOCK_ROUNDING_MS = 10;
const NOTICE_BYTES = 'Max connections reached'.length;

const FAULT_EXPECTED = {
  drop5: 'recovered',
  '404': 'failed-in-time',
  '509': 'limited-backoff',
  notice: 'limited-backoff',
  stall: 'recovered',
  slowstart: 'left',
  silent: 'failed-in-time',
} as const;

/** Faults run by `pnpm gate desktop --faults`. */
export type DesktopFault = keyof typeof FAULT_EXPECTED;

/** Fault names in run order. */
export const DESKTOP_FAULTS: readonly DesktopFault[] = [
  'drop5',
  '404',
  '509',
  'notice',
  'stall',
  'slowstart',
  'silent',
];

type Nullable = number | null;

/** Parsed `ELV_GATE_PLAYER` line printed by `apps/desktop`. */
export interface DesktopLine {
  ttffColdMs: Nullable;
  ttffWarmMs: { p50: Nullable; p95: Nullable };
  zapMs: { p50: Nullable; p95: Nullable; max: Nullable };
  surfaceCreated: number;
  staleEventsApplied: number;
  staleEventsDropped: number;
  failures: number;
  engineWedged: number;
  recoveries: Record<'1' | '2' | '3' | '4', number>;
  fault: string;
  faultOutcome: string | null;
  zaps: number;
  vod: { playing: boolean; seeked: boolean } | null;
  mpvSpawns: number;
  loadMode: string;
  presenter: string;
  videoVisible: boolean | null;
  distinct: number;
  coalesceMaxMs: number;
}

/** Combined measurement across the zap runs: median times and worst-run counters. */
export interface DesktopResult {
  zaps: number;
  ttffColdMs: Nullable;
  ttffWarmMs: { p50: Nullable; p95: Nullable };
  zapMs: { p50: Nullable; p95: Nullable; max: Nullable };
  surfaceCreated: number;
  mpvSpawns: number;
  staleEventsApplied: number;
  staleEventsDropped: number;
  failures: number;
  engineWedged: number;
  coalesceMaxMs: number;
  loadMode: string;
  presenter: string;
  videoVisible: boolean | null;
  distinct: number;
  vod: { playing: boolean; seeked: boolean } | null;
  limitResponses: number;
  overlapMs: number;
}

/** Verdict on one desktop fault run. */
export interface DesktopFaultReport {
  fault: DesktopFault;
  line: DesktopLine;
  failures: string[];
  warnings: string[];
  limitResponses: number;
  overlapMs: number;
}

/** Verdict on the orphan check (stream close delay after killing Electron main). */
export interface OrphanReport {
  ok: boolean;
  closeMs: number | null;
  failures: string[];
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNullable = (v: unknown): v is Nullable => v === null || isNumber(v);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

function readDesktopLine(v: Record<string, unknown>): DesktopLine | undefined {
  const warm = obj(v.ttffWarmMs);
  const zap = obj(v.zapMs);
  const rec = obj(v.recoveries);
  const vod = obj(v.vod);
  const vodOk =
    v.vod === null ||
    (vod !== undefined && typeof vod.playing === 'boolean' && typeof vod.seeked === 'boolean');
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
    !(v.faultOutcome === null || typeof v.faultOutcome === 'string') ||
    !vodOk ||
    typeof v.loadMode !== 'string' ||
    typeof v.presenter !== 'string' ||
    !(v.videoVisible === null || typeof v.videoVisible === 'boolean')
  ) {
    return undefined;
  }
  for (const key of [
    'surfaceCreated',
    'staleEventsApplied',
    'staleEventsDropped',
    'failures',
    'engineWedged',
    'zaps',
    'mpvSpawns',
    'distinct',
    'coalesceMaxMs',
  ]) {
    if (!isNumber(v[key])) return undefined;
  }
  for (const key of ['1', '2', '3', '4']) if (!isNumber(rec[key])) return undefined;
  return v as unknown as DesktopLine;
}

/** Parses the last well-formed `ELV_GATE_PLAYER {json}` line in `output`. */
export function parseDesktopLine(output: string): DesktopLine | undefined {
  let found: DesktopLine | undefined;
  const tag = 'ELV_GATE_PLAYER {';
  for (const line of output.split(/\r?\n/)) {
    const at = line.indexOf(tag);
    const end = line.lastIndexOf('}');
    if (at < 0 || end < at) continue;
    try {
      const parsed = obj(JSON.parse(line.slice(at + tag.length - 1, end + 1)));
      found = (parsed && readDesktopLine(parsed)) ?? found;
    } catch {
      // ignore malformed lines
    }
  }
  return found;
}

const medianOrNull = (values: readonly Nullable[]): Nullable => {
  const known = values.filter(isNumber);
  return known.length === 0 ? null : median(known);
};

/** Combines desktop zap runs into a single `DesktopResult`. */
export function aggregateDesktopRuns(
  lines: readonly DesktopLine[],
  stats: readonly { limitResponses: number; overlapMs: number }[],
): DesktopResult {
  const first = lines[0] as DesktopLine;
  const videoVisible = lines.some((l) => l.videoVisible === false)
    ? false
    : lines.every((l) => l.videoVisible === true)
      ? true
      : null;
  const vod = lines.every((l) => l.vod === null)
    ? null
    : {
        playing: lines.every((l) => l.vod?.playing === true),
        seeked: lines.every((l) => l.vod?.seeked === true),
      };
  return {
    zaps: first.zaps,
    ttffColdMs: medianOrNull(lines.map((l) => l.ttffColdMs)),
    ttffWarmMs: {
      p50: medianOrNull(lines.map((l) => l.ttffWarmMs.p50)),
      p95: medianOrNull(lines.map((l) => l.ttffWarmMs.p95)),
    },
    zapMs: {
      p50: medianOrNull(lines.map((l) => l.zapMs.p50)),
      p95: medianOrNull(lines.map((l) => l.zapMs.p95)),
      max: medianOrNull(lines.map((l) => l.zapMs.max)),
    },
    surfaceCreated: lines.find((l) => l.surfaceCreated !== 1)?.surfaceCreated ?? 1,
    mpvSpawns: lines.find((l) => l.mpvSpawns !== 1)?.mpvSpawns ?? 1,
    staleEventsApplied: Math.max(...lines.map((l) => l.staleEventsApplied)),
    staleEventsDropped: Math.max(...lines.map((l) => l.staleEventsDropped)),
    failures: Math.max(...lines.map((l) => l.failures)),
    engineWedged: Math.max(...lines.map((l) => l.engineWedged)),
    coalesceMaxMs: Math.max(...lines.map((l) => l.coalesceMaxMs)),
    loadMode: first.loadMode,
    presenter: first.presenter,
    videoVisible,
    distinct: Math.min(...lines.map((l) => l.distinct)),
    vod,
    limitResponses: Math.max(...stats.map((s) => s.limitResponses)),
    overlapMs: Math.max(...stats.map((s) => s.overlapMs)),
  };
}

const TIMES: readonly [string, (r: DesktopResult) => Nullable][] = [
  ['cold start', (r) => r.ttffColdMs],
  ['warm start p50', (r) => r.ttffWarmMs.p50],
  ['warm start p95', (r) => r.ttffWarmMs.p95],
  ['zap p50', (r) => r.zapMs.p50],
  ['zap p95', (r) => r.zapMs.p95],
  ['zap max', (r) => r.zapMs.max],
];

/** Compares a `DesktopResult` against absolute budgets and an optional baseline. */
export function compareDesktop(
  result: DesktopResult,
  baseline: DesktopResult | undefined,
  opts: { budgets?: BudgetMode; runs?: readonly DesktopResult[] } = {},
): CompareOutcome {
  const failures: string[] = [];
  const warnings: string[] = [];
  const soft = opts.budgets === 'warn';

  const checkTime = (
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

  checkTime('cold start', result.ttffColdMs, baseline?.ttffColdMs, BUDGET_COLD_MS, true);
  checkTime(
    'warm start p50',
    result.ttffWarmMs.p50,
    baseline?.ttffWarmMs.p50,
    BUDGET_WARM_P50_MS,
    true,
  );
  checkTime('zap p95', result.zapMs.p95, baseline?.zapMs.p95, BUDGET_ZAP_P95_MS, false);

  if (result.surfaceCreated !== 1)
    failures.push(`surfaceCreated ${result.surfaceCreated}, expected 1`);
  if (result.mpvSpawns !== 1) failures.push(`mpvSpawns ${result.mpvSpawns}, expected 1`);
  if (result.staleEventsApplied !== 0)
    failures.push(`staleEventsApplied ${result.staleEventsApplied}, expected 0`);
  if (result.failures !== 0) failures.push(`${result.failures} tunes failed during the zap runs`);
  if (result.engineWedged !== 0) failures.push(`engineWedged ${result.engineWedged}, expected 0`);
  if (result.coalesceMaxMs > COALESCE_CAP_MS)
    failures.push(`coalesceMaxMs ${result.coalesceMaxMs} ms exceeds the 1000 ms coalescing cap`);
  if (result.videoVisible === false) {
    failures.push(
      `videoVisible is false (distinct buckets: ${result.distinct}); the player area showed no video`,
    );
  } else if (result.videoVisible === null) {
    warnings.push(
      'videoVisible was not measured (screen capture returned no image; check Screen Recording permission on macOS or an unlocked display on Windows)',
    );
  }
  if (result.vod !== null) {
    if (!result.vod.playing) failures.push('VOD did not reach playing');
    else if (!result.vod.seeked)
      failures.push('VOD seek to 60 s did not resume playing near the target');
  }
  if (result.limitResponses !== 0)
    failures.push(`limitResponses ${result.limitResponses} on account ${ACCOUNT}, expected 0`);
  if (result.overlapMs > 0)
    warnings.push(`two ${ACCOUNT} streams were open together for ${result.overlapMs} ms`);

  (opts.runs ?? []).forEach((run, i) => {
    for (const [name, value] of TIMES) {
      if (value(run) === null && value(result) !== null) {
        warnings.push(`run ${i + 1}: ${name} was not measured; the result uses the other runs`);
      }
    }
  });
  return { ok: failures.length === 0, failures, warnings };
}

/** Judges one desktop fault run against spec §6 and simulator log spans. */
export function judgeDesktopFault(
  fault: DesktopFault,
  line: DesktopLine,
  entries: readonly SimLogEntry[],
  channel: string,
): { failures: string[]; warnings: string[] } {
  const failures: string[] = [];
  const warnings: string[] = [];
  const expected = FAULT_EXPECTED[fault];
  if (line.fault !== fault)
    failures.push(`the screen ran fault "${line.fault}", expected "${fault}"`);
  if (line.zaps < 1) failures.push(`${fault}: the screen made ${line.zaps} zaps, requested 1`);
  if (line.engineWedged !== 0)
    failures.push(`${fault}: engineWedged ${line.engineWedged}, expected 0`);
  if (line.coalesceMaxMs > COALESCE_CAP_MS)
    failures.push(
      `${fault}: coalesceMaxMs ${line.coalesceMaxMs} ms exceeds the 1000 ms coalescing cap`,
    );
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
    .map((e) => ({ status: e.status, bytes: e.bytes, ...span(e) }))
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
  } else if (fault === 'stall') {
    if (own.length < 2) failures.push('stall: no reconnect request after the 4 s stall watchdog');
  } else if (fault === 'slowstart') {
    if (line.zapMs.max === null)
      failures.push('slowstart: the zap away from the slow channel showed no frame');
    const after = entries.some(
      (e) => e.account === ACCOUNT && STREAM_PATH.test(e.path) && String(e.streamId) !== channel,
    );
    if (!after) failures.push('slowstart: the simulator saw no request after the zap');
    const { limitResponses, overlapMs } = connectionStats(entries, ACCOUNT);
    if (limitResponses > 0) {
      failures.push(
        `slowstart: ${limitResponses} limit responses on ${ACCOUNT}: the slow request stayed open beside the next channel`,
      );
    }
    if (overlapMs > 0)
      warnings.push(`slowstart: two ${ACCOUNT} streams were open together for ${overlapMs} ms`);
  } else if (fault === 'silent') {
    const last = own[own.length - 1];
    if (own.length < 2) {
      failures.push('silent: ladder made fewer than 2 requests before giving up');
    } else if (last !== undefined && last.end - first.start > SILENT_FAIL_MS) {
      failures.push(
        `silent: last request closed ${last.end - first.start} ms after the first request, limit ${SILENT_FAIL_MS} ms`,
      );
    }
    const { limitResponses, overlapMs } = connectionStats(entries, ACCOUNT);
    if (limitResponses > 0) {
      failures.push(
        `silent: ${limitResponses} limit responses on ${ACCOUNT}: a silent rung stayed open beside the next request`,
      );
    }
    if (overlapMs > 0)
      warnings.push(`silent: two ${ACCOUNT} streams were open together for ${overlapMs} ms`);
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
    const matching =
      fault === '509'
        ? own.filter((e) => e.status === 509)
        : own.filter((e) => e.status === 200 && e.bytes === NOTICE_BYTES);
    const [one, two] = matching;
    if (one === undefined) failures.push(`${fault}: the simulator answered no ${fault}`);
    else {
      if (one.end - first.start > LIMITED_WITHIN_MS) {
        failures.push(
          `${fault}: first limit answer took ${one.end - first.start} ms, limit ${LIMITED_WITHIN_MS} ms`,
        );
      }
      if (two === undefined) {
        warnings.push(`${fault}: no second request within the stay; the backoff was not verified`);
      } else if (two.start - one.end < FIRST_BACKOFF_MS - CLOCK_ROUNDING_MS) {
        failures.push(
          `${fault}: next request came ${two.start - one.end} ms after the limit answer, before the ${FIRST_BACKOFF_MS} ms backoff`,
        );
      }
    }
  }
  return { failures, warnings };
}
