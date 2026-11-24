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

const TZ_FORMATTERS = new Map<string, Intl.DateTimeFormat | null>();

/**
 * Normalizes a Stalker/Ministra portal URL into its API load endpoint (`portal.php` or
 * `server/load.php`) plus an optional 404 fallback endpoint probed during handshake.
 */
export function normalizeStalkerPortalUrl(raw: string): Result<StalkerPortalEndpoint> {
  const invalid = () => err(elvError('source-format', 'invalid-portal-url'));
  if (typeof raw !== 'string') return invalid();
  const trimmed = raw.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_URL_LENGTH ||
    CONTROL_OR_SPACE_RE.test(trimmed)
  ) {
    return invalid();
  }
  if (trimmed.startsWith('/')) return invalid();

  let candidate = trimmed;
  if (trimmed.includes('://')) {
    if (!HTTP_SCHEME_RE.test(trimmed)) return invalid();
  } else if (ANY_SCHEME_PREFIX_RE.test(trimmed) && !HOST_PORT_RE.test(trimmed)) {
    return invalid();
  } else {
    candidate = `http://${trimmed}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return invalid();
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    return invalid();
  }

  const origin = parsed.origin;
  const pathname = parsed.pathname.replace(/\/+$/, '');

  if (/\/(?:portal\.php|server\/load\.php)$/i.test(pathname)) {
    return ok({ endpoint: `${origin}${pathname}` });
  }
  if (/\/stalker_portal\/c$/i.test(pathname)) {
    const prefix = pathname.slice(0, -2);
    return ok({ endpoint: `${origin}${prefix}/server/load.php` });
  }
  if (/\/c$/i.test(pathname)) {
    const base = `${origin}${pathname.slice(0, -2)}`;
    return ok({
      endpoint: `${base}/portal.php`,
      fallbackEndpoint: `${base}/stalker_portal/server/load.php`,
    });
  }
  if (/\/stalker_portal$/i.test(pathname)) {
    const base = `${origin}${pathname}`;
    return ok({
      endpoint: `${base}/server/load.php`,
      fallbackEndpoint: `${base}/portal.php`,
    });
  }
  const base = `${origin}${pathname}`;
  return ok({
    endpoint: `${base}/portal.php`,
    fallbackEndpoint: `${base}/stalker_portal/server/load.php`,
  });
}

/** Strips leading Stalker playback command wrappers (`ffmpeg `, `ffrt `, `ffrt2 `, `ffrt3 `, `auto `). */
export function stripStalkerCommandPrefix(rawCmd: string): string {
  let out = rawCmd.trim();
  while (CMD_PREFIX_RE.test(out)) {
    out = out.replace(CMD_PREFIX_RE, '').trim();
  }
  return out;
}

/** Strips command wrappers and validates that a `create_link` output is an `http(s)://` URL. */
export function validateStalkerStreamUrl(rawCmd: string): Result<string> {
  const url = stripStalkerCommandPrefix(rawCmd);
  if (url.length === 0) return err(elvError('playback', 'stream-unavailable'));
  if (url.length > MAX_STREAM_URL_LENGTH || CONTROL_OR_SPACE_RE.test(url)) {
    return err(elvError('playback', 'unsupported-scheme'));
  }
  if (!HTTP_SCHEME_RE.test(url) || originOf(url) === undefined) {
    return err(elvError('playback', 'unsupported-scheme'));
  }
  try {
    const parsed = new URL(url);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hostname === '') {
      return err(elvError('playback', 'unsupported-scheme'));
    }
  } catch {
    return err(elvError('playback', 'unsupported-scheme'));
  }
  return ok(url);
}

function daysInMonth(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return month === 2 && leap ? 29 : (DAYS_IN_MONTH[month - 1] as number);
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
  if (!zone || zone.toUpperCase() === 'UTC' || m[4] === undefined) return wallMs;
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
