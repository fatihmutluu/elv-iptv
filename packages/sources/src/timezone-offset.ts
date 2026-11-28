const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const MAX_TZ_CACHE = 64;
const MIN_OFFSET_MINUTES = -12 * 60;
const MAX_OFFSET_MINUTES = 14 * 60;
const TZ_FORMATTERS = new Map<string, Intl.DateTimeFormat | null>();

const UTC_ALIAS_RE = /^(?:utc|gmt|z)$/i;
const FIXED_OFFSET_RE = /^(?:(?:utc|gmt)\s*)?([+-])(\d{1,2})(?::?(\d{2}))?$/i;
const NAIVE_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?$/;
const STRICT_NUMERIC_RE = /^[+-]?\d+(?:\.\d+)?$/;

/** Zero-padded wall-clock calendar components in a server timezone. */
export interface CalendarParts {
  readonly year: string;
  readonly month: string;
  readonly day: string;
  readonly hour: string;
  readonly minute: string;
  readonly second: string;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
const pad4 = (n: number): string => String(n).padStart(4, '0');

/** Returns the number of calendar days in `month` (1–12) for `year`. */
export function daysInMonth(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return month === 2 && leap ? 29 : (DAYS_IN_MONTH[month - 1] as number);
}

/**
 * Parses fixed UTC/GMT/bare offset strings (`UTC+3`, `UTC-05:30`, `GMT+2`, `+03:00`, `-0400`, `UTC`)
 * into signed minutes within `[-720, +840]`. Returns `undefined` for IANA names or invalid offsets.
 */
export function parseFixedOffsetMinutes(zone: string): number | undefined {
  const trimmed = zone.trim();
  if (trimmed.length === 0) return undefined;
  if (UTC_ALIAS_RE.test(trimmed)) return 0;
  const match = FIXED_OFFSET_RE.exec(trimmed);
  if (match === null) return undefined;
  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = match[3] !== undefined ? Number(match[3]) : 0;
  if (minutes > 59) return undefined;
  const total = sign * (hours * 60 + minutes);
  if (total < MIN_OFFSET_MINUTES || total > MAX_OFFSET_MINUTES) return undefined;
  return total === 0 ? 0 : total;
}

/** Formats signed offset minutes into canonical `UTC±HH:MM`. */
export function formatFixedOffsetTimezone(offsetMinutes: number): string {
  const normalized = Math.round(offsetMinutes);
  const safe = normalized === 0 ? 0 : normalized;
  const sign = safe < 0 ? '-' : '+';
  const abs = Math.abs(safe);
  return `UTC${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** Parses a naive `YYYY-MM-DD HH:mm:ss` panel timestamp as wall-clock UTC milliseconds. */
export function parseNaiveUtcMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const m = NAIVE_DATETIME_RE.exec(value.trim());
  if (m === null) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (year < 1000 || month < 1 || month > 12) return undefined;
  if (day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) {
    return undefined;
  }
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

/**
 * Infers a 15-minute-snapped `UTC±HH:MM` timezone from panel `time_now` minus `timestamp_now`
 * within `[-12h, +14h]`.
 */
export function inferUtcOffsetTimezone(
  timeNow: unknown,
  timestampNow: unknown,
): string | undefined {
  const wallMs = parseNaiveUtcMs(timeNow);
  if (wallMs === undefined) return undefined;
  let rawTs: number;
  if (typeof timestampNow === 'number') {
    rawTs = timestampNow;
  } else if (typeof timestampNow === 'string' && STRICT_NUMERIC_RE.test(timestampNow.trim())) {
    rawTs = Number(timestampNow.trim());
  } else {
    return undefined;
  }
  if (!Number.isFinite(rawTs) || rawTs <= 0) return undefined;
  const tsSec = rawTs >= 1e11 ? rawTs / 1000 : rawTs;
  const diffMinutes = (wallMs / 1000 - tsSec) / 60;
  const snapped = Math.round(diffMinutes / 15) * 15;
  if (snapped < MIN_OFFSET_MINUTES || snapped > MAX_OFFSET_MINUTES) return undefined;
  return formatFixedOffsetTimezone(snapped);
}

function getTzFormatter(timeZone: string): Intl.DateTimeFormat | null {
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

/**
 * Resolves a panel `server_info.timezone` value: accepts valid IANA names and fixed offsets
 * (`UTC+3`, `GMT-05:30`, `+03:00`), falling back to 15-minute-snapped `time_now - timestamp_now`
 * inference when missing or invalid.
 */
export function resolveServerTimezone(
  rawTimezone: unknown,
  timeNow?: unknown,
  timestampNow?: unknown,
): string | undefined {
  if (typeof rawTimezone === 'string') {
    const trimmed = rawTimezone.trim();
    if (trimmed.length > 0) {
      if (UTC_ALIAS_RE.test(trimmed)) return 'UTC';
      const fixed = parseFixedOffsetMinutes(trimmed);
      if (fixed !== undefined) return formatFixedOffsetTimezone(fixed);
      if (getTzFormatter(trimmed) !== null) return trimmed;
    }
  }
  return inferUtcOffsetTimezone(timeNow, timestampNow);
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

/** Converts a naive wall-clock UTC timestamp into epoch milliseconds in `serverTimezone` (fixed offset or IANA). */
export function wallTimeToUtcMs(wallUtcMs: number, serverTimezone?: string): number {
  const zone = serverTimezone?.trim();
  if (!zone) return wallUtcMs;
  const fixed = parseFixedOffsetMinutes(zone);
  if (fixed !== undefined) return wallUtcMs - fixed * 60_000;
  const fmt = getTzFormatter(zone);
  if (fmt === null) return wallUtcMs;
  const offset1 = tzWallAsUtcMs(fmt, wallUtcMs) - wallUtcMs;
  const candidate1 = wallUtcMs - offset1;
  const offset2 = tzWallAsUtcMs(fmt, candidate1) - candidate1;
  return wallUtcMs - offset2;
}

/** Formats epoch milliseconds into zero-padded calendar parts in `serverTimezone` (fixed offset, IANA, or UTC). */
export function utcMsToCalendarParts(epochMs: number, serverTimezone?: string): CalendarParts {
  const zone = serverTimezone?.trim();
  if (zone) {
    const fixed = parseFixedOffsetMinutes(zone);
    if (fixed !== undefined) {
      const shifted = new Date(epochMs + fixed * 60_000);
      return {
        year: pad4(shifted.getUTCFullYear()),
        month: pad2(shifted.getUTCMonth() + 1),
        day: pad2(shifted.getUTCDate()),
        hour: pad2(shifted.getUTCHours()),
        minute: pad2(shifted.getUTCMinutes()),
        second: pad2(shifted.getUTCSeconds()),
      };
    }
    const fmt = getTzFormatter(zone);
    if (fmt !== null) {
      let year = '';
      let month = '';
      let day = '';
      let hour = '';
      let minute = '';
      let second = '';
      for (const part of fmt.formatToParts(new Date(epochMs))) {
        if (part.type === 'year') year = part.value.padStart(4, '0');
        else if (part.type === 'month') month = part.value.padStart(2, '0');
        else if (part.type === 'day') day = part.value.padStart(2, '0');
        else if (part.type === 'hour') {
          hour = part.value === '24' ? '00' : part.value.padStart(2, '0');
        } else if (part.type === 'minute') minute = part.value.padStart(2, '0');
        else if (part.type === 'second') second = part.value.padStart(2, '0');
      }
      return { year, month, day, hour, minute, second };
    }
  }
  const date = new Date(epochMs);
  return {
    year: pad4(date.getUTCFullYear()),
    month: pad2(date.getUTCMonth() + 1),
    day: pad2(date.getUTCDate()),
    hour: pad2(date.getUTCHours()),
    minute: pad2(date.getUTCMinutes()),
    second: pad2(date.getUTCSeconds()),
  };
}
