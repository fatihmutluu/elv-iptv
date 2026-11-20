import { type FaultSpan, judgeLimitBackoff } from './fault-judge.ts';
import { ACCOUNT } from './player-judge.ts';
import { connectionStats, type SimLogEntry, STREAM_PATH, span } from './sim-log.ts';

/** Upper bound on rapid-zap coalescing delay during desktop zap and fault runs. */
export const COALESCE_CAP_MS = 1200;

const DROP_RECOVERY_MS = 10_000;
const NOT_FOUND_FAIL_MS = 10_000;
const SILENT_FAIL_MS = 12_000;
const LIMITED_WITHIN_MS = 2000;

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
  limitedAfterMs?: Nullable;
  zaps: number;
  vod: { playing: boolean; seeked: boolean } | null;
  mpvSpawns: number;
  loadMode: string;
  presenter: string;
  videoVisible: boolean | null;
  distinct: number;
  coalesceMaxMs: number;
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

  const own: FaultSpan[] = entries
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
    if (typeof line.limitedAfterMs === 'number' && line.limitedAfterMs > LIMITED_WITHIN_MS) {
      failures.push(
        `${fault}: the screen entered limited ${line.limitedAfterMs} ms after the tune, limit ${LIMITED_WITHIN_MS} ms`,
      );
    }
    judgeLimitBackoff(fault, own, failures, warnings, LIMITED_WITHIN_MS);
  }
  return { failures, warnings };
}
