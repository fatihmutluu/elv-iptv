const MAX_FORMATTER_CACHE = 16;
const dayFormatters = new Map<string, Intl.DateTimeFormat>();

function formatLocalDate(d: Date): string {
  const year = String(d.getFullYear()).padStart(4, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getDayFormatter(timeZone: string): Intl.DateTimeFormat | undefined {
  const cached = dayFormatters.get(timeZone);
  if (cached !== undefined) return cached;
  if (typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') return undefined;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    if (dayFormatters.size >= MAX_FORMATTER_CACHE) dayFormatters.clear();
    dayFormatters.set(timeZone, formatter);
    return formatter;
  } catch {
    return undefined;
  }
}

/**
 * Formats an epoch-millisecond timestamp as a local calendar day key (`YYYY-MM-DD`) in `timeZone`
 * via `Intl.DateTimeFormat` (with safe local-`Date` fallback when `timeZone` is omitted/invalid or
 * `Intl` is unavailable). Returns `""` for non-finite or out-of-range timestamps.
 */
export function localDayKey(epochMs: number, timeZone?: string): string {
  if (!Number.isFinite(epochMs)) return '';
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return '';
  if (timeZone !== undefined && timeZone !== '') {
    const formatter = getDayFormatter(timeZone);
    if (formatter !== undefined) {
      let year = '';
      let month = '';
      let day = '';
      for (const part of formatter.formatToParts(date)) {
        if (part.type === 'year') year = part.value;
        else if (part.type === 'month') month = part.value;
        else if (part.type === 'day') day = part.value;
      }
      if (year !== '' && month !== '' && day !== '') {
        return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      }
    }
  }
  return formatLocalDate(date);
}

/**
 * Buckets programmes into local calendar days (`YYYY-MM-DD`) by `start` epoch-ms timestamp in the
 * optional IANA `timeZone`, preserving input order within each day and skipping invalid starts.
 */
export function bucketProgrammesByLocalDay<T extends { start: number }>(
  programmes: readonly T[],
  timeZone?: string,
): Map<string, T[]> {
  const buckets = new Map<string, T[]>();
  for (const programme of programmes) {
    const key = localDayKey(programme.start, timeZone);
    if (key === '') continue;
    const list = buckets.get(key);
    if (list === undefined) buckets.set(key, [programme]);
    else list.push(programme);
  }
  return buckets;
}
