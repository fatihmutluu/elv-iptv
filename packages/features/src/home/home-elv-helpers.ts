import type {
  ElvRecommendationReason,
  ElvRecommendedItem,
  RatingValue,
  WatchProgressRow,
} from '@elv/data';
import type { ElvModePreferences } from '@elv/domain';
import type { AppI18n, MessageId } from '@elv/i18n';
import { applyElvCardPresentation } from '../shared';
import type { HomeRailEntry } from './home-model';

const HOME_ELV_REASON_KEYS: Readonly<Record<ElvRecommendationReason, MessageId>> = {
  more_like_this: 'elv.reason.moreLikeThis',
  trending: 'elv.reason.trending',
  top_picks: 'elv.reason.topPicks',
  upcoming_tv: 'elv.reason.upcomingTv',
  genre_match: 'elv.reason.genreMatch',
  cast_match: 'elv.reason.castMatch',
};

/** Maps a Wave E2 {@link ElvRecommendationReason} into localized Cinema Quietude badge copy. */
export function formatHomeElvReason(reason: ElvRecommendationReason, t: AppI18n['t']): string {
  return t(HOME_ELV_REASON_KEYS[reason]);
}

/** Excludes items the active profile has rated as `'dislike'` (`👎`) from Home discovery rails. */
export function filterOutDislikedItems<T extends { readonly key: string }>(
  items: readonly T[],
  ratingByKey: ReadonlyMap<string, RatingValue>,
): readonly T[] {
  if (items.length === 0 || ratingByKey.size === 0) return items;
  let hasDisliked = false;
  for (const item of items) {
    if (ratingByKey.get(item.key) === 'dislike') {
      hasDisliked = true;
      break;
    }
  }
  if (!hasDisliked) return items;
  return items.filter((item) => ratingByKey.get(item.key) !== 'dislike');
}

/** Options for {@link buildElvShowcaseEntries}. */
export interface BuildElvShowcaseEntriesOptions {
  readonly elvPrefs: ElvModePreferences;
  readonly locale: string;
  readonly t: AppI18n['t'];
  readonly progressByKey: ReadonlyMap<string, WatchProgressRow>;
  readonly ratingByKey: ReadonlyMap<string, RatingValue>;
}

/**
 * Maps mixed Movies + Series Wave E2 recommendations into Cinema Quietude {@link HomeRailEntry}
 * poster cards with ELV titles/posters/ratings, localized reason badges, and instant dislike filtering.
 */
export function buildElvShowcaseEntries(
  recommendations: readonly ElvRecommendedItem[],
  opts: BuildElvShowcaseEntriesOptions,
): HomeRailEntry[] {
  if (recommendations.length === 0) return [];
  const entries: HomeRailEntry[] = [];
  for (const rec of recommendations) {
    if (rec.item.kind !== 'movie' && rec.item.kind !== 'series') continue;
    if (opts.ratingByKey.get(rec.item.key) === 'dislike') continue;
    const presented = applyElvCardPresentation(
      rec.item,
      rec.enrichment,
      opts.elvPrefs,
      opts.locale,
    );
    const prog = opts.progressByKey.get(presented.key);
    entries.push({
      itemKey: presented.key,
      sourceId: presented.sourceId,
      kind: presented.kind,
      title: presented.name,
      subtitle: prog?.subtitle ?? null,
      backdropUri:
        rec.enrichment.title?.backdropUrl ??
        (presented as { backdrop?: string | null }).backdrop ??
        null,
      posterUri: presented.logo,
      year: presented.year,
      rating: presented.rating,
      durationMs: prog?.durationMs ?? 0,
      positionMs: prog?.positionMs ?? 0,
      watched: prog?.watched ?? false,
      badgeLabel: formatHomeElvReason(rec.reason, opts.t),
      catalogItem: presented,
    });
  }
  return entries;
}
