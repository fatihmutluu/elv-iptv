import { foldText } from './fold';
import { cleanDisplayTitle } from './title-clean';

/** Normalized VOD/series title and extracted release year used for metadata enrichment (`#215`). */
export interface CleanedVodTitle {
  readonly cleanTitle: string;
  readonly releaseYear: number | null;
  readonly foldedTitle: string;
}

const YEAR_MIN = 1900;
const YEAR_MAX = 2099;

const NOISE_ATOMS: ReadonlySet<string> = new Set([
  '4K',
  '8K',
  'UHD',
  'FHD',
  'HD',
  'SD',
  '2160P',
  '1080P',
  '720P',
  '576P',
  '480P',
  'HEVC',
  'X265',
  'X264',
  'H265',
  'H264',
  'H.265',
  'H.264',
  'HDR',
  'HDR10',
  'HDR10+',
  'DV',
  'DOLBY',
  'ATMOS',
  'BLURAY',
  'BLU-RAY',
  'BDRIP',
  'BRRIP',
  'WEBRIP',
  'WEB-DL',
  'WEBDL',
  'HDTV',
  'DVDRIP',
  'CAM',
  'TS',
  'REMUX',
  'MULTI',
  'DUAL',
  'TR-DUB',
  'TRDUB',
  'EN-DUB',
  'TR-SUB',
  'ENG-SUB',
  'ALT',
  'SUB',
  'DUB',
  'SUBBED',
  'DUBBED',
  'DUBLAJ',
  'ALTYAZI',
  'RAW',
  'VIP',
  '60FPS',
  '50FPS',
  '10BIT',
  'AAC',
  'AC3',
  'DTS',
  'NF',
  'AMZN',
  'DSNP',
  'ATVP',
  'IMAX',
  'EXTENDED',
  'REMASTERED',
  'UNCUT',
  'UNRATED',
]);

const COUNTRY_CODE_RE = /^[A-Z]{2}$/;
const YEAR_RE = /^(19|20)\d{2}$/;
const BRACKET_GROUP_RE = /[[(]([^[\]()]{1,32})[\])]/g;
const LEADING_PAREN_TAG_RE = /^\(([^()]{1,24})\)\s*(?:[-–—:|/•·]\s*)?/;
const LEADING_DELIMITED_NOISE_RE = /^([A-Za-z0-9.]{2,12})\s*(?:[|:]\s*|\s+[-–—]\s+|[-–—]\s+)/;
const TRAILING_SEP_RE = /[\s\-–—:|/•·]+$/;
const LEADING_SEP_RE = /^[\s\-–—:|/•·]+/;

function isValidYear(y: number | null | undefined): y is number {
  return typeof y === 'number' && Number.isInteger(y) && y >= YEAR_MIN && y <= YEAR_MAX;
}

function isNoiseAtom(atom: string): boolean {
  const upper = atom.toUpperCase();
  if (NOISE_ATOMS.has(upper)) return true;
  if (COUNTRY_CODE_RE.test(atom)) return true;
  return false;
}

function isNoiseGroup(inner: string): boolean {
  const atoms = inner
    .trim()
    .split(/[\s/+._|,-]+/)
    .filter(Boolean);
  if (atoms.length === 0) return false;
  return atoms.every(isNoiseAtom);
}

/**
 * Strips noisy IPTV prefixes/suffixes (`TR:`, `US |`, `[4K]`, `(UHD)`, `[FHD]`, `1080p`, `HEVC`,
 * `x265`, `H.264`, `HDR`, `BLURAY`, `WEB-DL`, `MULTI`, `TR-DUB`, `ALT`, `SUB`, `DUB`) and extracts
 * `(YYYY)` / `[YYYY]` / trailing `YYYY` (`1900..2099`) into `releaseYear` while preserving sequel
 * numbers (`2`, `3`, `II`, `Part 2`) and leading numeric titles (`2001: A Space Odyssey`).
 */
export function cleanVodTitle(rawTitle: string, existingYear?: number | null): CleanedVodTitle {
  const fallbackYear = isValidYear(existingYear) ? existingYear : null;
  const trimmed = rawTitle.trim().replace(/\s+/g, ' ');
  if (trimmed === '') {
    return { cleanTitle: '', releaseYear: fallbackYear, foldedTitle: '' };
  }

  let current = cleanDisplayTitle(trimmed);
  let extractedYear: number | null = null;

  // Strip leading parenthesized tags like "(UHD) Title" or "(TR) Title" and uppercase delimited noise prefixes like "AMZN | Title"
  for (;;) {
    const m = LEADING_PAREN_TAG_RE.exec(current);
    if (m !== null && isNoiseGroup(m[1] ?? '')) {
      const rest = current.slice(m[0].length).trim();
      if (rest === '') break;
      current = rest;
      continue;
    }
    const delim = LEADING_DELIMITED_NOISE_RE.exec(current);
    const token = delim?.[1] ?? '';
    if (delim !== null && token !== '' && token === token.toUpperCase() && NOISE_ATOMS.has(token)) {
      const rest = current.slice(delim[0].length).trim();
      if (rest === '') break;
      current = rest;
      continue;
    }
    break;
  }

  // Extract bracketed/parenthesized years and remove bracketed noise groups
  const afterBrackets = current.replace(BRACKET_GROUP_RE, (full, inner: string) => {
    const innerTrim = inner.trim();
    if (YEAR_RE.test(innerTrim)) {
      const parsed = Number(innerTrim);
      if (isValidYear(parsed)) {
        extractedYear = parsed;
        return ' ';
      }
    }
    // Handle combined bracket like "(2024 4K)" or "[TR 1080p]"
    const tokens = innerTrim.split(/[\s/+|,-]+/).filter(Boolean);
    if (tokens.length > 0) {
      let groupYear: number | null = null;
      const allNoiseOrYear = tokens.every((tok) => {
        if (YEAR_RE.test(tok)) {
          const parsed = Number(tok);
          if (isValidYear(parsed)) {
            groupYear = parsed;
            return true;
          }
        }
        return isNoiseAtom(tok);
      });
      if (allNoiseOrYear) {
        if (groupYear !== null) extractedYear = groupYear;
        return ' ';
      }
    }
    return full;
  });

  current = afterBrackets.replace(/\s+/g, ' ').replace(TRAILING_SEP_RE, '').trim();

  // Strip unbracketed trailing noise tokens (and trailing bare YYYY if not the only token)
  const words = current.split(/\s+/).filter(Boolean);
  while (words.length > 1) {
    const last = words[words.length - 1] as string;
    const strippedPunct = last.replace(/^[-–—:|/•·]+|[-–—:|/•·]+$/g, '');
    if (strippedPunct === '') {
      words.pop();
      continue;
    }
    if (NOISE_ATOMS.has(strippedPunct.toUpperCase())) {
      words.pop();
      continue;
    }
    // Bare trailing release year (e.g., "Big Buck Bunny 2008 1080p") ONLY when no bracketed year was already found
    if (extractedYear === null && YEAR_RE.test(strippedPunct)) {
      const parsed = Number(strippedPunct);
      if (isValidYear(parsed)) {
        extractedYear = parsed;
        words.pop();
        continue;
      }
    }
    break;
  }

  // Re-run cleanDisplayTitle once more in case stripping bracketed tags exposed a delimited prefix
  current = words.join(' ').replace(LEADING_SEP_RE, '').replace(TRAILING_SEP_RE, '').trim();
  if (current !== '') {
    current = cleanDisplayTitle(current).replace(TRAILING_SEP_RE, '').trim();
  }

  const cleanTitle = current === '' ? trimmed : current;
  const releaseYear = extractedYear ?? fallbackYear;
  return {
    cleanTitle,
    releaseYear,
    foldedTitle: foldText(cleanTitle),
  };
}
