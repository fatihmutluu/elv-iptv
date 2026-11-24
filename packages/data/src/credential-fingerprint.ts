const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const URL_SPLIT = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([^?#]*)(\?[^#]*)?(?:#.*)?$/i;
const FINGERPRINT_RE = /^fp:[0-9a-f]{64}$/;
const TYPED_XTREAM_ROOT_RE = /^(live|movie|series)$/;
const STREAM_ID_RE = /^\d+(?:\.[a-z0-9]+)?$/i;

const RESERVED_SHORT_ROOTS = new Set([
  'live',
  'movie',
  'movies',
  'series',
  'vod',
  'hls',
  'dash',
  'stream',
  'streams',
  'play',
  'api',
  'tv',
  'channel',
  'channels',
  'playlist',
  'playlists',
  'epg',
  'xmltv',
  'static',
  'media',
  'content',
  'cdn',
  'video',
  'videos',
  'audio',
  'files',
  'public',
  'assets',
  'v1',
  'v2',
]);

const utf8Encoder = new TextEncoder();

/** Extracted host and raw credentials tuple from a URL. Never persist or log this value. */
export interface CredentialTuple {
  host: string;
  username: string;
  password: string;
}

/** In-memory connection budget tracker keyed by account pool key (`#265`). */
export interface ConnectionPool {
  /** Returns whether another connection slot can be acquired for `poolKey` under `limit`. */
  canAcquire(poolKey: string, limit?: number): boolean;
  /** Acquires a connection slot for `poolKey` when under limit; returns `false` when at capacity. */
  acquire(poolKey: string, limit?: number): boolean;
  /** Releases one active connection slot for `poolKey` (clamped at 0). */
  release(poolKey: string): void;
  /** Number of currently active connections held for `poolKey`. */
  activeCount(poolKey: string): number;
}

const rotr = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));

/** Pure-TypeScript synchronous SHA-256 returning a 64-character lowercase hex digest. */
export function sha256Hex(input: string): string {
  const bytes = utf8Encoder.encode(input);
  const bitLen = bytes.length * 8;
  const totalLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(totalLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(totalLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(totalLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = w[i - 15] as number;
      const w2 = w[i - 2] as number;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) | 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + (SHA256_K[i] as number) + (w[i] as number)) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => (word >>> 0).toString(16).padStart(8, '0'))
    .join('');
}

function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function normalizeHost(scheme: string, authority: string): string | undefined {
  const at = authority.lastIndexOf('@');
  const rawHost = authority.slice(at + 1);
  if (rawHost === '' || /\s/.test(rawHost)) return undefined;
  const lower = rawHost.toLowerCase();
  const lowerScheme = scheme.toLowerCase();
  if (lowerScheme === 'http://' && lower.length > 3 && lower.endsWith(':80')) {
    return lower.slice(0, -3);
  }
  if (lowerScheme === 'https://' && lower.length > 4 && lower.endsWith(':443')) {
    return lower.slice(0, -4);
  }
  return lower;
}

function hashTuple(host: string, username: string, password: string): string {
  return `fp:${sha256Hex(`${host}\0${username}\0${password}`)}`;
}

/** Type guard verifying an opaque `fp:<64-hex>` credential fingerprint. */
export function isCredentialFingerprint(value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT_RE.test(value);
}

/**
 * Extracts normalized `(host, username, password)` from an M3U playlist or stream URL supporting
 * query-string credentials, typed Xtream paths, and conservative short-form Xtream paths.
 */
export function extractM3uUrlCredentialTuple(url: string): CredentialTuple | undefined {
  const trimmed = url.trim();
  const match = URL_SPLIT.exec(trimmed);
  if (match === null) return undefined;
  const host = normalizeHost(match[1] ?? '', match[2] ?? '');
  if (host === undefined) return undefined;

  const query = match[4]?.slice(1);
  if (query !== undefined && query.length > 0) {
    let username: string | undefined;
    let password: string | undefined;
    for (const pair of query.split('&')) {
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const key = pair.slice(0, eq).toLowerCase();
      if (key === 'username') username = safeDecode(pair.slice(eq + 1));
      else if (key === 'password') password = safeDecode(pair.slice(eq + 1));
    }
    if (username !== undefined && username !== '' && password !== undefined && password !== '') {
      return { host, username, password };
    }
  }

  const path = match[3] ?? '';
  const segs = path === '' ? [] : path.slice(1).split('/');
  if (segs.length >= 4) {
    const first = (segs[0] ?? '').toLowerCase();
    const rawUser = segs[1] ?? '';
    const rawPass = segs[2] ?? '';
    const streamId = segs[3] ?? '';
    if (
      TYPED_XTREAM_ROOT_RE.test(first) &&
      rawUser !== '' &&
      rawPass !== '' &&
      STREAM_ID_RE.test(streamId)
    ) {
      const username = safeDecode(rawUser);
      const password = safeDecode(rawPass);
      if (username !== '' && password !== '') return { host, username, password };
    }
  }

  if (segs.length === 3) {
    const rawUser = segs[0] ?? '';
    const rawPass = segs[1] ?? '';
    const streamId = segs[2] ?? '';
    if (
      rawUser !== '' &&
      rawPass !== '' &&
      !RESERVED_SHORT_ROOTS.has(rawUser.toLowerCase()) &&
      !RESERVED_SHORT_ROOTS.has(rawPass.toLowerCase()) &&
      STREAM_ID_RE.test(streamId)
    ) {
      const username = safeDecode(rawUser);
      const password = safeDecode(rawPass);
      if (
        username !== '' &&
        password !== '' &&
        !RESERVED_SHORT_ROOTS.has(username.toLowerCase()) &&
        !RESERVED_SHORT_ROOTS.has(password.toLowerCase())
      ) {
        return { host, username, password };
      }
    }
  }

  return undefined;
}

/** Derives a non-reversible `fp:<64-hex>` credential fingerprint for an Xtream source. */
export function fingerprintXtreamCredentials(
  server: string,
  username: string,
  password: string,
): string | undefined {
  if (username === '' || password === '') return undefined;
  const trimmed = server.trim();
  if (trimmed === '') return undefined;
  const candidate = trimmed.includes('://') ? trimmed : `http://${trimmed}`;
  const match = URL_SPLIT.exec(candidate);
  if (match === null) return undefined;
  const host = normalizeHost(match[1] ?? '', match[2] ?? '');
  if (host === undefined) return undefined;
  return hashTuple(host, username, password);
}

/**
 * Derives a non-reversible `fp:<64-hex>` credential fingerprint for an M3U source, inspecting
 * `playlistUrl` first and falling back to the first matching URL in `sampleStreamUrls`.
 */
export function fingerprintM3uCredentials(
  playlistUrl: string,
  sampleStreamUrls?: readonly string[],
): string | undefined {
  const fromPlaylist = extractM3uUrlCredentialTuple(playlistUrl);
  if (fromPlaylist !== undefined) {
    return hashTuple(fromPlaylist.host, fromPlaylist.username, fromPlaylist.password);
  }
  if (sampleStreamUrls !== undefined) {
    for (const url of sampleStreamUrls) {
      const tuple = extractM3uUrlCredentialTuple(url);
      if (tuple !== undefined) return hashTuple(tuple.host, tuple.username, tuple.password);
    }
  }
  return undefined;
}

/** Derives a non-reversible `fp:<64-hex>` credential fingerprint for a Stalker/MAC portal source (`#29`). */
export function fingerprintStalkerCredentials(portalUrl: string, mac: string): string | undefined {
  const trimmedPortal = portalUrl.trim();
  const trimmedMac = mac.trim().toUpperCase();
  if (trimmedPortal === '' || trimmedMac === '') return undefined;
  return `fp:${sha256Hex(`${trimmedPortal}\0${trimmedMac}`)}`;
}

/** Resolves the connection-pool key for a source (`credentialFingerprint` when valid, else `source.id`). */
export function resolveAccountPoolKey(source: {
  id: string;
  credentialFingerprint?: string | undefined;
}): string {
  return isCredentialFingerprint(source.credentialFingerprint)
    ? source.credentialFingerprint
    : source.id;
}

function resolveLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined || Number.isNaN(limit)) return fallback;
  if (limit === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor(limit));
}

/** Creates an in-memory connection budget pool keyed by opaque account pool key (`#265`). */
export function createConnectionPool(defaultMaxPerPool = 1): ConnectionPool {
  const defaultLimit = resolveLimit(defaultMaxPerPool, 1);
  const active = new Map<string, number>();

  return {
    activeCount(poolKey) {
      return active.get(poolKey) ?? 0;
    },

    canAcquire(poolKey, limit) {
      return (active.get(poolKey) ?? 0) < resolveLimit(limit, defaultLimit);
    },

    acquire(poolKey, limit) {
      const current = active.get(poolKey) ?? 0;
      if (current >= resolveLimit(limit, defaultLimit)) return false;
      active.set(poolKey, current + 1);
      return true;
    },

    release(poolKey) {
      const current = active.get(poolKey) ?? 0;
      if (current <= 1) active.delete(poolKey);
      else active.set(poolKey, current - 1);
    },
  };
}
