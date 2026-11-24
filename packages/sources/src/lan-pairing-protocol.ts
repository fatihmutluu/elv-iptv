import { elvError, err, ok, type Result } from '@elv/domain';

export {
  type LanPairingLocale,
  type RenderLanPairingHtmlOptions,
  renderLanPairingHtml,
} from './lan-pairing-html';

/** Default pairing session lifetime (5 minutes). */
export const LAN_PAIRING_TTL_MS = 300_000;

/** Maximum accepted HTTP request body size in bytes (16 KiB). */
export const LAN_PAIRING_MAX_BODY_BYTES = 16_384;

/** Maximum invalid pairing requests before locking out and shutting down the listener. */
export const LAN_PAIRING_MAX_FAILED_ATTEMPTS = 5;

const MAX_NAME_LENGTH = 120;
const MAX_URL_LENGTH = 2_048;
const MAX_CREDENTIAL_LENGTH = 256;

const TOKEN_RE = /^[0-9a-fA-F]{32,128}$/;
const IPV4_OCTET_RE = /^(0|[1-9]\d{0,2})$/;
const IPV6_GROUP_RE = /^[0-9a-fA-F]{1,4}$/;
const IPV6_ZONE_RE = /^[A-Za-z0-9_.-]+$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally strips/rejects ASCII control chars
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally rejects whitespace and ASCII control chars
const WHITESPACE_OR_CONTROL_RE = /[\s\u0000-\u001f\u007f]/;

/** Validated source payload received from the phone pairing web form (`#50`). */
export type LanPairingPayload =
  | {
      readonly kind: 'm3u';
      readonly name: string;
      readonly url: string;
      readonly guideUrl?: string;
    }
  | {
      readonly kind: 'xtream';
      readonly name: string;
      readonly server: string;
      readonly username: string;
      readonly password: string;
      readonly guideUrl?: string;
    };

/** Active ephemeral LAN pairing session metadata shown to the user as a QR code and fallback URL. */
export interface LanPairingSessionInfo {
  readonly url: string;
  readonly token: string;
  readonly host: string;
  readonly port: number;
  readonly expiresAtMs: number;
}

/** Validates that a pairing session token is at least 32 hex characters (128 bits) and bounded. */
export function isValidPairingToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

/** Constant-time string equality comparison over UTF-16 code units without early mismatch exit. */
export function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

function formatHostForAuthority(host: string): string | null {
  const trimmed = host.trim();
  if (trimmed.length === 0 || WHITESPACE_OR_CONTROL_RE.test(trimmed)) return null;
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1);
    if (inner.length === 0 || inner.includes('[') || inner.includes(']')) return null;
    return `[${inner.toLowerCase()}]`;
  }
  if (trimmed.includes(':')) {
    return `[${trimmed.toLowerCase()}]`;
  }
  return trimmed.toLowerCase();
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

/** Builds the pairing URL `http://<host>:<port>/pair/<token>`, bracketing IPv6 literals. */
export function buildLanPairingUrl(host: string, port: number, token: string): string {
  const formattedHost = formatHostForAuthority(host) ?? host.trim();
  return `http://${formattedHost}:${port}/pair/${token}`;
}

/** Checks whether an HTTP request path matches `/pair/<expectedToken>` in constant time. */
export function isValidPairingPath(path: string, expectedToken: string): boolean {
  if (!isValidPairingToken(expectedToken)) return false;
  const queryStart = path.indexOf('?');
  const cleanPath = queryStart === -1 ? path : path.slice(0, queryStart);
  const prefix = '/pair/';
  if (!cleanPath.startsWith(prefix)) return false;
  const candidate = cleanPath.slice(prefix.length);
  return constantTimeEqual(candidate, expectedToken);
}

function parseIpv4(raw: string): readonly [number, number, number, number] | null {
  const parts = raw.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!IPV4_OCTET_RE.test(part)) return null;
    const value = Number.parseInt(part, 10);
    if (value < 0 || value > 255) return null;
    octets.push(value);
  }
  const [a, b, c, d] = octets;
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  return [a, b, c, d];
}

function isPrivateOrLoopbackIpv4(octets: readonly [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  return false;
}

function parseIpv6SegmentList(segmentStr: string, allowTrailingIpv4: boolean): number[] | null {
  if (segmentStr.length === 0) return [];
  const rawParts = segmentStr.split(':');
  const groups: number[] = [];
  for (let i = 0; i < rawParts.length; i++) {
    const part = rawParts[i];
    if (part === undefined) return null;
    if (part.includes('.')) {
      if (!allowTrailingIpv4 || i !== rawParts.length - 1) return null;
      const ipv4 = parseIpv4(part);
      if (ipv4 === null) return null;
      groups.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
    } else {
      if (!IPV6_GROUP_RE.test(part)) return null;
      groups.push(Number.parseInt(part, 16));
    }
  }
  return groups;
}

function parseIpv6(raw: string): readonly number[] | null {
  let addr = raw;
  const pctIndex = addr.indexOf('%');
  if (pctIndex !== -1) {
    const zone = addr.slice(pctIndex + 1);
    if (!IPV6_ZONE_RE.test(zone)) return null;
    addr = addr.slice(0, pctIndex);
  }
  if (!addr.includes(':')) return null;

  const halves = addr.split('::');
  if (halves.length > 2) return null;

  const firstHalf = halves[0];
  if (firstHalf === undefined) return null;

  if (halves.length === 1) {
    const groups = parseIpv6SegmentList(firstHalf, true);
    if (groups === null || groups.length !== 8) return null;
    return groups;
  }

  const secondHalf = halves[1];
  if (secondHalf === undefined) return null;

  const left = parseIpv6SegmentList(firstHalf, false);
  const right = parseIpv6SegmentList(secondHalf, true);
  if (left === null || right === null) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

/**
 * Validates that a peer IP address belongs strictly to a private LAN or loopback range:
 * RFC1918 IPv4 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), IPv4-mapped IPv6 private/loopback,
 * IPv6 ULA (`fc00::/7`), IPv6 link-local (`fe80::/10`), and loopback (`127.0.0.0/8`, `::1`).
 * Rejects public WAN IPs, CGNAT, cloud metadata (`169.254.0.0/16`), multicast, and malformed strings.
 */
export function isPrivateLanAddress(ip: string): boolean {
  if (ip.length === 0 || ip.length > 128 || WHITESPACE_OR_CONTROL_RE.test(ip)) {
    return false;
  }

  const ipv4 = parseIpv4(ip);
  if (ipv4 !== null) {
    return isPrivateOrLoopbackIpv4(ipv4);
  }

  const groups = parseIpv6(ip);
  if (groups === null || groups.length !== 8) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  if (
    g0 === undefined ||
    g1 === undefined ||
    g2 === undefined ||
    g3 === undefined ||
    g4 === undefined ||
    g5 === undefined ||
    g6 === undefined ||
    g7 === undefined
  ) {
    return false;
  }

  if (
    g0 === 0 &&
    g1 === 0 &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    g5 === 0 &&
    g6 === 0 &&
    g7 === 1
  ) {
    return true;
  }

  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPrivateOrLoopbackIpv4([(g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff]);
  }

  // IPv6 ULA (fc00::/7)
  if ((g0 & 0xfe00) === 0xfc00) return true;
  // IPv6 link-local (fe80::/10)
  if ((g0 & 0xffc0) === 0xfe80) return true;

  return false;
}

/**
 * Validates that the HTTP `Host` header matches `<expectedHost>:<expectedPort>`
 * (or `<expectedHost>` when `expectedPort === 80`) to defend against DNS rebinding.
 */
export function isValidPairingHostHeader(
  hostHeader: string | undefined,
  expectedHost: string,
  expectedPort: number,
): boolean {
  const formattedHost = formatHostForAuthority(expectedHost);
  if (formattedHost === null || !isValidPort(expectedPort)) return false;
  if (hostHeader === undefined) return false;
  const candidate = hostHeader.trim().toLowerCase();
  if (candidate.length === 0 || WHITESPACE_OR_CONTROL_RE.test(candidate)) return false;
  if (candidate === `${formattedHost}:${expectedPort}`) return true;
  return expectedPort === 80 && candidate === formattedHost;
}

/**
 * Validates the HTTP `Origin` header on pairing submissions:
 * allows an absent `Origin` (non-CORS same-origin form post) or an exact
 * `http://<expectedHost>:<expectedPort>` match; rejects cross-origin sites and `null`.
 */
export function isValidPairingOrigin(
  originHeader: string | undefined,
  expectedHost: string,
  expectedPort: number,
): boolean {
  const formattedHost = formatHostForAuthority(expectedHost);
  if (formattedHost === null || !isValidPort(expectedPort)) return false;
  if (originHeader === undefined) return true;
  const candidate = originHeader.trim().toLowerCase();
  if (candidate.length === 0 || WHITESPACE_OR_CONTROL_RE.test(candidate)) return false;
  if (candidate === `http://${formattedHost}:${expectedPort}`) return true;
  return expectedPort === 80 && candidate === `http://${formattedHost}`;
}

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function cleanStringField(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_CHARS_RE, '').trim();
}

function parseHttpUrl(raw: string): URL | null {
  if (raw.length === 0 || WHITESPACE_OR_CONTROL_RE.test(raw)) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.hostname.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseRawFields(
  rawBody: string,
  contentType: string | undefined,
): Result<Record<string, unknown>> {
  const mime = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  const isJson =
    mime === 'application/json' ||
    mime.endsWith('+json') ||
    (mime === '' && rawBody.trimStart().startsWith('{'));
  const isForm = mime === 'application/x-www-form-urlencoded' || (mime === '' && !isJson);

  if (isJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return err(elvError('source-format', 'invalid-json'));
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return err(elvError('source-format', 'invalid-payload'));
    }
    return ok(parsed as Record<string, unknown>);
  }

  if (isForm) {
    const params = new URLSearchParams(rawBody);
    const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of params.entries()) {
      record[key] = value;
    }
    return ok(record);
  }

  return err(elvError('source-format', 'unsupported-content-type'));
}

/**
 * Parses and validates an M3U or Xtream source payload submitted to the LAN pairing server.
 * Accepts JSON or `application/x-www-form-urlencoded`, strips control characters, enforces length caps
 * and `http(s)://` schemes, and returns secret-free `elvError('source-format', ...)` errors on failure.
 */
export function parseLanPairingPayload(
  rawBody: string,
  contentType?: string,
): Result<LanPairingPayload> {
  if (utf8ByteLength(rawBody) > LAN_PAIRING_MAX_BODY_BYTES) {
    return err(elvError('source-format', 'payload-too-large'));
  }

  const parsedFields = parseRawFields(rawBody, contentType);
  if (!parsedFields.ok) return parsedFields;
  const fields = parsedFields.value;

  const kind = cleanStringField(fields.kind).toLowerCase();
  if (kind !== 'm3u' && kind !== 'xtream') {
    return err(elvError('source-format', 'invalid-kind'));
  }

  const rawName = cleanStringField(fields.name);
  if (rawName.length > MAX_NAME_LENGTH) {
    return err(elvError('source-format', 'name-too-long'));
  }

  const rawGuideUrl = cleanStringField(fields.guideUrl);
  let validatedGuideUrl: string | undefined;
  if (rawGuideUrl.length > 0) {
    if (rawGuideUrl.length > MAX_URL_LENGTH) {
      return err(elvError('source-format', 'guide-url-too-long'));
    }
    if (parseHttpUrl(rawGuideUrl) === null) {
      return err(elvError('source-format', 'invalid-guide-url'));
    }
    validatedGuideUrl = rawGuideUrl;
  }

  if (kind === 'm3u') {
    const url = cleanStringField(fields.url);
    if (url.length === 0) return err(elvError('source-format', 'missing-url'));
    if (url.length > MAX_URL_LENGTH) return err(elvError('source-format', 'url-too-long'));
    const parsedUrl = parseHttpUrl(url);
    if (parsedUrl === null) return err(elvError('source-format', 'invalid-url'));

    const name = rawName.length > 0 ? rawName : parsedUrl.hostname.slice(0, MAX_NAME_LENGTH);
    return ok(
      validatedGuideUrl !== undefined
        ? { kind: 'm3u', name, url, guideUrl: validatedGuideUrl }
        : { kind: 'm3u', name, url },
    );
  }

  const server = cleanStringField(fields.server);
  if (server.length === 0) return err(elvError('source-format', 'missing-server'));
  if (server.length > MAX_URL_LENGTH) return err(elvError('source-format', 'server-too-long'));
  const parsedServer = parseHttpUrl(server);
  if (parsedServer === null) return err(elvError('source-format', 'invalid-server'));

  const username = cleanStringField(fields.username);
  if (username.length === 0) return err(elvError('source-format', 'missing-username'));
  if (username.length > MAX_CREDENTIAL_LENGTH) {
    return err(elvError('source-format', 'username-too-long'));
  }

  const password = cleanStringField(fields.password);
  if (password.length === 0) return err(elvError('source-format', 'missing-password'));
  if (password.length > MAX_CREDENTIAL_LENGTH) {
    return err(elvError('source-format', 'password-too-long'));
  }

  const name = rawName.length > 0 ? rawName : parsedServer.hostname.slice(0, MAX_NAME_LENGTH);
  return ok(
    validatedGuideUrl !== undefined
      ? { kind: 'xtream', name, server, username, password, guideUrl: validatedGuideUrl }
      : { kind: 'xtream', name, server, username, password },
  );
}
