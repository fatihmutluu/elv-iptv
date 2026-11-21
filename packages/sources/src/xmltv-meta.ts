import { decodeUtf8 } from './utf8';

/** WHATWG Windows-1252 C1 block (0x80–0x9F); unmapped positions fall back to U+FFFD. */
const WIN1252_C1: readonly number[] = [
  0x20ac, 0xfffd, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0xfffd, 0x017d, 0xfffd, 0xfffd, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0xfffd, 0x017e, 0x0178,
];

const LATIN1_ENCODINGS = new Set([
  'iso-8859-1',
  'iso8859-1',
  'iso_8859-1',
  'latin1',
  'latin-1',
  'windows-1252',
  'cp1252',
  'x-cp1252',
]);

const INLINE_HTML_TAG_RE =
  /<(\/?)(b|i|u|em|strong|br|p|span|font|small|sub|sup|mark|del|ins)(?:\s+[^<>]*)?\s*\/?>/gi;

/**
 * True superscript modifier letters & digits only — excludes modifier punctuation/apostrophes
 * (`U+02B9–U+02DF`, `U+02E5–U+02FF`, e.g. ʻokina `U+02BB` / `U+02BC`) and baseline phonetic
 * small-caps (`U+1D00–U+1D2B`).
 */
const SUPERSCRIPT_RUN_RE =
  /[\u02B0-\u02B8\u02E0-\u02E4\u1D2C-\u1D61\u1D9B-\u1DBF\u2070-\u207F\u2C7C-\u2C7D\u00B2\u00B3\u00B9]+/g;

const BADGE_BOUNDARY_RE = /^[\s()[\]{},;:/|·•–—-]$/;

const SUPERSCRIPT_TO_ASCII: Readonly<Record<string, string>> = {
  '\u1D38': 'L',
  '\u02E1': 'L',
  '\u1D35': 'I',
  '\u2071': 'I',
  '\u2C7D': 'V',
  '\u1D5B': 'V',
  '\u1D31': 'E',
  '\u1D49': 'E',
  '\u1D3A': 'N',
  '\u207F': 'N',
  '\u1D42': 'W',
  '\u02B7': 'W',
};

const XMLTV_NS_RE = /^\s*\d*(?:\/\d+)?\s*\.\s*\d*(?:\/\d+)?(?:\s*\.\s*\d*(?:\/\d+)?)?\s*$/;
const DESC_EPISODE_RE = /^\s*(S\d{1,3}E\d{1,4})\b/i;

/** Returns whether an XML prolog `encoding` value selects Latin-1 / Windows-1252 decoding. */
export function isLatin1PrologEncoding(encoding: string | undefined): boolean {
  if (encoding === undefined) return false;
  return LATIN1_ENCODINGS.has(encoding.trim().toLowerCase());
}

/**
 * Decodes `bytes[start, end)` as UTF-8 on the default fast path (`latin1 === false`) or as
 * WHATWG Windows-1252 / ISO-8859-1 when the XML prolog declared a Latin-1 encoding.
 */
export function decodeXmlBytes(
  bytes: Uint8Array,
  start = 0,
  end: number = bytes.length,
  latin1 = false,
): string {
  if (!latin1) return decodeUtf8(bytes, start, end);
  const limit = Math.min(end, bytes.length);
  const units: number[] = [];
  let out = '';
  for (let i = Math.max(start, 0); i < limit; i++) {
    const b = bytes[i] as number;
    const cp = b >= 0x80 && b <= 0x9f ? (WIN1252_C1[b - 0x80] ?? 0xfffd) : b;
    units.push(cp);
    if (units.length >= 4096) {
      out += String.fromCharCode(...units);
      units.length = 0;
    }
  }
  if (units.length > 0) out += String.fromCharCode(...units);
  return out;
}

/**
 * Strips common entity-decoded inline HTML formatting tags while preserving stray non-markup `<`
 * characters (such as `Age < 18` or `1 < 2 & 3 > 0`). Whitespace is collapsed only when a tag matched.
 */
export function stripInlineHtml(text: string): string {
  if (!text.includes('<')) return text;
  let stripped = false;
  const cleaned = text.replace(INLINE_HTML_TAG_RE, (_match, slash: string, tag: string) => {
    stripped = true;
    const lower = tag.toLowerCase();
    if (lower === 'br' || (lower === 'p' && slash === '/')) return ' ';
    return '';
  });
  return stripped ? cleaned.replace(/[ \t\r\n]+/g, ' ').trim() : text;
}

function foldSuperscriptRun(run: string): string {
  let out = '';
  for (let i = 0; i < run.length; i++) {
    const mapped = SUPERSCRIPT_TO_ASCII[run[i] as string];
    if (mapped === undefined) return '';
    out += mapped;
  }
  return out;
}

function isBadgeBoundary(ch: string): boolean {
  return ch === '' || BADGE_BOUNDARY_RE.test(ch);
}

/**
 * Cleans inline HTML formatting tags and standalone Unicode superscript badge runs from a programme
 * `<title>`, promoting recognized superscript `LIVE` / `NEW` markers into boolean flags while leaving
 * modifier apostrophes, baseline small-caps, exponents, ordinals, and mid-word letters untouched.
 */
export function cleanTitleAndFlags(raw: string): {
  title: string;
  isLive: boolean;
  isNew: boolean;
} {
  const withoutHtml = stripInlineHtml(raw);
  let isLive = false;
  let isNew = false;
  let strippedSuper = false;
  const withoutSuper = withoutHtml.replace(SUPERSCRIPT_RUN_RE, (run, offset: number) => {
    const prev = offset > 0 ? (withoutHtml[offset - 1] ?? '') : '';
    const next =
      offset + run.length < withoutHtml.length ? (withoutHtml[offset + run.length] ?? '') : '';
    const folded = foldSuperscriptRun(run);
    const recognizedBadge = folded === 'LIVE' || folded === 'NEW';
    const standalone = isBadgeBoundary(prev) && isBadgeBoundary(next);
    if (!standalone && !(recognizedBadge && isBadgeBoundary(next))) {
      return run;
    }
    strippedSuper = true;
    if (folded === 'LIVE') isLive = true;
    else if (folded === 'NEW') isNew = true;
    return '';
  });
  const title = strippedSuper ? withoutSuper.replace(/[ \t\r\n]+/g, ' ').trim() : withoutHtml;
  return { title, isLive, isNew };
}

/** Precedence rank for `<episode-num system="...">`: `xmltv_ns` (3) > `onscreen` (2) > `dd_progid` (1) > other (0). */
export function episodeNumRank(system: string | undefined): number {
  if (system === undefined) return 0;
  const normalized = system.trim().toLowerCase();
  if (normalized === 'xmltv_ns') return 3;
  if (normalized === 'onscreen') return 2;
  if (normalized === 'dd_progid') return 1;
  return 0;
}

/** Validates numeric `xmltv_ns` format (requiring at least one digit) to reject alphabetic provider IDs. */
export function isValidXmltvNs(value: string): boolean {
  return XMLTV_NS_RE.test(value) && /\d/.test(value);
}

/** Extracts a leading `S##E##` episode code from `<desc>` when no valid `<episode-num>` was provided. */
export function extractDescEpisodeNum(desc: string): string | undefined {
  const match = DESC_EPISODE_RE.exec(desc);
  return match === null ? undefined : (match[1] as string).toUpperCase();
}
