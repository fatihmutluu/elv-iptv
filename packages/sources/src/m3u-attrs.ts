import type { M3uEntry } from './m3u-types';

const SPACE = 32;
const DQUOTE = 34;
const SQUOTE = 39;
const COMMA = 44;
const EQUALS = 61;

const SENTINEL_TVG_IDS = new Set(['(no tvg-id)', 'no tvg-id', 'null', 'none', 'n/a', 'undefined']);
const SATIP_CHNO_PREFIX_RE = /^(\d{1,5})\.\s+(\S.*)$/;

/**
 * Walks `key=value` pairs from `from`, calling `onAttr(lowerCaseKey, value)`. Values may be double-quoted,
 * single-quoted or bare. Returns the text after the first comma outside a value (trimmed), or `undefined`.
 */
export function parseAttrs(
  line: string,
  from: number,
  onAttr: (key: string, value: string, clean: boolean) => void,
  issues?: { rawQuote: boolean; recover?: boolean },
): string | undefined {
  const n = line.length;
  let i = from;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c <= SPACE) {
      i++;
      continue;
    }
    if (c === COMMA) {
      if (!issues?.recover) return line.slice(i + 1).trim();
      i++;
      continue;
    }
    let k = i;
    while (k < n) {
      const d = line.charCodeAt(k);
      if (d === EQUALS || d <= SPACE || d === COMMA) break;
      k++;
    }
    if (k >= n || line.charCodeAt(k) !== EQUALS) {
      i = k === i ? k + 1 : k;
      continue;
    }
    const key = line.slice(i, k).toLowerCase();
    k++;
    const q = line.charCodeAt(k);
    let value: string;
    let clean = true;
    if (q === DQUOTE || q === SQUOTE) {
      let end = line.indexOf(q === DQUOTE ? '"' : "'", k + 1);
      if (end < 0) end = n;
      value = line.slice(k + 1, end);
      i = end + 1;
      clean = !gluedToken(line, i);
      if (!clean && issues) issues.rawQuote = true;
    } else {
      let e = k;
      while (e < n) {
        const d = line.charCodeAt(e);
        if (d <= SPACE || d === COMMA) break;
        e++;
      }
      value = line.slice(k, e);
      i = e;
    }
    if (key) onAttr(key, value, clean);
  }
  return undefined;
}

/** True when the text at `at` continues a token that has no `=`, so the quote before it was not a closing one. */
function gluedToken(line: string, at: number): boolean {
  const n = line.length;
  if (at >= n) return false;
  const first = line.charCodeAt(at);
  if (first <= SPACE || first === COMMA) return false;
  for (let k = at; k < n; k++) {
    const d = line.charCodeAt(k);
    if (d === EQUALS) return false;
    if (d <= SPACE || d === COMMA) return true;
  }
  return true;
}

function num(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

function positiveChno(value: string): number | undefined {
  const n = num(value);
  return n !== undefined && n > 0 ? n : undefined;
}

function cleanTvgId(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === '' || SENTINEL_TVG_IDS.has(trimmed.toLowerCase())) return undefined;
  return value;
}

function setNum(
  e: M3uEntry,
  field: 'chno' | 'shiftHours' | 'timeshiftDays' | 'recordDays',
  value: number | undefined,
): void {
  if (value === undefined) delete e[field];
  else e[field] = value;
}

interface CatchupDraft {
  type?: string;
  source?: string;
  days?: number | undefined;
}

function applyAttr(e: M3uEntry, key: string, value: string, c: CatchupDraft): void {
  switch (key) {
    case 'tvg-id': {
      const id = cleanTvgId(value);
      if (id !== undefined) e.tvgId = id;
      return;
    }
    case 'channel-id': {
      if (e.tvgId === undefined) {
        const id = cleanTvgId(value);
        if (id !== undefined) e.tvgId = id;
      }
      return;
    }
    case 'tvg-name':
      if (value) e.tvgName = value;
      return;
    case 'tvg-logo':
      if (value) e.tvgLogo = value;
      return;
    case 'logo':
      if (e.tvgLogo === undefined && value) e.tvgLogo = value;
      return;
    case 'tvg-chno':
      setNum(e, 'chno', positiveChno(value));
      return;
    case 'ch-number':
    case 'channel-number':
      if (e.chno === undefined) {
        const parsed = positiveChno(value);
        if (parsed !== undefined) e.chno = parsed;
      }
      return;
    case 'tvg-shift':
      setNum(e, 'shiftHours', num(value));
      return;
    case 'group-title':
      for (const g of value.split(';')) {
        const t = g.trim();
        if (t) e.groups.push(t);
      }
      return;
    case 'radio': {
      const v = value.toLowerCase();
      e.radio = v === 'true' || v === '1' || v === 'yes';
      return;
    }
    case 'catchup':
      if (value) c.type = value;
      return;
    case 'catchup-source':
      if (value) c.source = value;
      return;
    case 'catchup-days':
      c.days = num(value);
      return;
    case 'timeshift':
      setNum(e, 'timeshiftDays', num(value));
      return;
    case 'tvg-rec':
      setNum(e, 'recordDays', num(value));
      return;
    default:
      e.extra[key] = value;
  }
}

/** An empty string map without a prototype, so input-controlled keys such as `__proto__` stay plain data. */
export function dict(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

/** Creates an entry with empty collections and no URL yet. */
export function newEntry(): M3uEntry {
  return {
    name: '',
    url: '',
    duration: -1,
    groups: [],
    radio: false,
    headers: { other: dict() },
    kodiProps: dict(),
    extra: dict(),
    kindHint: 'live',
    nonHttp: false,
  };
}

/**
 * Parses the text after `#EXTINF:` (duration, attributes, name) into a URL-less entry.
 */
export function parseExtinf(text: string, issues?: { rawQuote: boolean }): M3uEntry {
  const seen = issues ?? { rawQuote: false };
  const first = readExtinf(text, seen, true);
  if (!seen.rawQuote) return applySatIpPrefix(first);
  const comma = nameCommaAfterLastValue(text);
  if (comma < 0) return applySatIpPrefix(first);
  const second = readExtinf(text.slice(0, comma), { rawQuote: false, recover: true }, false);
  second.name = text.slice(comma + 1).trim() || second.tvgName || '';
  return applySatIpPrefix(second);
}

function applySatIpPrefix(e: M3uEntry): M3uEntry {
  if (e.chno !== undefined || e.name.length === 0) return e;
  const match = SATIP_CHNO_PREFIX_RE.exec(e.name);
  if (match === null) return e;
  const n = Number(match[1]);
  if (Number.isFinite(n) && n > 0) {
    e.chno = n;
    e.name = (match[2] ?? '').trim();
  }
  return e;
}

function nameCommaAfterLastValue(text: string): number {
  const open = text.lastIndexOf('="');
  if (open < 0) return -1;
  let pos = open + 2;
  while (pos < text.length) {
    const close = text.indexOf('"', pos);
    if (close < 0) return -1;
    if (!gluedToken(text, close + 1)) return text.indexOf(',', close + 1);
    if (close === open + 2 || text.charCodeAt(close - 1) <= SPACE) {
      const innerEnd = text.indexOf('"', close + 1);
      if (innerEnd < 0) return -1;
      pos = innerEnd + 1;
    } else {
      pos = close + 1;
    }
  }
  return -1;
}

function readExtinf(
  text: string,
  issues: { rawQuote: boolean; recover?: boolean },
  keepUnclean: boolean,
): M3uEntry {
  const e = newEntry();
  const n = text.length;
  let i = 0;
  while (i < n && text.charCodeAt(i) <= SPACE) i++;
  let j = i;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (c <= SPACE || c === COMMA) break;
    j++;
  }
  const token = text.slice(i, j);
  if (token.indexOf('=') < 0) {
    e.duration = num(token) ?? -1;
    i = j;
  }
  const draft: CatchupDraft = {};
  const name = parseAttrs(
    text,
    i,
    (key, value, clean) => {
      if (clean || keepUnclean) applyAttr(e, key, value, draft);
    },
    issues,
  );
  e.name = name || e.tvgName || '';
  const type =
    draft.type ?? (draft.source !== undefined || draft.days !== undefined ? 'default' : undefined);
  if (type !== undefined) {
    e.catchup = { type };
    if (draft.source !== undefined) e.catchup.source = draft.source;
    if (draft.days !== undefined) e.catchup.days = draft.days;
  }
  return e;
}
