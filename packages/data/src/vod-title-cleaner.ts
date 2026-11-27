import { foldText } from './fold';
import { cleanDisplayTitle } from './title-clean';
import {
  classifyLeadingDelimitedPrefix,
  classifyTrailingDelimitedNoise,
  classifyVodBracketGroup,
  isSafeUnbracketedNoiseToken,
  isValidVodYear,
  MULTI_WORD_TAGS,
  maxBareVodTrailingYear,
  parseVodYearToken,
} from './vod-tags';

/** Normalized VOD/series title and extracted release year used for metadata enrichment (`#215`). */
export interface CleanedVodTitle {
  readonly cleanTitle: string;
  readonly releaseYear: number | null;
  readonly foldedTitle: string;
}

const YEAR_MIN = 1900;
const YEAR_MAX = 2099;

const LEADING_BRACKET_RE = /^[[(]([^[\]()]{1,64})[\])]\s*(?:[-–—:|/•·]\s*)?/;
const LEADING_DELIMITED_NOISE_RE =
  /^([\p{L}\p{N}.+_-]{2,18})\s*(?:([|:])\s*|\s+[-–—]\s+|[-–—]\s+)/u;
const BRACKET_GROUP_RE = /[[(]([^[\]()]{1,64})[\])]/g;
const TRAILING_DELIMITED_RE = /^(.+?)(?:\s+[-–—•·]\s+|\s*\|\s*)([^|[\]()]+)$/;
const TRAILING_SEP_RE = /[\s\-–—:|/•·]+$/;
const LEADING_SEP_RE = /^[\s\-–—:|/•·]+/;

/**
 * Strips noisy IPTV prefixes/suffixes (`TR:`, `TUR |`, `FR |`, `[4K]`, `(UHD)`, `[FHD]`, `1080p`,
 * `HEVC`, `x265`, `H.264`, `HDR`, `BLURAY`, `WEB-DL`, `MULTI`, `TR-DUB`, `VOSTFR`, `ALTYAZILI`, etc.)
 * and extracts `(YYYY)` / `[YYYY]` / mixed `[2024 - Altyazılı]` / trailing `YYYY` (`1900..2099`)
 * into `releaseYear` while preserving sequel numbers (`2`, `3`, `II`, `Part 2`), protected short
 * words (`It`, `Up`, `Us`, `Her`, `Top Gun`), and numeric titles (`2001: A Space Odyssey`, `1917`).
 */
export function cleanVodTitle(rawTitle: string, existingYear?: number | null): CleanedVodTitle {
  const fallbackYear = isValidVodYear(existingYear, YEAR_MIN, YEAR_MAX) ? existingYear : null;
  const trimmed = rawTitle.trim().replace(/\s+/g, ' ');
  if (trimmed === '') {
    return { cleanTitle: '', releaseYear: fallbackYear, foldedTitle: '' };
  }

  let current = trimmed;
  let extractedYear: number | null = null;

  // 1. Strip stacked leading brackets & delimited multilingual/quality prefixes in a loop
  for (;;) {
    const bracketMatch = LEADING_BRACKET_RE.exec(current);
    if (bracketMatch !== null) {
      const classified = classifyVodBracketGroup(bracketMatch[1] ?? '', true, YEAR_MIN, YEAR_MAX);
      if (classified !== null) {
        const rest = current.slice(bracketMatch[0].length).trim();
        if (rest !== '') {
          if (classified.extractedYear !== null) extractedYear = classified.extractedYear;
          current = rest;
          continue;
        }
      }
    }

    const delimMatch = LEADING_DELIMITED_NOISE_RE.exec(current);
    if (delimMatch !== null) {
      const classified = classifyLeadingDelimitedPrefix(delimMatch[1] ?? '');
      if (classified !== null) {
        const rest = current.slice(delimMatch[0].length).trim();
        if (rest !== '') {
          current = rest;
          continue;
        }
      }
    }
    break;
  }

  // 2. Replace bracketed/parenthesized years and pure/mixed noise groups while never emptying title
  const afterBrackets = current.replace(BRACKET_GROUP_RE, (full, inner: string) => {
    const classified = classifyVodBracketGroup(inner, true, YEAR_MIN, YEAR_MAX);
    if (classified === null) return full;
    if (classified.extractedYear !== null) extractedYear = classified.extractedYear;
    return ' ';
  });

  const nonEmptyAfterBrackets = afterBrackets
    .replace(/\s+/g, ' ')
    .replace(TRAILING_SEP_RE, '')
    .trim();
  if (nonEmptyAfterBrackets !== '') {
    current = nonEmptyAfterBrackets;
  }

  // 3. Strip trailing ` - <noise>` / ` | <noise>` segments and multi-word/unbracketed trailing noise
  for (;;) {
    const delim = TRAILING_DELIMITED_RE.exec(current);
    if (delim !== null) {
      const before = (delim[1] ?? '').trim();
      const seg = (delim[2] ?? '').trim();
      if (before !== '' && classifyTrailingDelimitedNoise(seg) !== null) {
        current = before;
        continue;
      }
    }

    let strippedMultiWord = false;
    for (const [re] of MULTI_WORD_TAGS) {
      re.lastIndex = 0;
      if (re.test(current)) {
        const next = current
          .replace(re, ' ')
          .replace(/\s+/g, ' ')
          .replace(TRAILING_SEP_RE, '')
          .trim();
        if (next !== '' && next !== current) {
          current = next;
          strippedMultiWord = true;
          break;
        }
      }
    }
    if (strippedMultiWord) continue;

    break;
  }

  // 4. Strip unbracketed trailing noise tokens (and bare trailing YYYY when no bracket year was found)
  const words = current.split(/\s+/).filter(Boolean);
  while (words.length > 1) {
    const last = words[words.length - 1] as string;
    const strippedPunct = last.replace(/^[-–—:|/•·]+|[-–—:|/•·]+$/g, '');
    if (strippedPunct === '') {
      words.pop();
      continue;
    }
    if (isSafeUnbracketedNoiseToken(strippedPunct) !== undefined) {
      words.pop();
      continue;
    }
    if (extractedYear === null) {
      const bareYear = parseVodYearToken(strippedPunct, YEAR_MIN, maxBareVodTrailingYear());
      if (bareYear !== null && (fallbackYear === null || Math.abs(bareYear - fallbackYear) <= 1)) {
        extractedYear = bareYear;
        words.pop();
        continue;
      }
    }
    break;
  }

  current = words.join(' ').replace(LEADING_SEP_RE, '').replace(TRAILING_SEP_RE, '').trim();
  if (current !== '') {
    current = cleanDisplayTitle(current).replace(TRAILING_SEP_RE, '').trim();
  }

  // Re-run trailing delimited check if bracket removal or cleanDisplayTitle exposed a trailing noise tag
  for (;;) {
    const delim = TRAILING_DELIMITED_RE.exec(current);
    if (delim === null) break;
    const before = (delim[1] ?? '').trim();
    const seg = (delim[2] ?? '').trim();
    if (before !== '' && classifyTrailingDelimitedNoise(seg) !== null) {
      current = before;
      continue;
    }
    break;
  }

  const cleanTitle = current === '' ? trimmed : current;
  const releaseYear = extractedYear ?? fallbackYear;
  return {
    cleanTitle,
    releaseYear,
    foldedTitle: foldText(cleanTitle),
  };
}
