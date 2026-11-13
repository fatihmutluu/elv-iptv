const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const MINUTE = 60_000;

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

/** Offset in minutes of the suffix (`+0100`, `-05:00`, `+01`, `Z`), or undefined when malformed. */
function parseOffset(text: string): number | undefined {
  if (text === '' || text === 'Z') return 0;
  const sign = text[0] === '-' ? -1 : text[0] === '+' ? 1 : 0;
  if (sign === 0) return undefined;
  const body =
    text.length === 6 && text[3] === ':' ? text.slice(1, 3) + text.slice(4) : text.slice(1);
  if (body.length !== 2 && body.length !== 4) return undefined;
  const hours = digits(body, 0, 2);
  const minutes = body.length === 4 ? digits(body, 2, 2) : 0;
  if (hours < 0 || minutes < 0 || hours > 23 || minutes > 59) return undefined;
  return sign * (hours * 60 + minutes);
}

/**
 * Parses an XMLTV time, `YYYYMMDDHHMMSS ±HHMM`, to epoch milliseconds. Shorter forms down to `YYYY` and a
 * missing offset (UTC) are accepted; any invalid field gives `undefined`. Written by hand: no `Date.parse`.
 */
export function parseXmltvTime(text: string): number | undefined {
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
  const offset = parseOffset(t.slice(n).trim());
  if (offset === undefined) return undefined;
  return Date.UTC(year, month - 1, day, hour, minute, second) - offset * MINUTE;
}
