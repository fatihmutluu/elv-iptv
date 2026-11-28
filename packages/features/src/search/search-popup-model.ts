import { foldText, type ItemRow, type SearchResults } from '@elv/data';
import { sanitizeSearchQuery } from './search-model';

/** Maximum number of live query suggestions shown in {@link SearchPopupOverlay}. */
export const SEARCH_POPUP_SUGGESTION_LIMIT = 3;

/** Maximum number of cards rendered per horizontal rail inside {@link SearchPopupOverlay}. */
export const SEARCH_POPUP_RAIL_LIMIT = 12;

/** Live suggestion derived from matching catalog results in {@link SearchPopupOverlay}. */
export interface SearchPopupSuggestion {
  readonly title: string;
  readonly kind: 'movie' | 'series' | 'live';
  readonly itemKey: string;
}

/** Focusable rows inside {@link SearchPopupOverlay} for 10-ft TV D-pad navigation. */
export type SearchPopupNavRowId =
  | 'input'
  | 'suggestions'
  | 'movies'
  | 'series'
  | 'live'
  | 'viewAll';

/** Descriptor of one horizontally navigable row inside {@link SearchPopupOverlay}. */
export interface SearchPopupNavRowDescriptor {
  readonly id: SearchPopupNavRowId;
  readonly count: number;
}

/** Active 2D TV focus coordinate inside {@link SearchPopupOverlay}. */
export interface SearchPopupFocusPosition {
  readonly rowId: SearchPopupNavRowId;
  readonly col: number;
}

/** Directional D-pad movement supported by {@link stepSearchPopupFocus}. */
export type SearchPopupNavDirection = 'up' | 'down' | 'left' | 'right';

/** Outcome of one {@link stepSearchPopupFocus} navigation step. */
export interface SearchPopupFocusStepResult {
  readonly position: SearchPopupFocusPosition | null;
  readonly edgeTop: boolean;
}

interface RankedSuggestionCandidate {
  readonly suggestion: SearchPopupSuggestion;
  readonly tier: number;
  readonly order: number;
}

/**
 * Extracts up to `limit` (default `3`) deduplicated, prefix-prioritized title suggestions from
 * active catalog search matches (`movies -> series -> live`), normalizing Turkish dotted/dotless I.
 */
export function buildSearchPopupSuggestions(
  results: SearchResults,
  query: string,
  limit = SEARCH_POPUP_SUGGESTION_LIMIT,
): readonly SearchPopupSuggestion[] {
  const sanitized = sanitizeSearchQuery(query);
  if (sanitized.length === 0 || limit <= 0) return [];
  const foldedQuery = foldText(sanitized);
  if (foldedQuery.length === 0) return [];

  const buckets: readonly {
    readonly kind: SearchPopupSuggestion['kind'];
    readonly rows: readonly ItemRow[];
  }[] = [
    { kind: 'movie', rows: results.movies },
    { kind: 'series', rows: results.series },
    { kind: 'live', rows: results.live },
  ];

  const seenFolded = new Set<string>();
  const ranked: RankedSuggestionCandidate[] = [];
  let order = 0;

  for (const bucket of buckets) {
    for (const row of bucket.rows) {
      const title = row.name.trim();
      if (title.length === 0) continue;
      const foldedTitle = foldText(title);
      if (foldedTitle.length === 0 || seenFolded.has(foldedTitle)) continue;
      seenFolded.add(foldedTitle);

      const tier = foldedTitle.startsWith(foldedQuery)
        ? 0
        : foldedTitle.includes(foldedQuery)
          ? 1
          : 2;

      ranked.push({
        suggestion: { title, kind: bucket.kind, itemKey: row.key },
        tier,
        order,
      });
      order += 1;
    }
  }

  ranked.sort((a, b) => a.tier - b.tier || a.order - b.order);
  return ranked.slice(0, limit).map((entry) => entry.suggestion);
}

/** Builds the ordered visible TV navigation rows for {@link SearchPopupOverlay}. */
export function buildSearchPopupNavRows(input: {
  readonly hasClear: boolean;
  readonly suggestionCount: number;
  readonly movieCount: number;
  readonly seriesCount: number;
  readonly liveCount: number;
  readonly hasViewAll: boolean;
}): readonly SearchPopupNavRowDescriptor[] {
  const rows: SearchPopupNavRowDescriptor[] = [{ id: 'input', count: input.hasClear ? 2 : 1 }];
  if (input.suggestionCount > 0) rows.push({ id: 'suggestions', count: input.suggestionCount });
  if (input.movieCount > 0) rows.push({ id: 'movies', count: input.movieCount });
  if (input.seriesCount > 0) rows.push({ id: 'series', count: input.seriesCount });
  if (input.liveCount > 0) rows.push({ id: 'live', count: input.liveCount });
  if (input.hasViewAll) rows.push({ id: 'viewAll', count: 1 });
  return rows;
}

/** Advances 2D D-pad focus across {@link SearchPopupOverlay} rows and columns. */
export function stepSearchPopupFocus(
  rows: readonly SearchPopupNavRowDescriptor[],
  current: SearchPopupFocusPosition,
  direction: SearchPopupNavDirection,
): SearchPopupFocusStepResult {
  if (rows.length === 0) return { position: null, edgeTop: false };
  const rowIndex = Math.max(
    0,
    rows.findIndex((r) => r.id === current.rowId),
  );
  const row = rows[rowIndex];
  if (!row) return { position: null, edgeTop: false };
  const col = Math.min(Math.max(0, current.col), Math.max(0, row.count - 1));

  if (direction === 'left') {
    return {
      position: { rowId: row.id, col: Math.max(0, col - 1) },
      edgeTop: false,
    };
  }
  if (direction === 'right') {
    return {
      position: { rowId: row.id, col: Math.min(row.count - 1, col + 1) },
      edgeTop: false,
    };
  }
  if (direction === 'up') {
    if (rowIndex === 0) {
      return { position: null, edgeTop: true };
    }
    const prev = rows[rowIndex - 1];
    if (!prev) return { position: null, edgeTop: true };
    return {
      position: { rowId: prev.id, col: Math.min(col, Math.max(0, prev.count - 1)) },
      edgeTop: false,
    };
  }
  const next = rows[rowIndex + 1];
  if (!next) {
    return { position: { rowId: row.id, col }, edgeTop: false };
  }
  return {
    position: { rowId: next.id, col: Math.min(col, Math.max(0, next.count - 1)) },
    edgeTop: false,
  };
}
