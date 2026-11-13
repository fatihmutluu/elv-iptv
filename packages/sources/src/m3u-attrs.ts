import type { KindHint, M3uEntry } from './m3u-types';

const SPACE = 32;
const DQUOTE = 34;
const SQUOTE = 39;
const COMMA = 44;
const EQUALS = 61;

const VOD_EXTENSIONS = new Set(['mkv', 'mp4', 'avi', 'mov', 'm4v', 'webm']);

/**
 * Walks `key=value` pairs from `from`, calling `onAttr(lowerCaseKey, value)`. Values may be double-quoted,
 * single-quoted or bare. Returns the text after the first comma outside a value (trimmed), or `undefined`.
 *
 * A quoted value whose closing quote is glued to a token without `=` (a raw quote inside the value, as in
 * `tvg-name="A "B", C"`) is passed to `onAttr` with `clean = false`, and `issues.rawQuote` is set when given.
 * Lines without such values are walked exactly as before.
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
  if (value === '') return undefined;
  const n = Number(value);
  return Number.isNaN(n) ? undefined : n;
}

function setNum(
  e: M3uEntry,
  field: 'chno' | 'shiftHours' | 'timeshiftDays' | 'recordDays',
  value: number | undefined,
): void {
  if (value === undefined) delete e[field];
  else e[field] = value;
}

function applyAttr(e: M3uEntry, key: string, value: string, c: CatchupDraft): void {
  switch (key) {
    case 'tvg-id':
      if (value) e.tvgId = value;
      return;
    case 'tvg-name':
      if (value) e.tvgName = value;
      return;
    case 'tvg-logo':
      if (value) e.tvgLogo = value;
      return;
    case 'tvg-chno':
      setNum(e, 'chno', num(value));
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

interface CatchupDraft {
  type?: string;
  source?: string;
  days?: number | undefined;
}

/** Creates an entry with empty collections and no URL yet. */
export function newEntry(): M3uEntry {
  return {
    name: '',
    url: '',
    duration: -1,
    groups: [],
    radio: false,
    headers: { other: {} },
    kodiProps: {},
    extra: {},
    kindHint: 'live',
    nonHttp: false,
  };
}

/**
 * Parses the text after `#EXTINF:` (duration, attributes, name) into a URL-less entry.
 *
 * Real panels sometimes write a raw double quote inside an attribute value. When a value is cut that way
 * (`issues.rawQuote` is set), the line is read again: attributes that parsed cleanly are kept, the broken
 * ones are dropped, and the name starts after the first comma that follows the closing quote of the last
 * `="..."` value in the line.
 */
export function parseExtinf(text: string, issues?: { rawQuote: boolean }): M3uEntry {
  const seen = issues ?? { rawQuote: false };
  const first = readExtinf(text, seen, true);
  if (!seen.rawQuote) return first;
  const comma = nameCommaAfterLastValue(text);
  if (comma < 0) return first;
  const second = readExtinf(text.slice(0, comma), { rawQuote: false, recover: true }, false);
  second.name = text.slice(comma + 1).trim() || second.tvgName || '';
  return second;
}

function nameCommaAfterLastValue(text: string): number {
  const open = text.lastIndexOf('="');
  if (open < 0) return -1;
  const close = text.indexOf('"', open + 2);
  return close < 0 ? -1 : text.indexOf(',', close + 1);
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

function schemeEnd(url: string): number {
  const n = url.length;
  for (let i = 0; i < n; i++) {
    const c = url.charCodeAt(i);
    if (c === 58) return i >= 2 ? i : -1;
    const alpha = (c | 32) >= 97 && (c | 32) <= 122;
    const rest = (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46;
    if (!(alpha || (i > 0 && rest))) return -1;
  }
  return -1;
}

function resolve(url: string, base: string): string {
  const baseEnd = schemeEnd(base);
  if (baseEnd < 0 || base.slice(baseEnd, baseEnd + 3) !== '://') return url;
  const scheme = base.slice(0, baseEnd);
  if (url.startsWith('//')) return `${scheme}:${url}`;
  const hostStart = baseEnd + 3;
  let hostEnd = base.length;
  for (let i = hostStart; i < base.length; i++) {
    const c = base.charCodeAt(i);
    if (c === 47 || c === 63 || c === 35) {
      hostEnd = i;
      break;
    }
  }
  const origin = base.slice(0, hostEnd);
  if (url.startsWith('/')) return origin + url;
  const rest = base.slice(hostEnd);
  const pathEnd = rest.search(/[?#]/);
  const path = pathEnd < 0 ? rest : rest.slice(0, pathEnd);
  return `${origin}${path.slice(0, path.lastIndexOf('/') + 1) || '/'}${url}`;
}

function kindOf(url: string, schemeLen: number): KindHint {
  const pathStart = url.indexOf('/', schemeLen + 3);
  if (pathStart < 0) return 'live';
  let pathEnd = url.length;
  for (let i = pathStart; i < url.length; i++) {
    const c = url.charCodeAt(i);
    if (c === 63 || c === 35) {
      pathEnd = i;
      break;
    }
  }
  const path = url.slice(pathStart, pathEnd).toLowerCase();
  if (path.includes('/movie/')) return 'movie';
  if (path.includes('/series/')) return 'episode';
  if (path.includes('/live/')) return 'live';
  const dot = path.lastIndexOf('.');
  if (dot > path.lastIndexOf('/') && VOD_EXTENSIONS.has(path.slice(dot + 1))) return 'movie';
  return 'live';
}

/** Sets the entry's URL (resolving relative ones against `baseUrl`), `kindHint` and `nonHttp`. */
export function finishEntry(e: M3uEntry, rawUrl: string, baseUrl: string | undefined): void {
  let url = rawUrl;
  let end = schemeEnd(url);
  if (end < 0 && baseUrl) {
    url = resolve(url, baseUrl);
    end = schemeEnd(url);
  }
  e.url = url;
  if (end < 0) return;
  const scheme = url.slice(0, end).toLowerCase();
  e.nonHttp = scheme !== 'http' && scheme !== 'https';
  e.kindHint = kindOf(url, end);
}

/** Applies one `#EXTVLCOPT:` payload (`key=value`) to the entry's headers. */
export function applyVlcOpt(e: M3uEntry, payload: string): void {
  const eq = payload.indexOf('=');
  if (eq < 0) return;
  const key = payload.slice(0, eq).trim().toLowerCase();
  const value = payload.slice(eq + 1).trim();
  if (key === 'http-user-agent') e.headers.userAgent = value;
  else if (key === 'http-referrer' || key === 'http-referer') e.headers.referer = value;
}

/** Applies one `#EXTHTTP:` JSON payload; returns false when it is not a JSON object. */
export function applyExtHttp(e: M3uEntry, payload: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  for (const [key, raw] of Object.entries(parsed)) {
    const value = String(raw);
    const lower = key.toLowerCase();
    if (lower === 'user-agent') e.headers.userAgent = value;
    else if (lower === 'referer' || lower === 'referrer') e.headers.referer = value;
    else e.headers.other[lower] = value;
  }
  return true;
}

/** Applies one `#KODIPROP:` payload (`key=value`, kept raw). */
export function applyKodiProp(e: M3uEntry, payload: string): void {
  const eq = payload.indexOf('=');
  if (eq > 0) e.kodiProps[payload.slice(0, eq).trim()] = payload.slice(eq + 1).trim();
}
