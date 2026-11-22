import type { ElvError, HttpClient } from '@elv/domain';
import { hasExplicitScheme, normalizeXtreamHostKey, resolveXtreamBaseUrl } from './xtream-scheme';

const DEFAULT_COOLDOWN_429_MS = 60_000;
const MIN_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 600_000;
const INT_SECONDS_RE = /^\d+$/;
const HTTP_5XX_RE = /^http-5\d\d$/;
const HTTP_4XX_RE = /^http-4\d\d$/;

/** Per-HttpClient account-scoped 429 cooldown deadlines keyed by `${username}\0${password}`. */
const COOLDOWNS_BY_CLIENT = new WeakMap<HttpClient, Map<string, number>>();

/** Returns an opaque internal account key; never logged, surfaced, or returned. */
export function accountCooldownKey(username: string, password: string): string {
  return `${username}\0${password}`;
}

/** Checks whether the account is currently under an active HTTP 429 cooldown. */
export function isAccountCoolingDown(http: HttpClient, accountKey: string, nowMs: number): boolean {
  const map = COOLDOWNS_BY_CLIENT.get(http);
  if (map === undefined) return false;
  const until = map.get(accountKey);
  if (until === undefined) return false;
  if (nowMs < until) return true;
  map.delete(accountKey);
  return false;
}

/** Parses `Retry-After` (integer seconds or HTTP-date) clamped to `[1_000, 600_000]`, else `fallbackMs`. */
export function parseRetryAfterMs(
  headers: Readonly<Record<string, string>> | undefined,
  fallbackMs: number | undefined,
): number {
  const fallback = Math.max(0, fallbackMs ?? DEFAULT_COOLDOWN_429_MS);
  if (headers === undefined) return fallback;
  let raw: string | undefined;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'retry-after') {
      raw = v;
      break;
    }
  }
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fallback;
  if (INT_SECONDS_RE.test(trimmed)) {
    const ms = Number(trimmed) * 1000;
    if (Number.isFinite(ms)) {
      return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, ms));
    }
  }
  const targetEpoch = Date.parse(trimmed);
  if (Number.isFinite(targetEpoch)) {
    const delta = targetEpoch - Date.now();
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, delta));
  }
  return fallback;
}

/** Records an account-scoped HTTP 429 cooldown deadline for `http`. */
export function recordAccountCooldown(
  http: HttpClient,
  accountKey: string,
  nowMs: number,
  durationMs: number,
): void {
  if (durationMs <= 0) return;
  let map = COOLDOWNS_BY_CLIENT.get(http);
  if (map === undefined) {
    map = new Map<string, number>();
    COOLDOWNS_BY_CLIENT.set(http, map);
  }
  const deadline = nowMs + durationMs;
  const existing = map.get(accountKey);
  if (existing === undefined || deadline > existing) {
    map.set(accountKey, deadline);
  }
}

/** Normalized server slot retaining whether the caller supplied an explicit scheme. */
export interface XtreamServerEntry {
  readonly raw: string;
  readonly hostKey: string;
  readonly explicitScheme: boolean;
}

/** Deduplicates `[primary, ...backupServers]` while preserving explicit schemes and scheme-less probing. */
export function buildServerEntries(
  primaryRaw: string,
  backups: readonly string[] | undefined,
): XtreamServerEntry[] {
  const primaryTrimmed = primaryRaw.trim();
  const primaryExplicit = hasExplicitScheme(primaryTrimmed);
  const primaryExplicitScheme = primaryExplicit
    ? primaryTrimmed.slice(0, primaryTrimmed.indexOf('://') + 3).toLowerCase()
    : undefined;

  const toEntry = (raw: string, isPrimary: boolean): XtreamServerEntry => {
    const trimmed = raw.trim();
    if (hasExplicitScheme(trimmed)) {
      return {
        raw: resolveXtreamBaseUrl(trimmed),
        hostKey: normalizeXtreamHostKey(trimmed),
        explicitScheme: true,
      };
    }
    if (!isPrimary && primaryExplicitScheme !== undefined) {
      const inherited = `${primaryExplicitScheme}${trimmed}`;
      return {
        raw: resolveXtreamBaseUrl(inherited),
        hostKey: normalizeXtreamHostKey(trimmed),
        explicitScheme: true,
      };
    }
    return {
      raw: trimmed,
      hostKey: normalizeXtreamHostKey(trimmed),
      explicitScheme: false,
    };
  };

  const dedupKey = (entry: XtreamServerEntry): string =>
    entry.explicitScheme ? entry.raw : resolveXtreamBaseUrl(entry.raw);

  const primaryEntry = toEntry(primaryTrimmed, true);
  const out: XtreamServerEntry[] = [primaryEntry];
  const seen = new Set<string>([dedupKey(primaryEntry)]);

  if (backups === undefined) return out;
  for (const raw of backups) {
    if (raw.trim().length === 0) continue;
    const entry = toEntry(raw, false);
    const key = dedupKey(entry);
    if (key.length > 0 && !seen.has(key)) {
      seen.add(key);
      out.push(entry);
    }
  }
  return out;
}

/**
 * Computes the ordered server indices to try for one request:
 * - On primary (`activeIndex === 0`): `[0, 1, ..., n-1]`.
 * - On backup with primary cooldown elapsed: `[0, activeIndex, ...rest]` (probes primary for promotion).
 * - On backup during cooldown: `[activeIndex, ...otherBackups, 0]` (avoids probing dead primary unless all backups fail).
 */
export function buildAttemptOrder(
  serverCount: number,
  activeIndex: number,
  probePrimary: boolean,
): number[] {
  if (serverCount <= 1) return [0];
  const order: number[] = [];
  const push = (idx: number) => {
    if (!order.includes(idx)) order.push(idx);
  };
  if (activeIndex === 0) {
    for (let i = 0; i < serverCount; i++) push(i);
    return order;
  }
  if (probePrimary) {
    push(0);
    push(activeIndex);
    for (let i = 1; i < serverCount; i++) push(i);
    return order;
  }
  push(activeIndex);
  for (let i = 1; i < serverCount; i++) push(i);
  push(0);
  return order;
}

/** True when an error warrants failing over to the next mirror (network/5xx only; never 429, 4xx, auth, or abort). */
export function isFailoverEligible(error: ElvError): boolean {
  if (error.category !== 'network') return false;
  if (error.code === 'aborted' || error.code === 'http-429') return false;
  if (HTTP_4XX_RE.test(error.code)) return false;
  if (HTTP_5XX_RE.test(error.code)) return true;
  return true;
}
