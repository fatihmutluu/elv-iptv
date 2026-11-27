import {
  ELV_IMDB_GENRE_ID_PREFIX,
  type ElvGenreBucket,
  type ElvRecommendationReason,
} from '@elv/data';
import type { AppI18n, MessageId } from '@elv/i18n';
import type { DisplayCategory } from '../shared';

const CANONICAL_IMDB_GENRE_KEYS: Readonly<Record<string, MessageId>> = {
  action: 'elv.genre.Action',
  adventure: 'elv.genre.Adventure',
  animation: 'elv.genre.Animation',
  biography: 'elv.genre.Biography',
  comedy: 'elv.genre.Comedy',
  crime: 'elv.genre.Crime',
  documentary: 'elv.genre.Documentary',
  drama: 'elv.genre.Drama',
  family: 'elv.genre.Family',
  fantasy: 'elv.genre.Fantasy',
  history: 'elv.genre.History',
  horror: 'elv.genre.Horror',
  music: 'elv.genre.Music',
  mystery: 'elv.genre.Mystery',
  romance: 'elv.genre.Romance',
  'sci-fi': 'elv.genre.SciFi',
  scifi: 'elv.genre.SciFi',
  sport: 'elv.genre.Sport',
  thriller: 'elv.genre.Thriller',
  war: 'elv.genre.War',
  western: 'elv.genre.Western',
};

const RECOMMENDATION_REASON_KEYS: Readonly<Record<ElvRecommendationReason, MessageId>> = {
  more_like_this: 'elv.reason.moreLikeThis',
  trending: 'elv.reason.trending',
  top_picks: 'elv.reason.topPicks',
  upcoming_tv: 'elv.reason.upcomingTv',
  genre_match: 'elv.reason.genreMatch',
  cast_match: 'elv.reason.castMatch',
};

/** Returns `true` when `categoryId` is a synthetic ELV Mode IMDb genre bucket ID (`imdb-genre:*`). */
export function isElvImdbGenreCategoryId(categoryId: string): boolean {
  return categoryId.startsWith(ELV_IMDB_GENRE_ID_PREFIX);
}

/** Resolves the `@elv/i18n` {@link MessageId} for a canonical IMDb genre name, or `null` if unmapped. */
export function resolveElvGenreMessageId(genreName: string): MessageId | null {
  const normalized = genreName.trim().toLowerCase();
  if (normalized === '') return null;
  return CANONICAL_IMDB_GENRE_KEYS[normalized] ?? null;
}

/** Formats a canonical IMDb genre name into the active UI locale, falling back to the raw genre name. */
export function formatElvGenreLabel(genreName: string, t: AppI18n['t']): string {
  const key = resolveElvGenreMessageId(genreName);
  if (key !== null) return t(key);
  const trimmed = genreName.trim();
  return trimmed !== '' ? trimmed : genreName;
}

/** Maps a Wave E2 {@link ElvRecommendationReason} to its `@elv/i18n` {@link MessageId}. */
export function resolveElvRecommendationReasonMessageId(
  reason: ElvRecommendationReason,
): MessageId {
  return RECOMMENDATION_REASON_KEYS[reason];
}

/** Formats a Wave E2 recommendation explainability reason badge in the active UI locale. */
export function formatElvRecommendationReason(
  reason: ElvRecommendationReason,
  t: AppI18n['t'],
): string {
  return t(RECOMMENDATION_REASON_KEYS[reason]);
}

/** Converts IMDb genre buckets from `listElvImdbGenres` into localized {@link DisplayCategory} entries. */
export function buildImdbGenreDisplayCategories(
  buckets: readonly ElvGenreBucket[],
  kind: 'movie' | 'series',
  t: AppI18n['t'],
): DisplayCategory[] {
  return buckets.map((bucket, index) => ({
    row: {
      id: bucket.id,
      sourceId: 'elv-imdb',
      kind,
      name: bucket.name,
      position: index,
      itemCount: bucket.count,
    },
    label: formatElvGenreLabel(bucket.name, t),
  }));
}
