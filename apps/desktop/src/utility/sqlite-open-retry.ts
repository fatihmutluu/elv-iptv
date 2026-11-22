import type { Result } from '@elv/domain';

const DEFAULT_OPEN_MAX_ATTEMPTS = 3;
const DEFAULT_OPEN_BACKOFF_MS: readonly number[] = [100, 250];
const TRANSIENT_SQLITE_LOCK_RE = /sqlite_busy|sqlite_locked|database(?:\s+table)?\s+is\s+locked/i;

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

/** Formats a thrown SQLite error while preserving its `code` (e.g. `SQLITE_BUSY`) for retry classification. */
export function formatSqliteOpenError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const msg = error instanceof Error ? error.message : 'open failed';
  if (typeof code === 'string' && code.length > 0 && !msg.includes(code)) {
    return `${code}: ${msg}`;
  }
  return msg;
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
