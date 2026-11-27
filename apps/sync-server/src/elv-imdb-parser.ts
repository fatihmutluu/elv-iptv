import type { ElvMediaType, ImdbSuggestionCandidate } from './elv-types.ts';
import { foldTitleForMatch } from './elv-validation.ts';

/** Standard IMDb CDN width for poster images. */
export const IMDB_POSTER_WIDTH_PX = 300;

/** Minimum confidence score required to accept a metadata match (prevents false merges). */
export const MIN_MATCH_CONFIDENCE = 0.78;

const IMDB_IMAGE_V1_RE = /\._V1_[^/]*\.(?:jpe?g|png|webp)$/i;
const ALLOWED_AMAZON_MEDIA_HOST_RE = /^(?:[a-z0-9-]+\.)?media-amazon\.com$/;
const ALLOWED_IMDB_MEDIA_HOST_RE = /^(?:[a-z0-9-]+\.)?media-imdb\.com$/;

const LEADING_ARTICLE_RE = /^(?:the|a|an)\s+/;
const ROMAN_NUMERAL_TO_DIGIT: Readonly<Record<string, string>> = {
  ii: '2',
  iii: '3',
  iv: '4',
  v: '5',
  vi: '6',
  vii: '7',
  viii: '8',
  ix: '9',
  x: '10',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
};

const AMBIGUOUS_REMAKE_WINDOW_UNITS = 500;

function isAllowedImdbImageHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === 'images-na.ssl-images-amazon.com' ||
    ALLOWED_AMAZON_MEDIA_HOST_RE.test(lower) ||
    ALLOWED_IMDB_MEDIA_HOST_RE.test(lower)
  );
}

/**
 * Rewrites an IMDb/Amazon CDN image URL cleanly to `._V1_QL75_UX${widthPx}_.jpg`.
 * Strictly enforces HTTPS and an IMDb/Amazon media host allowlist (SSRF-safe).
 * Returns empty string for untrusted or malformed URLs.
 */
export function resizeImdbImageUrl(url: string, widthPx: number): string {
  if (typeof url !== 'string' || url.trim().length === 0) return '';
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return '';
  }
  if (parsed.protocol !== 'https:') return '';
  if (parsed.username !== '' || parsed.password !== '' || parsed.port !== '') return '';
  if (!isAllowedImdbImageHost(parsed.hostname)) return '';

  const clampedWidth = Math.min(1920, Math.max(40, Math.round(widthPx)));
  const cleanPath = parsed.pathname;
  const rewrittenPath = IMDB_IMAGE_V1_RE.test(cleanPath)
    ? cleanPath.replace(IMDB_IMAGE_V1_RE, `._V1_QL75_UX${clampedWidth}_.jpg`)
    : cleanPath;
  return `https://${parsed.hostname.toLowerCase()}${rewrittenPath}`;
}

/** Maps IMDb suggestion `qid`/`q` values to ELV media types (`movie`, `series`, or `other`). */
export function mapImdbQidToMediaType(qid: unknown, q?: unknown): ElvMediaType | 'other' {
  const token = String(qid ?? q ?? '')
    .trim()
    .toLowerCase();
  if (token === 'movie' || token === 'tvmovie' || token === 'feature' || token === 'short') {
    return 'movie';
  }
  if (
    token === 'tvseries' ||
    token === 'tvminiseries' ||
    token === 'tvspecial' ||
    token === 'tv series' ||
    token === 'tv mini-series'
  ) {
    return 'series';
  }
  return 'other';
}

function extractSequelToken(foldedTitle: string): string | null {
  const partMatch =
    /\b(?:part|chapter|vol|volume|book|episode)\s+(\d+|ii|iii|iv|v|vi|two|three|four|five)\b/.exec(
      foldedTitle,
    );
  if (partMatch?.[1]) {
    return ROMAN_NUMERAL_TO_DIGIT[partMatch[1]] ?? partMatch[1];
  }
  const tokens = foldedTitle.split(' ').filter(Boolean);
  if (tokens.length < 2) return null;
  const last = tokens[tokens.length - 1] ?? '';
  if (/^[2-9]$|^10$/.test(last)) return last;
  if (last in ROMAN_NUMERAL_TO_DIGIT) return ROMAN_NUMERAL_TO_DIGIT[last] ?? null;
  return null;
}

function normalizedLevenshteinSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const left = a.slice(0, 120);
  const right = b.slice(0, 120);
  const prev = new Array<number>(right.length + 1);
  const curr = new Array<number>(right.length + 1);
  for (let j = 0; j <= right.length; j += 1) prev[j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    curr[0] = i;
    const leftChar = left.charCodeAt(i - 1);
    for (let j = 1; j <= right.length; j += 1) {
      const cost = leftChar === right.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    for (let j = 0; j <= right.length; j += 1) prev[j] = curr[j] ?? 0;
  }
  const dist = prev[right.length] ?? maxLen;
  return Math.max(0, 1 - dist / Math.max(left.length, right.length));
}

/** Computes Turkish-safe, article- and sequel-aware title similarity (`0.0 .. 1.0`). */
export function computeTitleSimilarity(queryTitle: string, candidateTitle: string): number {
  const a = foldTitleForMatch(queryTitle);
  const b = foldTitleForMatch(candidateTitle);
  if (!a || !b) return 0;
  if (a === b) return 1;

  const aNoArt = a.replace(LEADING_ARTICLE_RE, '');
  const bNoArt = b.replace(LEADING_ARTICLE_RE, '');
  const leadingArticleDiffers =
    a.slice(0, a.length - aNoArt.length) !== b.slice(0, b.length - bNoArt.length);
  if (aNoArt.length > 0 && aNoArt === bNoArt) return 0.9;

  const aTokens = new Set(aNoArt.split(' ').filter(Boolean));
  const bTokens = new Set(bNoArt.split(' ').filter(Boolean));
  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection += 1;
  }
  const union = aTokens.size + bTokens.size - intersection;
  const jaccard = union > 0 ? intersection / union : 0;
  const charSim = normalizedLevenshteinSimilarity(aNoArt, bNoArt);
  let blended = 0.6 * jaccard + 0.4 * charSim;

  if (leadingArticleDiffers) {
    blended = Math.min(blended, 0.9);
  }

  const aSeq = extractSequelToken(a);
  const bSeq = extractSequelToken(b);
  if (aSeq !== bSeq) {
    blended = Math.max(0, blended - 0.35);
  }
  return blended;
}

/** Query attributes passed to candidate scoring and match selection helpers. */
export interface ImDbMatchQuery {
  readonly cleanTitle: string;
  readonly year: number | null;
  readonly mediaType: ElvMediaType;
}

/**
 * Scores an IMDb suggestion candidate against a cleaned catalog query (`0.0 .. 1.0`).
 * Strictly penalizes year mismatches >= 2 (preventing remake false merges) and type mismatches.
 */
export function scoreImdbCandidate(
  query: ImDbMatchQuery,
  candidate: ImdbSuggestionCandidate,
): number {
  const titleSim = computeTitleSimilarity(query.cleanTitle, candidate.title);
  let score = titleSim * 0.85;

  if (candidate.mediaType === 'other') {
    score -= 0.4;
  } else if (candidate.mediaType !== query.mediaType) {
    score -= 0.35;
  }

  if (query.year !== null && candidate.year !== null) {
    const diff = Math.abs(query.year - candidate.year);
    if (diff === 0) {
      score += 0.15;
    } else if (diff === 1) {
      score += 0.05;
    } else {
      score -= 0.4;
    }
  } else if (query.year !== null && candidate.year === null) {
    score -= 0.08;
  }

  const clamped = Math.max(0, Math.min(1, score));
  return Math.round(clamped * 10_000) / 10_000;
}

/** Returns true when `queryYear === null` and distinct-year candidates tie within remake ambiguity window. */
export function hasAmbiguousRemakeYears(
  bestConfidence: number,
  entries: readonly { readonly confidence: number; readonly year: number | null }[],
): boolean {
  if (entries.length < 2) return false;
  const distinctYears = new Set<number>();
  for (const entry of entries) {
    const deltaUnits = Math.round((bestConfidence - entry.confidence) * 10_000);
    if (deltaUnits <= AMBIGUOUS_REMAKE_WINDOW_UNITS && entry.year !== null) {
      distinctYears.add(entry.year);
    }
  }
  return distinctYears.size >= 2;
}

/**
 * Selects the highest-scoring IMDb candidate above `MIN_MATCH_CONFIDENCE` (0.78), or `null`.
 * Rejects ambiguous remakes when `query.year === null` and >= 2 distinct-year candidates score within `0.05`.
 */
export function selectBestImdbMatch(
  query: ImDbMatchQuery,
  candidates: readonly ImdbSuggestionCandidate[],
): { readonly candidate: ImdbSuggestionCandidate; readonly confidence: number } | null {
  const qualified: {
    readonly candidate: ImdbSuggestionCandidate;
    readonly confidence: number;
    readonly year: number | null;
  }[] = [];
  let best: { readonly candidate: ImdbSuggestionCandidate; readonly confidence: number } | null =
    null;

  for (const candidate of candidates) {
    const confidence = scoreImdbCandidate(query, candidate);
    if (confidence >= MIN_MATCH_CONFIDENCE) {
      qualified.push({ candidate, confidence, year: candidate.year });
      if (!best || confidence > best.confidence) {
        best = { candidate, confidence };
      }
    }
  }

  if (!best) return null;
  if (query.year === null && hasAmbiguousRemakeYears(best.confidence, qualified)) {
    return null;
  }
  return best;
}
