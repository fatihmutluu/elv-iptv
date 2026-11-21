/** Milliseconds in a single calendar day. */
const DAY_MS = 86_400_000;

/** Lead window before expiry during which a source displays an expiring-soon warning (7 days). */
export const EXPIRING_SOON_WINDOW_MS = 7 * DAY_MS;

/** User-facing lifecycle warning resolved for a provider source account (`#170`). */
export type SourceAccountWarning =
  | { readonly kind: 'expired' }
  | { readonly kind: 'expiring-soon'; readonly days: number }
  | { readonly kind: 'trial' };

/** Minimal account lifecycle shape read from persisted non-secret source metadata. */
export interface SourceAccountMetaLike {
  readonly isTrial?: boolean;
  readonly expiresAt?: number;
}

/**
 * Resolves the highest-precedence account lifecycle warning for a source card:
 * 1. `expired` when `expiresAt` is finite and `<= nowMs`
 * 2. `expiring-soon` when `expiresAt` is finite and within {@link EXPIRING_SOON_WINDOW_MS}
 * 3. `trial` when `isTrial === true`
 * 4. `null` when healthy or metadata is absent.
 */
export function resolveSourceAccountWarning(
  meta: SourceAccountMetaLike | undefined,
  nowMs: number,
): SourceAccountWarning | null {
  if (meta === undefined) return null;
  if (
    Number.isFinite(nowMs) &&
    nowMs >= 0 &&
    meta.expiresAt !== undefined &&
    Number.isFinite(meta.expiresAt)
  ) {
    const remainingMs = meta.expiresAt - nowMs;
    if (remainingMs <= 0) {
      return { kind: 'expired' };
    }
    if (remainingMs <= EXPIRING_SOON_WINDOW_MS) {
      return {
        kind: 'expiring-soon',
        days: Math.max(1, Math.ceil(remainingMs / DAY_MS)),
      };
    }
  }
  if (meta.isTrial === true) {
    return { kind: 'trial' };
  }
  return null;
}
