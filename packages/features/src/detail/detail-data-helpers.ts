import {
  type CatalogService,
  type CategoryRow,
  DEFAULT_PROFILE_ID,
  type EpisodeRow,
  type ItemDetailRow,
  type ItemRow,
  type SeasonRow,
  type WatchProgressRow,
} from '@elv/data';
import type { ElvError } from '@elv/domain';
import { batchLoadProgressByKeys, type DetailTarget } from '../shared';

const RELATED_LIMIT = 12;

/** Loading / error / ready state for a series's season list. */
export type DetailSeasonsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly error: ElvError }
  | { readonly kind: 'ready'; readonly seasons: readonly SeasonRow[] };

/** Atomic hydrated state snapshot held inside `useDetailData`. */
export interface DetailSnapshot {
  readonly detailRow: ItemDetailRow | null;
  readonly inMyList: boolean;
  readonly movieProgress: WatchProgressRow | null;
  readonly seasonsState: DetailSeasonsState;
  readonly selectedSeason: number | null;
  readonly episodes: readonly EpisodeRow[];
  readonly episodesLoading: boolean;
  readonly episodeProgressByKey: ReadonlyMap<string, WatchProgressRow>;
  readonly related: readonly ItemRow[];
  readonly relatedCategoryId: string | undefined;
  readonly relatedProgressByKey: ReadonlyMap<string, WatchProgressRow>;
}

/** Creates an empty {@link DetailSnapshot} for a newly opened movie or series target. */
export function emptyDetailSnapshot(kind: 'movie' | 'series', categoryId?: string): DetailSnapshot {
  return {
    detailRow: null,
    inMyList: false,
    movieProgress: null,
    seasonsState: kind === 'series' ? { kind: 'loading' } : { kind: 'ready', seasons: [] },
    selectedSeason: null,
    episodes: [],
    episodesLoading: kind === 'series',
    episodeProgressByKey: new Map(),
    related: [],
    relatedCategoryId: categoryId,
    relatedProgressByKey: new Map(),
  };
}

/** Fetches up to 12 bounded *More Like This* items excluding the active title plus their progress. */
export async function fetchRelatedDetailItems(catalog: CatalogService, target: DetailTarget) {
  let categoryId = target.categoryId;
  if (categoryId === undefined) {
    const cats = await catalog
      .categories(target.sourceId, target.kind)
      .catch(() => [] as CategoryRow[]);
    categoryId = (cats.find((c) => c.itemCount > 0) ?? cats[0])?.id;
  }
  if (categoryId === undefined) {
    return {
      categoryId: undefined,
      items: [] as ItemRow[],
      progress: new Map<string, WatchProgressRow>(),
    };
  }
  const raw = await catalog.items(categoryId, 0, RELATED_LIMIT + 1).catch(() => [] as ItemRow[]);
  const items = raw.filter((item) => item.key !== target.itemKey).slice(0, RELATED_LIMIT);
  const progress = await batchLoadProgressByKeys(
    catalog,
    items.map((item) => item.key),
  ).catch(() => new Map<string, WatchProgressRow>());
  return { categoryId, items, progress };
}

/** Builds an optimistic movie {@link WatchProgressRow} for `toggleWatched`. */
export function buildOptimisticWatchedRow(
  prevRow: WatchProgressRow | null,
  nextWatched: boolean,
  meta: { sourceId: string; itemKey: string; title: string; logo: string | null },
): WatchProgressRow {
  if (prevRow) {
    return {
      ...prevRow,
      watched: nextWatched,
      positionMs: nextWatched ? prevRow.positionMs : 0,
      updatedAt: Date.now(),
    };
  }
  return {
    profileId: DEFAULT_PROFILE_ID,
    sourceId: meta.sourceId,
    itemKey: meta.itemKey,
    kind: 'movie',
    title: meta.title,
    subtitle: null,
    logo: meta.logo,
    seriesKey: null,
    season: null,
    episode: null,
    positionMs: 0,
    durationMs: 0,
    watched: nextWatched,
    updatedAt: Date.now(),
  };
}
