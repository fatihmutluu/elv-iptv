import type { LogEntry } from '../sim/log.ts';

/** The fields of a simulator request log entry the player gate reads. */
export type SimLogEntry = Pick<
  LogEntry,
  't' | 'path' | 'query' | 'status' | 'bytes' | 'ms' | 'account' | 'streamId'
>;

/** Reads and clears the simulator's request log. */
export interface SimLog {
  clear(): Promise<void>;
  entries(): Promise<SimLogEntry[]>;
}

/** Body of the simulator's connection-limit notice (HTTP 200); no media stream is this short. */
const NOTICE_BYTES = 'Max connections reached'.length;
/** Paths of media stream requests that carry an MPEG-TS body. */
export const STREAM_PATH = /^\/(?:live|movie|series|timeshift)\/.+\.ts$/;

/** The simulator's request log over HTTP, for a simulator reachable at `base`. */
export function httpSimLog(base: string): SimLog {
  const url = `${base}/_sim/requests`;
  return {
    async clear() {
      const response = await fetch(url, { method: 'DELETE' });
      if (!response.ok)
        throw new Error(`gate: clearing the simulator log failed (${response.status})`);
    },
    async entries() {
      const response = await fetch(url);
      if (!response.ok)
        throw new Error(`gate: reading the simulator log failed (${response.status})`);
      return (await response.json()) as SimLogEntry[];
    },
  };
}

/** Start and end of a logged request in epoch milliseconds (`t` is the time the response ended). */
export function span(entry: SimLogEntry): { start: number; end: number } {
  const end = Date.parse(entry.t);
  return { start: end - entry.ms, end };
}

const isNotice = (entry: SimLogEntry): boolean =>
  entry.status === 200 && entry.bytes === NOTICE_BYTES;

/** Whether the request's own `?fault=` produced this answer (`status=509`, `status=429` or `text-notice`). */
function forcedByFault(entry: SimLogEntry): boolean {
  const parts = (entry.query.fault ?? '').split(',');
  return isNotice(entry) ? parts.includes('text-notice') : parts.includes(`status=${entry.status}`);
}

const isLimit = (entry: SimLogEntry): boolean =>
  (entry.status === 509 || entry.status === 429 || isNotice(entry)) && !forcedByFault(entry);

/**
 * Connection-limit answers and stream overlap of one account. `limitResponses` counts the 509, 429 and notice answers
 * the account got, except an answer its request's own `?fault=` forced (a `status=509` fault answering 509 is not a
 * limit; a slow-start request answered 509 because another one was open is). `overlapMs` sums, over every pair of
 * TS stream requests of the account, whatever their answer, the time both were open. Entries without the account
 * (HLS segments, other accounts) are ignored.
 */
export function connectionStats(
  entries: readonly SimLogEntry[],
  account: string,
): { limitResponses: number; overlapMs: number } {
  const own = entries.filter((e) => e.account === account);
  const limitResponses = own.filter(isLimit).length;
  const spans = own
    .filter((e) => STREAM_PATH.test(e.path))
    .map(span)
    .sort((a, b) => a.start - b.start);
  let overlapMs = 0;
  for (let i = 0; i < spans.length; i++) {
    const a = spans[i] as { start: number; end: number };
    for (let j = i + 1; j < spans.length; j++) {
      const b = spans[j] as { start: number; end: number };
      if (b.start >= a.end) break;
      overlapMs += Math.min(a.end, b.end) - b.start;
    }
  }
  return { limitResponses, overlapMs };
}
