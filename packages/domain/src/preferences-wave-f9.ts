import { hostnameOf, originOf } from './headers';

/** Maximum UTF-16 length accepted for a custom sync server base URL (`#26`). */
export const MAX_SYNC_SERVER_URL_LENGTH = 256;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1']);

/** Wave F9 E2EE sync, first-run welcome, and opt-in telemetry preference fields (`#26`, `#458`). */
export interface WaveF9PreferencesFields {
  readonly telemetryOptIn: boolean;
  readonly welcomeDismissed: boolean;
  readonly syncServerUrl: string;
}

/** Default values for all Wave F9 preference fields. */
export const DEFAULT_WAVE_F9_PREFERENCES: WaveF9PreferencesFields = Object.freeze({
  telemetryOptIn: false,
  welcomeDismissed: false,
  syncServerUrl: '',
});

function hasUnsafeUrlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return value.includes('?') || value.includes('#') || value.includes('\\');
}

function parseValidSyncServerUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  if (trimmed.length > MAX_SYNC_SERVER_URL_LENGTH || hasUnsafeUrlChars(trimmed)) {
    return undefined;
  }
  const sep = trimmed.indexOf('://');
  if (sep <= 0) return undefined;
  const scheme = trimmed.slice(0, sep).toLowerCase();
  if (scheme !== 'https' && scheme !== 'http') return undefined;

  const afterScheme = sep + 3;
  const slashIdx = trimmed.indexOf('/', afterScheme);
  const authority =
    slashIdx === -1 ? trimmed.slice(afterScheme) : trimmed.slice(afterScheme, slashIdx);
  if (authority.length === 0 || authority.includes('@')) return undefined;

  const origin = originOf(trimmed);
  const host = hostnameOf(trimmed);
  if (origin === undefined || host === undefined) return undefined;
  if (scheme === 'http' && !LOOPBACK_HOSTS.has(host)) return undefined;

  if (slashIdx === -1) return origin;
  const rawPath = trimmed.slice(slashIdx);
  const segments = rawPath.split('/');
  for (const seg of segments) {
    if (seg === '..') return undefined;
  }
  const cleanPath = rawPath.replace(/\/+$/, '');
  return `${origin}${cleanPath}`;
}

/**
 * Returns true when `value` is empty or a valid sync server base URL (`https://` or local
 * `http://127.0.0.1` / `http://localhost` / `http://[::1]`) with no credentials, query, or fragment.
 */
export function isValidSyncServerUrl(value: unknown): value is string {
  return typeof value === 'string' && parseValidSyncServerUrl(value) !== undefined;
}

/** Normalizes a sync server base URL or returns `fallback` when invalid or unsafe. */
export function normalizeSyncServerUrl(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  const normalized = parseValidSyncServerUrl(value);
  return normalized !== undefined ? normalized : fallback;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function parseWaveF9Preferences(
  parsed: Record<string, unknown>,
  defaults: WaveF9PreferencesFields,
): WaveF9PreferencesFields {
  return {
    telemetryOptIn: boolOr(parsed.telemetryOptIn, defaults.telemetryOptIn),
    welcomeDismissed: boolOr(parsed.welcomeDismissed, defaults.welcomeDismissed),
    syncServerUrl: normalizeSyncServerUrl(parsed.syncServerUrl, defaults.syncServerUrl),
  };
}

export function serializeWaveF9Preferences(
  snapshot: WaveF9PreferencesFields,
  defaults: WaveF9PreferencesFields,
): Partial<WaveF9PreferencesFields> {
  const telemetryOptIn = Boolean(snapshot.telemetryOptIn);
  const welcomeDismissed = Boolean(snapshot.welcomeDismissed);
  const syncServerUrl = normalizeSyncServerUrl(snapshot.syncServerUrl, defaults.syncServerUrl);
  return {
    ...(telemetryOptIn === defaults.telemetryOptIn ? {} : { telemetryOptIn }),
    ...(welcomeDismissed === defaults.welcomeDismissed ? {} : { welcomeDismissed }),
    ...(syncServerUrl === defaults.syncServerUrl ? {} : { syncServerUrl }),
  };
}

export function mergeWaveF9Preferences(
  base: WaveF9PreferencesFields,
  patch: Partial<WaveF9PreferencesFields>,
): WaveF9PreferencesFields {
  return {
    telemetryOptIn: boolOr(patch.telemetryOptIn, base.telemetryOptIn),
    welcomeDismissed: boolOr(patch.welcomeDismissed, base.welcomeDismissed),
    syncServerUrl:
      patch.syncServerUrl !== undefined
        ? normalizeSyncServerUrl(patch.syncServerUrl, base.syncServerUrl)
        : base.syncServerUrl,
  };
}
