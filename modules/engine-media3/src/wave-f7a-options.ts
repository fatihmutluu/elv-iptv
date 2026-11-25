import type { DisplaySyncPolicy, LoadCommand } from '@elv/playback';

/** Auto frame-rate display matching mode forwarded to Media3 (`#116`). */
export type Media3AutoFrameRateMode = 'off' | 'seamless' | 'always';

/** Night-Mode dynamic range compression preset forwarded to Media3 (`#115`). */
export type Media3NightModeDrcPreset = 'off' | 'light' | 'night';

/** Widevine DRM security level reported by Android `FrameworkMediaDrm` (`#272`). */
export type Media3WidevineSecurityLevel = 'L1' | 'L3' | 'unavailable';

/** Device DRM capability snapshot returned by `getDrmCapabilities()` (`#272`). */
export interface Media3DrmCapabilities {
  readonly widevineSecurityLevel: Media3WidevineSecurityLevel;
  readonly clearKeySupported: boolean;
}

/** Display sync options forwarded to Media3 (`#116`). */
export interface Media3DisplaySyncOptions {
  readonly autoFrameRate?: Media3AutoFrameRateMode;
  readonly autoDynamicRange?: boolean;
}

/** Supported Media3 DRM scheme names (`#272`). */
export type Media3DrmScheme = 'clearkey' | 'widevine' | 'playready';

/** One ClearKey key-id / key pair (32-char hex or base64url, `#272`). */
export interface Media3DrmClearKeyPair {
  readonly kid: string;
  readonly key: string;
}

/** Play-time DRM configuration forwarded to Media3 (`#272`). Never logged or persisted. */
export interface Media3DrmConfig {
  readonly scheme: Media3DrmScheme;
  readonly licenseUrl?: string;
  readonly licenseHeaders?: Readonly<Record<string, string>>;
  readonly clearKeys?: readonly Media3DrmClearKeyPair[];
  readonly multiSession?: boolean;
}

/** Validated Wave F7A load options extracted from a `LoadCommand` (`#115`, `#116`, `#272`). */
export interface Media3WaveF7ALoadOptions {
  readonly drm?: Media3DrmConfig;
  readonly displaySync?: DisplaySyncPolicy;
  readonly nightModeDrc?: Media3NightModeDrcPreset;
  readonly audioDelayByRefreshRateMs?: Readonly<Record<string, number>>;
}

const DEFAULT_DRM_CAPABILITIES: Media3DrmCapabilities = Object.freeze({
  widevineSecurityLevel: 'unavailable',
  clearKeySupported: false,
});

const AFR_MODES: ReadonlySet<string> = new Set(['off', 'seamless', 'always']);
const DRC_PRESETS: ReadonlySet<string> = new Set(['off', 'light', 'night']);
const HEX_32_RE = /^[0-9a-fA-F]{32}$/;
const B64URL_22_RE = /^[A-Za-z0-9_-]{22}(?:==)?$/;
const MAX_REFRESH_OFFSET_MS = 1_000;
const MAX_CLEARKEY_PAIRS = 64;

/** Normalizes a raw `autoFrameRate` mode value, returning `undefined` when invalid or unset. */
function normalizeMedia3AutoFrameRate(raw: unknown): Media3AutoFrameRateMode | undefined {
  if (typeof raw !== 'string') return undefined;
  const lower = raw.trim().toLowerCase();
  return AFR_MODES.has(lower) ? (lower as Media3AutoFrameRateMode) : undefined;
}

/** Normalizes a partial or full display-sync policy into a complete {@link DisplaySyncPolicy}. */
export function normalizeMedia3DisplaySyncPolicy(
  raw: Media3DisplaySyncOptions | DisplaySyncPolicy | undefined,
): DisplaySyncPolicy {
  return {
    autoFrameRate: normalizeMedia3AutoFrameRate(raw?.autoFrameRate) ?? 'seamless',
    autoDynamicRange: typeof raw?.autoDynamicRange === 'boolean' ? raw.autoDynamicRange : true,
  };
}

/** Normalizes a raw `nightModeDrc` preset value, returning `undefined` when invalid or unset. */
export function normalizeMedia3NightModeDrc(raw: unknown): Media3NightModeDrcPreset | undefined {
  if (typeof raw !== 'string') return undefined;
  const lower = raw.trim().toLowerCase();
  return DRC_PRESETS.has(lower) ? (lower as Media3NightModeDrcPreset) : undefined;
}

/** Normalizes a raw native `getDrmCapabilities()` payload safely (`#272`). */
export function normalizeMedia3DrmCapabilities(raw: unknown): Media3DrmCapabilities {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_DRM_CAPABILITIES;
  const r = raw as { widevineSecurityLevel?: unknown; clearKeySupported?: unknown };
  const level =
    typeof r.widevineSecurityLevel === 'string' ? r.widevineSecurityLevel.trim().toUpperCase() : '';
  const widevineSecurityLevel: Media3WidevineSecurityLevel =
    level === 'L1' || level === 'L3' ? level : 'unavailable';
  return {
    widevineSecurityLevel,
    clearKeySupported: Boolean(r.clearKeySupported),
  };
}

/** Normalizes and clamps per-refresh-rate A/V delay offsets to `[-1000, 1000]` ms (`#115`). */
export function normalizeMedia3AudioDelayByRefreshRate(
  raw: unknown,
): Record<string, number> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, number> = {};
  let hasAny = false;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const cleanKey = key.trim();
    if (cleanKey.length === 0 || cleanKey.length > 16) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const clamped = Math.max(
      -MAX_REFRESH_OFFSET_MS,
      Math.min(MAX_REFRESH_OFFSET_MS, Math.round(value)),
    );
    out[cleanKey] = clamped;
    hasAny = true;
  }
  return hasAny ? out : undefined;
}

function isAllowedLicenseUrl(raw: string): boolean {
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  const trimmed = raw.trim();
  const sep = trimmed.indexOf('://');
  if (sep <= 0) return false;
  const scheme = trimmed.slice(0, sep).toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return false;
  const rest = trimmed.slice(sep + 3);
  return rest.length > 0 && rest[0] !== '/' && rest[0] !== '\\';
}

function normalizeDrmScheme(raw: unknown): Media3DrmScheme | undefined {
  if (typeof raw !== 'string') return undefined;
  switch (raw.trim().toLowerCase()) {
    case 'clearkey':
    case 'org.w3.clearkey':
      return 'clearkey';
    case 'widevine':
    case 'com.widevine.alpha':
      return 'widevine';
    case 'playready':
    case 'com.microsoft.playready':
      return 'playready';
    default:
      return undefined;
  }
}

function isValidClearKeyPart(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  return HEX_32_RE.test(trimmed) || B64URL_22_RE.test(trimmed);
}

/** Validates and normalizes an optional play-time DRM configuration (`#272`). */
function normalizeMedia3DrmConfig(raw: unknown): Media3DrmConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const src = raw as Record<string, unknown>;
  const scheme = normalizeDrmScheme(src.scheme);
  if (scheme === undefined) return undefined;

  const rawUrl = typeof src.licenseUrl === 'string' ? src.licenseUrl.trim() : '';
  const licenseUrl = rawUrl.length > 0 && isAllowedLicenseUrl(rawUrl) ? rawUrl : undefined;

  let licenseHeaders: Record<string, string> | undefined;
  if (
    typeof src.licenseHeaders === 'object' &&
    src.licenseHeaders !== null &&
    !Array.isArray(src.licenseHeaders)
  ) {
    const cleanHeaders: Record<string, string> = {};
    let count = 0;
    for (const [k, v] of Object.entries(src.licenseHeaders as Record<string, unknown>)) {
      const name = k.trim();
      if (name.length === 0 || typeof v !== 'string') continue;
      cleanHeaders[name] = v;
      count += 1;
    }
    if (count > 0) licenseHeaders = cleanHeaders;
  }

  let clearKeys: Media3DrmClearKeyPair[] | undefined;
  if (scheme === 'clearkey' && Array.isArray(src.clearKeys)) {
    const validPairs: Media3DrmClearKeyPair[] = [];
    for (const item of src.clearKeys) {
      if (validPairs.length >= MAX_CLEARKEY_PAIRS) break;
      if (typeof item !== 'object' || item === null) continue;
      const pair = item as { kid?: unknown; key?: unknown };
      if (!isValidClearKeyPart(pair.kid) || !isValidClearKeyPart(pair.key)) continue;
      validPairs.push({ kid: pair.kid.trim(), key: pair.key.trim() });
    }
    if (validPairs.length > 0) clearKeys = validPairs;
  }

  if (licenseUrl === undefined && (clearKeys === undefined || clearKeys.length === 0)) {
    return undefined;
  }

  return {
    scheme,
    ...(licenseUrl === undefined ? {} : { licenseUrl }),
    ...(licenseHeaders === undefined ? {} : { licenseHeaders }),
    ...(clearKeys === undefined ? {} : { clearKeys }),
    ...(typeof src.multiSession === 'boolean' ? { multiSession: src.multiSession } : {}),
  };
}

/** Extracts validated Wave F7A options (`drm`, `displaySync`, `nightModeDrc`, `audioDelayByRefreshRateMs`) from a `LoadCommand`. */
export function extractMedia3WaveF7ALoadOptions(cmd: LoadCommand): Media3WaveF7ALoadOptions {
  const opts = cmd.options as
    | {
        drm?: unknown;
        autoFrameRate?: unknown;
        displaySync?: { autoFrameRate?: unknown; autoDynamicRange?: unknown };
        nightModeDrc?: unknown;
        audioDelayByRefreshRateMs?: unknown;
      }
    | undefined;
  const req = cmd as { drm?: unknown };
  const drm = normalizeMedia3DrmConfig(req.drm ?? opts?.drm);
  const rawAfr = normalizeMedia3AutoFrameRate(
    opts?.displaySync?.autoFrameRate ?? opts?.autoFrameRate,
  );
  const displaySync: DisplaySyncPolicy | undefined =
    opts?.displaySync !== undefined || rawAfr !== undefined
      ? {
          autoFrameRate: rawAfr ?? 'seamless',
          autoDynamicRange:
            typeof opts?.displaySync?.autoDynamicRange === 'boolean'
              ? opts.displaySync.autoDynamicRange
              : true,
        }
      : undefined;
  const nightModeDrc = normalizeMedia3NightModeDrc(opts?.nightModeDrc);
  const audioDelayByRefreshRateMs = normalizeMedia3AudioDelayByRefreshRate(
    opts?.audioDelayByRefreshRateMs,
  );
  return {
    ...(drm === undefined ? {} : { drm }),
    ...(displaySync === undefined ? {} : { displaySync }),
    ...(nightModeDrc === undefined ? {} : { nightModeDrc }),
    ...(audioDelayByRefreshRateMs === undefined ? {} : { audioDelayByRefreshRateMs }),
  };
}
