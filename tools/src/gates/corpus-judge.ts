import { crashFailures } from './player-judge.ts';

interface CorpusFailure {
  id: string;
  label: string;
  reason: string;
}

/** Parsed payload of `ELV_GATE_CORPUS {json}`. */
export interface CorpusLine {
  total: number;
  passed: number;
  failed: CorpusFailure[];
  surfaceCreated: number;
  staleEventsApplied: number;
}

/** Verdict of a corpus gate run. */
export interface CorpusVerdict {
  ok: boolean;
  failures: string[];
}

function readCorpus(value: unknown): CorpusLine | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (
    typeof v.total !== 'number' ||
    !Number.isInteger(v.total) ||
    v.total < 0 ||
    typeof v.passed !== 'number' ||
    !Number.isInteger(v.passed) ||
    v.passed < 0 ||
    typeof v.surfaceCreated !== 'number' ||
    typeof v.staleEventsApplied !== 'number' ||
    !Array.isArray(v.failed)
  ) {
    return undefined;
  }
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
  if (line.total === 0) failures.push('corpus: 0 items ran');
  if (line.passed + line.failed.length !== line.total) {
    failures.push(
      `corpus: passed (${line.passed}) + failed (${line.failed.length}) != total (${line.total})`,
    );
  }
  if (line.staleEventsApplied > 0) {
    failures.push(`staleEventsApplied: ${line.staleEventsApplied} (expected 0)`);
  }
  if (connections.limitResponses > 0) {
    failures.push(`limitResponses: ${connections.limitResponses} (expected 0)`);
  }
  failures.push(...crashFailures(crashes));
  return { ok: failures.length === 0, failures };
}
