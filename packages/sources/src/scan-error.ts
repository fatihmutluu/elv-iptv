import { type ElvError, type ErrorCategory, elvError } from '@elv/domain';

const CATEGORIES: readonly string[] = ['network', 'auth', 'source-format', 'playback', 'storage'];

/**
 * Converts anything thrown by an input iterable into an {@link ElvError}: ElvError-shaped values keep their
 * `category`, `code` and `detail`, an `AbortError` becomes `network` / `aborted`, everything else
 * `network` / `stream-failed`.
 */
export function toElvError(e: unknown): ElvError {
  const c = e as { category?: unknown; code?: unknown; detail?: unknown; name?: unknown } | null;
  if (
    c &&
    typeof c.code === 'string' &&
    typeof c.category === 'string' &&
    CATEGORIES.includes(c.category)
  ) {
    return elvError(
      c.category as ErrorCategory,
      c.code,
      typeof c.detail === 'string' ? c.detail : undefined,
    );
  }
  if (c && c.name === 'AbortError') return elvError('network', 'aborted');
  return elvError('network', 'stream-failed');
}
