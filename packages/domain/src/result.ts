/** Coarse failure classes shared by every layer; UI copy is chosen from the category. */
export type ErrorCategory = 'network' | 'auth' | 'source-format' | 'playback' | 'storage';

/** A typed, secret-free failure. `detail` must never contain URLs with credentials. */
export interface ElvError {
  category: ErrorCategory;
  code: string;
  detail?: string;
}

/** Success or failure without exceptions. */
export type Result<T, E = ElvError> = { ok: true; value: T } | { ok: false; error: E };

/** Wraps a success value. */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Wraps a failure. */
export function err<E = ElvError>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Builds an {@link ElvError}, leaving `detail` out when it is undefined. */
export function elvError(category: ErrorCategory, code: string, detail?: string): ElvError {
  return detail === undefined ? { category, code } : { category, code, detail };
}
