import type { ItemRow } from '@elv/data';

/** Optional cast entry structured for future metadata enrichment (`#215`). */
export interface DetailCastMember {
  readonly name: string;
  readonly role?: string | null;
  readonly avatarUri?: string | null;
}

/**
 * Navigation target opening `DetailScreen` for a movie or series from Home, Catalog rails,
 * Category grids, or *More Like This*. Carries optional metadata fields so future enrichment
 * (`#215`) plugs in without screen rewrites.
 */
export interface DetailTarget {
  readonly itemKey: string;
  readonly sourceId: string;
  readonly kind: 'movie' | 'series';
  readonly title: string;
  readonly posterUri: string | null;
  readonly backdropUri: string | null;
  readonly year: number | null;
  readonly rating: number | null;
  /** SQLite row id when already known; otherwise resolved on demand via `catalog.itemDetail`. */
  readonly catalogId?: number;
  /** Category id from which the title was opened (powers fast *More Like This* queries). */
  readonly categoryId?: string;
  readonly overview?: string | null;
  readonly genres?: readonly string[];
  readonly cast?: readonly DetailCastMember[];
}

/** Converts a movie or series {@link ItemRow} into a {@link DetailTarget}. */
export function detailTargetFromItem(item: ItemRow, categoryId?: string): DetailTarget | undefined {
  if (item.kind !== 'movie' && item.kind !== 'series') return undefined;
  return {
    itemKey: item.key,
    sourceId: item.sourceId,
    kind: item.kind,
    title: item.name,
    posterUri: item.logo,
    backdropUri: item.logo,
    year: item.year,
    rating: item.rating,
    catalogId: item.id,
    ...(categoryId !== undefined ? { categoryId } : {}),
  };
}
