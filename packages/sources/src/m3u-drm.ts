import {
  type DrmClearKeyPair,
  type DrmConfig,
  type DrmScheme,
  originOf,
  sanitizeHeaders,
  setSafeHeader,
} from '@elv/domain';

const LICENSE_TYPE_KEY = 'inputstream.adaptive.license_type';
const LICENSE_KEY_KEY = 'inputstream.adaptive.license_key';
const DRM_LEGACY_KEY = 'inputstream.adaptive.drm_legacy';
const HTTP_URL_RE = /^https?:\/\//i;
const HEX_32_RE = /^[0-9a-fA-F]{32}$/;
const UUID_HEX_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const B64URL_16_RE = /^[A-Za-z0-9_-]{22}(?:==)?$/;
const B64STD_16_RE = /^[A-Za-z0-9+/]{22}(?:==)?$/;
const PROTO_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const utf8 = new TextEncoder();

/** Maximum number of ClearKey `kid:key` pairs accepted per M3U entry (`#272`). */
export const MAX_CLEARKEY_PAIRS = 32;

/** Maximum UTF-8 byte length accepted for inline ClearKey JWK JSON (`#272`). */
export const MAX_CLEARKEY_JWK_BYTES = 8_192;

/** Maximum number of sanitized HTTP headers accepted from Kodi pipe syntax (`#272`). */
export const MAX_LICENSE_HEADERS = 32;

const MAX_LICENSE_URL_CHARS = 4_096;
const MAX_LICENSE_HEADER_NAME_CHARS = 128;
const MAX_LICENSE_HEADER_VALUE_CHARS = 2_048;

const SCHEME_MAP: Readonly<Record<string, DrmScheme>> = {
  clearkey: 'clearkey',
  'org.w3.clearkey': 'clearkey',
  widevine: 'widevine',
  'com.widevine.alpha': 'widevine',
  playready: 'playready',
  'com.microsoft.playready': 'playready',
};

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function hasControlOrSpace(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

function decodeBase64ByteLength(stdB64: string): number {
  try {
    const padded = stdB64.endsWith('==') ? stdB64 : `${stdB64}==`;
    return atob(padded).length;
  } catch {
    return -1;
  }
}

function normalizeClearKeyToken(token: string): string | undefined {
  if (HEX_32_RE.test(token)) return token;
  if (UUID_HEX_RE.test(token)) return token.replace(/-/g, '').toLowerCase();
  if (B64URL_16_RE.test(token)) {
    const std = token.replace(/-/g, '+').replace(/_/g, '/');
    return decodeBase64ByteLength(std) === 16 ? token.replace(/=+$/, '') : undefined;
  }
  if (B64STD_16_RE.test(token)) {
    if (decodeBase64ByteLength(token) !== 16) return undefined;
    return token.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  return undefined;
}

function isValidLicenseUrl(url: string): boolean {
  if (url.length === 0 || url.length > MAX_LICENSE_URL_CHARS) return false;
  if (hasControlOrSpace(url)) return false;
  return HTTP_URL_RE.test(url) && originOf(url) !== undefined;
}

function safeDecodeComponent(raw: string): string {
  if (!raw.includes('%')) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function parsePipeHeaders(rawHeaders: string | undefined): Record<string, string> | undefined {
  if (rawHeaders === undefined) return undefined;
  const trimmed = rawHeaders.trim();
  if (trimmed.length === 0) return undefined;
  const candidate: Record<string, string> = {};
  for (const part of trimmed.split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const rawName = safeDecodeComponent(part.slice(0, eq)).trim();
    if (
      rawName.length === 0 ||
      rawName.length > MAX_LICENSE_HEADER_NAME_CHARS ||
      PROTO_KEYS.has(rawName.toLowerCase())
    ) {
      continue;
    }
    const rawValue = safeDecodeComponent(part.slice(eq + 1));
    setSafeHeader(candidate, rawName, rawValue);
  }
  const sanitized = sanitizeHeaders(candidate);
  const bounded: Record<string, string> = {};
  let count = 0;
  for (const key of Object.keys(sanitized)) {
    if (count >= MAX_LICENSE_HEADERS) break;
    const value = sanitized[key];
    if (value === undefined || value.length > MAX_LICENSE_HEADER_VALUE_CHARS) continue;
    setSafeHeader(bounded, key, value);
    count += 1;
  }
  return count > 0 ? bounded : undefined;
}

function parseClearKeyJson(raw: string): readonly DrmClearKeyPair[] | undefined {
  if (utf8.encode(raw).byteLength > MAX_CLEARKEY_JWK_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (Object.hasOwn(obj, 'keys')) {
    const keys = obj.keys;
    if (!Array.isArray(keys) || keys.length === 0) return undefined;
    const pairs: DrmClearKeyPair[] = [];
    for (const entry of keys) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined;
      const record = entry as { kty?: unknown; kid?: unknown; k?: unknown };
      if (record.kty !== 'oct' || typeof record.kid !== 'string' || typeof record.k !== 'string') {
        return undefined;
      }
      const kid = normalizeClearKeyToken(record.kid);
      const key = normalizeClearKeyToken(record.k);
      if (kid === undefined || key === undefined) return undefined;
      if (pairs.length < MAX_CLEARKEY_PAIRS) {
        pairs.push({ kid, key });
      }
    }
    return pairs.length > 0 ? pairs : undefined;
  }

  const keys = Object.keys(obj);
  if (keys.length === 0) return undefined;
  const pairs: DrmClearKeyPair[] = [];
  for (const rawKid of keys) {
    if (PROTO_KEYS.has(rawKid.toLowerCase())) return undefined;
    const rawVal = obj[rawKid];
    if (typeof rawVal !== 'string') return undefined;
    const kid = normalizeClearKeyToken(rawKid.trim());
    const key = normalizeClearKeyToken(rawVal.trim());
    if (kid === undefined || key === undefined) return undefined;
    if (pairs.length < MAX_CLEARKEY_PAIRS) {
      pairs.push({ kid, key });
    }
  }
  return pairs.length > 0 ? pairs : undefined;
}

function parseClearKeyPairs(raw: string): readonly DrmClearKeyPair[] | undefined {
  if (hasControlChar(raw)) return undefined;
  const segments = raw.split(',');
  const pairs: DrmClearKeyPair[] = [];
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (trimmed.length === 0) return undefined;
    const colon = trimmed.indexOf(':');
    if (colon <= 0 || trimmed.indexOf(':', colon + 1) !== -1) return undefined;
    const kid = normalizeClearKeyToken(trimmed.slice(0, colon).trim());
    const key = normalizeClearKeyToken(trimmed.slice(colon + 1).trim());
    if (kid === undefined || key === undefined) return undefined;
    if (pairs.length < MAX_CLEARKEY_PAIRS) {
      pairs.push({ kid, key });
    }
  }
  return pairs.length > 0 ? pairs : undefined;
}

function parseRemoteLicense(scheme: DrmScheme, raw: string): DrmConfig | undefined {
  const pipeIdx = raw.indexOf('|');
  const urlPart = (pipeIdx < 0 ? raw : raw.slice(0, pipeIdx)).trim();
  if (!isValidLicenseUrl(urlPart)) return undefined;
  let headersPart: string | undefined;
  if (pipeIdx >= 0) {
    const rest = raw.slice(pipeIdx + 1);
    const secondPipe = rest.indexOf('|');
    headersPart = secondPipe < 0 ? rest : rest.slice(0, secondPipe);
  }
  const licenseHeaders = parsePipeHeaders(headersPart);
  return {
    scheme,
    licenseUrl: urlPart,
    ...(licenseHeaders === undefined ? {} : { licenseHeaders }),
  };
}

/**
 * Parses Kodi `#KODIPROP:inputstream.adaptive.license_type`, `license_key`, and `drm_legacy`
 * directives into a validated play-time {@link DrmConfig} (`#272`). Returns `undefined` when DRM
 * tags are absent, unsupported, or fail strict URL / 128-bit ClearKey validation.
 */
export function parseM3uDrmProps(
  kodiProps: Readonly<Record<string, string>>,
): DrmConfig | undefined {
  let rawType: string | undefined;
  let rawKey: string | undefined;
  let rawLegacy: string | undefined;
  for (const key of Object.keys(kodiProps)) {
    const lower = key.toLowerCase();
    if (lower === LICENSE_TYPE_KEY) rawType = kodiProps[key];
    else if (lower === LICENSE_KEY_KEY) rawKey = kodiProps[key];
    else if (lower === DRM_LEGACY_KEY) rawLegacy = kodiProps[key];
  }
  if (rawType === undefined && rawKey === undefined && rawLegacy !== undefined) {
    const pipe = rawLegacy.indexOf('|');
    if (pipe > 0) {
      rawType = rawLegacy.slice(0, pipe);
      rawKey = rawLegacy.slice(pipe + 1);
    }
  }
  if (rawKey === undefined) return undefined;
  const keyTrimmed = rawKey.trim();
  if (keyTrimmed.length === 0) return undefined;

  if (rawType === undefined) {
    if (HTTP_URL_RE.test(keyTrimmed) || keyTrimmed.includes('://')) return undefined;
    const clearKeys = keyTrimmed.startsWith('{')
      ? parseClearKeyJson(keyTrimmed)
      : parseClearKeyPairs(keyTrimmed);
    return clearKeys === undefined ? undefined : { scheme: 'clearkey', clearKeys };
  }

  const scheme = SCHEME_MAP[rawType.trim().toLowerCase()];
  if (scheme === undefined) return undefined;

  if (keyTrimmed.startsWith('{')) {
    if (scheme !== 'clearkey') return undefined;
    const clearKeys = parseClearKeyJson(keyTrimmed);
    return clearKeys === undefined ? undefined : { scheme, clearKeys };
  }

  if (HTTP_URL_RE.test(keyTrimmed)) {
    return parseRemoteLicense(scheme, keyTrimmed);
  }

  if (scheme === 'clearkey' && !keyTrimmed.includes('://')) {
    const clearKeys = parseClearKeyPairs(keyTrimmed);
    return clearKeys === undefined ? undefined : { scheme, clearKeys };
  }

  return undefined;
}
