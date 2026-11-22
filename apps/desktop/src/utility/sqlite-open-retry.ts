import { type Result, redactText } from '@elv/domain';

const DEFAULT_OPEN_MAX_ATTEMPTS = 3;
const DEFAULT_OPEN_BACKOFF_MS: readonly number[] = [100, 250];
const TRANSIENT_SQLITE_LOCK_RE = /sqlite_busy|sqlite_locked|database(?:\s+table)?\s+is\s+locked/i;
const QUOTED_WIN_PATH_RE = /(['"])(?:[A-Za-z]:[\\/]|\\\\)[^'"]+\1/g;
const QUOTED_POSIX_PATH_RE =
  /(['"])\/(?:Users|home|var|tmp|private|etc|opt|mnt|media|run|srv|root|Volumes|Library|Applications|data|storage)(?:\/[^'"]*)?\1/g;
const WIN_DRIVE_PATH_RE =
  /(?<![A-Za-z0-9_])[A-Za-z]:[\\/](?:[^'"<>|\r\n\\/:]+[\\/])*[^\s'"<>|,;)\r\n]+/g;
const WIN_UNC_PATH_RE = /\\\\[^\s'"<>|\\/:]+\\(?:[^'"<>|\r\n\\/:]+[\\/])*[^\s'"<>|,;)\r\n]+/g;
const POSIX_KNOWN_SPACED_PATH_RE =
  /(^|[\s'"(=,:])\/(?:Users|home|var|tmp|private|Volumes|Library|Applications)\/(?:[^'"<>|\r\n/:]+\/)*[^\s'"<>|,;)\r\n]+/g;
const POSIX_ABS_PATH_RE = /(^|[\s'"(=,:])\/(?:[^\s'"<>|,;):/]+\/)+[^\s'"<>|,;)]*/g;

function sanitizeSqliteErrorDetail(text: string): string {
  return redactText(text)
    .replace(QUOTED_WIN_PATH_RE, '$1<path>$1')
    .replace(QUOTED_POSIX_PATH_RE, '$1<path>$1')
    .replace(WIN_UNC_PATH_RE, '<path>')
    .replace(WIN_DRIVE_PATH_RE, '<path>')
    .replace(POSIX_KNOWN_SPACED_PATH_RE, '$1<path>')
    .replace(POSIX_ABS_PATH_RE, '$1<path>');
}

/** Options for {@link openSqliteWithRetry}. */
export interface SqliteOpenRetryOptions {
  maxAttempts?: number;
  backoffMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

/** Whether an error message or code indicates a transient SQLite busy/locked open failure (`#138`). */
function isTransientSqliteBusyError(error: unknown): boolean {
  if (typeof error === 'string') return TRANSIENT_SQLITE_LOCK_RE.test(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && TRANSIENT_SQLITE_LOCK_RE.test(code)) return true;
  const msg = error instanceof Error ? error.message : String(error);
  return TRANSIENT_SQLITE_LOCK_RE.test(msg);
}

/**
 * Formats a thrown SQLite error while preserving its `code` (e.g. `SQLITE_BUSY`) for retry
 * classification and redacting local filesystem paths and URLs before surfacing in `ElvError.detail`.
 */
export function formatSqliteOpenError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const msg = error instanceof Error ? error.message : 'open failed';
  const combined =
    typeof code === 'string' && code.length > 0 && !msg.includes(code) ? `${code}: ${msg}` : msg;
  return sanitizeSqliteErrorDetail(combined);
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries a SQLite open attempt up to `maxAttempts` (default 3) with bounded backoff (`[100, 250]` ms)
 * only when the attempt returns `storage/migration-failed` caused by transient `SQLITE_BUSY` / `SQLITE_LOCKED`.
 */
export async function openSqliteWithRetry<T>(
  attemptOpen: () => Promise<Result<T>>,
  opts?: SqliteOpenRetryOptions,
): Promise<Result<T>> {
  const maxAttempts = Math.max(1, opts?.maxAttempts ?? DEFAULT_OPEN_MAX_ATTEMPTS);
  const backoffMs = opts?.backoffMs ?? DEFAULT_OPEN_BACKOFF_MS;
  const sleep = opts?.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt += 1) {
    const res = await attemptOpen();
    if (res.ok) return res;
    const retryable =
      res.error.code === 'migration-failed' && isTransientSqliteBusyError(res.error.detail);
    if (!retryable || attempt + 1 >= maxAttempts) return res;
    const delay = backoffMs[attempt] ?? backoffMs[backoffMs.length - 1] ?? 250;
    await sleep(delay);
  }
}
