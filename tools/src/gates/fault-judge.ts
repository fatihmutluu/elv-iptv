import type { GateTarget } from './gate-device.ts';
import { ACCOUNT, type PlayerLine, type Verdict } from './player-judge.ts';
import { connectionStats, type SimLogEntry, STREAM_PATH, span } from './sim-log.ts';

/** A fault run needs one stay on the faulted channel; 0.1 gives 10 s, and 0.05 gives 20 s for stall/silent or bursty drop5. */
const FAULT_RATE = 0.1;
const LONG_FAULT_RATE = 0.05;
/** A slow-start run zaps 800 ms after the first tune, while that request still waits for its 3 s late answer. */
const SLOW_START_RATE = 1.25;
/** Zaps requested on every fault run. */
export const FAULT_ZAPS = 1;

/** Spec 7 fault windows. */
const DROP_RECOVERY_MS = 10_000;
const STALL_RECOVERY_MS = 10_000;
const NOT_FOUND_FAIL_MS = 10_000;
const SILENT_FAIL_MS = 12_000;
const LIMITED_WITHIN_MS = 2000;
const LIMIT_BACKOFF_MS: readonly number[] = [2000, 4000, 8000, 15_000];
const CLOCK_ROUNDING_MS = 10;
const NOTICE_BYTES = 'Max connections reached'.length;

/** The faults a player gate run injects, with the outcome the screen must report for each. */
const FAULT_EXPECTED = {
  drop5: 'recovered',
  '404': 'failed-in-time',
  '509': 'limited-backoff',
  notice: 'limited-backoff',
  stall: 'recovered',
  slowstart: 'left',
  silent: 'failed-in-time',
} as const;

/** Name of an injected player-gate fault. */
export type Fault = keyof typeof FAULT_EXPECTED;

/** Request span from the simulator log with HTTP status and response byte count. */
export interface FaultSpan {
  status: number;
  bytes: number;
  start: number;
  end: number;
}

const ANDROID_FAULTS: readonly Fault[] = ['drop5', '404', '509', 'slowstart', 'silent'];
const APPLE_FAULTS: readonly Fault[] = [
  'drop5',
  '404',
  '509',
  'notice',
  'stall',
  'slowstart',
  'silent',
];

/** Faults `--faults` runs on `target`, in order. */
export function faultsFor(target: GateTarget): readonly Fault[] {
  return target === 'android-tv' ? ANDROID_FAULTS : APPLE_FAULTS;
}

/** Zap rate (zaps per second) that gives `fault` its needed stay on `channels[0]` (accounting for `burstSec` preroll on `drop5`). */
export function faultRate(fault: Fault, burstSec = 0): number {
  if (fault === 'slowstart') return SLOW_START_RATE;
  if (fault === 'silent' || fault === 'stall') return LONG_FAULT_RATE;
  if (fault === 'drop5' && burstSec > 0) return LONG_FAULT_RATE;
  return FAULT_RATE;
}

/**
 * Verifies every connection-limit (`509` or `notice`) backoff interval on `own` against the 2 s, 4 s, 8 s, then 15 s
 * ladder, resetting the step counter after any request that was not limited. When `firstLimitWindowMs` is set, also
 * requires the first limit answer to complete within that window from `own[0].start`.
 */
export function judgeLimitBackoff(
  fault: '509' | 'notice',
  own: readonly FaultSpan[],
  failures: string[],
  warnings: string[],
  firstLimitWindowMs?: number,
): void {
  const isLimit =
    fault === '509'
      ? (e: FaultSpan) => e.status === 509
      : (e: FaultSpan) => e.status === 200 && e.bytes === NOTICE_BYTES;
  let seen = 0;
  let attempt = 0;
  let verified = 0;
  for (let i = 0; i < own.length; i += 1) {
    const current = own[i] as FaultSpan;
    if (!isLimit(current)) {
      attempt = 0;
      continue;
    }
    seen += 1;
    if (seen === 1 && firstLimitWindowMs !== undefined) {
      const first = own[0] as FaultSpan;
      if (current.end - first.start > firstLimitWindowMs) {
        failures.push(
          `${fault}: first limit answer took ${current.end - first.start} ms, limit ${firstLimitWindowMs} ms`,
        );
      }
    }
    const stepMs = LIMIT_BACKOFF_MS[Math.min(attempt, LIMIT_BACKOFF_MS.length - 1)] as number;
    attempt += 1;
    const nextReq = own[i + 1];
    if (nextReq === undefined) break;
    verified += 1;
    const gap = nextReq.start - current.end;
    if (gap < stepMs - CLOCK_ROUNDING_MS) {
      const label = seen === 1 ? `the ${fault}` : `${fault} ${seen}`;
      failures.push(
        `${fault}: next request came ${gap} ms after ${label}, before the ${stepMs} ms backoff`,
      );
    }
  }
  if (seen === 0) {
    failures.push(`${fault}: the simulator answered no ${fault}`);
  } else if (verified === 0) {
    warnings.push(`${fault}: no second request within the stay; the backoff was not verified`);
  }
}

/**
 * Judges one fault run against spec 7. The screen's `faultOutcome` must be the expected one (`missed` fails); the
 * windows come from the simulator log of the faulted channel: a dropped stream must be requested again within 10 s of
 * the drop, a stalled stream within `10 s + burstSec` of the first request without a limit answer, a 404 answered for
 * the last time within 10 s, and after every 509 or notice the screen must enter `limited` within 2,000 ms and wait
 * out the 2 s, 4 s, 8 s, then 15 s backoff ladder. A slow start (its answer held back 3 s, left by a zap after
 * 800 ms) needs the zap's frame, a request after the zap and no limit answer.
 */
export function judgeFault(
  fault: Fault,
  line: PlayerLine,
  entries: readonly SimLogEntry[],
  channel: string,
  burstSec = 0,
): Verdict {
  const failures: string[] = [];
  const warnings: string[] = [];
  const expected = FAULT_EXPECTED[fault];
  if (line.fault !== (fault as string)) {
    failures.push(`the screen ran fault "${line.fault}", expected "${fault}"`);
  }
  if (line.zaps < FAULT_ZAPS) {
    failures.push(`${fault}: the screen made ${line.zaps} zaps, requested ${FAULT_ZAPS}`);
  }
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
    judgeStall(own, entries, burstSec, failures, warnings);
  } else if (fault === 'slowstart') {
    judgeSlowStart(line, entries, channel, failures, warnings);
  } else if (fault === 'silent') {
    judgeSilent(own, entries, failures, warnings);
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
    if (line.limitedAfterMs !== null && line.limitedAfterMs > LIMITED_WITHIN_MS) {
      failures.push(
        `${fault}: the screen entered limited ${line.limitedAfterMs} ms after the tune, limit ${LIMITED_WITHIN_MS} ms`,
      );
    } else if (line.limitedAfterMs === null && line.faultOutcome === 'limited-backoff') {
      warnings.push(
        `${fault}: the screen reported no limitedAfterMs (an app build that predates it)`,
      );
    }
    judgeLimitBackoff(fault, own, failures, warnings);
  }
  return { failures, warnings };
}

function judgeStall(
  own: readonly FaultSpan[],
  entries: readonly SimLogEntry[],
  burstSec: number,
  failures: string[],
  warnings: string[],
): void {
  const first = own[0] as FaultSpan;
  const again = own[1];
  const limitMs = STALL_RECOVERY_MS + Math.max(0, burstSec) * 1000;
  if (again === undefined) failures.push('stall: no new request after the stall');
  else if (again.start - first.start > limitMs) {
    failures.push(
      `stall: the new request came ${again.start - first.start} ms after the first request, limit ${limitMs} ms`,
    );
  }
  const { limitResponses, overlapMs } = connectionStats(entries, ACCOUNT);
  if (limitResponses > 0) {
    failures.push(
      `stall: ${limitResponses} limit responses on ${ACCOUNT}: the stalled request stayed open beside the new one`,
    );
  }
  if (overlapMs > 0) {
    warnings.push(`stall: two ${ACCOUNT} streams were open together for ${overlapMs} ms`);
  }
}

function judgeSilent(
  own: readonly FaultSpan[],
  entries: readonly SimLogEntry[],
  failures: string[],
  warnings: string[],
): void {
  const first = own[0] as FaultSpan;
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
  if (overlapMs > 0) {
    warnings.push(`silent: two ${ACCOUNT} streams were open together for ${overlapMs} ms`);
  }
}

function judgeSlowStart(
  line: PlayerLine,
  entries: readonly SimLogEntry[],
  channel: string,
  failures: string[],
  warnings: string[],
): void {
  if (line.zapMs.max === null) {
    failures.push('slowstart: the zap away from the slow channel showed no frame');
  }
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
  if (overlapMs > 0) {
    warnings.push(`slowstart: two ${ACCOUNT} streams were open together for ${overlapMs} ms`);
  }
}
