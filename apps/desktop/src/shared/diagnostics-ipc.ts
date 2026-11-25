/** IPC channels exposed by main for opt-in redacted diagnostics & crash report export (`#226`). */
export const DIAGNOSTICS_CHANNELS = Object.freeze({
  readLogTail: 'diagnostics:readLogTail',
  exportReport: 'diagnostics:exportReport',
  copyText: 'diagnostics:copyText',
} as const);

/** Maximum number of redacted log lines returned across IPC (`#226`). */
export const MAX_DIAGNOSTIC_LOG_LINES = 250;

/** Maximum UTF-8 byte size accepted for diagnostic Markdown export or copy (512 KiB, `#226`). */
export const MAX_DIAGNOSTIC_REPORT_BYTES = 512 * 1024;

/** Default filename presented in Electron's native save dialog (`#226`). */
export const DEFAULT_DIAGNOSTIC_REPORT_FILENAME = 'elv-iptv-diagnostic-report.md';

/** Request payload for `diagnostics:exportReport` (`#226`). Never carries a file path. */
export interface ExportDiagnosticReportRequest {
  readonly markdown: string;
}

/** Reply payload from `diagnostics:exportReport` (`#226`). Never leaks the chosen host path. */
export interface ExportDiagnosticReportReply {
  readonly saved: boolean;
}

/** Request payload for `diagnostics:copyText` (`#226`). */
export interface CopyDiagnosticTextRequest {
  readonly text: string;
}

/** Frozen `window.elv.diagnostics` bridge exposed by the sandboxed Electron preload (`#226`). */
export interface DiagnosticsBridge {
  readLogTail(maxLines?: number): Promise<string[]>;
  exportReport(markdown: string): Promise<ExportDiagnosticReportReply>;
  copyReport(text: string): Promise<boolean>;
}

const utf8Encoder = new TextEncoder();

const isSafeRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' &&
  x !== null &&
  !Array.isArray(x) &&
  !Object.hasOwn(x, '__proto__') &&
  !Object.hasOwn(x, 'constructor') &&
  !Object.hasOwn(x, 'prototype');

const hasSingleKey = (x: Record<string, unknown>, key: string): boolean => {
  const keys = Object.keys(x);
  return keys.length === 1 && keys[0] === key;
};

const isBoundedNonEmptyText = (x: unknown, maxBytes: number): x is string => {
  if (typeof x !== 'string' || x.trim().length === 0) return false;
  if (x.length > maxBytes) return false;
  return utf8Encoder.encode(x).byteLength <= maxBytes;
};

/**
 * Validates and clamps `maxLines` for `diagnostics:readLogTail` (`undefined` -> `250`, finite
 * numbers clamped to `1..250`, any non-number/NaN/Infinity -> `null`).
 */
export function parseReadLogTailMaxLines(raw: unknown): number | null {
  if (raw === undefined) return MAX_DIAGNOSTIC_LOG_LINES;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return Math.min(MAX_DIAGNOSTIC_LOG_LINES, Math.max(1, Math.floor(raw)));
}

/** Validates a `{ markdown }` payload for `diagnostics:exportReport` (`<= 512 KiB`, no extra keys). */
export function isExportDiagnosticReportRequest(x: unknown): x is ExportDiagnosticReportRequest {
  return (
    isSafeRecord(x) &&
    hasSingleKey(x, 'markdown') &&
    isBoundedNonEmptyText(x['markdown'], MAX_DIAGNOSTIC_REPORT_BYTES)
  );
}

/** Validates a `{ saved: boolean }` reply from `diagnostics:exportReport`. */
export function isExportDiagnosticReportReply(x: unknown): x is ExportDiagnosticReportReply {
  return isSafeRecord(x) && hasSingleKey(x, 'saved') && typeof x['saved'] === 'boolean';
}

/** Validates a `{ text }` payload for `diagnostics:copyText` (`<= 512 KiB`, no extra keys). */
export function isCopyDiagnosticTextRequest(x: unknown): x is CopyDiagnosticTextRequest {
  return (
    isSafeRecord(x) &&
    hasSingleKey(x, 'text') &&
    isBoundedNonEmptyText(x['text'], MAX_DIAGNOSTIC_REPORT_BYTES)
  );
}

/** Validates a `string[]` reply from `diagnostics:readLogTail`. */
export function isReadLogTailReply(x: unknown): x is string[] {
  return (
    Array.isArray(x) &&
    x.length <= MAX_DIAGNOSTIC_LOG_LINES &&
    x.every((item) => typeof item === 'string')
  );
}
