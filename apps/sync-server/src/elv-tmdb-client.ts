import { fetchTmdbFeeds, resolveTmdbExternalImdbId } from './elv-tmdb-feeds.ts';
import { asRecord, defaultTmdbFetchFn, fetchTmdbJson } from './elv-tmdb-http.ts';
import { mapTmdbDetailToRichPayload, mapTmdbGenreIds, toTmdbBcp47Lang } from './elv-tmdb-mapper.ts';
import {
  parseTmdbSearchResults,
  selectBestTmdbCandidate,
  splitDualTitleQuery,
  type TmdbSearchCandidateRaw,
} from './elv-tmdb-scoring.ts';
import type {
  ElvFetchFn,
  ElvMediaType,
  ElvRichSearchMatchPayload,
  ElvRichTitlePayload,
  ElvSubrequestBudget,
} from './elv-types.ts';
import { validateImdbId } from './elv-validation.ts';

export { fetchTmdbFeeds, mapTmdbGenreIds, resolveTmdbExternalImdbId, toTmdbBcp47Lang };

const MAX_SEARCH_BYTES = 128 * 1024;
const MAX_DETAIL_BYTES = 512 * 1024;
const APPEND_DETAIL = 'credits,external_ids,recommendations,videos,translations';
const TMDB_ID_RE = /^[1-9]\d{0,9}$/;

/** Options accepted by TMDB v3 client calls. */
export interface TmdbClientOptions {
  readonly tmdbApiKey: string;
  readonly fetchFn?: ElvFetchFn;
  readonly nowMs?: number;
  readonly budget?: ElvSubrequestBudget;
}

/** Fetches full TMDB movie/TV detail directly by `tmdbId` with `0` `/find` hops. */
export async function fetchTmdbTitleDetail(
  tmdbId: string,
  mediaType: ElvMediaType,
  lang: string,
  options: TmdbClientOptions,
  fallbackImdbId?: string | null,
): Promise<{
  readonly payload: ElvRichTitlePayload | null;
  readonly subrequestsUsed: number;
  readonly budgetExhausted: boolean;
}> {
  if (!TMDB_ID_RE.test(tmdbId.trim())) {
    return { payload: null, subrequestsUsed: 0, budgetExhausted: false };
  }
  const fetchFn = options.fetchFn ?? defaultTmdbFetchFn;
  const nowMs = options.nowMs ?? Date.now();
  const counter: { count: number; budgetExhausted?: boolean } = { count: 0 };
  const kind = mediaType === 'series' ? 'tv' : 'movie';
  const raw = await fetchTmdbJson(
    `/${kind}/${tmdbId.trim()}`,
    {
      language: toTmdbBcp47Lang(lang),
      append_to_response: APPEND_DETAIL,
    },
    options.tmdbApiKey,
    fetchFn,
    MAX_DETAIL_BYTES,
    options.budget,
    counter,
  );
  const payload = raw
    ? mapTmdbDetailToRichPayload(raw, mediaType, lang, nowMs, fallbackImdbId)
    : null;
  return {
    payload,
    subrequestsUsed: counter.count,
    budgetExhausted: Boolean(counter.budgetExhausted),
  };
}

/** Resolves `imdbId` via `/3/find/{imdbId}` and fetches full localized TMDB title detail. */
export async function findAndFetchByImdbId(
  imdbId: string,
  lang: string,
  options: TmdbClientOptions,
): Promise<{
  readonly payload: ElvRichTitlePayload | null;
  readonly subrequestsUsed: number;
  readonly budgetExhausted: boolean;
}> {
  const valid = validateImdbId(imdbId);
  if (!valid.ok) return { payload: null, subrequestsUsed: 0, budgetExhausted: false };
  if (options.budget && options.budget.remaining() < 2) {
    return { payload: null, subrequestsUsed: 0, budgetExhausted: true };
  }
  const fetchFn = options.fetchFn ?? defaultTmdbFetchFn;
  const counter: { count: number; budgetExhausted?: boolean } = { count: 0 };
  const findRaw = asRecord(
    await fetchTmdbJson(
      `/find/${encodeURIComponent(valid.value)}`,
      { external_source: 'imdb_id', language: toTmdbBcp47Lang(lang) },
      options.tmdbApiKey,
      fetchFn,
      MAX_SEARCH_BYTES,
      options.budget,
      counter,
    ),
  );
  if (!findRaw) {
    return {
      payload: null,
      subrequestsUsed: counter.count,
      budgetExhausted: Boolean(counter.budgetExhausted),
    };
  }

  const movies = Array.isArray(findRaw.movie_results) ? findRaw.movie_results : [];
  const tv = Array.isArray(findRaw.tv_results) ? findRaw.tv_results : [];
  const firstMovie = asRecord(movies[0]);
  const firstTv = asRecord(tv[0]);
  const mediaType: ElvMediaType | null = firstMovie ? 'movie' : firstTv ? 'series' : null;
  const hit = firstMovie ?? firstTv;
  const tmdbId = typeof hit?.id === 'number' && hit.id > 0 ? String(hit.id) : null;
  if (!mediaType || !tmdbId) {
    return {
      payload: null,
      subrequestsUsed: counter.count,
      budgetExhausted: Boolean(counter.budgetExhausted),
    };
  }

  const detail = await fetchTmdbTitleDetail(tmdbId, mediaType, lang, options, valid.value);
  return {
    payload: detail.payload,
    subrequestsUsed: counter.count + detail.subrequestsUsed,
    budgetExhausted: Boolean(counter.budgetExhausted || detail.budgetExhausted),
  };
}

async function runSingleSearch(
  query: string,
  mediaType: ElvMediaType,
  year: number | null,
  bcp47Lang: string,
  options: TmdbClientOptions,
  counter: { count: number; budgetExhausted?: boolean },
): Promise<readonly TmdbSearchCandidateRaw[]> {
  const fetchFn = options.fetchFn ?? defaultTmdbFetchFn;
  const kind = mediaType === 'series' ? 'tv' : 'movie';
  const baseParams: Record<string, string> = {
    query: query.trim(),
    language: bcp47Lang,
    include_adult: 'false',
  };
  if (year !== null) {
    baseParams[mediaType === 'series' ? 'first_air_date_year' : 'year'] = String(year);
  }
  const firstRaw = asRecord(
    await fetchTmdbJson(
      `/search/${kind}`,
      baseParams,
      options.tmdbApiKey,
      fetchFn,
      MAX_SEARCH_BYTES,
      options.budget,
      counter,
    ),
  );
  const firstResults = parseTmdbSearchResults(firstRaw?.results, mediaType);
  if (firstResults.length > 0 || year === null || counter.budgetExhausted) return firstResults;
  if (options.budget && options.budget.remaining() < 2) {
    counter.budgetExhausted = true;
    return firstResults;
  }

  const retryRaw = asRecord(
    await fetchTmdbJson(
      `/search/${kind}`,
      { query: query.trim(), language: bcp47Lang, include_adult: 'false' },
      options.tmdbApiKey,
      fetchFn,
      MAX_SEARCH_BYTES,
      options.budget,
      counter,
    ),
  );
  return parseTmdbSearchResults(retryRaw?.results, mediaType);
}

/**
 * Searches TMDB v3 (`/search/movie` or `/search/tv`), retries without year on 0 results,
 * falls back to `"Left - Right"` / `"Left / Right"` segment splitting, and fetches full detail.
 */
export async function searchTmdbMatch(
  query: string,
  mediaType: ElvMediaType,
  year: number | null,
  lang: string,
  options: TmdbClientOptions,
): Promise<{
  readonly match: ElvRichSearchMatchPayload | null;
  readonly subrequestsUsed: number;
  readonly budgetExhausted: boolean;
}> {
  const trimmed = query.trim();
  if (!trimmed || !options.tmdbApiKey.trim()) {
    return { match: null, subrequestsUsed: 0, budgetExhausted: false };
  }
  if (options.budget && options.budget.remaining() < 2) {
    return { match: null, subrequestsUsed: 0, budgetExhausted: true };
  }
  const bcp47Lang = toTmdbBcp47Lang(lang);
  const counter: { count: number; budgetExhausted?: boolean } = { count: 0 };

  const primaryCandidates = await runSingleSearch(
    trimmed,
    mediaType,
    year,
    bcp47Lang,
    options,
    counter,
  );
  let selected = selectBestTmdbCandidate(trimmed, year, primaryCandidates);

  if (!selected && !counter.budgetExhausted) {
    for (const seg of splitDualTitleQuery(trimmed)) {
      if (options.budget && options.budget.remaining() < 2) {
        counter.budgetExhausted = true;
        break;
      }
      const segCandidates = await runSingleSearch(
        seg,
        mediaType,
        year,
        bcp47Lang,
        options,
        counter,
      );
      const segBest = selectBestTmdbCandidate(seg, year, segCandidates);
      if (segBest && (!selected || segBest.confidence > selected.confidence)) {
        selected = segBest;
        if (selected.confidence >= 0.95 && year !== null) break;
      }
      if (counter.budgetExhausted) break;
    }
  }

  if (!selected) {
    return {
      match: null,
      subrequestsUsed: counter.count,
      budgetExhausted: Boolean(counter.budgetExhausted),
    };
  }

  const detail = await fetchTmdbTitleDetail(selected.candidate.tmdbId, mediaType, lang, options);
  const totalUsed = counter.count + detail.subrequestsUsed;
  const exhausted = Boolean(counter.budgetExhausted || detail.budgetExhausted);
  if (!detail.payload) {
    return { match: null, subrequestsUsed: totalUsed, budgetExhausted: exhausted };
  }
  return {
    match: { ...detail.payload, confidence: selected.confidence },
    subrequestsUsed: totalUsed,
    budgetExhausted: exhausted,
  };
}
