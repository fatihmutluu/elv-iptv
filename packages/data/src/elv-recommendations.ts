import type { SqlDriver } from '@elv/domain';
import {
  hydrateBestPlayableMatches,
  loadActiveSourceIds,
  type RowLogoResolver,
  resolveItemsLogos,
} from './elv-discovery-helpers';
import type {
  ElvEnrichmentStore,
  ElvFeedRecord,
  ElvItemEnrichment,
  ElvMediaType,
  ElvTitleRecord,
} from './elv-enrichment-types';
import { uniqueNonEmpty } from './elv-enrichment-types';
import { foldText } from './fold';
import { loadActiveParentalFilter } from './parental-repo';
import { type ItemRow, resolveQueryProfileId } from './queries-shared';

/** Default recommendation page size returned by {@link computeElvRecommendations}. */
export const ELV_RECOMMENDATION_DEFAULT_LIMIT = 24;

/** Maximum recommendation page size accepted by {@link computeElvRecommendations}. */
export const ELV_RECOMMENDATION_MAX_LIMIT = 100;

/** Feed keys stored in `elv_feeds` and intersected into Pool C (`#512`). */
export const ELV_FEED_KEYS = ['top_picks', 'moviemeter', 'tvmeter', 'current_upcoming_tv'] as const;

/** Recommendation ranking profile (`'home'` favors feeds ~65/35; `'elv_picks'` favors taste ~70/30). */
export type ElvRecommendationProfile = 'home' | 'elv_picks';

/** Primary explainability badge for a recommended title (`#512`). */
export type ElvRecommendationReason =
  | 'more_like_this'
  | 'trending'
  | 'top_picks'
  | 'upcoming_tv'
  | 'genre_match'
  | 'cast_match';

/** Query options for {@link CatalogElvOpsMethods.getElvRecommendations} (`#512`). */
export interface ElvRecommendationsQuery {
  readonly profileId?: string;
  readonly profile: ElvRecommendationProfile;
  readonly kind?: ElvMediaType;
  readonly limit?: number;
  readonly excludedSourceIds?: readonly string[];
  readonly maxRatingAge?: number | null;
  readonly parentalUnlocked?: boolean;
}

/** Full dependency input for {@link computeElvRecommendations} (`#512`). */
export interface ComputeElvRecommendationsInput extends ElvRecommendationsQuery {
  readonly catalogDb: SqlDriver;
  readonly enrichmentStore: ElvEnrichmentStore;
  readonly now?: () => number;
  readonly resolveRowLogos?: RowLogoResolver;
}

/** One playable, deduplicated, enriched recommendation returned by {@link computeElvRecommendations}. */
export interface ElvRecommendedItem {
  readonly item: ItemRow;
  readonly enrichment: ElvItemEnrichment;
  readonly score: number;
  readonly reason: ElvRecommendationReason;
}

const BAYESIAN_PRIOR_VOTES = 1_000;
const BAYESIAN_PRIOR_MEAN = 6.8;
const MAX_SIGNAL_ROWS = 500;
const POOL_B_CANDIDATE_LIMIT = 150;
const MAX_SIGNAL_CAST_PER_TITLE = 6;

interface FeedSignal {
  score: number;
  reason: 'top_picks' | 'upcoming_tv' | 'trending';
  feedCount: number;
}

interface ScoredCandidate {
  readonly imdbId: string;
  readonly score: number;
  readonly bayesian: number;
  readonly reason: ElvRecommendationReason;
}

/**
 * Computes the Bayesian IMDb rating prior-weighted toward `6.8` with `m = 1000` votes:
 * `((v / (v + 1000)) * r + (1000 / (v + 1000)) * 6.8)` (`#512`).
 */
export function computeBayesianRating(
  rating: number | null | undefined,
  votes: number | null | undefined,
): number {
  if (typeof rating !== 'number' || !Number.isFinite(rating) || rating <= 0) {
    return BAYESIAN_PRIOR_MEAN;
  }
  const v =
    typeof votes === 'number' && Number.isFinite(votes) && votes > 0 ? Math.floor(votes) : 0;
  return (
    (v / (v + BAYESIAN_PRIOR_VOTES)) * rating +
    (BAYESIAN_PRIOR_VOTES / (v + BAYESIAN_PRIOR_VOTES)) * BAYESIAN_PRIOR_MEAN
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function personKeysForTitle(title: ElvTitleRecord): string[] {
  const keys = new Set<string>();
  if (title.director !== null && title.director.trim() !== '') {
    for (const part of title.director.split(/[,;&/]/g)) {
      const folded = foldText(part);
      if (folded !== '') keys.add(`name:${folded}`);
    }
  }
  const castSlice = title.cast.slice(0, MAX_SIGNAL_CAST_PER_TITLE);
  for (const member of castSlice) {
    if (typeof member.personId === 'string' && member.personId.trim() !== '') {
      keys.add(`id:${member.personId.trim().toLowerCase()}`);
    }
    const folded = foldText(member.name);
    if (folded !== '') keys.add(`name:${folded}`);
  }
  return [...keys];
}

function feedReasonForKey(feedKey: string): 'top_picks' | 'upcoming_tv' | 'trending' {
  if (feedKey === 'top_picks') return 'top_picks';
  if (feedKey === 'current_upcoming_tv') return 'upcoming_tv';
  return 'trending';
}

function feedPriorityBoost(feedKey: string): number {
  if (feedKey === 'top_picks') return 0.08;
  if (feedKey === 'current_upcoming_tv') return 0.05;
  return 0;
}

function buildFeedSignals(
  feeds: readonly ElvFeedRecord[],
  kind: ElvMediaType | undefined,
): Map<string, FeedSignal> {
  const out = new Map<string, FeedSignal>();
  for (const feed of feeds) {
    const reason = feedReasonForKey(feed.feedKey);
    const boost = feedPriorityBoost(feed.feedKey);
    for (let idx = 0; idx < feed.items.length; idx += 1) {
      const entry = feed.items[idx];
      if (entry === undefined) continue;
      if (kind !== undefined && entry.mediaType !== kind) continue;
      const rank =
        typeof entry.rank === 'number' && Number.isFinite(entry.rank) && entry.rank > 0
          ? entry.rank
          : idx + 1;
      const baseScore = clamp(1 - (rank - 1) / 60 + boost, 0.25, 1);
      const existing = out.get(entry.imdbId);
      if (existing === undefined) {
        out.set(entry.imdbId, { score: baseScore, reason, feedCount: 1 });
      } else {
        const nextCount = existing.feedCount + 1;
        const multiBonus = Math.min(0.12, (nextCount - 1) * 0.06);
        const betterScore = Math.min(1, Math.max(existing.score, baseScore) + multiBonus);
        const betterReason = baseScore > existing.score ? reason : existing.reason;
        out.set(entry.imdbId, {
          score: betterScore,
          reason: betterReason,
          feedCount: nextCount,
        });
      }
    }
  }
  return out;
}

/**
 * 3-Pool On-Device ELV Recommendation Engine (`< 10 ms`, `#512`):
 * - Pool A: IMDb `More Like This` graph (`like +6`, `favorite +4`, `watched +2`, `dislike -6`).
 * - Pool B: Top ~150 enriched matched library titles scored by genre affinity, cast/director
 *   affinity, and Bayesian IMDb rating.
 * - Pool C: IMDb daily feeds (`top_picks`, `moviemeter`, `tvmeter`, `current_upcoming_tv`)
 *   intersected with playable IPTV items (cold-start safe).
 * - Deduplicates by `imdbId` selecting the healthiest playable variant via `elv_quality_memory`.
 */
export async function computeElvRecommendations(
  input: ComputeElvRecommendationsInput,
): Promise<readonly ElvRecommendedItem[]> {
  const { catalogDb, enrichmentStore, profile, kind } = input;
  if (input.limit !== undefined && (!Number.isFinite(input.limit) || input.limit <= 0)) {
    return [];
  }
  const limit = Math.max(
    1,
    Math.min(
      ELV_RECOMMENDATION_MAX_LIMIT,
      Math.floor(input.limit ?? ELV_RECOMMENDATION_DEFAULT_LIMIT),
    ),
  );
  const profileId = resolveQueryProfileId(input.profileId);

  const [
    activeSourceIds,
    parentalFilter,
    ratingRows,
    favoriteRows,
    watchedRows,
    episodeWatchedSeriesRows,
    feeds,
  ] = await Promise.all([
    loadActiveSourceIds(catalogDb, input.excludedSourceIds),
    loadActiveParentalFilter(catalogDb, profileId, input.parentalUnlocked),
    catalogDb.all<{ item_key: string; value: string }>(
      `SELECT item_key, value FROM ratings
        WHERE profile_id = ?
        ORDER BY updated_at DESC, item_key ASC
        LIMIT ?`,
      [profileId, MAX_SIGNAL_ROWS],
    ),
    catalogDb.all<{ item_key: string }>(
      `SELECT item_key FROM favorites
        WHERE profile_id = ? AND kind IN ('movie', 'series')
        ORDER BY sort_order ASC, added_at DESC
        LIMIT ?`,
      [profileId, MAX_SIGNAL_ROWS],
    ),
    catalogDb.all<{ item_key: string }>(
      `SELECT item_key FROM watch_progress
        WHERE profile_id = ? AND watched = 1 AND kind IN ('movie', 'series')
        ORDER BY updated_at DESC, item_key ASC
        LIMIT ?`,
      [profileId, MAX_SIGNAL_ROWS],
    ),
    catalogDb.all<{ series_key: string }>(
      `SELECT series_key FROM watch_progress
        WHERE profile_id = ? AND watched = 1 AND kind = 'episode'
          AND series_key IS NOT NULL AND series_key != ''
        GROUP BY series_key
        ORDER BY MAX(updated_at) DESC, series_key ASC
        LIMIT ?`,
      [profileId, MAX_SIGNAL_ROWS],
    ),
    enrichmentStore.listFeeds(ELV_FEED_KEYS),
  ]);

  if (activeSourceIds.length === 0) return [];

  const effectiveMaxRatingAge =
    input.maxRatingAge !== undefined && input.maxRatingAge !== null
      ? parentalFilter?.maxRatingAge !== null && parentalFilter?.maxRatingAge !== undefined
        ? Math.min(input.maxRatingAge, parentalFilter.maxRatingAge)
        : input.maxRatingAge
      : (parentalFilter?.maxRatingAge ?? null);

  const likedKeys = new Set<string>();
  const dislikedKeys = new Set<string>();
  for (const row of ratingRows) {
    if (row.value === 'like') likedKeys.add(row.item_key);
    else if (row.value === 'dislike') dislikedKeys.add(row.item_key);
  }
  const favoriteKeys = new Set<string>(favoriteRows.map((r) => r.item_key));
  const watchedKeys = new Set<string>(watchedRows.map((r) => r.item_key));
  const episodeWatchedSeriesKeys = new Set<string>(
    episodeWatchedSeriesRows.map((r) => r.series_key),
  );

  const excludedItemKeys = new Set<string>([
    ...likedKeys,
    ...dislikedKeys,
    ...favoriteKeys,
    ...watchedKeys,
  ]);
  const allSignalKeys = [...new Set<string>([...excludedItemKeys, ...episodeWatchedSeriesKeys])];

  const [signalEnrich, poolBTitles] = await Promise.all([
    allSignalKeys.length > 0
      ? enrichmentStore.getEnrichmentForKeys(allSignalKeys)
      : Promise.resolve(new Map<string, ElvItemEnrichment>()),
    enrichmentStore.listTopRatedMatchedTitles({
      ...(kind !== undefined ? { mediaType: kind } : {}),
      limit: POOL_B_CANDIDATE_LIMIT,
      allowedSourceIds: activeSourceIds,
    }),
  ]);

  const excludedImdbIds = new Set<string>();
  const mltScores = new Map<string, number>();
  const genreAffinity = new Map<string, number>();
  const positivePersons = new Set<string>();
  const dislikedPersons = new Set<string>();

  interface SignalFlags {
    liked: boolean;
    favorite: boolean;
    watched: boolean;
    disliked: boolean;
    title: ElvTitleRecord | null;
  }
  const signalsByImdb = new Map<string, SignalFlags>();

  const registerSignal = (
    key: string,
    field: 'liked' | 'favorite' | 'watched' | 'disliked',
    excludeFromCandidates: boolean,
  ) => {
    const enrich = signalEnrich.get(key);
    if (enrich === undefined) return;
    if (excludeFromCandidates) excludedImdbIds.add(enrich.imdbId);
    const existing = signalsByImdb.get(enrich.imdbId) ?? {
      liked: false,
      favorite: false,
      watched: false,
      disliked: false,
      title: enrich.title,
    };
    existing[field] = true;
    if (existing.title === null && enrich.title !== null) existing.title = enrich.title;
    signalsByImdb.set(enrich.imdbId, existing);
  };

  for (const k of likedKeys) registerSignal(k, 'liked', true);
  for (const k of favoriteKeys) registerSignal(k, 'favorite', true);
  for (const k of watchedKeys) registerSignal(k, 'watched', true);
  for (const k of episodeWatchedSeriesKeys) registerSignal(k, 'watched', false);
  for (const k of dislikedKeys) registerSignal(k, 'disliked', true);

  let hasPositiveSignals = false;
  for (const sig of signalsByImdb.values()) {
    const title = sig.title;
    if (title === null) continue;
    const mltDelta =
      (sig.liked ? 6 : 0) +
      (sig.favorite ? 4 : 0) +
      (sig.watched ? 2 : 0) +
      (sig.disliked ? -6 : 0);
    const genreDelta =
      (sig.liked ? 3 : 0) +
      (sig.favorite ? 2 : 0) +
      (sig.watched ? 1.5 : 0) +
      (sig.disliked ? -4 : 0);

    if (sig.liked || sig.favorite || sig.watched) hasPositiveSignals = true;

    if (mltDelta !== 0) {
      for (const neighborId of title.mltImdbIds) {
        mltScores.set(neighborId, (mltScores.get(neighborId) ?? 0) + mltDelta);
      }
    }
    if (genreDelta !== 0) {
      for (const genre of title.genres) {
        const gKey = genre.trim().toLowerCase();
        if (gKey !== '') genreAffinity.set(gKey, (genreAffinity.get(gKey) ?? 0) + genreDelta);
      }
    }
    if (sig.liked || sig.favorite || sig.watched) {
      for (const pKey of personKeysForTitle(title)) positivePersons.add(pKey);
    } else if (sig.disliked) {
      for (const pKey of personKeysForTitle(title)) dislikedPersons.add(pKey);
    }
  }

  const feedSignals = buildFeedSignals(feeds, kind);
  const titleByImdb = new Map<string, ElvTitleRecord>();
  const candidateImdbSet = new Set<string>();

  for (const title of poolBTitles) {
    if (excludedImdbIds.has(title.imdbId)) continue;
    titleByImdb.set(title.imdbId, title);
    candidateImdbSet.add(title.imdbId);
  }
  for (const [imdbId, mltScore] of mltScores) {
    if (mltScore > 0 && !excludedImdbIds.has(imdbId)) candidateImdbSet.add(imdbId);
  }
  for (const imdbId of feedSignals.keys()) {
    if (!excludedImdbIds.has(imdbId)) candidateImdbSet.add(imdbId);
  }

  if (candidateImdbSet.size === 0) return [];

  const matchesByImdb = await enrichmentStore.listMatchedMatchesForImdbIds(
    [...candidateImdbSet],
    kind,
    { allowedSourceIds: activeSourceIds },
  );
  if (matchesByImdb.size === 0) return [];

  const missingTitleIds: string[] = [];
  for (const imdbId of matchesByImdb.keys()) {
    if (!titleByImdb.has(imdbId)) missingTitleIds.push(imdbId);
  }
  if (missingTitleIds.length > 0) {
    const fetchedTitles = await enrichmentStore.getTitlesByImdbIds(missingTitleIds);
    for (const [id, t] of fetchedTitles) titleByImdb.set(id, t);
  }

  const feedWeight = profile === 'home' ? 0.65 : 0.3;
  const personalWeight = profile === 'home' ? 0.35 : 0.7;

  const scored: ScoredCandidate[] = [];
  for (const imdbId of matchesByImdb.keys()) {
    const title = titleByImdb.get(imdbId);
    if (title === undefined) continue;
    if (kind !== undefined && title.mediaType !== kind) continue;

    const mltRaw = mltScores.get(imdbId) ?? 0;
    const poolANorm = mltRaw > 0 ? 1 - Math.exp(-mltRaw / 6) : 0;

    let genreRaw = 0;
    if (title.genres.length > 0) {
      let sum = 0;
      for (const g of title.genres) {
        sum += genreAffinity.get(g.trim().toLowerCase()) ?? 0;
      }
      genreRaw = sum / Math.sqrt(title.genres.length);
    }

    let personRaw = 0;
    const matchedPositive = new Set<string>();
    for (const pKey of personKeysForTitle(title)) {
      if (positivePersons.has(pKey) && !matchedPositive.has(pKey)) {
        matchedPositive.add(pKey);
        personRaw += 2;
      } else if (dislikedPersons.has(pKey) && !positivePersons.has(pKey)) {
        personRaw -= 1;
      }
    }
    const cappedPersonRaw = clamp(personRaw, -4, 8);

    const bayesian = computeBayesianRating(title.rating, title.votes);
    const bayesianNorm = clamp((bayesian - 5.0) / 4.2, 0, 1);

    let poolBNorm: number;
    if (hasPositiveSignals) {
      const genreNorm = clamp(genreRaw / 8, -0.5, 1);
      const castNorm = clamp(cappedPersonRaw / 4, 0, 1);
      const personalAffinity = Math.max(0, genreNorm * 0.6 + castNorm * 0.4);
      poolBNorm =
        personalAffinity > 0
          ? clamp(personalAffinity * 0.75 + bayesianNorm * 0.25, 0, 1)
          : bayesianNorm * 0.12;
    } else {
      poolBNorm = bayesianNorm * 0.55;
    }

    const dislikePenalty =
      (mltRaw < 0 ? Math.min(0.45, Math.abs(mltRaw) / 12) : 0) +
      (genreRaw < 0 ? Math.min(0.35, Math.abs(genreRaw) / 10) : 0);

    const personalScore = clamp(
      Math.max(poolANorm, poolBNorm * 0.9) + 0.3 * Math.min(poolANorm, poolBNorm) - dislikePenalty,
      0,
      1,
    );

    const feedSig = feedSignals.get(imdbId);
    const poolCNorm = feedSig?.score ?? 0;
    const combined = feedWeight * poolCNorm + personalWeight * personalScore;
    if (combined <= 0 && !hasPositiveSignals && poolCNorm === 0 && bayesianNorm === 0) continue;

    let reason: ElvRecommendationReason;
    if (profile === 'home') {
      if (feedSig !== undefined && feedWeight * poolCNorm >= personalWeight * personalScore) {
        reason = feedSig.reason;
      } else if (poolANorm > 0) {
        reason = 'more_like_this';
      } else if (cappedPersonRaw > 0 && cappedPersonRaw >= genreRaw) {
        reason = 'cast_match';
      } else if (feedSig !== undefined && genreRaw <= 0) {
        reason = feedSig.reason;
      } else {
        reason = 'genre_match';
      }
    } else {
      if (poolANorm > 0 && personalWeight * poolANorm >= feedWeight * poolCNorm) {
        reason = 'more_like_this';
      } else if (
        cappedPersonRaw > 0 &&
        cappedPersonRaw >= genreRaw &&
        personalWeight * poolBNorm >= feedWeight * poolCNorm
      ) {
        reason = 'cast_match';
      } else if (genreRaw > 0 && personalWeight * poolBNorm >= feedWeight * poolCNorm) {
        reason = 'genre_match';
      } else if (feedSig !== undefined) {
        reason = feedSig.reason;
      } else if (poolANorm > 0) {
        reason = 'more_like_this';
      } else if (cappedPersonRaw > 0) {
        reason = 'cast_match';
      } else {
        reason = 'genre_match';
      }
    }

    scored.push({
      imdbId,
      score: Math.round(combined * 10_000) / 10_000,
      bayesian,
      reason,
    });
  }

  if (scored.length === 0) return [];

  scored.sort(
    (a, b) => b.score - a.score || b.bayesian - a.bayesian || a.imdbId.localeCompare(b.imdbId),
  );

  const hydrateWindow = scored.slice(0, Math.max(limit * 3, 60));
  const excludedSourceSet = new Set(uniqueNonEmpty(input.excludedSourceIds ?? []));
  const hydratedByImdb = await hydrateBestPlayableMatches({
    catalogDb,
    enrichmentStore,
    orderedImdbIds: hydrateWindow.map((c) => c.imdbId),
    matchesByImdb,
    titleByImdb,
    kind,
    excludedItemKeys,
    excludedSourceIds: excludedSourceSet,
    parentalFilter,
    maxRatingAge: effectiveMaxRatingAge,
  });

  const selected: {
    item: ItemRow;
    enrichment: ElvItemEnrichment;
    score: number;
    reason: ElvRecommendationReason;
  }[] = [];
  for (const candidate of hydrateWindow) {
    const match = hydratedByImdb.get(candidate.imdbId);
    if (match === undefined) continue;
    selected.push({
      item: match.item,
      enrichment: match.enrichment,
      score: candidate.score,
      reason: candidate.reason,
    });
    if (selected.length >= limit) break;
  }

  if (selected.length === 0) return [];
  const resolvedItems = await resolveItemsLogos(
    selected.map((s) => s.item),
    input.resolveRowLogos,
  );
  return selected.map((entry, idx) => ({
    item: resolvedItems[idx] ?? entry.item,
    enrichment: entry.enrichment,
    score: entry.score,
    reason: entry.reason,
  }));
}
