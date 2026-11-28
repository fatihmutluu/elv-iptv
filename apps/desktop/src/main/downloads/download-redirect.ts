import { lookup as dnsLookup } from 'node:dns/promises';

/** Maximum manual HTTP 3xx redirects followed for one offline VOD download request. */
export const MAX_DOWNLOAD_REDIRECT_HOPS = 8;

const MAX_DOWNLOAD_URL_CHARS = 8 * 1024;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const SAFE_REDIRECT_HEADER_NAMES: ReadonlySet<string> = new Set([
  'range',
  'user-agent',
  'accept',
  'accept-language',
  'referer',
  'origin',
  'if-range',
  'if-none-match',
  'if-modified-since',
]);
const METADATA_HOSTS: ReadonlySet<string> = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata.aws.internal',
  'instance-data',
]);

/** Async DNS resolver returning all A/AAAA IP address literals for a non-IP hostname. */
export type DownloadDnsLookup = (hostname: string) => Promise<readonly string[]>;

async function defaultDownloadDnsLookup(hostname: string): Promise<readonly string[]> {
  const rows = await dnsLookup(hostname, { all: true, verbatim: true });
  return rows.map((row) => row.address);
}

/** Network boundary classification for a download target hostname or IP literal. */
export type DownloadHostClass =
  | 'metadata'
  | 'loopback'
  | 'private-lan'
  | 'link-local'
  | 'unspecified'
  | 'public';

/** Failure reason raised by {@link fetchDownloadWithManualRedirects}. */
export type DownloadRedirectErrorReason =
  | 'invalid-url'
  | 'ssrf-blocked'
  | 'dns-lookup-failed'
  | 'too-many-redirects';

/** Typed fail-closed error thrown when a download URL or redirect hop violates security policy. */
export class DownloadRedirectError extends Error {
  readonly reason: DownloadRedirectErrorReason;

  constructor(reason: DownloadRedirectErrorReason, message: string) {
    super(message);
    this.name = 'DownloadRedirectError';
    this.reason = reason;
  }
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function normalizeHostRaw(rawHost: string): string {
  let host = rawHost.trim().toLowerCase();
  while (host.endsWith('.')) host = host.slice(0, -1);
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  return host;
}

function parseIpv4Part(part: string): number | null {
  if (part.length === 0) return null;
  let value: number;
  if (/^0x[0-9a-f]+$/i.test(part)) {
    value = Number.parseInt(part.slice(2), 16);
  } else if (/^0[0-7]+$/.test(part)) {
    value = Number.parseInt(part, 8);
  } else if (/^(?:0|[1-9][0-9]*)$/.test(part)) {
    value = Number.parseInt(part, 10);
  } else {
    return null;
  }
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) return null;
  return value;
}

function parseIpv4ToUint32(host: string): number | null {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    const n = parseIpv4Part(part);
    if (n === null) return null;
    nums.push(n);
  }
  const [a = 0, b = 0, c = 0, d = 0] = nums;
  if (nums.length === 1) return a >>> 0;
  if (nums.length === 2) {
    if (a > 0xff || b > 0xff_ffff) return null;
    return ((a << 24) | b) >>> 0;
  }
  if (nums.length === 3) {
    if (a > 0xff || b > 0xff || c > 0xffff) return null;
    return ((a << 24) | (b << 16) | c) >>> 0;
  }
  if (a > 0xff || b > 0xff || c > 0xff || d > 0xff) return null;
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function classifyIpv4Uint32(addr: number): DownloadHostClass {
  const a = (addr >>> 24) & 0xff;
  const b = (addr >>> 16) & 0xff;
  if (a === 169 && b === 254) return 'metadata';
  if (a === 127) return 'loopback';
  if (a === 0) return 'unspecified';
  if (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  ) {
    return 'private-lan';
  }
  return 'public';
}

function parseIpv6ToHextets(raw: string): number[] | null {
  if (!raw.includes(':')) return null;
  let expanded = raw;
  const lastColon = expanded.lastIndexOf(':');
  const tail = expanded.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4ToUint32(tail);
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    expanded = `${expanded.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = expanded.split('::');
  if (halves.length > 2) return null;

  const parseHalf = (segment: string): number[] | null => {
    if (segment === '') return [];
    const items = segment.split(':');
    const out: number[] = [];
    for (const item of items) {
      if (!/^[0-9a-f]{1,4}$/.test(item)) return null;
      out.push(Number.parseInt(item, 16));
    }
    return out;
  };

  const left = parseHalf(halves[0] ?? '');
  if (left === null) return null;
  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }
  const right = parseHalf(halves[1] ?? '');
  if (right === null) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array<number>(missing).fill(0), ...right];
}

function classifyIpv6Hextets(h: readonly number[]): DownloadHostClass {
  const [h0 = 0, h1 = 0, h2 = 0, h3 = 0, h4 = 0, h5 = 0, h6 = 0, h7 = 0] = h;
  const firstSixZero = h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0;
  const firstFiveZero = h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0;

  if (firstSixZero && h6 === 0 && h7 === 0) return 'unspecified';
  if (firstSixZero && h6 === 0 && h7 === 1) return 'loopback';

  // IPv4-mapped (::ffff:0:0/96), IPv4-translated (::ffff:0:0:0/96), IPv4-compatible (::/96), NAT64 (64:ff9b::/96)
  const isV4Mapped = firstFiveZero && h5 === 0xffff;
  const isV4Translated = h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0xffff && h5 === 0;
  const isV4Compat = firstSixZero;
  const isNat64 = h0 === 0x0064 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0;
  if (isV4Mapped || isV4Translated || isV4Compat || isNat64) {
    return classifyIpv4Uint32(((h6 << 16) | h7) >>> 0);
  }

  // 6to4 (2002::/16): embedded IPv4 in h1:h2
  if (h0 === 0x2002) {
    return classifyIpv4Uint32(((h1 << 16) | h2) >>> 0);
  }

  // Local-use NAT64 (64:ff9b:1::/48, RFC 8215): inspect embedded IPv4 and never classify as public
  if (h0 === 0x0064 && h1 === 0xff9b && h2 === 0x0001) {
    const embedded =
      h3 === 0 && h4 === 0 && h5 === 0
        ? classifyIpv4Uint32(((h6 << 16) | h7) >>> 0)
        : classifyIpv4Uint32(((h3 << 16) | ((h4 & 0xff) << 8) | ((h5 >>> 8) & 0xff)) >>> 0);
    return embedded === 'public' ? 'private-lan' : embedded;
  }

  // AWS IPv6 IMDS fd00:ec2::254
  if (
    h0 === 0xfd00 &&
    h1 === 0x0ec2 &&
    h2 === 0 &&
    h3 === 0 &&
    h4 === 0 &&
    h5 === 0 &&
    h6 === 0 &&
    h7 === 0x0254
  ) {
    return 'metadata';
  }
  if ((h0 & 0xffc0) === 0xfe80) return 'link-local';
  if ((h0 & 0xfe00) === 0xfc00) return 'private-lan';
  if ((h0 & 0xff00) === 0xff00) return 'private-lan';
  return 'public';
}

/**
 * Classifies a hostname or IP literal (including alternate IPv4 hex/octal/int encodings and
 * IPv4-mapped IPv6 addresses) for SSRF redirect policy checks.
 */
export function classifyDownloadHost(rawHost: string): DownloadHostClass {
  const host = normalizeHostRaw(rawHost);
  if (host.length === 0) return 'unspecified';
  if (METADATA_HOSTS.has(host)) return 'metadata';
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';

  if (host.includes(':')) {
    const zoneIdx = host.indexOf('%');
    const addr = zoneIdx >= 0 ? host.slice(0, zoneIdx) : host;
    const hextets = parseIpv6ToHextets(addr);
    if (hextets === null) return 'unspecified';
    const cls = classifyIpv6Hextets(hextets);
    if (zoneIdx >= 0 && cls === 'public') return 'link-local';
    return cls;
  }

  const v4 = parseIpv4ToUint32(host);
  if (v4 !== null) return classifyIpv4Uint32(v4);
  return 'public';
}

function canonicalHostKey(rawHost: string): string {
  const host = normalizeHostRaw(rawHost);
  if (host.includes(':')) {
    const zoneIdx = host.indexOf('%');
    const addr = zoneIdx >= 0 ? host.slice(0, zoneIdx) : host;
    const hextets = parseIpv6ToHextets(addr);
    if (hextets !== null) {
      return hextets.map((n) => n.toString(16).padStart(4, '0')).join(':');
    }
    return addr;
  }
  const v4 = parseIpv4ToUint32(host);
  if (v4 !== null) {
    return `${(v4 >>> 24) & 0xff}.${(v4 >>> 16) & 0xff}.${(v4 >>> 8) & 0xff}.${v4 & 0xff}`;
  }
  return host;
}

function parseValidatedDownloadUrl(rawUrl: string): URL {
  if (
    typeof rawUrl !== 'string' ||
    rawUrl.length === 0 ||
    rawUrl.length > MAX_DOWNLOAD_URL_CHARS ||
    hasControlChar(rawUrl)
  ) {
    throw new DownloadRedirectError('invalid-url', 'disallowed download URL');
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new DownloadRedirectError('invalid-url', 'malformed download URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new DownloadRedirectError('invalid-url', 'disallowed download URL scheme');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new DownloadRedirectError(
      'invalid-url',
      'embedded credentials in download URL are not allowed',
    );
  }
  if (parsed.hostname.length === 0) {
    throw new DownloadRedirectError('invalid-url', 'missing hostname in download URL');
  }
  return parsed;
}

function isIpLiteralHost(rawHost: string): boolean {
  const host = normalizeHostRaw(rawHost);
  if (host.length === 0) return false;
  if (host.includes(':')) {
    const zoneIdx = host.indexOf('%');
    const addr = zoneIdx >= 0 ? host.slice(0, zoneIdx) : host;
    return parseIpv6ToHextets(addr) !== null;
  }
  return parseIpv4ToUint32(host) !== null;
}

function summarizeHostBoundary(classes: readonly DownloadHostClass[]): DownloadHostClass {
  if (classes.includes('metadata')) return 'metadata';
  if (classes.includes('unspecified')) return 'unspecified';
  if (classes.includes('public')) return 'public';
  if (classes.includes('private-lan')) return 'private-lan';
  if (classes.includes('link-local')) return 'link-local';
  return 'loopback';
}

async function resolveHostClasses(
  rawHost: string,
  lookup: DownloadDnsLookup,
): Promise<readonly DownloadHostClass[]> {
  const literalClass = classifyDownloadHost(rawHost);
  if (
    literalClass === 'metadata' ||
    literalClass === 'unspecified' ||
    literalClass === 'loopback' ||
    isIpLiteralHost(rawHost)
  ) {
    return [literalClass];
  }

  let addresses: readonly string[];
  try {
    addresses = await lookup(normalizeHostRaw(rawHost));
  } catch {
    throw new DownloadRedirectError('dns-lookup-failed', 'download hostname DNS lookup failed');
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new DownloadRedirectError(
      'dns-lookup-failed',
      'download hostname resolved to no addresses',
    );
  }

  const classes: DownloadHostClass[] = [];
  for (const addr of addresses) {
    if (typeof addr !== 'string' || !isIpLiteralHost(addr)) {
      throw new DownloadRedirectError('ssrf-blocked', 'invalid DNS lookup address');
    }
    classes.push(classifyDownloadHost(addr));
  }
  return classes;
}

function assertClassTransitionAllowed(
  fromClass: DownloadHostClass,
  fromHostKey: string,
  toClass: DownloadHostClass,
  toHostKey: string,
): void {
  if (toClass === 'metadata') {
    throw new DownloadRedirectError('ssrf-blocked', 'redirect to cloud metadata endpoint blocked');
  }
  if (fromClass === 'public') {
    if (toClass !== 'public') {
      throw new DownloadRedirectError('ssrf-blocked', 'public download redirected to private host');
    }
    return;
  }
  if (fromClass === 'private-lan' || fromClass === 'link-local') {
    if (toClass === 'loopback' || toClass === 'unspecified') {
      throw new DownloadRedirectError('ssrf-blocked', 'LAN download redirected to loopback host');
    }
    return;
  }
  if (fromClass === 'loopback') {
    if (toClass === 'unspecified') {
      throw new DownloadRedirectError(
        'ssrf-blocked',
        'loopback download redirected to unspecified address',
      );
    }
    if (toClass === 'loopback' && toHostKey !== fromHostKey) {
      throw new DownloadRedirectError(
        'ssrf-blocked',
        'redirect across distinct loopback hosts blocked',
      );
    }
    return;
  }
  throw new DownloadRedirectError('ssrf-blocked', 'disallowed download host boundary');
}

function assertRedirectHopAllowed(
  initialBoundary: DownloadHostClass,
  initialHostKey: string,
  currentBoundary: DownloadHostClass,
  currentHostKey: string,
  nextClasses: readonly DownloadHostClass[],
  nextHostKey: string,
): void {
  for (const nextClass of nextClasses) {
    assertClassTransitionAllowed(initialBoundary, initialHostKey, nextClass, nextHostKey);
    assertClassTransitionAllowed(currentBoundary, currentHostKey, nextClass, nextHostKey);
  }
}

function retainSafeRedirectHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!SAFE_REDIRECT_HEADER_NAMES.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

/** Parameters for {@link fetchDownloadWithManualRedirects}. */
export interface ManualDownloadRedirectOptions {
  readonly initialUrl: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly fetchHop: (url: string, init: RequestInit, initialHost: string) => Promise<Response>;
  readonly lookup?: DownloadDnsLookup;
  readonly maxHops?: number;
}

/**
 * Issues a download GET using `redirect: 'manual'` hop-by-hop with strict scheme, userinfo,
 * DNS-resolved SSRF network-boundary, hop-to-hop transition, and cross-host/downgrade
 * safe-header allowlist enforcement.
 */
export async function fetchDownloadWithManualRedirects(
  opts: ManualDownloadRedirectOptions,
): Promise<Response> {
  const maxHops = Math.max(0, Math.floor(opts.maxHops ?? MAX_DOWNLOAD_REDIRECT_HOPS));
  const lookup = opts.lookup ?? defaultDownloadDnsLookup;
  const initialParsed = parseValidatedDownloadUrl(opts.initialUrl);
  const initialClasses = await resolveHostClasses(initialParsed.hostname, lookup);
  if (initialClasses.includes('metadata') || initialClasses.includes('unspecified')) {
    throw new DownloadRedirectError('ssrf-blocked', 'disallowed initial download host');
  }
  const initialBoundary = summarizeHostBoundary(initialClasses);
  const initialHostKey = canonicalHostKey(initialParsed.hostname);
  const initialHostRaw = normalizeHostRaw(initialParsed.hostname);

  let currentParsed = initialParsed;
  let currentBoundary = initialBoundary;
  let currentHostKey = initialHostKey;
  let activeHeaders: Record<string, string> = { ...opts.headers };

  for (let hop = 0; ; hop += 1) {
    const response = await opts.fetchHop(
      currentParsed.toString(),
      {
        method: 'GET',
        headers: { ...activeHeaders },
        signal: opts.signal,
        redirect: 'manual',
      },
      initialHostRaw,
    );

    if (REDIRECT_STATUSES.has(response.status)) {
      const rawLocation = response.headers.get('location');
      if (rawLocation === null || rawLocation.trim().length === 0) {
        return response;
      }
      await response.body?.cancel().catch(() => undefined);

      if (hop >= maxHops) {
        throw new DownloadRedirectError('too-many-redirects', 'too many download redirects');
      }

      const trimmedLocation = rawLocation.trim();
      if (hasControlChar(trimmedLocation)) {
        throw new DownloadRedirectError('invalid-url', 'invalid redirect location header');
      }
      let nextUrlStr: string;
      try {
        nextUrlStr = new URL(trimmedLocation, currentParsed).toString();
      } catch {
        throw new DownloadRedirectError('invalid-url', 'malformed redirect location URL');
      }

      const nextParsed = parseValidatedDownloadUrl(nextUrlStr);
      const nextClasses = await resolveHostClasses(nextParsed.hostname, lookup);
      const nextHostKey = canonicalHostKey(nextParsed.hostname);
      assertRedirectHopAllowed(
        initialBoundary,
        initialHostKey,
        currentBoundary,
        currentHostKey,
        nextClasses,
        nextHostKey,
      );

      const crossHost = nextHostKey !== initialHostKey || nextHostKey !== currentHostKey;
      const downgraded =
        (currentParsed.protocol === 'https:' || initialParsed.protocol === 'https:') &&
        nextParsed.protocol === 'http:';
      if (crossHost || downgraded) {
        activeHeaders = retainSafeRedirectHeaders(activeHeaders);
      }

      currentParsed = nextParsed;
      currentBoundary = summarizeHostBoundary(nextClasses);
      currentHostKey = nextHostKey;
      continue;
    }

    // Defense-in-depth if an injected transport followed redirects internally.
    if (typeof response.url === 'string' && response.url.length > 0) {
      try {
        const finalParsed = parseValidatedDownloadUrl(response.url);
        if (finalParsed.href !== currentParsed.href) {
          const finalClasses = await resolveHostClasses(finalParsed.hostname, lookup);
          assertRedirectHopAllowed(
            initialBoundary,
            initialHostKey,
            currentBoundary,
            currentHostKey,
            finalClasses,
            canonicalHostKey(finalParsed.hostname),
          );
        }
      } catch (error) {
        await response.body?.cancel().catch(() => undefined);
        throw error;
      }
    }

    return response;
  }
}
