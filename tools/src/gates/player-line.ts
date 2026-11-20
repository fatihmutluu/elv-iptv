/** The simulator account every player gate run uses (one connection allowed). */
export const ACCOUNT = 'demo';

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
  /** Tune start to the first `limited` status on the faulted dwell; `null` outside limit runs or on older builds. */
  limitedAfterMs: Nullable;
  zaps: number;
  /** Null outside soak runs, and for app builds that predate them. */
  soak: SoakBlock | null;
  /** `other` for app builds that predate the field. */
  final: FinalStatus;
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
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const FINALS: ReadonlySet<unknown> = new Set(['playing', 'failed', 'limited', 'other']);

function readSoak(value: unknown): SoakBlock | null | undefined {
  if (value === undefined || value === null) return null;
  const s = obj(value);
  if (s === undefined || typeof s.ended !== 'boolean' || !isNullable(s.durationMs)) {
    return undefined;
  }
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
  const limitedAfterMs = v.limitedAfterMs ?? null;
  if (
    soak === undefined ||
    !FINALS.has(final) ||
    (limitedAfterMs !== null && (!isNumber(limitedAfterMs) || limitedAfterMs < 0))
  ) {
    return undefined;
  }
  return {
    ...(v as unknown as PlayerLine),
    soak,
    final: final as FinalStatus,
    limitedAfterMs,
  };
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

/** One failure naming the crash reports a run left, or none. */
export function crashFailures(crashes: readonly string[]): string[] {
  return crashes.length === 0 ? [] : [`crash reports newer than the run: ${crashes.join(', ')}`];
}
