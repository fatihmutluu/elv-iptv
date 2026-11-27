import { foldText } from './fold';

/** Minimum valid film/series year accepted across VOD title cleaners (`#215`, `#404`). */
export const VOD_MIN_YEAR = 1888;
/** Maximum valid film/series year accepted across VOD title cleaners (`#215`, `#404`). */
export const VOD_MAX_YEAR = 2099;

export interface VodTagSpec {
  readonly canonical: string;
  readonly rank?: number;
  readonly bonus?: number;
  /** Safe to strip even as an unbracketed trailing token in the title body. */
  readonly safeUnbracketed?: boolean;
  /** When unbracketed, require ALL-CAPS form so normal TitleCase English words stay intact. */
  readonly uppercaseOnlyUnbracketed?: boolean;
}

const TWO_LETTER_ROMAN_NUMERALS: ReadonlySet<string> = new Set([
  'II',
  'IV',
  'VI',
  'IX',
  'XI',
  'XV',
  'XX',
]);

/**
 * Curated 2/3-letter & hyphenated language/region codes stripped only in brackets, leading
 * delimited prefixes, or trailing delimited suffixes (or hyphenated `XX-DUB`/`XX-SUB` tags).
 */
const LANG_REGION_CODES: ReadonlySet<string> = new Set([
  'TR',
  'TUR',
  'EN',
  'ENG',
  'DE',
  'DEU',
  'GER',
  'FR',
  'FRA',
  'FRE',
  'ES',
  'ESP',
  'SPA',
  'LAT',
  'IT',
  'ITA',
  'PT',
  'POR',
  'PT-BR',
  'BR',
  'AR',
  'ARA',
  'RU',
  'RUS',
  'NL',
  'NLD',
  'DUT',
  'PL',
  'POL',
  'RO',
  'EL',
  'GR',
  'IN',
  'HI',
  'KO',
  'KOR',
  'JA',
  'JP',
  'CN',
  'ZH',
  'UK',
  'US',
  'OV',
  'VF',
]);

/** Language/meta words stripped in brackets or delimited prefix/suffix segments, never bare inside titles. */
const DELIMITED_ONLY_WORDS: ReadonlySet<string> = new Set([
  'TURKCE',
  'ENGLISH',
  'GERMAN',
  'DEUTSCH',
  'FRENCH',
  'FRANCAIS',
  'SPANISH',
  'ESPANOL',
  'ITALIAN',
  'ITALIANO',
  'PORTUGUESE',
  'ARABIC',
  'RUSSIAN',
  'DUTCH',
  'POLISH',
  'HINDI',
  'KOREAN',
  'JAPANESE',
  'CHINESE',
  'ORIGINAL',
  'ORIJINAL',
  'YERLI',
  'AUDIO',
]);

/** Canonical quality, codec, audio, platform, edition, and sub/dub specs keyed by folded UPPERCASE key. */
const VOD_TAG_SPECS: Readonly<Record<string, VodTagSpec>> = {
  '4K': { canonical: '4K', rank: 40, safeUnbracketed: true },
  '8K': { canonical: '8K', rank: 50, safeUnbracketed: true },
  UHD: { canonical: '4K', rank: 40, safeUnbracketed: true },
  '2160P': { canonical: '4K', rank: 40, safeUnbracketed: true },
  FHD: { canonical: '1080p', rank: 30, safeUnbracketed: true },
  '1080P': { canonical: '1080p', rank: 30, safeUnbracketed: true },
  HD: { canonical: '720p', rank: 20, safeUnbracketed: true, uppercaseOnlyUnbracketed: true },
  '720P': { canonical: '720p', rank: 20, safeUnbracketed: true },
  '576P': { canonical: '576p', rank: 15, safeUnbracketed: true },
  SD: { canonical: 'SD', rank: 10, safeUnbracketed: true, uppercaseOnlyUnbracketed: true },
  '480P': { canonical: 'SD', rank: 10, safeUnbracketed: true },
  CAM: { canonical: 'CAM', rank: 5, safeUnbracketed: true, uppercaseOnlyUnbracketed: true },
  TS: { canonical: 'TS', rank: 5, safeUnbracketed: true, uppercaseOnlyUnbracketed: true },
  HDTS: { canonical: 'TS', rank: 5, safeUnbracketed: true },
  REMUX: { canonical: 'REMUX', bonus: 4, safeUnbracketed: true },
  BLURAY: { canonical: 'BluRay', bonus: 2, safeUnbracketed: true },
  'BLU-RAY': { canonical: 'BluRay', bonus: 2, safeUnbracketed: true },
  BDRIP: { canonical: 'BDRip', bonus: 1, safeUnbracketed: true },
  'BD-RIP': { canonical: 'BDRip', bonus: 1, safeUnbracketed: true },
  BRRIP: { canonical: 'BRRip', bonus: 1, safeUnbracketed: true },
  'BR-RIP': { canonical: 'BRRip', bonus: 1, safeUnbracketed: true },
  'WEB-DL': { canonical: 'WEB-DL', bonus: 1, safeUnbracketed: true },
  WEBDL: { canonical: 'WEB-DL', bonus: 1, safeUnbracketed: true },
  WEBRIP: { canonical: 'WEBRip', safeUnbracketed: true },
  'WEB-RIP': { canonical: 'WEBRip', safeUnbracketed: true },
  WEB: { canonical: 'WEB', safeUnbracketed: true, uppercaseOnlyUnbracketed: true },
  HDTV: { canonical: 'HDTV', safeUnbracketed: true },
  HDRIP: { canonical: 'HDRip', safeUnbracketed: true },
  'HD-RIP': { canonical: 'HDRip', safeUnbracketed: true },
  DVDRIP: { canonical: 'DVDRip', safeUnbracketed: true },
  'DVD-RIP': { canonical: 'DVDRip', safeUnbracketed: true },
  TVRIP: { canonical: 'TVRip', safeUnbracketed: true },
  'TV-RIP': { canonical: 'TVRip', safeUnbracketed: true },
  HDR: { canonical: 'HDR', bonus: 2, safeUnbracketed: true },
  HDR10: { canonical: 'HDR10', bonus: 2, safeUnbracketed: true },
  'HDR10+': { canonical: 'HDR10+', bonus: 2, safeUnbracketed: true },
  SDR: { canonical: 'SDR', safeUnbracketed: true, uppercaseOnlyUnbracketed: true },
  DV: { canonical: 'DV', bonus: 2, safeUnbracketed: true, uppercaseOnlyUnbracketed: true },
  '3D': { canonical: '3D', safeUnbracketed: true, uppercaseOnlyUnbracketed: true },
  HEVC: { canonical: 'HEVC', bonus: 1, safeUnbracketed: true },
  H265: { canonical: 'HEVC', bonus: 1, safeUnbracketed: true },
  'H.265': { canonical: 'HEVC', bonus: 1, safeUnbracketed: true },
  X265: { canonical: 'HEVC', bonus: 1, safeUnbracketed: true },
  H264: { canonical: 'H.264', safeUnbracketed: true },
  'H.264': { canonical: 'H.264', safeUnbracketed: true },
  X264: { canonical: 'H.264', safeUnbracketed: true },
  AV1: { canonical: 'AV1', bonus: 1, safeUnbracketed: true },
  '10BIT': { canonical: '10bit', safeUnbracketed: true },
  '60FPS': { canonical: '60fps', safeUnbracketed: true },
  '50FPS': { canonical: '50fps', safeUnbracketed: true },
  DOLBY: { canonical: 'Dolby', safeUnbracketed: true, uppercaseOnlyUnbracketed: true },
  ATMOS: { canonical: 'Atmos', safeUnbracketed: true },
  AAC: { canonical: 'AAC', safeUnbracketed: true, uppercaseOnlyUnbracketed: true },
  AC3: { canonical: 'AC3', safeUnbracketed: true },
  DTS: { canonical: 'DTS', safeUnbracketed: true, uppercaseOnlyUnbracketed: true },
  DDP: { canonical: 'DDP', safeUnbracketed: true, uppercaseOnlyUnbracketed: true },
  'DDP5.1': { canonical: 'DDP5.1', safeUnbracketed: true },
  '5.1': { canonical: '5.1', safeUnbracketed: true },
  '7.1': { canonical: '7.1', safeUnbracketed: true },
  NF: { canonical: 'NF', safeUnbracketed: true, uppercaseOnlyUnbracketed: true },
  AMZN: { canonical: 'AMZN', safeUnbracketed: true, uppercaseOnlyUnbracketed: true },
  DSNP: { canonical: 'DSNP', safeUnbracketed: true, uppercaseOnlyUnbracketed: true },
  ATVP: { canonical: 'ATVP', safeUnbracketed: true, uppercaseOnlyUnbracketed: true },
  VOD: { canonical: 'VOD', uppercaseOnlyUnbracketed: true },
  VIP: { canonical: 'VIP', safeUnbracketed: true, uppercaseOnlyUnbracketed: true },
  NEW: { canonical: 'NEW', uppercaseOnlyUnbracketed: true },
  TOP: { canonical: 'TOP', uppercaseOnlyUnbracketed: true },
  RAW: { canonical: 'RAW', safeUnbracketed: true, uppercaseOnlyUnbracketed: true },
  IMAX: { canonical: 'IMAX', safeUnbracketed: true },
  EXTENDED: { canonical: 'Extended', safeUnbracketed: true },
  UNRATED: { canonical: 'Unrated', safeUnbracketed: true },
  REMASTERED: { canonical: 'Remastered', safeUnbracketed: true },
  UNCUT: { canonical: 'Uncut', safeUnbracketed: true },
  THEATRICAL: { canonical: 'Theatrical', safeUnbracketed: true },
  MULTI: { canonical: 'Multi', safeUnbracketed: true, uppercaseOnlyUnbracketed: true },
  MULTISUB: { canonical: 'MultiSub', safeUnbracketed: true },
  'MULTI-SUB': { canonical: 'MultiSub', safeUnbracketed: true },
  DUAL: { canonical: 'Dual Audio', safeUnbracketed: true, uppercaseOnlyUnbracketed: true },
  DUB: { canonical: 'Dubbed', safeUnbracketed: true, uppercaseOnlyUnbracketed: true },
  SUB: { canonical: 'Subtitled', safeUnbracketed: true, uppercaseOnlyUnbracketed: true },
  ALT: { canonical: 'Altyazılı', safeUnbracketed: true, uppercaseOnlyUnbracketed: true },
  DUBBED: { canonical: 'Dubbed', safeUnbracketed: true },
  SUBBED: { canonical: 'Subbed', safeUnbracketed: true },
  SUBTITLED: { canonical: 'Subtitled', safeUnbracketed: true },
  DUBLAJ: { canonical: 'Dublaj', safeUnbracketed: true },
  ALTYAZI: { canonical: 'Altyazı', safeUnbracketed: true },
  ALTYAZILI: { canonical: 'Altyazılı', safeUnbracketed: true },
  VOSTFR: { canonical: 'VOSTFR', safeUnbracketed: true },
  VOSE: { canonical: 'VOSE', safeUnbracketed: true },
  SUBESP: { canonical: 'SubEsp', safeUnbracketed: true },
  TRUEFRENCH: { canonical: 'TrueFrench', safeUnbracketed: true },
  VFF: { canonical: 'VFF', safeUnbracketed: true, uppercaseOnlyUnbracketed: true },
  VFQ: { canonical: 'VFQ', safeUnbracketed: true, uppercaseOnlyUnbracketed: true },
  OMU: { canonical: 'OMU', safeUnbracketed: true, uppercaseOnlyUnbracketed: true },
  LATINO: { canonical: 'Latino' },
  CASTELLANO: { canonical: 'Castellano' },
  'TR-DUB': { canonical: 'TR Dublaj', safeUnbracketed: true },
  TRDUB: { canonical: 'TR Dublaj', safeUnbracketed: true },
  'TR-SUB': { canonical: 'TR Sub', safeUnbracketed: true },
  'TR-ALT': { canonical: 'TR Altyazı', safeUnbracketed: true },
  'EN-DUB': { canonical: 'EN Dub', safeUnbracketed: true },
  'EN-SUB': { canonical: 'EN Sub', safeUnbracketed: true },
  'ENG-SUB': { canonical: 'EN Sub', safeUnbracketed: true },
  'FR-DUB': { canonical: 'FR Dub', safeUnbracketed: true },
  'FR-SUB': { canonical: 'FR Sub', safeUnbracketed: true },
  'DE-DUB': { canonical: 'DE Dub', safeUnbracketed: true },
  'DE-SUB': { canonical: 'DE Sub', safeUnbracketed: true },
  'ES-DUB': { canonical: 'ES Dub', safeUnbracketed: true },
  'ES-SUB': { canonical: 'ES Sub', safeUnbracketed: true },
  'IT-DUB': { canonical: 'IT Dub', safeUnbracketed: true },
  'PT-DUB': { canonical: 'PT Dub', safeUnbracketed: true },
};

export const MULTI_WORD_TAGS: readonly (readonly [RegExp, string, number])[] = [
  [/\bDolby\s+Vision\b/gi, 'DV', 2],
  [/\bDolby\s+Atmos\b/gi, 'Atmos', 0],
  [/\bDirector'?s\s+Cut\b/gi, "Director's Cut", 0],
  [/\bExtended\s+Cut\b/gi, 'Extended', 0],
  [/\bSpecial\s+Edition\b/gi, 'Special Edition', 0],
  [/\bDual\s+Audio\b/gi, 'Dual Audio', 0],
  [/\bMulti[\s-]+Audio\b/gi, 'Multi', 0],
  [/\bMulti[\s-]+Sub(?:s|titles)?\b/gi, 'MultiSub', 0],
  [/\bT[üu]rk[çc]e\s+Dublaj\b/gi, 'TR Dublaj', 0],
  [/\bTR\s+Dublaj\b/gi, 'TR Dublaj', 0],
  [/\bT[üu]rk[çc]e\s+Altyaz[ıi](?:l[ıi])?\b/gi, 'TR Altyazı', 0],
  [/\bSub\s+Esp(?:a[ñn]ol)?\b/gi, 'SubEsp', 0],
];

const TWO_LETTER_UPPER_RE = /^[A-Z]{2}$/;
const YEAR_TOKEN_RE = /^\d{4}$/;

/** Locale-independent ASCII-folded uppercase key for tag table lookup. */
export function foldTagKey(atom: string): string {
  const folded = foldText(atom);
  if (folded !== '') return folded.toUpperCase();
  return atom.trim().toUpperCase();
}

function isTwoLetterLangOrCountry(atom: string): boolean {
  return TWO_LETTER_UPPER_RE.test(atom) && !TWO_LETTER_ROMAN_NUMERALS.has(atom);
}

export function isValidVodYear(
  y: number | null | undefined,
  minYear = VOD_MIN_YEAR,
  maxYear = VOD_MAX_YEAR,
): y is number {
  return typeof y === 'number' && Number.isInteger(y) && y >= minYear && y <= maxYear;
}

export function parseVodYearToken(
  tok: string,
  minYear = VOD_MIN_YEAR,
  maxYear = VOD_MAX_YEAR,
): number | null {
  if (!YEAR_TOKEN_RE.test(tok)) return null;
  const parsed = Number(tok);
  return isValidVodYear(parsed, minYear, maxYear) ? parsed : null;
}

export function lookupVodTagSpec(atom: string): VodTagSpec | undefined {
  const exactUpper = atom.trim().toUpperCase();
  const exact = Object.hasOwn(VOD_TAG_SPECS, exactUpper) ? VOD_TAG_SPECS[exactUpper] : undefined;
  if (exact !== undefined) return exact;
  // Preserve dotted specs such as `H.265`, `DDP5.1`, `5.1`, `7.1` before `foldText` collapses punctuation.
  const foldedUpper = foldTagKey(atom);
  return Object.hasOwn(VOD_TAG_SPECS, foldedUpper) ? VOD_TAG_SPECS[foldedUpper] : undefined;
}

function isKnownBracketOrDelimAtom(rawAtom: string): boolean {
  if (TWO_LETTER_ROMAN_NUMERALS.has(rawAtom.toUpperCase())) return false;
  if (lookupVodTagSpec(rawAtom) !== undefined) return true;
  const key = foldTagKey(rawAtom);
  if (LANG_REGION_CODES.has(key) || DELIMITED_ONLY_WORDS.has(key)) return true;
  return isTwoLetterLangOrCountry(rawAtom);
}

/** Splits a bracket or delimited suffix group into tag/year atoms while preserving hyphenated specs (`WEB-DL`, `TR-DUB`, `PT-BR`). */
function tokenizeVodTagGroup(content: string): string[] {
  const atoms: string[] = [];
  for (const rawPiece of content.trim().split(/[\s/|+•·,]+/)) {
    const piece = rawPiece.replace(/^-+|-+$/g, '');
    if (piece.length === 0) continue;
    if (
      lookupVodTagSpec(piece) !== undefined ||
      LANG_REGION_CODES.has(foldTagKey(piece)) ||
      !piece.includes('-')
    ) {
      atoms.push(piece);
      continue;
    }
    const parts = piece.split(/-+/).filter(Boolean);
    for (let i = 0; i < parts.length; ) {
      const part = parts[i] ?? '';
      const next = parts[i + 1];
      if (next !== undefined) {
        const pair = `${part}-${next}`;
        if (lookupVodTagSpec(pair) !== undefined || LANG_REGION_CODES.has(foldTagKey(pair))) {
          atoms.push(pair);
          i += 2;
          continue;
        }
      }
      atoms.push(part);
      i += 1;
    }
  }
  return atoms;
}

export interface ClassifiedBracketGroup {
  readonly extractedYear: number | null;
  readonly atoms: readonly string[];
}

/** Validates a bracketed `(...)` / `[...]` group whose every atom is a noise tag or valid release year. */
export function classifyVodBracketGroup(
  inner: string,
  allowMixedYear: boolean,
  minYear = VOD_MIN_YEAR,
  maxYear = VOD_MAX_YEAR,
): ClassifiedBracketGroup | null {
  const trimmed = inner.trim();
  if (trimmed === '' || TWO_LETTER_ROMAN_NUMERALS.has(trimmed.toUpperCase())) return null;
  const atoms = tokenizeVodTagGroup(trimmed);
  if (atoms.length === 0) return null;

  let extractedYear: number | null = null;
  let hasTagAtom = false;
  for (const atom of atoms) {
    const yearVal = parseVodYearToken(atom, minYear, maxYear);
    if (yearVal !== null) {
      if (!allowMixedYear && atoms.length > 1) return null;
      extractedYear = yearVal;
      continue;
    }
    if (!isKnownBracketOrDelimAtom(atom)) return null;
    hasTagAtom = true;
  }

  if (!hasTagAtom && extractedYear === null) return null;
  return { extractedYear, atoms };
}

/** Validates a leading delimited prefix (`TR |`, `TUR:`, `4K -`, `PT-BR |`) while protecting TitleCase words like `It: Chapter Two`. */
export function classifyLeadingDelimitedPrefix(rawPrefix: string): readonly string[] | null {
  const atoms = tokenizeVodTagGroup(rawPrefix);
  if (atoms.length === 0) return null;
  for (const atom of atoms) {
    if (TWO_LETTER_ROMAN_NUMERALS.has(atom.toUpperCase())) return null;
    if (parseVodYearToken(atom) !== null) return null;
    const spec = lookupVodTagSpec(atom);
    const key = foldTagKey(atom);
    const isCode = LANG_REGION_CODES.has(key) || isTwoLetterLangOrCountry(atom);
    const isDelimWord = DELIMITED_ONLY_WORDS.has(key);
    if (spec === undefined && !isCode && !isDelimWord) return null;

    // Require uppercase on 2-letter alphabetic atoms and dictionary-ambiguous words
    // so "It: Chapter Two", "Top: Secret", "Original: Story", and "New: Horizons" stay intact.
    const isUpper = atom === atom.toUpperCase();
    if (/^[A-Za-z]{2}$/.test(atom) && !isUpper) return null;
    if ((spec?.uppercaseOnlyUnbracketed || isDelimWord) && !isUpper && key !== 'TURKCE') {
      // Allow known full language names like `Castellano`, `Türkçe`, `French` with `|`, wait:
      // protect `Original` / `New` / `Top` / `Sub` / `Dub` if mixed-case!
      if (
        key === 'ORIGINAL' ||
        key === 'ORIJINAL' ||
        key === 'NEW' ||
        key === 'TOP' ||
        key === 'SUB' ||
        key === 'DUB' ||
        key === 'RAW' ||
        key === 'WEB' ||
        key === 'VIP' ||
        key === 'VOD'
      ) {
        return null;
      }
    }
  }
  return atoms;
}

/** Upper bound for bare unbracketed trailing years so futuristic sci-fi titles (`Blade Runner 2049`) stay intact. */
export function maxBareVodTrailingYear(): number {
  return new Date().getUTCFullYear() + 2;
}

/** Validates a trailing ` - <segment>` / ` | <segment>` suffix so noise strips while real subtitles (`- Reloaded`) stay intact. */
export function classifyTrailingDelimitedNoise(rawSegment: string): readonly string[] | null {
  const trimmed = rawSegment.trim();
  if (trimmed === '') return null;
  // First strip multi-word phrases from a copy to handle `Movie Title - Türkçe Dublaj`, `Dual Audio`
  let work = trimmed;
  const matchedPhrases: string[] = [];
  for (const [re, canonical] of MULTI_WORD_TAGS) {
    re.lastIndex = 0;
    if (re.test(work)) {
      matchedPhrases.push(canonical);
      work = work.replace(re, ' ').trim();
    }
  }
  const remAtoms = work === '' ? [] : tokenizeVodTagGroup(work);
  if (matchedPhrases.length === 0 && remAtoms.length === 0) return null;

  for (const atom of remAtoms) {
    if (TWO_LETTER_ROMAN_NUMERALS.has(atom.toUpperCase())) return null;
    const spec = lookupVodTagSpec(atom);
    const key = foldTagKey(atom);
    const isUpper = atom === atom.toUpperCase();
    // Require ALL-CAPS on 2-letter alphabetic atoms so TitleCase words like `Title - It` or `Title - Us` stay intact.
    if (/^[A-Za-z]{2}$/.test(atom) && !isUpper) return null;
    const isCode = LANG_REGION_CODES.has(key) || TWO_LETTER_UPPER_RE.test(atom);
    const isDelimWord = DELIMITED_ONLY_WORDS.has(key);
    if (spec === undefined && !isCode && !isDelimWord) return null;
    // Protect single mixed-case dictionary-ambiguous words like `Title - Original`, `Title - New`, `Title - Top`
    if (
      remAtoms.length === 1 &&
      matchedPhrases.length === 0 &&
      !isUpper &&
      (spec?.uppercaseOnlyUnbracketed ||
        key === 'ORIGINAL' ||
        key === 'ORIJINAL' ||
        key === 'AUDIO')
    ) {
      return null;
    }
  }
  return [...matchedPhrases, ...remAtoms];
}

/** True when a single unbracketed token is safe to strip from title body or trailing noise run. */
export function isSafeUnbracketedNoiseToken(rawToken: string): VodTagSpec | undefined {
  const spec = lookupVodTagSpec(rawToken);
  if (spec === undefined || spec.safeUnbracketed !== true) return undefined;
  if (spec.uppercaseOnlyUnbracketed && rawToken !== rawToken.toUpperCase()) return undefined;
  return spec;
}
