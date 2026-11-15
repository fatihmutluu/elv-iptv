/** Subset of a stream simulator `/_sim/requests` log entry needed to count concurrent streams. */
export interface SimMediaEntry {
  t: string;
  ms: number;
  path: string;
  account?: string | null;
  status?: number;
}

const LIVE_TS_PATH = /^\/live\/([^/]+)\/[^/]+\/\d+(?:\.ts)?$/;

function matchesAccountTs(entry: SimMediaEntry, account: string): boolean {
  if (entry.status !== undefined && (entry.status < 200 || entry.status >= 300)) return false;
  const match = LIVE_TS_PATH.exec(entry.path);
  if (match === null) return false;
  const entryAccount = entry.account ?? match[1];
  return entryAccount === account;
}

/**
 * Peak count of `account`'s live MPEG-TS stream requests open at the same time in `entries`.
 * `entry.t` is the ISO timestamp when the response finished (`start = Date.parse(t) - ms`).
 */
export function maxOpenMedias(entries: readonly SimMediaEntry[], account: string): number {
  const points: { time: number; delta: 1 | -1 }[] = [];
  for (const entry of entries) {
    if (!matchesAccountTs(entry, account)) continue;
    const end = Date.parse(entry.t);
    if (!Number.isFinite(end)) continue;
    const duration = Math.max(0, entry.ms);
    const start = end - duration;
    points.push({ time: start, delta: 1 });
    points.push({ time: duration === 0 ? end + 0.5 : end, delta: -1 });
  }
  points.sort((a, b) => (a.time !== b.time ? a.time - b.time : a.delta - b.delta));

  let open = 0;
  let peak = 0;
  for (const point of points) {
    open += point.delta;
    if (open > peak) peak = open;
  }
  return peak;
}
