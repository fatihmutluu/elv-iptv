import * as nodeFs from 'node:fs';
import { dirname } from 'node:path';
import { redactUrls } from './player/mpv/redact.ts';

/** Default total on-disk cap across active (`elv-desktop.log`) and single backup (`elv-desktop.log.1`). */
export const DEFAULT_MAX_TOTAL_BYTES = 10 * 1024 * 1024;

/** Minimal synchronous filesystem surface used by {@link createDesktopLogger}. */
export interface DesktopLogFs {
  mkdirSync(dir: string, options: { recursive: true }): unknown;
  statSync(path: string): { size: number };
  appendFileSync(path: string, data: string, encoding: 'utf8'): void;
  writeFileSync(path: string, data: string, encoding: 'utf8'): void;
  renameSync(oldPath: string, newPath: string): void;
  rmSync(path: string, options?: { force?: boolean }): void;
}

/** Configuration for {@link createDesktopLogger}. */
export interface DesktopLoggerOptions {
  /** Absolute path to the active log file (backup is written to `<logPath>.1`). */
  logPath: string;
  /** Maximum combined UTF-8 bytes across active and backup files (default 10 MiB). */
  maxTotalBytes?: number;
  /** Optional filesystem override for tests. */
  fs?: DesktopLogFs;
  /** When true, also mirrors every redacted line to stderr. */
  mirrorStderr?: boolean;
  /** Optional stderr writer override for tests (defaults to `process.stderr.write`). */
  writeStderr?: (chunk: string) => void;
}

/** Bounded, URL-redacting rolling diagnostic logger for the Electron main process (`#269`). */
export interface DesktopLogger {
  log(line: string): void;
  readonly logPath: string;
  readonly backupPath: string;
}

function truncateUtf8Bytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  if (maxBytes <= 0) return '';
  let end = maxBytes;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return buf.subarray(0, end).toString('utf8');
}

function formatBoundedEntry(redactedLine: string, maxFileBytes: number): string {
  const normalized = redactedLine.endsWith('\n') ? redactedLine : `${redactedLine}\n`;
  if (Buffer.byteLength(normalized, 'utf8') <= maxFileBytes) return normalized;
  const body = normalized.slice(0, -1);
  const suffix = maxFileBytes >= 8 ? '...\n' : '\n';
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  return `${truncateUtf8Bytes(body, Math.max(0, maxFileBytes - suffixBytes))}${suffix}`;
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string'
    ? err.code
    : undefined;
}

/**
 * Creates a synchronous rolling logger that redacts URLs and credentials before writing anywhere,
 * rotates `<logPath>` into `<logPath>.1` at `maxTotalBytes / 2`, enforces a strict `<= maxTotalBytes`
 * disk ceiling (default 10 MiB), and degrades gracefully on Windows file-lock errors.
 */
export function createDesktopLogger(options: DesktopLoggerOptions): DesktopLogger {
  const { logPath } = options;
  const backupPath = `${logPath}.1`;
  const logDir = dirname(logPath);
  const fs = options.fs ?? nodeFs;
  const mirrorStderr = options.mirrorStderr ?? false;
  const writeStderr = options.writeStderr ?? ((chunk: string) => void process.stderr.write(chunk));
  const totalCap = Math.max(2, Math.floor(options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES));
  const maxFileBytes = Math.max(1, Math.floor(totalCap / 2));

  let dirReady = false;
  let backupChecked = false;

  const safeSize = (path: string): number => {
    try {
      return Math.max(0, fs.statSync(path).size);
    } catch {
      return 0;
    }
  };

  const ensureDir = (): void => {
    if (dirReady) return;
    try {
      fs.mkdirSync(logDir, { recursive: true });
      dirReady = true;
    } catch {
      // Directory creation may fail on locked/unwritable paths; append will hit fallback cleanly.
    }
  };

  const truncateActive = (): void => {
    try {
      fs.writeFileSync(logPath, '', 'utf8');
    } catch {
      // Best-effort truncate fallback when rename fails under Windows locks.
    }
  };

  const rotateFor = (currentSize: number): void => {
    if (currentSize > maxFileBytes) {
      truncateActive();
      return;
    }
    try {
      fs.rmSync(backupPath, { force: true });
    } catch {
      // Locked backup on Windows (EBUSY/EACCES): rename below will fail and fall back to truncate.
    }
    try {
      fs.renameSync(logPath, backupPath);
    } catch {
      truncateActive();
    }
  };

  const appendEntry = (entry: string): boolean => {
    try {
      fs.appendFileSync(logPath, entry, 'utf8');
      return true;
    } catch (err) {
      if (errorCode(err) === 'ENOENT') {
        dirReady = false;
        ensureDir();
        try {
          fs.appendFileSync(logPath, entry, 'utf8');
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
  };

  const emitStderr = (chunk: string): void => {
    try {
      writeStderr(chunk);
    } catch {
      // Never crash the app if stderr is closed.
    }
  };

  const log = (line: string): void => {
    const redacted = redactUrls(line);
    const entry = formatBoundedEntry(redacted, maxFileBytes);
    const entryBytes = Buffer.byteLength(entry, 'utf8');

    if (mirrorStderr) emitStderr(entry);

    ensureDir();

    if (!backupChecked) {
      backupChecked = true;
      if (safeSize(backupPath) > maxFileBytes) {
        try {
          fs.rmSync(backupPath, { force: true });
        } catch {
          // Ignore locked backup file; active cap still applies.
        }
      }
    }

    const currentSize = safeSize(logPath);
    if (currentSize > 0 && currentSize + entryBytes > maxFileBytes) {
      rotateFor(currentSize);
    }

    if (!appendEntry(entry) && !mirrorStderr) {
      emitStderr(entry);
    }
  };

  return { log, logPath, backupPath };
}
