import { normalizeLanguageCode } from '@elv/domain';
import { decodeCodepageSlice, type XmlEncoding } from './codepages';
import { decodeUtf8 } from './utf8';

const XML_PROLOG_ENCODINGS: Readonly<Record<string, XmlEncoding>> = {
  'iso-8859-1': 'windows-1252',
  'iso8859-1': 'windows-1252',
  'iso_8859-1': 'windows-1252',
  latin1: 'windows-1252',
  'latin-1': 'windows-1252',
  'windows-1252': 'windows-1252',
  cp1252: 'windows-1252',
  'x-cp1252': 'windows-1252',
  'windows-1254': 'windows-1254',
  cp1254: 'windows-1254',
  'x-cp1254': 'windows-1254',
  'iso-8859-9': 'windows-1254',
  'iso8859-9': 'windows-1254',
  'iso_8859-9': 'windows-1254',
  latin5: 'windows-1254',
  'latin-5': 'windows-1254',
  'windows-1251': 'windows-1251',
  cp1251: 'windows-1251',
  'x-cp1251': 'windows-1251',
  'windows-1256': 'windows-1256',
  cp1256: 'windows-1256',
  'x-cp1256': 'windows-1256',
  'iso-8859-6': 'iso-8859-6',
  'iso8859-6': 'iso-8859-6',
  'iso_8859-6': 'iso-8859-6',
  arabic: 'iso-8859-6',
};

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

/** Resolves an XML prolog `encoding` attribute to a supported {@link XmlEncoding}, defaulting to `'utf-8'`. */
export function resolveXmlPrologEncoding(encoding: string | undefined): XmlEncoding {
  if (encoding === undefined) return 'utf-8';
  return XML_PROLOG_ENCODINGS[encoding.trim().toLowerCase()] ?? 'utf-8';
}

/**
 * Decodes `bytes[start, end)` as UTF-8 on the default fast path or using the shared WHATWG
 * single-byte codepage tables when the XML prolog declared a legacy encoding (`#429`).
 */
export function decodeXmlBytes(
  bytes: Uint8Array,
  start = 0,
  end: number = bytes.length,
  encoding: XmlEncoding = 'utf-8',
): string {
  if (encoding === 'utf-8') return decodeUtf8(bytes, start, end);
  return decodeCodepageSlice(bytes, start, end, encoding);
}

/** Function scoring an XML `lang` attribute against caller language preferences (higher wins). */
export type LanguageScorer = (lang: string | undefined) => number;

function normalizeBcp47(raw: string): string {
  return raw.trim().toLowerCase().replaceAll('_', '-');
}

/**
 * Compiles a scorer for `preferredLanguages` (`#121`, `#429`) enforcing strict precedence:
 * exact BCP-47 tag > primary language subtag (including ISO-639-2/B/T aliases) > untagged > first seen.
 * Returns `undefined` when no valid preferences were provided.
 */
export function createLanguageScorer(
  preferredLanguages: readonly string[] | undefined,
): LanguageScorer | undefined {
  if (preferredLanguages === undefined || preferredLanguages.length === 0) return undefined;
  const primaryGroup = new Map<string, number>();
  const exactPref = new Map<string, { group: number; prefIdx: number }>();
  let prefCount = 0;

  for (const raw of preferredLanguages) {
    const exact = normalizeBcp47(raw);
    if (exact.length === 0) continue;
    const primary = normalizeLanguageCode(exact);
    if (primary === undefined) continue;
    let group = primaryGroup.get(primary);
    if (group === undefined) {
      group = primaryGroup.size;
      primaryGroup.set(primary, group);
    }
    const idx = prefCount++;
    if (!exactPref.has(exact)) exactPref.set(exact, { group, prefIdx: idx });
  }

  const groupCount = primaryGroup.size;
  if (groupCount === 0) return undefined;

  return (lang: string | undefined): number => {
    if (lang === undefined) return 2;
    const exact = normalizeBcp47(lang);
    if (exact.length === 0) return 2;
    const exactMatch = exactPref.get(exact);
    if (exactMatch !== undefined) {
      return (
        3 + (groupCount - 1 - exactMatch.group) * (prefCount + 1) + (prefCount - exactMatch.prefIdx)
      );
    }
    const primary = normalizeLanguageCode(exact);
    if (primary !== undefined) {
      const group = primaryGroup.get(primary);
      if (group !== undefined) {
        return 3 + (groupCount - 1 - group) * (prefCount + 1);
      }
    }
    return 1;
  };
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
