import type { AppI18n } from '@elv/i18n';

/** Milliseconds in a single calendar day. */
const DAY_MS = 86_400_000;

/** Lead window before expiry during which a source displays an expiring-soon warning (7 days). */
export const EXPIRING_SOON_WINDOW_MS = 7 * DAY_MS;

/** User-facing lifecycle warning resolved for a provider source account (`#170`). */
export type SourceAccountWarning =
  | { readonly kind: 'expired' }
  | { readonly kind: 'expiring-soon'; readonly days: number }
  | { readonly kind: 'trial' };

/** Non-warning account health summary shown on a quiet secondary caption line (Wave Q6). */
export interface SourceAccountHealth {
  readonly healthyExpiresAt?: number;
  readonly activeConnections?: number;
  readonly maxConnections?: number;
}

/** Minimal account lifecycle shape read from persisted non-secret source metadata. */
export interface SourceAccountMetaLike {
  readonly isTrial?: boolean;
  readonly expiresAt?: number;
  readonly maxConnections?: number;
  readonly activeConnections?: number;
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

/**
 * Resolves quiet non-warning account health metadata (healthy expiry date beyond the warning
 * window and provider connection quota) for display on a source card's secondary caption line.
 */
export function resolveSourceAccountHealth(
  meta: SourceAccountMetaLike | undefined,
  nowMs: number,
): SourceAccountHealth | null {
  if (meta === undefined) return null;
  const healthyExpiresAt =
    Number.isFinite(nowMs) &&
    nowMs >= 0 &&
    meta.expiresAt !== undefined &&
    Number.isFinite(meta.expiresAt) &&
    meta.expiresAt > 0 &&
    meta.expiresAt - nowMs > EXPIRING_SOON_WINDOW_MS
      ? meta.expiresAt
      : undefined;
  const maxConnections =
    typeof meta.maxConnections === 'number' &&
    Number.isFinite(meta.maxConnections) &&
    meta.maxConnections >= 1
      ? Math.floor(meta.maxConnections)
      : undefined;
  const activeConnections =
    maxConnections !== undefined &&
    typeof meta.activeConnections === 'number' &&
    Number.isFinite(meta.activeConnections) &&
    meta.activeConnections >= 0
      ? Math.floor(meta.activeConnections)
      : undefined;
  if (healthyExpiresAt === undefined && maxConnections === undefined) return null;
  return {
    ...(healthyExpiresAt !== undefined ? { healthyExpiresAt } : {}),
    ...(activeConnections !== undefined ? { activeConnections } : {}),
    ...(maxConnections !== undefined ? { maxConnections } : {}),
  };
}

/** Formats an account expiry epoch-ms timestamp into a concise locale-aware UTC calendar date. */
export function formatAccountExpiryDate(expiresAtMs: number, locale: string): string {
  const date = new Date(expiresAtMs);
  if (typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function') {
    try {
      return new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeZone: 'UTC',
      }).format(date);
    } catch {
      // Fallback below when runtime lacks full ICU locale data
    }
  }
  const y = String(date.getUTCFullYear()).padStart(4, '0');
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Formats the quiet secondary caption summarizing healthy account expiry and connection quota
 * (e.g. `Expires Jan 15, 2027 · 1/3 connections`), returning `null` when nothing applies.
 */
export function formatSourceAccountHealthCaption(
  meta: SourceAccountMetaLike | undefined,
  nowMs: number,
  i18n: AppI18n,
): string | null {
  const health = resolveSourceAccountHealth(meta, nowMs);
  if (health === null) return null;
  const parts: string[] = [];
  if (health.healthyExpiresAt !== undefined) {
    parts.push(
      i18n.t('sources.account.expiresOn', {
        date: formatAccountExpiryDate(health.healthyExpiresAt, i18n.locale),
      }),
    );
  }
  if (health.maxConnections !== undefined) {
    parts.push(
      health.activeConnections !== undefined
        ? i18n.t('sources.account.connectionsActive', {
            active: health.activeConnections,
            max: health.maxConnections,
          })
        : i18n.t('sources.account.connectionsMax', { max: health.maxConnections }),
    );
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}
