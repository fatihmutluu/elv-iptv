import { crashFailures } from './player-judge.ts';

interface CorpusFailure {
  id: string;
  label: string;
  reason: string;
}

/** Items in the format corpus sweep; every manifest and report must agree on it. */
export const CORPUS_ITEM_COUNT = 29;

/** Parsed payload of `ELV_GATE_CORPUS {json}`. */
export interface CorpusLine {
  total: number;
  passed: number;
  failed: CorpusFailure[];
  surfaceCreated: number;
  staleEventsApplied: number;
  /** mpv processes started; desktop only. */
  mpvSpawns?: number;
  /** The sampled player area showed video (`null`: not measured); desktop only. */
  videoVisible?: boolean | null;
}

/** Verdict of a corpus gate run. */
export interface CorpusVerdict {
  ok: boolean;
  failures: string[];
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

function readDesktopExtras(
  v: Record<string, unknown>,
): Pick<CorpusLine, 'mpvSpawns' | 'videoVisible'> | undefined {
  const extras: Pick<CorpusLine, 'mpvSpawns' | 'videoVisible'> = {};
  if (v.mpvSpawns !== undefined) {
    if (!isCount(v.mpvSpawns)) return undefined;
    extras.mpvSpawns = v.mpvSpawns;
  }
  if (v.videoVisible !== undefined) {
    if (v.videoVisible !== null && typeof v.videoVisible !== 'boolean') return undefined;
    extras.videoVisible = v.videoVisible;
  }
  return extras;
}

function readCorpus(value: unknown): CorpusLine | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (
    !isCount(v.total) ||
    !isCount(v.passed) ||
    !isCount(v.surfaceCreated) ||
    !isCount(v.staleEventsApplied) ||
    !Array.isArray(v.failed)
  ) {
    return undefined;
  }
  const extras = readDesktopExtras(v);
  if (extras === undefined) return undefined;
  const failed: CorpusFailure[] = [];
  for (const item of v.failed) {
    if (typeof item !== 'object' || item === null) return undefined;
    const e = item as Record<string, unknown>;
    if (typeof e.id !== 'string' || typeof e.label !== 'string' || typeof e.reason !== 'string') {
      return undefined;
    }
    failed.push({ id: e.id, label: e.label, reason: e.reason });
  }
  return {
    total: v.total,
    passed: v.passed,
    failed,
    surfaceCreated: v.surfaceCreated,
    staleEventsApplied: v.staleEventsApplied,
    ...extras,
  };
}

/** The last well-formed `ELV_GATE_CORPUS {json}` line in a log dump, or undefined when there is none. */
export function parseCorpusLine(log: string): CorpusLine | undefined {
  let found: CorpusLine | undefined;
  const tag = 'ELV_GATE_CORPUS {';
  for (const line of log.split(/\r?\n/)) {
    const at = line.indexOf(tag);
    const end = line.lastIndexOf('}');
    if (at < 0 || end < at) continue;
    try {
      const parsed: unknown = JSON.parse(line.slice(at + tag.length - 1, end + 1));
      found = readCorpus(parsed) ?? found;
    } catch {
      // ignore truncated or foreign lines
    }
  }
  return found;
}

/** Judges the corpus report line, simulator connection stats, and crash reports. */
export function judgeCorpus(
  line: CorpusLine,
  connections: { limitResponses: number; overlapMs: number },
  crashes: readonly string[] = [],
): CorpusVerdict {
  const failures = line.failed.map((f) => `${f.id} (${f.label}): ${f.reason}`);
  if (line.total !== CORPUS_ITEM_COUNT) {
    failures.push(`corpus: total ${line.total} (expected ${CORPUS_ITEM_COUNT})`);
  }
  if (line.passed + line.failed.length !== line.total) {
    failures.push(
      `corpus: passed (${line.passed}) + failed (${line.failed.length}) != total (${line.total})`,
    );
  }
  if (line.surfaceCreated !== 1) {
    failures.push(`surfaceCreated: ${line.surfaceCreated} (expected 1)`);
  }
  if (line.staleEventsApplied > 0) {
    failures.push(`staleEventsApplied: ${line.staleEventsApplied} (expected 0)`);
  }
  if (connections.limitResponses > 0) {
    failures.push(`limitResponses: ${connections.limitResponses} (expected 0)`);
  }
  if (connections.overlapMs !== 0) {
    failures.push(`overlapMs: ${connections.overlapMs} (expected 0)`);
  }
  if (line.mpvSpawns !== undefined && line.mpvSpawns !== 1) {
    failures.push(`mpvSpawns: ${line.mpvSpawns} (expected 1)`);
  }
  if (line.videoVisible === false) {
    failures.push('videoVisible: false (the player area showed no video)');
  }
  failures.push(...crashFailures(crashes));
  return { ok: failures.length === 0, failures };
}
