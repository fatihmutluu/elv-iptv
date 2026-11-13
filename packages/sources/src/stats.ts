/** A non-fatal problem found while scanning; `line` is 1-based. */
export interface ScanWarning {
  code: string;
  line: number;
}

/** Counters and capped warnings that every scanner reports. */
export interface ScanStats {
  lines: number;
  entries: number;
  skipped: number;
  warnings: ScanWarning[];
}

/** Number of warnings a scan keeps. */
export const MAX_WARNINGS = 100;

/** Creates zeroed statistics. */
export function createStats(): ScanStats {
  return { lines: 0, entries: 0, skipped: 0, warnings: [] };
}

/** Records a warning; only the first 100 are kept so hostile input cannot grow memory. */
export function warn(stats: ScanStats, code: string, line: number): void {
  if (stats.warnings.length < MAX_WARNINGS) stats.warnings.push({ code, line });
}
