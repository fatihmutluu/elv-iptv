import {
  type ElvError,
  sanitizeHeaderValue,
  streamTransportHeaders,
  type TransportSettings,
} from '@elv/domain';
import { isSameSafePortalHost } from './stalker-url';
import { isRaw } from './xtream-records';

const DEFAULT_MAG250_USER_AGENT =
  'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';
const DEFAULT_X_USER_AGENT = 'Model: MAG250; Link: WiFi';
const STALKER_VER = 'ImageDescription:%200.2.18-r14-pub-250';

const AUTH_FAILURE_RE =
  /authorization\s+failed|access\s+denied|\bunauthorized(?:\s+request)?\b|invalid\s+token|auth(?:entication)?\s+failed/i;
const HTML_LEADING_RE = /^(?:<!doctype\s+html|<html\b)/i;
const MAX_PLAIN_TEXT_AUTH_BYTES = 2048;

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

const utf8 = new TextEncoder();
const rotr = (v: number, bits: number): number => (v >>> bits) | (v << (32 - bits));

function sha256Hex(input: string): string {
  const bytes = utf8.encode(input);
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
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
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
      const t1 = (h + s1 + ch + (SHA256_K[i] as number) + (w[i] as number)) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
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

/** Derives a deterministic non-reversible 43-char `__cfduid` token from an explicit STB serial number. */
export function deriveCfduidFromSerial(serialNumber: string): string {
  return `d${sha256Hex(`stalker-sn:${serialNumber}`).slice(0, 42)}`;
}

/** Builds the dynamic per-request STB `Cookie` header reflecting the latest active timezone. */
export function buildStalkerCookieHeader(parts: {
  mac: string;
  stbLang: string;
  timezone: string;
  cfduid?: string;
}): string {
  const base = `mac=${encodeURIComponent(parts.mac)}; stb_lang=${encodeURIComponent(parts.stbLang)}; timezone=${encodeURIComponent(parts.timezone)}`;
  return parts.cfduid !== undefined ? `${base}; __cfduid=${parts.cfduid}` : base;
}

/** Builds Stalker portal API request headers with consistent MAG250 defaults and optional SN/Bearer. */
export function buildStalkerRequestHeaders(input: {
  baseHeaders: Readonly<Record<string, string>>;
  cookie: string;
  bearerToken?: string;
  serialNumber?: string;
}): Record<string, string> {
  const headers: Record<string, string> = { ...input.baseHeaders };
  if (headers['user-agent'] === undefined) {
    headers['user-agent'] = DEFAULT_MAG250_USER_AGENT;
  }
  headers.Cookie = input.cookie;
  headers['X-User-Agent'] = DEFAULT_X_USER_AGENT;
  if (input.serialNumber !== undefined) {
    const cleanSn = sanitizeHeaderValue(input.serialNumber);
    if (cleanSn.length > 0) headers.SN = cleanSn;
  }
  if (input.bearerToken !== undefined) {
    headers.Authorization = `Bearer ${input.bearerToken}`;
  }
  return headers;
}

/**
 * Builds lower-case playback headers for `targetUrl`, attaching portal session headers strictly
 * when `targetUrl` targets the same host as `activeEndpoint` without an `https -> http` downgrade.
 */
export function buildStalkerPlaybackHeaders(input: {
  transport: TransportSettings | undefined;
  activeEndpoint: string;
  targetUrl: string;
  cookie: string;
  bearerToken?: string;
  serialNumber?: string;
}): Record<string, string> {
  const headers = streamTransportHeaders(input.transport);
  if (
    input.activeEndpoint.length === 0 ||
    !isSameSafePortalHost(input.activeEndpoint, input.targetUrl)
  ) {
    return headers;
  }
  headers.cookie = input.cookie;
  if (input.bearerToken !== undefined) {
    headers.authorization = `Bearer ${input.bearerToken}`;
  }
  if (headers['user-agent'] === undefined) {
    headers['user-agent'] = DEFAULT_MAG250_USER_AGENT;
  }
  headers['x-user-agent'] = DEFAULT_X_USER_AGENT;
  if (input.serialNumber !== undefined) {
    const cleanSn = sanitizeHeaderValue(input.serialNumber);
    if (cleanSn.length > 0) headers.sn = cleanSn;
  }
  return headers;
}

/** Builds the `get_profile` query string without ever inventing unconfigured device identifiers. */
export function buildStalkerProfileQuery(input: {
  mac: string;
  serialNumber?: string;
  deviceId?: string;
  deviceId2?: string;
  signature?: string;
  authSecondStep?: boolean;
}): string {
  const metrics: Record<string, string> = {
    mac: input.mac,
    model: 'MAG250',
    type: 'STB',
  };
  if (input.serialNumber !== undefined) metrics.sn = input.serialNumber;
  if (input.deviceId !== undefined) metrics.uid = input.deviceId;

  const parts = [
    'type=stb',
    'action=get_profile',
    'hd=1',
    `ver=${STALKER_VER}`,
    'num_banks=2',
    'stb_type=MAG250',
  ];
  if (input.serialNumber !== undefined) parts.push(`sn=${encodeURIComponent(input.serialNumber)}`);
  if (input.deviceId !== undefined) parts.push(`device_id=${encodeURIComponent(input.deviceId)}`);
  if (input.deviceId2 !== undefined) {
    parts.push(`device_id2=${encodeURIComponent(input.deviceId2)}`);
  }
  if (input.signature !== undefined) {
    parts.push(`signature=${encodeURIComponent(input.signature)}`);
  }
  parts.push(`metrics=${encodeURIComponent(JSON.stringify(metrics))}`);
  if (input.authSecondStep === true) parts.push('auth_second_step=1');
  parts.push('JsHttpRequest=1-xml');
  return parts.join('&');
}

/** Returns `true` when non-JSON response text indicates a Stalker authentication rejection. */
export function textIndicatesAuthFailure(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PLAIN_TEXT_AUTH_BYTES) return false;
  return AUTH_FAILURE_RE.test(trimmed);
}

/** Returns `true` when a parsed Stalker JSON payload carries an auth-failure envelope. */
export function payloadIndicatesAuthFailure(parsed: unknown): boolean {
  if (typeof parsed === 'string') return AUTH_FAILURE_RE.test(parsed);
  if (!isRaw(parsed)) return false;
  for (const field of [parsed.text, parsed.js, parsed.error, parsed.msg, parsed.message]) {
    if (typeof field === 'string' && AUTH_FAILURE_RE.test(field)) return true;
  }
  if (isRaw(parsed.js)) {
    for (const field of [parsed.js.error, parsed.js.msg, parsed.js.message, parsed.js.text]) {
      if (typeof field === 'string' && AUTH_FAILURE_RE.test(field)) return true;
    }
  }
  return false;
}

/** Returns `true` when an HTTP 200 response appears to be an HTML portal landing page. */
export function looksLikeHtmlResponse(
  headers: Readonly<Record<string, string>>,
  text: string,
): boolean {
  const ct = headers['content-type']?.toLowerCase() ?? '';
  if (ct.includes('text/html') || ct.includes('application/xhtml+xml')) return true;
  return HTML_LEADING_RE.test(text.trimStart());
}

/** Classifies a tokenless `type=itv&action=get_genres` JSON payload for behavioral discovery. */
export function classifyGenresProbePayload(
  parsed: unknown,
): 'valid-non-empty' | 'valid-empty' | 'other-json' {
  if (!isRaw(parsed) || !('js' in parsed)) return 'other-json';
  const js = parsed.js;
  let rows: unknown[] | undefined;
  if (Array.isArray(js)) {
    rows = js;
  } else if (isRaw(js) && Array.isArray(js.data)) {
    rows = js.data;
  }
  if (rows === undefined) return 'other-json';
  if (rows.length === 0) return 'valid-empty';
  const hasGenreObject = rows.some(
    (r) => isRaw(r) && (r.id !== undefined || r.title !== undefined || r.name !== undefined),
  );
  return hasGenreObject ? 'valid-non-empty' : 'other-json';
}

/** Returns `true` for host-level network transport failures where probing sibling paths is futile. */
export function isHostLevelNetworkError(error: ElvError): boolean {
  if (error.category !== 'network') return false;
  return (
    error.code === 'fetch-failed' ||
    error.code === 'request-failed' ||
    error.code === 'dns-failed' ||
    error.code === 'connect-refused' ||
    error.code === 'host-unreachable'
  );
}

function discoveryErrorRank(error: ElvError): number {
  if (error.category === 'auth') return 5;
  if (error.code === 'too-large' || error.code === 'stream-failed') return 4;
  if (error.category === 'source-format') return 3;
  if (error.code === 'timeout' || /^http-5\d\d$/.test(error.code)) return 2;
  return 1;
}

/** Picks the more informative failure across probed endpoint candidates. */
export function pickMoreSpecificDiscoveryError(
  current: ElvError | undefined,
  next: ElvError,
): ElvError {
  if (current === undefined) return next;
  return discoveryErrorRank(next) > discoveryErrorRank(current) ? next : current;
}
