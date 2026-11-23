const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const MINUTE = 60_000;
const MAX_TZ_CACHE = 64;

const tzFormatterCache = new Map<string, Intl.DateTimeFormat | null>();

function getTimeZoneFormatter(timeZone: string): Intl.DateTimeFormat | undefined {
  const trimmed = timeZone.trim();
  if (trimmed.length === 0) return undefined;
  const cached = tzFormatterCache.get(trimmed);
  if (cached !== undefined) return cached ?? undefined;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: trimmed,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    if (tzFormatterCache.size >= MAX_TZ_CACHE) tzFormatterCache.clear();
    tzFormatterCache.set(trimmed, fmt);
    return fmt;
  } catch {
    if (tzFormatterCache.size >= MAX_TZ_CACHE) tzFormatterCache.clear();
    tzFormatterCache.set(trimmed, null);
    return undefined;
  }
}

function zoneOffsetMs(epochMs: number, fmt: Intl.DateTimeFormat): number {
  let y = 0;
  let m = 1;
  let d = 1;
  let h = 0;
  let min = 0;
  let s = 0;
  for (const part of fmt.formatToParts(new Date(epochMs))) {
    if (part.type === 'year') y = Number(part.value);
    else if (part.type === 'month') m = Number(part.value);
    else if (part.type === 'day') d = Number(part.value);
    else if (part.type === 'hour') h = Number(part.value) % 24;
    else if (part.type === 'minute') min = Number(part.value);
    else if (part.type === 'second') s = Number(part.value);
  }
  return Date.UTC(y, m - 1, d, h, min, s) - epochMs;
}

/**
 * Converts a wall-clock instant (encoded as UTC ms) to true epoch ms in `timeZone` using
 * deterministic 2-pass offset resolution. Handles spring-forward gaps by advancing past the gap
 * and fall-back overlaps deterministically. Falls back to `wallUtcMs` on invalid timezones.
 */
function resolveWallClockInTimeZone(wallUtcMs: number, timeZone: string): number {
  const fmt = getTimeZoneFormatter(timeZone);
  if (fmt === undefined) return wallUtcMs;
  const off1 = zoneOffsetMs(wallUtcMs, fmt);
  const guess1 = wallUtcMs - off1;
  const off2 = zoneOffsetMs(guess1, fmt);
  if (off2 === off1) return guess1;
  const guess2 = wallUtcMs - off2;
  if (zoneOffsetMs(guess2, fmt) === off2) return guess2;
  // Spring-forward gap: wall clock does not exist; advance into the post-transition offset.
  return wallUtcMs - Math.min(off1, off2);
}

/** Options for {@link parseXmltvTime}. */
export interface ParseXmltvTimeOptions {
  /** IANA timezone (e.g. `Europe/Berlin`, `America/New_York`) applied only when the timestamp omits an explicit offset. */
  readonly defaultTimeZone?: string;
}

function digits(text: string, at: number, count: number): number {
  let v = 0;
  for (let i = at; i < at + count; i++) {
    const c = text.charCodeAt(i) - 48;
    if (c < 0 || c > 9) return -1;
    v = v * 10 + c;
  }
  return v;
}

function daysIn(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return month === 2 && leap ? 29 : (DAYS[month - 1] as number);
}

/** Offset in minutes of the suffix (`+0100`, `-05:00`, `+01`, `Z`, `UTC`, `GMT`, `UTC±HHMM`, `GMT±HH:MM`), or undefined when malformed. */
function parseOffset(text: string): number | undefined {
  if (text === '') return 0;
  const upper = text.toUpperCase();
  if (upper === 'Z' || upper === 'UTC' || upper === 'GMT') return 0;
  let rest = upper;
  if (rest.startsWith('UTC') || rest.startsWith('GMT')) {
    rest = rest.slice(3).trimStart();
  }
  const sign = rest[0] === '-' ? -1 : rest[0] === '+' ? 1 : 0;
  if (sign === 0) return undefined;
  const body =
    rest.length === 6 && rest[3] === ':' ? rest.slice(1, 3) + rest.slice(4) : rest.slice(1);
  if (body.length !== 2 && body.length !== 4) return undefined;
  const hours = digits(body, 0, 2);
  const minutes = body.length === 4 ? digits(body, 2, 2) : 0;
  if (hours < 0 || minutes < 0 || hours > 23 || minutes > 59) return undefined;
  return sign * (hours * 60 + minutes);
}

/**
 * Parses an XMLTV time, `YYYYMMDDHHMMSS ±HHMM`, to epoch milliseconds. Shorter forms down to `YYYY` and a
 * missing offset (UTC, or `opts.defaultTimeZone` when provided and valid) are accepted; any invalid field
 * gives `undefined`. Written by hand: no `Date.parse`.
 */
export function parseXmltvTime(text: string, opts?: ParseXmltvTimeOptions): number | undefined {
  const t = text.trim();
  let n = 0;
  while (n < t.length && n < 14) {
    const c = t.charCodeAt(n);
    if (c < 48 || c > 57) break;
    n++;
  }
  if (n < 4 || n % 2 !== 0) return undefined;
  const year = digits(t, 0, 4);
  const month = n >= 6 ? digits(t, 4, 2) : 1;
  const day = n >= 8 ? digits(t, 6, 2) : 1;
  const hour = n >= 10 ? digits(t, 8, 2) : 0;
  const minute = n >= 12 ? digits(t, 10, 2) : 0;
  const second = n >= 14 ? digits(t, 12, 2) : 0;
  if (year < 1000 || month < 1 || month > 12) return undefined;
  if (day < 1 || day > daysIn(year, month) || hour > 23 || minute > 59 || second > 59)
    return undefined;
  const suffix = t.slice(n).trim();
  const wallUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  if (suffix === '') {
    return opts?.defaultTimeZone !== undefined
      ? resolveWallClockInTimeZone(wallUtcMs, opts.defaultTimeZone)
      : wallUtcMs;
  }
  const offset = parseOffset(suffix);
  if (offset === undefined) return undefined;
  return wallUtcMs - offset * MINUTE;
}
