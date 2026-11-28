import { elvError, err, ok, openAsyncIterator, originOf, type Result } from '@elv/domain';
import { toElvError } from './scan-error';
import type { StalkerPortalEndpoint } from './stalker-types';
import { toNumber } from './xtream-normalize';

const MAX_URL_LENGTH = 2048;
const MAX_STREAM_URL_LENGTH = 4096;
const FIRST_BUFFER_BYTES = 64 * 1024;
const MAX_TZ_CACHE = 64;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejects ASCII control characters in URLs
const CONTROL_OR_SPACE_RE = /[\u0000-\u0020\u007f]|\s/;
const HTTP_SCHEME_RE = /^https?:\/\//i;
const ANY_SCHEME_PREFIX_RE = /^[a-z][a-z0-9+.-]*:/i;
const HOST_PORT_RE = /^(?:[a-z0-9.-]+|\[[0-9a-f:]+\]):\d+(?:\/|[?#]|$)/i;
const CMD_PREFIX_RE = /^(?:ffmpeg|ffrt\d*|auto)(?:\s+|$)/i;
const DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[ Tt](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d{1,6})?(Z|z|[+-]\d{2}:?\d{2})?)?$/;
const FIXED_TZ_OFFSET_RE = /^(?:(?:UTC|GMT)\s*)?([+-])(\d{1,2})(?::?(\d{2}))?$/i;
const PHP_FILE_RE = /\.php$/i;
const SERVER_LOAD_PHP_RE = /\/server\/load\.php$/i;
const STALKER_PORTAL_TAIL_RE = /\/stalker_portal$/i;
const STALKER_PORTAL_C_TAIL_RE = /\/stalker_portal\/c$/i;
const C_TAIL_RE = /\/c$/i;
const INDEX_TAIL_RE = /\/index\.(?:html?|php)$/i;

const utf8Encoder = new TextEncoder();
const TZ_FORMATTERS = new Map<string, Intl.DateTimeFormat | null>();

function pushUniqueCandidate(out: string[], seen: Set<string>, url: string): void {
  if (/\/stalker_portal\/stalker_portal(?:\/|$)/i.test(url)) return;
  if (seen.has(url)) return;
  seen.add(url);
  out.push(url);
}

function appendDirectoryCandidates(
  out: string[],
  seen: Set<string>,
  origin: string,
  dirPath: string,
): void {
  const base = `${origin}${dirPath}`;
  pushUniqueCandidate(out, seen, `${base}/portal.php`);
  pushUniqueCandidate(out, seen, `${base}/server/load.php`);
  if (!STALKER_PORTAL_TAIL_RE.test(dirPath)) {
    pushUniqueCandidate(out, seen, `${base}/stalker_portal/server/load.php`);
  }
}

function parseHttpPortalUrl(raw: string): URL | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_URL_LENGTH ||
    CONTROL_OR_SPACE_RE.test(trimmed) ||
    trimmed.startsWith('/')
  ) {
    return undefined;
  }
  let candidate = trimmed;
  if (trimmed.includes('://')) {
    if (!HTTP_SCHEME_RE.test(trimmed)) return undefined;
  } else if (ANY_SCHEME_PREFIX_RE.test(trimmed) && !HOST_PORT_RE.test(trimmed)) {
    return undefined;
  } else {
    candidate = `http://${trimmed}`;
  }
  try {
    const parsed = new URL(candidate);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.hostname.length === 0 ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Normalizes a Stalker/Ministra portal URL into its primary API endpoint plus a full deduplicated
 * candidate list for behavioral discovery (`portal.php`, `server/load.php`, `stalker_portal/server/load.php`,
 * explicit `.php` siblings, and literal `/c/` paths).
 */
export function normalizeStalkerPortalUrl(raw: string): Result<StalkerPortalEndpoint> {
  const parsed = parseHttpPortalUrl(raw);
  if (parsed === undefined) return err(elvError('source-format', 'invalid-portal-url'));

  const origin = parsed.origin;
  const pathname = parsed.pathname.replace(/\/+$/, '');
  const candidates: string[] = [];
  const seen = new Set<string>();

  if (PHP_FILE_RE.test(pathname)) {
    pushUniqueCandidate(candidates, seen, `${origin}${pathname}`);
    if (SERVER_LOAD_PHP_RE.test(pathname)) {
      const basePath = pathname.slice(0, -'/server/load.php'.length);
      appendDirectoryCandidates(candidates, seen, origin, basePath);
      if (STALKER_PORTAL_TAIL_RE.test(basePath)) {
        const parentPath = basePath.slice(0, -'/stalker_portal'.length);
        appendDirectoryCandidates(candidates, seen, origin, parentPath);
      }
    } else {
      const slash = pathname.lastIndexOf('/');
      const dirPath = slash <= 0 ? '' : pathname.slice(0, slash);
      appendDirectoryCandidates(candidates, seen, origin, dirPath);
      if (C_TAIL_RE.test(dirPath)) {
        const parentPath = dirPath.slice(0, -2);
        appendDirectoryCandidates(candidates, seen, origin, parentPath);
      }
    }
  } else if (STALKER_PORTAL_C_TAIL_RE.test(pathname)) {
    const prefix = pathname.slice(0, -2);
    pushUniqueCandidate(candidates, seen, `${origin}${prefix}/server/load.php`);
    pushUniqueCandidate(candidates, seen, `${origin}${prefix}/portal.php`);
    pushUniqueCandidate(candidates, seen, `${origin}${pathname}/portal.php`);
    pushUniqueCandidate(candidates, seen, `${origin}${pathname}/server/load.php`);
    const parent = prefix.slice(0, -'/stalker_portal'.length);
    appendDirectoryCandidates(candidates, seen, origin, parent);
  } else if (C_TAIL_RE.test(pathname)) {
    const parentPath = pathname.slice(0, -2);
    appendDirectoryCandidates(candidates, seen, origin, parentPath);
    appendDirectoryCandidates(candidates, seen, origin, pathname);
  } else if (STALKER_PORTAL_TAIL_RE.test(pathname)) {
    const base = `${origin}${pathname}`;
    pushUniqueCandidate(candidates, seen, `${base}/server/load.php`);
    pushUniqueCandidate(candidates, seen, `${base}/portal.php`);
  } else {
    appendDirectoryCandidates(candidates, seen, origin, pathname);
  }

  const endpoint = candidates[0] as string;
  const fallbackEndpoint = candidates[1];
  return ok({
    endpoint,
    ...(fallbackEndpoint !== undefined ? { fallbackEndpoint } : {}),
    candidates,
  });
}

function normalizeHostName(rawHost: string): string {
  const unbracketed =
    rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  return unbracketed.toLowerCase().replace(/\.+$/, '');
}

/**
 * Returns `true` when `targetUrl` is a safe same-host portal URL relative to `portalUrl`
 * (matching normalized hostname without trailing DNS dot, and strictly forbidding `https -> http`
 * downgrade).
 */
export function isSameSafePortalHost(portalUrl: string, targetUrl: string): boolean {
  const base = parseHttpPortalUrl(portalUrl);
  if (base === undefined) return false;
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return false;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
  if (base.protocol === 'https:' && target.protocol !== 'https:') return false;
  return normalizeHostName(base.hostname) === normalizeHostName(target.hostname);
}

/**
 * Derives `../server/load.php` and sibling `/c` endpoint candidates when an API probe redirects to
 * an HTML `/c/` landing page on the same normalized host with no `https -> http` downgrade
 * (blocks cross-host credential exfiltration and off-host private-LAN/loopback SSRF).
 */
export function deriveStalkerRedirectCandidates(
  initialEndpoint: string,
  finalUrl: string,
): string[] {
  if (!isSameSafePortalHost(initialEndpoint, finalUrl)) return [];
  const redirected = parseHttpPortalUrl(finalUrl);
  if (redirected === undefined) return [];
  const cleanPath = redirected.pathname.replace(INDEX_TAIL_RE, '').replace(/\/+$/, '');
  if (!C_TAIL_RE.test(cleanPath)) return [];

  const origin = redirected.origin;
  const parentPath = cleanPath.slice(0, -2);
  const out: string[] = [];
  const seen = new Set<string>();
  pushUniqueCandidate(out, seen, `${origin}${parentPath}/server/load.php`);
  pushUniqueCandidate(out, seen, `${origin}${parentPath}/portal.php`);
  if (!STALKER_PORTAL_TAIL_RE.test(parentPath)) {
    pushUniqueCandidate(out, seen, `${origin}${parentPath}/stalker_portal/server/load.php`);
  }
  pushUniqueCandidate(out, seen, `${origin}${cleanPath}/portal.php`);
  pushUniqueCandidate(out, seen, `${origin}${cleanPath}/server/load.php`);
  return out;
}

/**
 * Encodes a Stalker `create_link` `cmd` query parameter using single-decode STB wire semantics:
 * leaves `%` unescaped (preventing `%3A` -> `%253A` double-encoding) while percent-encoding `&`,
 * `#`, `;`, `+`, whitespace, quotes, angle brackets, backticks, ASCII control characters, and
 * non-ASCII UTF-8 bytes.
 */
export function encodeStalkerCmdQueryValue(cmd: string): string {
  const bytes = utf8Encoder.encode(cmd);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i] as number;
    if (
      b <= 0x20 ||
      b >= 0x7f ||
      b === 0x22 || // "
      b === 0x23 || // #
      b === 0x26 || // &
      b === 0x27 || // '
      b === 0x2b || // +
      b === 0x3b || // ;
      b === 0x3c || // <
      b === 0x3e || // >
      b === 0x60 // `
    ) {
      out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    } else {
      out += String.fromCharCode(b);
    }
  }
  return out;
}

/** Strips leading Stalker playback command wrappers (`ffmpeg `, `ffrt `, `ffrt2 `, `ffrt3 `, `auto `). */
export function stripStalkerCommandPrefix(rawCmd: string): string {
  let out = rawCmd.trim();
  while (CMD_PREFIX_RE.test(out)) {
    out = out.replace(CMD_PREFIX_RE, '').trim();
  }
  return out;
}

function resolvePortalInstallBase(
  portalEndpoint: string | undefined,
): { origin: string; basePath: string; baseUrl: string } | undefined {
  if (portalEndpoint === undefined) return undefined;
  const parsed = parseHttpPortalUrl(portalEndpoint);
  if (parsed === undefined) return undefined;
  const pathname = parsed.pathname.replace(/\/+$/, '');
  let basePath: string;
  if (SERVER_LOAD_PHP_RE.test(pathname)) {
    basePath = pathname.slice(0, -'/server/load.php'.length);
  } else if (PHP_FILE_RE.test(pathname)) {
    const slash = pathname.lastIndexOf('/');
    basePath = slash <= 0 ? '' : pathname.slice(0, slash);
  } else {
    basePath = pathname;
  }
  return {
    origin: parsed.origin,
    basePath,
    baseUrl: `${parsed.origin}${basePath}/`,
  };
}

/**
 * Strips command wrappers and validates that a `create_link` output is an `http(s)://` URL.
 * When `portalEndpoint` is supplied, resolves relative `/media/...` and query-only `?token=...`
 * outputs against the portal installation base path (preserving subpaths like `/stalker_portal/`).
 */
export function validateStalkerStreamUrl(rawCmd: string, portalEndpoint?: string): Result<string> {
  const url = stripStalkerCommandPrefix(rawCmd);
  if (url.length === 0) return err(elvError('playback', 'stream-unavailable'));
  if (url.length > MAX_STREAM_URL_LENGTH || CONTROL_OR_SPACE_RE.test(url)) {
    return err(elvError('playback', 'unsupported-scheme'));
  }
  if (url.startsWith('//')) {
    return err(elvError('playback', 'unsupported-scheme'));
  }

  let resolved = url;
  if (HTTP_SCHEME_RE.test(url)) {
    if (originOf(url) === undefined) return err(elvError('playback', 'unsupported-scheme'));
  } else if (ANY_SCHEME_PREFIX_RE.test(url)) {
    return err(elvError('playback', 'unsupported-scheme'));
  } else {
    const base = resolvePortalInstallBase(portalEndpoint);
    if (base === undefined) return err(elvError('playback', 'unsupported-scheme'));
    try {
      let target: URL;
      if (url.startsWith('?')) {
        target = new URL(url, base.baseUrl);
      } else if (url.startsWith('/')) {
        const lowerUrl = url.toLowerCase();
        const lowerPrefix = `${base.basePath.toLowerCase()}/`;
        if (base.basePath.length > 0 && !lowerUrl.startsWith(lowerPrefix)) {
          target = new URL(url.slice(1), base.baseUrl);
        } else {
          target = new URL(url, base.origin);
        }
      } else {
        target = new URL(url, base.baseUrl);
      }
      if (target.origin !== base.origin) return err(elvError('playback', 'unsupported-scheme'));
      resolved = target.toString();
    } catch {
      return err(elvError('playback', 'unsupported-scheme'));
    }
  }

  if (resolved.length > MAX_STREAM_URL_LENGTH || CONTROL_OR_SPACE_RE.test(resolved)) {
    return err(elvError('playback', 'unsupported-scheme'));
  }
  try {
    const parsed = new URL(resolved);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hostname === '') {
      return err(elvError('playback', 'unsupported-scheme'));
    }
  } catch {
    return err(elvError('playback', 'unsupported-scheme'));
  }
  return ok(resolved);
}

function daysInMonth(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return month === 2 && leap ? 29 : (DAYS_IN_MONTH[month - 1] as number);
}

function parseFixedTimezoneOffsetMinutes(zone: string): number | undefined {
  const upper = zone.toUpperCase();
  if (upper === 'UTC' || upper === 'GMT' || upper === 'Z') return 0;
  const m = FIXED_TZ_OFFSET_RE.exec(zone);
  if (m === null) return undefined;
  const sign = m[1] === '-' ? -1 : 1;
  const hours = Number(m[2]);
  const minutes = m[3] === undefined ? 0 : Number(m[3]);
  if (hours > 14 || minutes > 59 || (hours === 14 && minutes > 0)) return undefined;
  return sign * (hours * 60 + minutes);
}

function tzFormatter(timeZone: string): Intl.DateTimeFormat | null {
  if (typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') return null;
  const cached = TZ_FORMATTERS.get(timeZone);
  if (cached !== undefined) return cached;
  let fmt: Intl.DateTimeFormat | null = null;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    fmt = null;
  }
  if (TZ_FORMATTERS.size >= MAX_TZ_CACHE) TZ_FORMATTERS.clear();
  TZ_FORMATTERS.set(timeZone, fmt);
  return fmt;
}

function tzWallAsUtcMs(fmt: Intl.DateTimeFormat, epochMs: number): number {
  let y = 0;
  let mo = 1;
  let d = 1;
  let h = 0;
  let mi = 0;
  let s = 0;
  for (const part of fmt.formatToParts(new Date(epochMs))) {
    if (part.type === 'year') y = Number(part.value);
    else if (part.type === 'month') mo = Number(part.value);
    else if (part.type === 'day') d = Number(part.value);
    else if (part.type === 'hour') h = Number(part.value) % 24;
    else if (part.type === 'minute') mi = Number(part.value);
    else if (part.type === 'second') s = Number(part.value);
  }
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

/** Parses Stalker numeric epoch seconds/ms or ISO/SQL datetime strings into epoch milliseconds. */
export function parseStalkerTimestampMs(value: unknown, timeZone?: string): number | undefined {
  const numeric = toNumber(value);
  if (numeric !== undefined) {
    if (numeric <= 0) return undefined;
    return numeric >= 1e12 ? Math.trunc(numeric) : Math.trunc(numeric * 1000);
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.startsWith('0000-00-00')) return undefined;
  const m = DATETIME_RE.exec(trimmed);
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = m[4] === undefined ? 0 : Number(m[4]);
  const minute = m[5] === undefined ? 0 : Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  if (year < 1970 || month < 1 || month > 12) return undefined;
  if (day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) {
    return undefined;
  }
  const wallMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const tzPart = m[7];
  if (tzPart !== undefined) {
    if (tzPart === 'Z' || tzPart === 'z') return wallMs;
    const sign = tzPart[0] === '-' ? -1 : 1;
    const digits = tzPart.slice(1).replace(':', '');
    const offH = Number(digits.slice(0, 2));
    const offM = Number(digits.slice(2, 4));
    if (offH > 23 || offM > 59) return undefined;
    return wallMs - sign * (offH * 60 + offM) * 60_000;
  }
  const zone = timeZone?.trim();
  if (!zone || m[4] === undefined) return wallMs;
  const fixedOffsetMin = parseFixedTimezoneOffsetMinutes(zone);
  if (fixedOffsetMin !== undefined) return wallMs - fixedOffsetMin * 60_000;
  const fmt = tzFormatter(zone);
  if (fmt === null) return wallMs;
  const offset1 = tzWallAsUtcMs(fmt, wallMs) - wallMs;
  const candidate1 = wallMs - offset1;
  const offset2 = tzWallAsUtcMs(fmt, candidate1) - candidate1;
  return wallMs - offset2;
}

/** Quietly cancels an unused HTTP response body stream. */
export async function discardStalkerBody(body: AsyncIterable<Uint8Array>): Promise<void> {
  try {
    await openAsyncIterator(body).return?.();
  } catch {
    // Response is already classified by its HTTP status.
  }
}

/** Reads an HTTP response body into memory up to `maxBytes`, returning `too-large` when exceeded. */
export async function readBoundedStalkerBody(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<Result<Uint8Array>> {
  let buffer = new Uint8Array(Math.min(FIRST_BUFFER_BYTES, Math.max(1, maxBytes)));
  let total = 0;
  const it = openAsyncIterator(body);
  try {
    for (;;) {
      const step = await it.next();
      if (step.done) break;
      const chunk = step.value;
      if (total + chunk.length > maxBytes) {
        await it.return?.();
        return err(elvError('source-format', 'too-large'));
      }
      if (total + chunk.length > buffer.length) {
        const grown = new Uint8Array(
          Math.min(maxBytes, Math.max(buffer.length * 2, total + chunk.length)),
        );
        grown.set(buffer.subarray(0, total));
        buffer = grown;
      }
      buffer.set(chunk, total);
      total += chunk.length;
    }
  } catch (e) {
    await it.return?.().catch(() => undefined);
    return err(toElvError(e));
  }
  return ok(buffer.subarray(0, total));
}
