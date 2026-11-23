import { foldText } from './fold';

/** Parsed version grouping key, display label, and quality rank for a VOD movie title (`#404`). */
export interface ParsedVodVersion {
  /** Normalized group key (`<folded-base>` or `<folded-base>::<year>` when release year is known). */
  readonly groupKey: string;
  /** Concise extracted version label (e.g. `4K HDR`, `1080p Dubbed`, or `''` when untagged). */
  readonly versionLabel: string;
  /** Numeric quality rank for picking the default/best version. */
  readonly qualityRank: number;
}

const DEFAULT_QUALITY_RANK = 15;
const MIN_MOVIE_YEAR = 1888;
const MAX_MOVIE_YEAR = 2100;

const COUNTRY_OR_LANG_BRACKET_RE = /^\s*\[([A-Z]{2,3})\]\s*(?:[-–—:|/•·]\s*)?/;
const LEADING_TAG_PREFIX_RE =
  /^\s*([A-Z]{2}|4K|UHD|FHD|HD|SD|MULTI|DUB|SUB)\s*(?:\||:|[-–—]\s+)\s*/;
const TRAILING_YEAR_PARENS_RE = /\s*[([]((?:18|19|20)\d{2})[)\]]\s*/g;
const BRACKET_GROUP_RE = /\s*\[([^\]]{1,48})\]\s*|\s*\(([^)]{1,48})\)\s*/g;

interface TagSpec {
  readonly canonical: string;
  readonly rank?: number;
  readonly bonus?: number;
}

const VOD_TAGS: Readonly<Record<string, TagSpec>> = {
  '4K': { canonical: '4K', rank: 40 },
  UHD: { canonical: '4K', rank: 40 },
  '2160P': { canonical: '4K', rank: 40 },
  FHD: { canonical: '1080p', rank: 30 },
  '1080P': { canonical: '1080p', rank: 30 },
  HD: { canonical: '720p', rank: 20 },
  '720P': { canonical: '720p', rank: 20 },
  SD: { canonical: 'SD', rank: 10 },
  '480P': { canonical: 'SD', rank: 10 },
  CAM: { canonical: 'CAM', rank: 5 },
  TS: { canonical: 'TS', rank: 5 },
  HDTS: { canonical: 'TS', rank: 5 },
  REMUX: { canonical: 'REMUX', bonus: 4 },
  BLURAY: { canonical: 'BluRay', bonus: 2 },
  'BLU-RAY': { canonical: 'BluRay', bonus: 2 },
  BDRIP: { canonical: 'BDRip', bonus: 1 },
  'BD-RIP': { canonical: 'BDRip', bonus: 1 },
  BRRIP: { canonical: 'BRRip', bonus: 1 },
  'BR-RIP': { canonical: 'BRRip', bonus: 1 },
  'WEB-DL': { canonical: 'WEB-DL', bonus: 1 },
  WEBDL: { canonical: 'WEB-DL', bonus: 1 },
  WEBRIP: { canonical: 'WEBRip' },
  'WEB-RIP': { canonical: 'WEBRip' },
  HDRIP: { canonical: 'HDRip' },
  'HD-RIP': { canonical: 'HDRip' },
  DVDRIP: { canonical: 'DVDRip' },
  'DVD-RIP': { canonical: 'DVDRip' },
  TVRIP: { canonical: 'TVRip' },
  'TV-RIP': { canonical: 'TVRip' },
  HDR: { canonical: 'HDR', bonus: 2 },
  HDR10: { canonical: 'HDR10', bonus: 2 },
  'HDR10+': { canonical: 'HDR10+', bonus: 2 },
  DV: { canonical: 'DV', bonus: 2 },
  HEVC: { canonical: 'HEVC', bonus: 1 },
  H265: { canonical: 'HEVC', bonus: 1 },
  'H.265': { canonical: 'HEVC', bonus: 1 },
  X265: { canonical: 'HEVC', bonus: 1 },
  H264: { canonical: 'H.264' },
  'H.264': { canonical: 'H.264' },
  X264: { canonical: 'H.264' },
  AV1: { canonical: 'AV1', bonus: 1 },
  '10BIT': { canonical: '10bit' },
  '60FPS': { canonical: '60fps' },
  ATMOS: { canonical: 'Atmos' },
  DTS: { canonical: 'DTS' },
  '3D': { canonical: '3D' },
  IMAX: { canonical: 'IMAX' },
  EXTENDED: { canonical: 'Extended' },
  UNRATED: { canonical: 'Unrated' },
  REMASTERED: { canonical: 'Remastered' },
  UNCUT: { canonical: 'Uncut' },
  THEATRICAL: { canonical: 'Theatrical' },
  DUBBED: { canonical: 'Dubbed' },
  SUBTITLED: { canonical: 'Subtitled' },
  DUB: { canonical: 'Dubbed' },
  SUB: { canonical: 'Subtitled' },
  MULTI: { canonical: 'Multi' },
  DUAL: { canonical: 'Dual Audio' },
  VOSTFR: { canonical: 'VOSTFR' },
  DUBLAJ: { canonical: 'Dublaj' },
  ALTYAZILI: { canonical: 'Altyazılı' },
};

const MULTI_WORD_TAGS: readonly (readonly [RegExp, string, number])[] = [
  [/\bDolby\s+Vision\b/gi, 'DV', 2],
  [/\bDirector'?s\s+Cut\b/gi, "Director's Cut", 0],
  [/\bExtended\s+Cut\b/gi, 'Extended', 0],
  [/\bSpecial\s+Edition\b/gi, 'Special Edition', 0],
  [/\bDual\s+Audio\b/gi, 'Dual Audio', 0],
  [/\bMulti[\s-]+Audio\b/gi, 'Multi', 0],
  [/\bT[üu]rk[çc]e\s+Dublaj\b/gi, 'TR Dublaj', 0],
  [/\bTR\s+Dublaj\b/gi, 'TR Dublaj', 0],
];

const STANDALONE_VOD_TOKEN_RE =
  /(?<![\p{L}\p{N}])(4K|UHD|2160P|FHD|1080P|HD|720P|SD|480P|REMUX|BLU-RAY|BLURAY|BD-RIP|BDRIP|BR-RIP|BRRIP|WEB-DL|WEBDL|WEB-RIP|WEBRIP|HD-RIP|HDRIP|DVD-RIP|DVDRIP|TV-RIP|TVRIP|HDR10\+|HDR10|HDR|HEVC|H\.265|H265|X265|H\.264|H264|X264|AV1|10BIT|60FPS|ATMOS|IMAX|EXTENDED|UNRATED|REMASTERED|UNCUT|THEATRICAL|DUBBED|SUBTITLED|MULTI|VOSTFR|DUBLAJ|ALTYAZILI)(?![\p{L}\p{N}])/giu;

const TWO_LETTER_UPPER_RE = /^[A-Z]{2}$/;
const TWO_LETTER_ROMAN_NUMERALS = new Set(['II', 'IV', 'VI', 'IX', 'XI', 'XV', 'XX']);

function isTwoLetterLangOrCountry(atom: string): boolean {
  return TWO_LETTER_UPPER_RE.test(atom) && !TWO_LETTER_ROMAN_NUMERALS.has(atom);
}

function isValidYear(y: number | null | undefined): y is number {
  return typeof y === 'number' && Number.isInteger(y) && y >= MIN_MOVIE_YEAR && y <= MAX_MOVIE_YEAR;
}

function tokenizeTagGroup(content: string): string[] {
  const atoms: string[] = [];
  for (const rawPiece of content.trim().split(/[\s/|+,]+/)) {
    const piece = rawPiece.replace(/^-+|-+$/g, '');
    if (piece.length === 0) continue;
    if (Object.hasOwn(VOD_TAGS, piece.toUpperCase()) || !piece.includes('-')) {
      atoms.push(piece);
      continue;
    }
    const parts = piece.split(/-+/).filter(Boolean);
    for (let i = 0; i < parts.length; ) {
      const part = parts[i] ?? '';
      const next = parts[i + 1];
      if (next !== undefined) {
        const pair = `${part}-${next}`;
        if (Object.hasOwn(VOD_TAGS, pair.toUpperCase())) {
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

function isPureTagGroup(content: string): boolean {
  const atoms = tokenizeTagGroup(content);
  if (atoms.length === 0) return false;
  return atoms.every((atom) => {
    const upper = atom.toUpperCase();
    return Object.hasOwn(VOD_TAGS, upper) || isTwoLetterLangOrCountry(atom);
  });
}

/**
 * Parses a VOD movie title and optional release year into a deterministic `groupKey`,
 * human-readable `versionLabel`, and `qualityRank` (`#404`).
 * Strips delimited quality/edition/language tags while preserving release years, sequel numbers,
 * Roman numerals (`II`, `III`, `Part 2`), and numeric titles (`2001`, `1917`).
 */
export function parseVodVersion(title: string, year?: number | null): ParsedVodVersion {
  const trimmed = title.trim();
  if (trimmed === '') {
    return { groupKey: '', versionLabel: '', qualityRank: DEFAULT_QUALITY_RANK };
  }

  let current = trimmed;
  let resolvedYear: number | undefined = isValidYear(year) ? year : undefined;
  let baseRank = -1;
  let bonusRank = 0;
  const labels: string[] = [];
  const seenLabels = new Set<string>();

  const recordLabel = (label: string, rank?: number, bonus?: number): void => {
    if (rank !== undefined && rank > baseRank) baseRank = rank;
    if (bonus !== undefined && bonus > 0) bonusRank += bonus;
    if (!seenLabels.has(label)) {
      seenLabels.add(label);
      labels.push(label);
    }
  };

  // 1. Strip leading bracketed country/lang prefix e.g. `[TR] Dune...`
  const leadBracket = COUNTRY_OR_LANG_BRACKET_RE.exec(current);
  if (leadBracket !== null) {
    const rest = current.slice(leadBracket[0].length).trim();
    if (rest.length > 0) {
      const code = (leadBracket[1] ?? '').toUpperCase();
      const spec = VOD_TAGS[code];
      if (spec !== undefined) recordLabel(spec.canonical, spec.rank, spec.bonus);
      else recordLabel(code);
      current = rest;
    }
  }

  // 2. Strip leading delimited prefix e.g. `TR | Dune...` or `4K - Dune...`
  const leadDelim = LEADING_TAG_PREFIX_RE.exec(current);
  if (leadDelim !== null) {
    const rest = current.slice(leadDelim[0].length).trim();
    if (rest.length > 0) {
      const code = (leadDelim[1] ?? '').toUpperCase();
      const spec = VOD_TAGS[code];
      if (spec !== undefined) recordLabel(spec.canonical, spec.rank, spec.bonus);
      else recordLabel(code);
      current = rest;
    }
  }

  // 3. Extract multi-word edition/audio/HDR tags
  for (const [re, label, bonus] of MULTI_WORD_TAGS) {
    re.lastIndex = 0;
    if (re.test(current)) {
      const next = current.replace(re, ' ').trim();
      if (next.length > 0) {
        recordLabel(label, undefined, bonus);
        current = next;
      }
    }
  }

  // 4. Extract parenthesized/bracketed 4-digit release year when title text remains
  current = current.replace(TRAILING_YEAR_PARENS_RE, (full, yStr: string) => {
    const parsedYear = Number(yStr);
    const remaining = current.replace(full, ' ').trim();
    if (remaining.length === 0 || !isValidYear(parsedYear)) return full;
    if (resolvedYear === undefined) resolvedYear = parsedYear;
    return ' ';
  });

  // 5. Extract pure tag groups inside [...] or (...)
  current = current.replace(
    BRACKET_GROUP_RE,
    (full, g1: string | undefined, g2: string | undefined) => {
      const inner = (g1 ?? g2 ?? '').trim();
      if (!isPureTagGroup(inner)) return full;
      const atoms = tokenizeTagGroup(inner);
      for (const atom of atoms) {
        const upper = atom.toUpperCase();
        const spec = VOD_TAGS[upper];
        if (spec !== undefined) recordLabel(spec.canonical, spec.rank, spec.bonus);
        else recordLabel(atom.toUpperCase());
      }
      return ' ';
    },
  );

  // 6. Extract standalone bounded VOD quality/edition/language tokens
  const afterTokens = current.replace(STANDALONE_VOD_TOKEN_RE, (_full, tok: string) => {
    const spec = VOD_TAGS[tok.toUpperCase()];
    if (spec !== undefined) recordLabel(spec.canonical, spec.rank, spec.bonus);
    return ' ';
  });

  const foldedStem = foldText(afterTokens);
  const finalStem = foldedStem.length > 0 ? foldedStem : foldText(trimmed);
  const groupKey = resolvedYear !== undefined ? `${finalStem}::${resolvedYear}` : finalStem;
  const qualityRank = (baseRank >= 0 ? baseRank : DEFAULT_QUALITY_RANK) + bonusRank;

  return {
    groupKey,
    versionLabel: labels.join(' '),
    qualityRank,
  };
}
