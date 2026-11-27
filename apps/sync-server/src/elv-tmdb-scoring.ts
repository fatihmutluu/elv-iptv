import {
  computeTitleSimilarity,
  hasAmbiguousRemakeYears,
  MIN_MATCH_CONFIDENCE,
} from './elv-imdb-parser.ts';
import type { ElvMediaType } from './elv-types.ts';

const TMDB_ID_RE = /^[1-9]\d{0,9}$/;

function asRecord(val: unknown): Record<string, unknown> | null {
  return val !== null && typeof val === 'object' && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : null;
}

function nonEmptyString(val: unknown): string | null {
  if (typeof val !== 'string') return null;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Parses a 4-digit release year (`1880..2100`) from a TMDB `YYYY-MM-DD` date string. */
export function parseTmdbReleaseYear(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const match = /^(\d{4})/.exec(raw.trim());
  if (!match?.[1]) return null;
  const year = Number(match[1]);
  return Number.isInteger(year) && year >= 1880 && year <= 2100 ? year : null;
}

/** Splits bilingual IPTV titles (`"Local - Original"` or `"Local / Original"`) into fallback search queries. */
export function splitDualTitleQuery(query: string): readonly string[] {
  const parts = query
    .split(/\s+(?:-|\/)\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 2);
  if (parts.length < 2) return [];
  const segments: string[] = [];
  const first = parts[0];
  const rest = parts.slice(1).join(' - ');
  if (first) segments.push(first);
  if (rest && !segments.includes(rest)) segments.push(rest);
  if (parts.length > 2) {
    const last = parts[parts.length - 1];
    if (last && !segments.includes(last)) segments.push(last);
  }
  return segments;
}

/** Raw TMDB search result shape normalized for scoring. */
export interface TmdbSearchCandidateRaw {
  readonly tmdbId: string;
  readonly title: string;
  readonly originalTitle: string;
  readonly year: number | null;
  readonly voteCount: number;
  readonly popularity: number;
}

/** Parses `/3/search/movie` or `/3/search/tv` results array into normalized scoring inputs. */
export function parseTmdbSearchResults(
  rawResults: unknown,
  mediaType: ElvMediaType,
): readonly TmdbSearchCandidateRaw[] {
  if (!Array.isArray(rawResults)) return [];
  const out: TmdbSearchCandidateRaw[] = [];
  for (const entry of rawResults) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const rawId = typeof rec.id === 'number' ? String(rec.id) : nonEmptyString(rec.id);
    if (!rawId || !TMDB_ID_RE.test(rawId)) continue;
    const title = nonEmptyString(mediaType === 'series' ? rec.name : rec.title);
    const originalTitle =
      nonEmptyString(mediaType === 'series' ? rec.original_name : rec.original_title) ?? title;
    if (!title && !originalTitle) continue;
    const year = parseTmdbReleaseYear(
      mediaType === 'series' ? rec.first_air_date : rec.release_date,
    );
    const voteCount =
      typeof rec.vote_count === 'number' && Number.isFinite(rec.vote_count) && rec.vote_count > 0
        ? Math.round(rec.vote_count)
        : 0;
    const popularity =
      typeof rec.popularity === 'number' && Number.isFinite(rec.popularity) && rec.popularity > 0
        ? rec.popularity
        : 0;
    out.push({
      tmdbId: rawId,
      title: title ?? originalTitle ?? '',
      originalTitle: originalTitle ?? title ?? '',
      year,
      voteCount,
      popularity,
    });
  }
  return out;
}

function scoreTmdbSearchCandidate(
  queryTitle: string,
  queryYear: number | null,
  candidate: TmdbSearchCandidateRaw,
): number {
  const titleSim = Math.max(
    computeTitleSimilarity(queryTitle, candidate.title),
    computeTitleSimilarity(queryTitle, candidate.originalTitle),
  );
  let score = titleSim * 0.85;
  if (queryYear !== null && candidate.year !== null) {
    const diff = Math.abs(queryYear - candidate.year);
    if (diff === 0) score += 0.15;
    else if (diff === 1) score += 0.05;
    else score -= 0.4;
  } else if (queryYear !== null && candidate.year === null) {
    score -= 0.08;
  }
  const clamped = Math.max(0, Math.min(1, score));
  return Math.round(clamped * 10_000) / 10_000;
}

/** Selects the best TMDB search candidate using confidence, remake guard, and vote/popularity tiebreak. */
export function selectBestTmdbCandidate(
  queryTitle: string,
  queryYear: number | null,
  candidates: readonly TmdbSearchCandidateRaw[],
): { readonly candidate: TmdbSearchCandidateRaw; readonly confidence: number } | null {
  interface Scored {
    readonly candidate: TmdbSearchCandidateRaw;
    readonly confidence: number;
    readonly year: number | null;
    readonly rankScore: number;
  }
  const qualified: Scored[] = [];
  let best: Scored | null = null;
  let maxVotes = 0;

  for (const candidate of candidates) {
    const confidence = scoreTmdbSearchCandidate(queryTitle, queryYear, candidate);
    if (confidence < MIN_MATCH_CONFIDENCE) continue;
    maxVotes = Math.max(maxVotes, candidate.voteCount);
    const voteBonus = Math.min(0.015, Math.log10(Math.max(1, candidate.voteCount + 1)) * 0.003);
    const popBonus = Math.min(0.005, Math.log10(Math.max(1, candidate.popularity + 1)) * 0.001);
    const entry: Scored = {
      candidate,
      confidence,
      year: candidate.year,
      rankScore: confidence + voteBonus + popBonus,
    };
    qualified.push(entry);
    if (!best || entry.rankScore > best.rankScore) {
      best = entry;
    }
  }

  if (!best) return null;

  if (queryYear === null && qualified.length >= 2) {
    const significant = qualified.filter(
      (entry) => !(maxVotes >= 100 && entry.candidate.voteCount < 10),
    );
    if (hasAmbiguousRemakeYears(best.confidence, significant)) {
      return null;
    }
  }

  return { candidate: best.candidate, confidence: best.confidence };
}
