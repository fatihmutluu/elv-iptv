import {
  type AlphabetBucket,
  type FavoriteRow,
  type ItemRow,
  type ItemSortOrder,
  MIN_RESUME_POSITION_MS,
  type WatchProgressRow,
} from '@elv/data';
import type { DetailTarget, PagedListSource } from '../shared';

/** Number of category rails loaded initially in Movies & Series Discovery Mode. */
export const INITIAL_VISIBLE_CATEGORIES = 8;

/** Additional category rails loaded per progressive batch when clicking `Load more categories`. */
export const CATEGORY_LOAD_BATCH = 8;

/** Maximum preview posters loaded per category rail in Discovery Mode. */
export const RAIL_ITEM_LIMIT = 18;

/** Maximum concurrent category preview queries fired in Discovery Mode. */
export const MAX_CONCURRENT_RAIL_QUERIES = 4;

/** SQLite page size used by the O(1)-memory row-virtualized Category Grid. */
export const GRID_PAGE_SIZE = 180;

/** Maximum LRU pages retained in JS memory for a single Category Grid. */
export const GRID_MAX_PAGES = 8;

/** Maximum Continue Watching cards loaded at the top of Movies & Series Discovery. */
export const CATALOG_CONTINUE_LIMIT = 20;

/** Minimum item count required before rendering the A–Z `AlphabetJumpRail` (`#407`). */
export const ALPHABET_RAIL_MIN_ITEMS = 40;

/** Quick filter view shown alongside provider categories on Movies & Series screens (`#508`). */
export type CatalogQuickFilter = 'all' | 'mylist' | 'elvPicks';

/** Preserved tab navigation state for a Movies or Series tab across tab switches. */
export interface CatalogTabMemory {
  readonly selectedCategoryId: string | null;
  readonly visibleCategoryCount: number;
  readonly quickFilter?: CatalogQuickFilter;
  readonly gridScrollRow?: number;
  readonly sortBy?: ItemSortOrder;
}

/** Default clean {@link CatalogTabMemory} snapshot for initial tab entry. */
export const EMPTY_CATALOG_MEMORY: CatalogTabMemory = {
  selectedCategoryId: null,
  visibleCategoryCount: INITIAL_VISIBLE_CATEGORIES,
};

/** Navigable vertical row identifier inside {@link CatalogDiscoveryScreen} for 10-ft TV D-pad focus. */
export type CatalogNavRowId =
  | 'empty'
  | 'catChips'
  | 'continue'
  | 'loadMore'
  | 'gridBack'
  | `rail-${number}`;

/** Descriptor of one currently visible focusable horizontal row inside Catalog Discovery or Grid header. */
export interface CatalogNavRowDescriptor {
  readonly id: CatalogNavRowId;
  readonly count: number;
}

/** Focusable rail descriptor passed into {@link buildCatalogNavRows}. */
export interface CatalogRailNavEntry {
  readonly catIndex: number;
  readonly count: number;
}

/** Input parameters for {@link buildCatalogNavRows}. */
export interface BuildCatalogNavRowsInput {
  readonly isLoading: boolean;
  readonly hasSources: boolean;
  readonly hasCategories: boolean;
  readonly categoryChipCount: number;
  readonly continueCount?: number;
  readonly railEntries?: readonly CatalogRailNavEntry[];
  readonly hasLoadMore?: boolean;
  readonly isGridMode?: boolean;
  readonly gridHeaderCount?: number;
}

/** 2D `(row, col)` coordinate clamped inside a virtualized category grid. */
export interface GridFocusPosition {
  readonly row: number;
  readonly col: number;
}

/** Computes total virtualized row count for `itemCount` posters arranged in `columns` columns. */
export function computeRowCount(itemCount: number, columns: number): number {
  if (!Number.isFinite(itemCount) || !Number.isFinite(columns)) return 0;
  const safeItems = Math.floor(itemCount);
  const safeCols = Math.floor(columns);
  if (safeItems <= 0 || safeCols <= 0) return 0;
  return Math.ceil(safeItems / safeCols);
}

/**
 * Extracts the exact items (or `undefined` unloaded placeholders) belonging to `rowIndex` in a
 * `columns`-wide virtualized grid backed by either a `PagedListSource` or a plain item array.
 */
export function chunkRowItems<T>(
  source: Pick<PagedListSource<T>, 'count' | 'get'> | readonly T[],
  rowIndex: number,
  columns: number,
): (T | undefined)[] {
  if (!Number.isFinite(rowIndex) || !Number.isFinite(columns)) return [];
  const safeRow = Math.floor(rowIndex);
  const safeCols = Math.floor(columns);
  if (safeRow < 0 || safeCols <= 0) return [];

  const isArray = Array.isArray(source);
  const total = isArray
    ? source.length
    : (source as Pick<PagedListSource<T>, 'count' | 'get'>).count();
  const start = safeRow * safeCols;
  if (start >= total) return [];

  const end = Math.min(total, start + safeCols);
  const out: (T | undefined)[] = [];
  for (let i = start; i < end; i++) {
    out.push(isArray ? source[i] : (source as Pick<PagedListSource<T>, 'count' | 'get'>).get(i));
  }
  return out;
}

/** Filters active Continue Watching progress rows for either the Movies or Series discovery tab. */
export function filterContinueWatchingForCatalog(
  rows: readonly WatchProgressRow[],
  kind: 'movie' | 'series',
): WatchProgressRow[] {
  return rows.filter((row) => {
    if (row.watched) return false;
    const isNextUpEpisode = row.kind === 'episode' && row.positionMs === 0;
    if (!isNextUpEpisode && row.positionMs < MIN_RESUME_POSITION_MS) return false;
    return kind === 'movie'
      ? row.kind === 'movie'
      : row.kind === 'series' || row.kind === 'episode';
  });
}

/** Builds a {@link DetailTarget} from a Continue Watching {@link WatchProgressRow}. */
export function detailTargetFromProgress(
  row: WatchProgressRow,
  tabKind: 'movie' | 'series',
): DetailTarget {
  return {
    itemKey: tabKind === 'series' ? (row.seriesKey ?? row.itemKey) : row.itemKey,
    sourceId: row.sourceId,
    kind: tabKind,
    title: row.title,
    posterUri: row.logo,
    backdropUri: (row as { backdrop?: string | null }).backdrop ?? null,
    year: null,
    rating: null,
  };
}

/** Filters {@link FavoriteRow} entries to those matching the Movies or Series catalog tab. */
export function filterFavoritesForCatalog(
  rows: readonly FavoriteRow[],
  kind: 'movie' | 'series',
): FavoriteRow[] {
  return rows.filter((row) => row.kind === kind);
}

/** Converts a Movie or Series {@link FavoriteRow} into a renderable {@link ItemRow} card model. */
export function itemRowFromFavorite(row: FavoriteRow, kind: 'movie' | 'series'): ItemRow {
  return {
    id: 0,
    key: row.itemKey,
    sourceId: row.sourceId,
    providerId: null,
    kind,
    name: row.title,
    logo: row.logo,
    num: null,
    year: row.year,
    rating: row.rating,
  };
}

/** Builds a {@link DetailTarget} from a Movie or Series {@link FavoriteRow}. */
export function detailTargetFromFavorite(row: FavoriteRow, kind: 'movie' | 'series'): DetailTarget {
  return {
    itemKey: row.itemKey,
    sourceId: row.sourceId,
    kind,
    title: row.title,
    posterUri: row.logo,
    backdropUri: (row as { backdrop?: string | null }).backdrop ?? null,
    year: row.year,
    rating: row.rating,
  };
}

/** Returns a `[0, 1]` watch-progress bar ratio for unwatched in-progress items, or `undefined`. */
export function computeProgressRatio(progress: WatchProgressRow | undefined): number | undefined {
  if (progress === undefined || progress.watched) return undefined;
  if (
    !Number.isFinite(progress.positionMs) ||
    !Number.isFinite(progress.durationMs) ||
    progress.positionMs <= 0 ||
    progress.durationMs <= 0
  ) {
    return undefined;
  }
  return Math.min(1, Math.max(0, progress.positionMs / progress.durationMs));
}

/** Computes remaining whole minutes (`>= 1`) for an in-progress item, or `null` when duration is invalid. */
export function formatCatalogRemainingMinutes(
  positionMs: number,
  durationMs: number,
): number | null {
  if (!Number.isFinite(positionMs) || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  const remainingMs = Math.max(0, durationMs - Math.max(0, positionMs));
  return Math.max(1, Math.ceil(remainingMs / 60_000));
}

const CATALOG_EPISODE_CODE_PREFIX_RE = /^(?:S\d+(?:\s*[·•\-:]?\s*E\d+)?|E\d+)(?:\s|$|[·•—\-:])/i;

/**
 * Formats an episode subtitle as `S# · E# — Title` when season/episode metadata is present,
 * avoiding double-prefixing if `rawSubtitle` already starts with an `S#`/`E#` code.
 */
export function formatCatalogEpisodeSubtitle(
  season: number | null | undefined,
  episode: number | null | undefined,
  rawSubtitle: string | null,
): string | null {
  const trimmed = rawSubtitle?.trim() ?? '';
  if (trimmed !== '' && CATALOG_EPISODE_CODE_PREFIX_RE.test(trimmed)) return trimmed;
  const hasSeason = typeof season === 'number' && Number.isFinite(season);
  const hasEpisode = typeof episode === 'number' && Number.isFinite(episode);
  const code =
    hasSeason && hasEpisode
      ? `S${season} · E${episode}`
      : hasEpisode
        ? `E${episode}`
        : hasSeason
          ? `S${season}`
          : '';
  if (code !== '' && trimmed !== '') return `${code} — ${trimmed}`;
  if (code !== '') return code;
  return trimmed !== '' ? trimmed : null;
}

/** Clamps a 2D TV grid focus coordinate `(row, col)` to a valid item slot, including partial last rows. */
export function clampGridFocus(
  row: number,
  col: number,
  itemCount: number,
  columns: number,
): GridFocusPosition {
  const safeItems = Number.isFinite(itemCount) ? Math.floor(itemCount) : 0;
  const safeCols = Number.isFinite(columns) ? Math.floor(columns) : 0;
  if (safeItems <= 0 || safeCols <= 0) return { row: 0, col: 0 };

  const maxRow = Math.max(0, Math.ceil(safeItems / safeCols) - 1);
  const clampedRow = Math.min(maxRow, Math.max(0, Math.floor(row)));
  const rowItems = Math.min(safeCols, safeItems - clampedRow * safeCols);
  const maxCol = Math.max(0, rowItems - 1);
  const clampedCol = Math.min(maxCol, Math.max(0, Math.floor(col)));
  return { row: clampedRow, col: clampedCol };
}

/**
 * Resolves the active `#` or `A..Z` bucket letter owning `currentOffset` (`#407`).
 * Returns `null` when no non-empty buckets exist.
 */
export function resolveActiveAlphabetLetter(
  buckets: readonly AlphabetBucket[],
  currentOffset: number,
): string | null {
  const available = buckets.filter((b) => b.count > 0);
  if (available.length === 0) return null;
  const safeOffset = Number.isFinite(currentOffset) ? Math.max(0, Math.floor(currentOffset)) : 0;
  let active = available[0]?.letter ?? null;
  for (const bucket of available) {
    if (bucket.offset <= safeOffset) {
      active = bucket.letter;
    } else {
      break;
    }
  }
  return active;
}

function isRailLetter(letter: string): boolean {
  const normalized = letter.trim().toUpperCase();
  return normalized === '#' || (normalized.length === 1 && normalized >= 'A' && normalized <= 'Z');
}

/**
 * Steps TV focus `up` or `down` across available (`count > 0`) rail alphabet buckets (`#`, `A..Z`, `#407`).
 */
export function stepAlphabetRailLetter(
  buckets: readonly AlphabetBucket[],
  currentLetter: string | null,
  direction: 'up' | 'down',
): string | null {
  const available = buckets.filter((b) => b.count > 0 && isRailLetter(b.letter));
  if (available.length === 0) return null;
  const normalized = currentLetter?.trim().toUpperCase() ?? null;
  const currentIdx =
    normalized !== null
      ? available.findIndex((b) => b.letter.trim().toUpperCase() === normalized)
      : -1;
  if (currentIdx === -1) {
    return available[0]?.letter ?? null;
  }
  const nextIdx =
    direction === 'up'
      ? Math.max(0, currentIdx - 1)
      : Math.min(available.length - 1, currentIdx + 1);
  return available[nextIdx]?.letter ?? null;
}

/** Builds the ordered list of focusable horizontal rows for 10-ft TV D-pad navigation. */
export function buildCatalogNavRows(input: BuildCatalogNavRowsInput): CatalogNavRowDescriptor[] {
  if (input.isLoading) return [];
  if (!input.hasSources) return [{ id: 'empty', count: 1 }];
  if (!input.hasCategories) return [];

  const rows: CatalogNavRowDescriptor[] = [];
  if (input.categoryChipCount > 0) {
    rows.push({ id: 'catChips', count: input.categoryChipCount });
  }

  if (input.isGridMode) {
    const headerCount = input.gridHeaderCount ?? 1;
    if (headerCount > 0) {
      rows.push({ id: 'gridBack', count: headerCount });
    }
    return rows;
  }

  if ((input.continueCount ?? 0) > 0) {
    rows.push({ id: 'continue', count: input.continueCount ?? 0 });
  }

  if (input.railEntries !== undefined) {
    for (const entry of input.railEntries) {
      if (entry.count > 0) {
        rows.push({ id: `rail-${entry.catIndex}`, count: entry.count });
      }
    }
  }

  if (input.hasLoadMore) {
    rows.push({ id: 'loadMore', count: 1 });
  }
  return rows;
}
