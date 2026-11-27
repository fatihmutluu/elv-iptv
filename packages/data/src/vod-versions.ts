import { foldText } from './fold';
import {
  classifyLeadingDelimitedPrefix,
  classifyTrailingDelimitedNoise,
  classifyVodBracketGroup,
  foldTagKey,
  isSafeUnbracketedNoiseToken,
  isValidVodYear,
  lookupVodTagSpec,
  MULTI_WORD_TAGS,
  maxBareVodTrailingYear,
  parseVodYearToken,
  VOD_MAX_YEAR,
  VOD_MIN_YEAR,
} from './vod-tags';

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

const LEADING_BRACKET_RE = /^\s*[[(]([^[\]()]{1,64})[\])]\s*(?:[-–—:|/•·]\s*)?/;
const LEADING_TAG_PREFIX_RE =
  /^\s*([\p{L}\p{N}.+_-]{2,18}(?:\s+[\p{L}\p{N}.+_-]{2,18})?)\s*(?:\||:|[-–—]\s+)\s*/u;
const BRACKET_GROUP_RE = /\s*\[([^\]]{1,64})\]\s*|\s*\(([^)]{1,64})\)\s*/g;
const TRAILING_DELIMITED_RE = /^(.+?)(?:\s+[-–—•·]\s+|\s*\|\s*)([^|[\]()]+)$/;
const WORD_OR_DELIM_SPLIT_RE = /(\s+)/;
const TRAILING_SEP_RE = /[\s\-–—:|/•·]+$/;

/**
 * Parses a VOD movie title and optional release year into a deterministic `groupKey`,
 * human-readable `versionLabel`, and `qualityRank` (`#404`).
 * Strips multilingual/quality/edition prefixes, mixed year+noise brackets, bare trailing years,
 * and trailing noise suffixes while preserving sequel numbers, Roman numerals (`II`, `III`, `IV`),
 * protected short-word titles (`It`, `Up`, `Us`, `Her`, `Top Gun`), and numeric titles (`2001`, `1917`).
 */
export function parseVodVersion(title: string, year?: number | null): ParsedVodVersion {
  const trimmed = title.trim();
  if (trimmed === '') {
    return { groupKey: '', versionLabel: '', qualityRank: DEFAULT_QUALITY_RANK };
  }

  let current = trimmed;
  const fallbackYear = isValidVodYear(year, VOD_MIN_YEAR, VOD_MAX_YEAR) ? year : undefined;
  let extractedYear: number | undefined;
  let baseRank = -1;
  let bonusRank = 0;
  const labels: string[] = [];
  const seenLabels = new Set<string>();

  const recordLabel = (label: string, rank?: number, bonus?: number): void => {
    if (rank !== undefined && rank > baseRank) baseRank = rank;
    if (bonus !== undefined && bonus > 0) bonusRank += bonus;
    if (label !== '' && !seenLabels.has(label)) {
      seenLabels.add(label);
      labels.push(label);
    }
  };

  const recordAtom = (atom: string): void => {
    if (parseVodYearToken(atom, VOD_MIN_YEAR, VOD_MAX_YEAR) !== null) return;
    const spec = lookupVodTagSpec(atom);
    if (spec !== undefined) {
      recordLabel(spec.canonical, spec.rank, spec.bonus);
      return;
    }
    const upper = foldTagKey(atom);
    if (upper !== '') recordLabel(upper);
  };

  // 1. Stacked leading prefixes (`[TR]`, `(FR)`, `TR |`, `TUR | 4K -`, `AMZN:`)
  for (;;) {
    const leadBracket = LEADING_BRACKET_RE.exec(current);
    if (leadBracket !== null) {
      const classified = classifyVodBracketGroup(
        leadBracket[1] ?? '',
        true,
        VOD_MIN_YEAR,
        VOD_MAX_YEAR,
      );
      if (classified !== null) {
        const rest = current.slice(leadBracket[0].length).trim();
        if (rest.length > 0) {
          if (classified.extractedYear !== null && extractedYear === undefined) {
            extractedYear = classified.extractedYear;
          }
          for (const atom of classified.atoms) recordAtom(atom);
          current = rest;
          continue;
        }
      }
    }

    const leadDelim = LEADING_TAG_PREFIX_RE.exec(current);
    if (leadDelim !== null) {
      const atoms = classifyLeadingDelimitedPrefix(leadDelim[1] ?? '');
      if (atoms !== null) {
        const rest = current.slice(leadDelim[0].length).trim();
        if (rest.length > 0) {
          for (const atom of atoms) recordAtom(atom);
          current = rest;
          continue;
        }
      }
    }
    break;
  }

  // 2. Trailing delimited noise segments (`Movie Title - 4K`, `Movie Title - Türkçe Dublaj`)
  for (;;) {
    const delim = TRAILING_DELIMITED_RE.exec(current);
    if (delim === null) break;
    const before = (delim[1] ?? '').trim();
    const seg = (delim[2] ?? '').trim();
    const atoms = classifyTrailingDelimitedNoise(seg);
    if (before.length > 0 && atoms !== null) {
      for (const atom of atoms) {
        const spec = lookupVodTagSpec(atom);
        if (spec !== undefined) recordLabel(spec.canonical, spec.rank, spec.bonus);
        else recordLabel(atom);
      }
      current = before;
      continue;
    }
    break;
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

  // 4. Extract pure year & mixed year+tag groups inside [...] or (...) while preserving title body
  current = current.replace(
    BRACKET_GROUP_RE,
    (full, g1: string | undefined, g2: string | undefined) => {
      const inner = (g1 ?? g2 ?? '').trim();
      const classified = classifyVodBracketGroup(inner, true, VOD_MIN_YEAR, VOD_MAX_YEAR);
      if (classified === null) return full;
      const remaining = current.replace(full, ' ').trim();
      if (remaining.length === 0) return full;
      if (classified.extractedYear !== null && extractedYear === undefined) {
        extractedYear = classified.extractedYear;
      }
      for (const atom of classified.atoms) recordAtom(atom);
      return ' ';
    },
  );

  current = current.replace(/\s+/g, ' ').replace(TRAILING_SEP_RE, '').trim();

  // 5. Extract safe bounded standalone VOD tokens (preserving real short-word titles and Roman numerals)
  const parts = current.split(WORD_OR_DELIM_SPLIT_RE);
  const keptParts: string[] = [];
  let nonEmptyCount = 0;
  for (const part of parts) {
    if (part === '' || /^\s+$/.test(part)) {
      keptParts.push(part);
      continue;
    }
    const cleanedWord = part.replace(/^[-–—:|/•·]+|[-–—:|/•·]+$/g, '');
    const spec = cleanedWord === '' ? undefined : isSafeUnbracketedNoiseToken(cleanedWord);
    if (
      spec !== undefined &&
      (nonEmptyCount > 0 || parts.filter((p) => p.trim() !== '').length > 1)
    ) {
      recordLabel(spec.canonical, spec.rank, spec.bonus);
      continue;
    }
    nonEmptyCount += 1;
    keptParts.push(part);
  }
  const afterTokens = keptParts.join('').replace(/\s+/g, ' ').replace(TRAILING_SEP_RE, '').trim();
  if (afterTokens.length > 0) current = afterTokens;

  // 6. Strip bare trailing YYYY when no bracketed year was extracted (e.g. `Dune Part Two 2024`)
  if (extractedYear === undefined) {
    const words = current.split(/\s+/).filter(Boolean);
    if (words.length > 1) {
      const last = words[words.length - 1] ?? '';
      const bareYear = parseVodYearToken(last, VOD_MIN_YEAR, maxBareVodTrailingYear());
      if (
        bareYear !== null &&
        (fallbackYear === undefined || Math.abs(bareYear - fallbackYear) <= 1)
      ) {
        extractedYear = bareYear;
        words.pop();
        current = words.join(' ').replace(TRAILING_SEP_RE, '').trim();
      }
    }
  }

  // Re-check trailing delimited noise if bracket removal exposed e.g. `Movie Title - VOSTFR`
  for (;;) {
    const delim = TRAILING_DELIMITED_RE.exec(current);
    if (delim === null) break;
    const before = (delim[1] ?? '').trim();
    const seg = (delim[2] ?? '').trim();
    const atoms = classifyTrailingDelimitedNoise(seg);
    if (before.length > 0 && atoms !== null) {
      for (const atom of atoms) {
        const spec = lookupVodTagSpec(atom);
        if (spec !== undefined) recordLabel(spec.canonical, spec.rank, spec.bonus);
        else recordLabel(atom);
      }
      current = before;
      continue;
    }
    break;
  }

  const resolvedYear = extractedYear ?? fallbackYear;
  const foldedStem = foldText(current);
  const finalStem = foldedStem.length > 0 ? foldedStem : foldText(trimmed);
  const groupKey = resolvedYear !== undefined ? `${finalStem}::${resolvedYear}` : finalStem;
  const qualityRank = (baseRank >= 0 ? baseRank : DEFAULT_QUALITY_RANK) + bonusRank;

  return {
    groupKey,
    versionLabel: labels.join(' '),
    qualityRank,
  };
}
