import type { ElvError, HttpClient } from '@elv/domain';

/** Supported transport schemes for Xtream Codes servers. */
export type XtreamScheme = 'https' | 'http';

const EXPLICIT_SCHEME_RE = /^https?:\/\//i;
const HTTP_STATUS_CODE_RE = /^http-\d{3}$/;

/** Per-`HttpClient` session cache of resolved schemes keyed by normalized `host[:port]`. */
const SCHEMES_BY_CLIENT = new WeakMap<HttpClient, Map<string, XtreamScheme>>();

/** Returns `true` when `input` starts with an explicit `http://` or `https://` scheme. */
export function hasExplicitScheme(input: string): boolean {
  return EXPLICIT_SCHEME_RE.test(input.trim());
}

/** Strips query, fragment, trailing slashes, and trailing Xtream `.php` endpoints from a URL. */
export function stripXtreamTail(url: string): string {
  return url
    .replace(/[?#].*$/s, '')
    .replace(/\/+$/, '')
    .replace(/\/(?:player_api|panel_api|get|xmltv)\.php$/i, '')
    .replace(/\/+$/, '');
}

/** Normalizes a host, `host:port`, or full URL into a canonical lowercase `host[:port]` key. */
export function normalizeXtreamHostKey(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) return '';
  const withoutScheme = trimmed.replace(EXPLICIT_SCHEME_RE, '');
  let end = withoutScheme.length;
  for (let i = 0; i < withoutScheme.length; i++) {
    const ch = withoutScheme[i];
    if (ch === '/' || ch === '?' || ch === '#') {
      end = i;
      break;
    }
  }
  return withoutScheme.slice(0, end).trim().toLowerCase();
}

/** Returns the session-cached Xtream scheme (`'https'` or `'http'`) for `hostKey` on `http`, if known. */
export function getCachedXtreamScheme(http: HttpClient, hostKey: string): XtreamScheme | undefined {
  const key = normalizeXtreamHostKey(hostKey);
  if (key.length === 0) return undefined;
  return SCHEMES_BY_CLIENT.get(http)?.get(key);
}

/** Records the resolved Xtream scheme (`'https'` or `'http'`) for `hostKey` on `http`. */
export function setCachedXtreamScheme(
  http: HttpClient,
  hostKey: string,
  scheme: XtreamScheme,
): void {
  const key = normalizeXtreamHostKey(hostKey);
  if (key.length === 0) return;
  let map = SCHEMES_BY_CLIENT.get(http);
  if (map === undefined) {
    map = new Map<string, XtreamScheme>();
    SCHEMES_BY_CLIENT.set(http, map);
  }
  map.set(key, scheme);
}

/** Clears all cached Xtream scheme resolutions associated with `http`. */
export function clearXtreamSchemeCache(http: HttpClient): void {
  SCHEMES_BY_CLIENT.delete(http);
}

/** Builds a normalized base URL for a scheme-less or explicit `server` forced to `scheme`. */
export function buildXtreamBaseUrlWithScheme(server: string, scheme: XtreamScheme): string {
  const trimmed = server.trim();
  const withoutScheme = trimmed.replace(EXPLICIT_SCHEME_RE, '');
  return stripXtreamTail(`${scheme}://${withoutScheme}`);
}

/**
 * Resolves an Xtream `server` into a normalized base URL:
 * - Preserves an explicit `http://` or `https://` scheme verbatim (lowercased).
 * - For scheme-less inputs, uses the cached scheme on `http` when present, otherwise defaults to `'https'`.
 */
export function resolveXtreamBaseUrl(server: string, http?: HttpClient): string {
  const trimmed = server.trim();
  if (hasExplicitScheme(trimmed)) {
    const normalizedScheme = trimmed.replace(EXPLICIT_SCHEME_RE, (m) => m.toLowerCase());
    return stripXtreamTail(normalizedScheme);
  }
  const cached = http !== undefined ? getCachedXtreamScheme(http, trimmed) : undefined;
  return buildXtreamBaseUrlWithScheme(trimmed, cached ?? 'https');
}

/** Returns `true` when `error` proves the server answered HTTP (never trigger HTTP fallback). */
export function isHttpResponseError(error: ElvError): boolean {
  return (
    error.category === 'auth' ||
    error.code === 'too-many-redirects' ||
    HTTP_STATUS_CODE_RE.test(error.code)
  );
}

/**
 * Returns `true` when a failed `https://` probe warrants falling back to `http://`:
 * strictly transport/TLS/connect/timeout failures, never aborts, redirect loops, or HTTP status responses.
 */
export function isSchemeFallbackEligible(error: ElvError): boolean {
  if (error.category !== 'network') return false;
  if (error.code === 'aborted' || error.code === 'too-many-redirects') return false;
  return !HTTP_STATUS_CODE_RE.test(error.code);
}
