const DEFAULT_WINDOW_MS = 220;

/** Configuration for {@link createSelectDebounceGuard}. */
export interface SelectDebounceGuardOptions {
  /** Suppression window in milliseconds; values `<= 0` disable debouncing. Defaults to `220`. */
  windowMs?: number;
}

/** Pure timestamp-based guard that suppresses duplicate Select bursts for the same key. */
export interface SelectDebounceGuard {
  /**
   * Returns `true` when a Select at `nowMs` for `key` (default `''`) should proceed, or `false`
   * when it falls within `windowMs` of the previous allowed Select for the same key.
   */
  allow(nowMs: number, key?: string): boolean;
  /** Clears recorded state so the next Select is allowed immediately. */
  reset(): void;
}

/**
 * Creates a pure debounce guard for duplicate Select bursts.
 * Time always comes from the caller; no wall clock is read internally.
 */
export function createSelectDebounceGuard(opts?: SelectDebounceGuardOptions): SelectDebounceGuard {
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
  const disabled = !Number.isFinite(windowMs) || windowMs <= 0;
  let lastAt: number | undefined;
  let lastKey: string | undefined;

  function reset(): void {
    lastAt = undefined;
    lastKey = undefined;
  }

  function allow(nowMs: number, key = ''): boolean {
    if (disabled) return true;
    if (!Number.isFinite(nowMs)) {
      reset();
      return true;
    }
    if (lastAt === undefined || key !== lastKey || nowMs < lastAt || nowMs - lastAt >= windowMs) {
      lastAt = nowMs;
      lastKey = key;
      return true;
    }
    return false;
  }

  return { allow, reset };
}
