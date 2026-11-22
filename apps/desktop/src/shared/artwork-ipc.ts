/** Minimum user-configurable artwork disk cache ceiling in MiB (`#405`). */
export const ARTWORK_CACHE_MIN_MB = 64;
/** Maximum user-configurable artwork disk cache ceiling in MiB (`#405`). */
export const ARTWORK_CACHE_MAX_MB = 256;
/** Default artwork disk cache ceiling in MiB (`#405`). */
export const DEFAULT_ARTWORK_CACHE_MB = 128;

const BYTES_PER_MIB = 1024 * 1024;

/** Minimum user-configurable artwork disk cache ceiling in bytes (`#405`). */
export const ARTWORK_CACHE_MIN_BYTES = ARTWORK_CACHE_MIN_MB * BYTES_PER_MIB;
/** Maximum user-configurable artwork disk cache ceiling in bytes (`#405`). */
export const ARTWORK_CACHE_MAX_BYTES = ARTWORK_CACHE_MAX_MB * BYTES_PER_MIB;
/** Default artwork disk cache ceiling in bytes (`#405`). */
export const DEFAULT_ARTWORK_CACHE_BYTES = DEFAULT_ARTWORK_CACHE_MB * BYTES_PER_MIB;

/** Custom Electron protocol scheme serving cached artwork strictly from disk (`#405`). */
export const ARTWORK_PROTOCOL_SCHEME = 'elv-art';
const ARTWORK_PROTOCOL_HOST = 'cache';
/** Origin prefix for cached desktop artwork protocol URLs (`#405`). */
export const ARTWORK_PROTOCOL_ORIGIN = `${ARTWORK_PROTOCOL_SCHEME}://${ARTWORK_PROTOCOL_HOST}`;

const SHA256_KEY = /^[a-f0-9]{64}$/;
const ARTWORK_PROTOCOL_URL = /^elv-art:\/\/cache\/([a-f0-9]{64})$/;

/** IPC channels exposed by main for artwork disk cache management (`#405`). */
export const ARTWORK_CHANNELS = Object.freeze({
  clear: 'artwork:clear',
  resolve: 'artwork:resolve',
  setLimit: 'artwork:set-limit',
  stats: 'artwork:stats',
} as const);

/** Current occupancy and configured byte budget reported by the desktop artwork cache (`#405`). */
export interface DesktopArtworkCacheStats {
  readonly bytes: number;
  readonly entries: number;
  readonly maxBytes: number;
}

/** Frozen `window.elv.artwork` bridge exposed by the Electron preload (`#405`). */
export interface ArtworkBridge {
  clear(): Promise<void>;
  resolve(uri: string): Promise<string | null>;
  setLimitBytes(maxBytes: number): Promise<void>;
  stats(): Promise<DesktopArtworkCacheStats>;
}

/** Formats a 64-char lowercase SHA-256 hex key into its canonical `elv-art://cache/<key>` URL. */
export function formatArtworkProtocolUrl(key: string): string {
  if (!SHA256_KEY.test(key)) {
    throw new Error('artwork cache key must be a 64-character lowercase SHA-256 hex digest');
  }
  return `${ARTWORK_PROTOCOL_ORIGIN}/${key}`;
}

/** Extracts the 64-char lowercase SHA-256 hex key from a canonical `elv-art://cache/<key>` URL. */
export function parseArtworkProtocolKey(requestUrl: string): string | null {
  if (typeof requestUrl !== 'string') return null;
  const match = ARTWORK_PROTOCOL_URL.exec(requestUrl);
  return match?.[1] ?? null;
}

/** Runtime guard validating a canonical `elv-art://cache/<64-hex>` URL returned over IPC. */
export function isArtworkProtocolUrl(x: unknown): x is string {
  return typeof x === 'string' && ARTWORK_PROTOCOL_URL.test(x);
}

/** Clamps a byte limit to `[64 MiB, 256 MiB]` (defaulting to `128 MiB` on non-finite input). */
export function clampArtworkCacheLimitBytes(bytes: number): number {
  if (!Number.isFinite(bytes)) return DEFAULT_ARTWORK_CACHE_BYTES;
  const rounded = Math.floor(bytes);
  return Math.max(ARTWORK_CACHE_MIN_BYTES, Math.min(ARTWORK_CACHE_MAX_BYTES, rounded));
}

/** Validates a positive finite `maxBytes` payload sent over `artwork:set-limit`. */
export function isArtworkSetLimitBytes(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}

/** Validates a {@link DesktopArtworkCacheStats} reply from main. */
export function isDesktopArtworkCacheStats(x: unknown): x is DesktopArtworkCacheStats {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const rec = x as Record<string, unknown>;
  return (
    typeof rec.bytes === 'number' &&
    Number.isSafeInteger(rec.bytes) &&
    rec.bytes >= 0 &&
    typeof rec.entries === 'number' &&
    Number.isSafeInteger(rec.entries) &&
    rec.entries >= 0 &&
    typeof rec.maxBytes === 'number' &&
    Number.isSafeInteger(rec.maxBytes) &&
    rec.maxBytes >= 0
  );
}

const MAX_URL_CHARS = 4096;

function hasControlOrWhitespace(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : -1));
  if (octets.some((n) => n < 0 || n > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function isPrivateIpv6(rawHost: string): boolean {
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  const lower = host.toLowerCase();
  if (
    lower === '::1' ||
    lower === '::' ||
    lower === '0:0:0:0:0:0:0:0' ||
    lower === '0:0:0:0:0:0:0:1' ||
    /^fe[89ab][0-9a-f]:/.test(lower) ||
    /^f[cd][0-9a-f]{2}:/.test(lower)
  ) {
    return true;
  }
  const v4Mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (v4Mapped?.[1] && isPrivateIpv4(v4Mapped[1])) return true;
  const v4HexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (v4HexMapped?.[1] && v4HexMapped[2]) {
    const hi = Number.parseInt(v4HexMapped[1], 16);
    const lo = Number.parseInt(v4HexMapped[2], 16);
    return isPrivateIpv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
  }
  return false;
}

/** Validates that an artwork URL is HTTP/HTTPS without credentials, control chars, or SSRF targets (`#405`). */
export function isSafeArtworkUrl(uri: string, opts?: { allowPrivateHosts?: boolean }): boolean {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > MAX_URL_CHARS) return false;
  if (hasControlOrWhitespace(uri)) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (host.length === 0) return false;
  if (opts?.allowPrivateHosts) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || isPrivateIpv4(host)) return false;
  return !(host.includes(':') && isPrivateIpv6(host));
}
