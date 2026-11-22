import { MAX_INLINE_LOGO_BYTES, sanitizeArtworkUrl } from './artwork-url';
import type { M3uEntry } from './m3u-types';

export { MAX_INLINE_LOGO_BYTES };

const SPACE = 32;
const DQUOTE = 34;
const SQUOTE = 39;
const COMMA = 44;
const EQUALS = 61;
const BACKSLASH = 92;

/** Non-fatal issues encountered while parsing an `#EXTINF:` attribute list. */
export interface ExtinfIssues {
  rawQuote: boolean;
  inlineLogoStripped?: boolean;
  recover?: boolean;
}

const SENTINEL_TVG_IDS = new Set(['(no tvg-id)', 'no tvg-id', 'null', 'none', 'n/a', 'undefined']);
const TRAILING_QUOTED_ATTR_RE = /["']\s+[a-z][a-z0-9_-]*=["']/i;

function isEscapableInQuote(ch: number): boolean {
  return ch === DQUOTE || ch === SQUOTE || ch === BACKSLASH;
}

function readQuoted(line: string, openIdx: number, quote: number): { value: string; end: number } {
  const n = line.length;
  let out = '';
  let segStart = openIdx + 1;
  let p = openIdx + 1;
  while (p < n) {
    const ch = line.charCodeAt(p);
    if (ch === BACKSLASH && p + 1 < n && isEscapableInQuote(line.charCodeAt(p + 1))) {
      out += line.slice(segStart, p) + (line[p + 1] as string);
      p += 2;
      segStart = p;
      continue;
    }
    if (ch === quote) {
      return {
        value: out.length === 0 ? line.slice(segStart, p) : out + line.slice(segStart, p),
        end: p,
      };
    }
    p++;
  }
  return {
    value: out.length === 0 ? line.slice(segStart, n) : out + line.slice(segStart, n),
    end: n,
  };
}

function findUnescapedQuote(text: string, from: number, quote: number): number {
  const n = text.length;
  for (let i = from; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === BACKSLASH && i + 1 < n && isEscapableInQuote(text.charCodeAt(i + 1))) {
      i++;
      continue;
    }
    if (c === quote) return i;
  }
  return -1;
}

/**
 * Walks `key=value` pairs from `from`, calling `onAttr(lowerCaseKey, value)`. Values may be double-quoted,
 * single-quoted (supporting `\"`, `\'`, `\\` escapes) or bare. Returns the text after the first comma outside
 * a value (trimmed), or `undefined`.
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
      if (!issues?.recover) {
        const tail = line.slice(i + 1).trim();
        if (issues && TRAILING_QUOTED_ATTR_RE.test(tail)) issues.rawQuote = true;
        return tail;
      }
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
      const quoted = readQuoted(line, k, q);
      value = quoted.value;
      i = quoted.end + 1;
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
  return trimmed;
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

function applyAttr(
  e: M3uEntry,
  key: string,
  value: string,
  c: CatchupDraft,
  issues?: ExtinfIssues,
): void {
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
    case 'tvg-logo': {
      const logo = sanitizeArtworkUrl(value);
      if (logo.oversizedData && issues) issues.inlineLogoStripped = true;
      if (logo.url !== undefined) e.tvgLogo = logo.url;
      return;
    }
    case 'logo': {
      const logo = sanitizeArtworkUrl(value);
      if (logo.oversizedData && issues) issues.inlineLogoStripped = true;
      if (e.tvgLogo === undefined && logo.url !== undefined) e.tvgLogo = logo.url;
      return;
    }
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
export function parseExtinf(text: string, issues?: ExtinfIssues): M3uEntry {
  const seen: ExtinfIssues = issues ?? { rawQuote: false };
  const first = readExtinf(text, seen, true);
  if (!seen.rawQuote) return first;
  const comma = nameCommaAfterLastValue(text);
  if (comma < 0) return first;
  const recoveryIssues: ExtinfIssues = {
    rawQuote: false,
    inlineLogoStripped: seen.inlineLogoStripped === true,
    recover: true,
  };
  const second = readExtinf(text.slice(0, comma), recoveryIssues, false);
  if (recoveryIssues.inlineLogoStripped) seen.inlineLogoStripped = true;
  second.name = text.slice(comma + 1).trim() || second.tvgName || '';
  return second;
}

function findLastQuotedAttrOpen(text: string): { open: number; quote: number } | undefined {
  const dq = text.lastIndexOf('="');
  const sq = text.lastIndexOf("='");
  if (dq < 0 && sq < 0) return undefined;
  return dq > sq ? { open: dq, quote: DQUOTE } : { open: sq, quote: SQUOTE };
}

function nameCommaAfterLastValue(text: string): number {
  const last = findLastQuotedAttrOpen(text);
  if (last === undefined) return -1;
  const { open, quote } = last;
  let pos = open + 2;
  while (pos < text.length) {
    const close = findUnescapedQuote(text, pos, quote);
    if (close < 0) return -1;
    if (!gluedToken(text, close + 1)) return text.indexOf(',', close + 1);
    if (close === open + 2 || text.charCodeAt(close - 1) <= SPACE) {
      const innerEnd = findUnescapedQuote(text, close + 1, quote);
      if (innerEnd < 0) return -1;
      pos = innerEnd + 1;
    } else {
      pos = close + 1;
    }
  }
  return -1;
}

function readExtinf(text: string, issues: ExtinfIssues, keepUnclean: boolean): M3uEntry {
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
      if (clean || keepUnclean) applyAttr(e, key, value, draft, issues);
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
