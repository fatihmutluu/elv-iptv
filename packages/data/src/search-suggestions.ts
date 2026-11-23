import type { ContentKind, SqlDriver } from '@elv/domain';
import { foldText } from './fold';

/** Default idle search suggestion count (`#397`). */
export const DEFAULT_SEARCH_SUGGESTIONS_LIMIT = 8;

/** Maximum idle search suggestion count (`#397`). */
export const MAX_SEARCH_SUGGESTIONS_LIMIT = 16;

/** Category of an on-device idle search suggestion (`#397`). */
export type SearchSuggestionKind = 'favorite' | 'recent' | 'category';

/** An on-device idle search suggestion derived from favorites, recent playback, or top categories (`#397`). */
export interface SearchSuggestion {
  readonly kind: SearchSuggestionKind;
  readonly label: string;
  readonly query: string;
  readonly itemKind?: ContentKind;
  readonly sourceId?: string;
  readonly itemKey?: string;
  readonly categoryId?: string;
}

/** Options for {@link querySearchSuggestions} and `CatalogService.searchSuggestions` (`#397`). */
export interface SearchSuggestionsOptions {
  readonly limit?: number;
  readonly sourceId?: string;
  readonly profileId?: string;
}

function clampSuggestionsLimit(limit: number | undefined): number {
  const n =
    limit === undefined || !Number.isFinite(limit)
      ? DEFAULT_SEARCH_SUGGESTIONS_LIMIT
      : Math.floor(limit);
  return Math.min(MAX_SEARCH_SUGGESTIONS_LIMIT, Math.max(0, n));
}

/**
 * Queries up to `limit` (default `8`, max `16`) deduplicated on-device idle search suggestions from
 * favorites, continue-watching / recent live channels, and top popular non-hidden categories (`#397`).
 */
export async function querySearchSuggestions(
  db: SqlDriver,
  options?: SearchSuggestionsOptions,
): Promise<readonly SearchSuggestion[]> {
  const limit = clampSuggestionsLimit(options?.limit);
  if (limit === 0) return [];
  const profileId = options?.profileId?.trim() || 'default';
  const sourceId = options?.sourceId?.trim() || undefined;
  const srcFilter = sourceId === undefined ? '' : ' AND f.source_id = ?';
  const wpSrcFilter = sourceId === undefined ? '' : ' AND wp.source_id = ?';
  const rcSrcFilter = sourceId === undefined ? '' : ' AND rc.source_id = ?';
  const catSrcFilter = sourceId === undefined ? '' : ' AND c.source_id = ?';

  const [favRows, wpRows, rcRows, catRows] = await Promise.all([
    db.all<{
      source_id: string;
      item_key: string;
      kind: ContentKind;
      title: string;
    }>(
      `SELECT f.source_id, f.item_key, f.kind, f.title
         FROM favorites f
         JOIN sources s ON s.id = f.source_id AND s.deleting = 0
        WHERE f.profile_id = ?${srcFilter}
          AND NOT EXISTS (SELECT 1 FROM live l WHERE l.source_id = f.source_id AND l.key = f.item_key AND l.is_hidden = 1)
          AND NOT EXISTS (SELECT 1 FROM movies m WHERE m.source_id = f.source_id AND m.key = f.item_key AND m.is_hidden = 1)
          AND NOT EXISTS (SELECT 1 FROM series ser WHERE ser.source_id = f.source_id AND ser.key = f.item_key AND ser.is_hidden = 1)
        ORDER BY f.added_at DESC
        LIMIT ?`,
      [profileId, ...(sourceId === undefined ? [] : [sourceId]), limit],
    ),
    db.all<{
      source_id: string;
      item_key: string;
      series_key: string | null;
      kind: string;
      title: string;
      updated_at: number;
    }>(
      `SELECT wp.source_id, wp.item_key, wp.series_key, wp.kind, wp.title, wp.updated_at
         FROM watch_progress wp
         JOIN sources s ON s.id = wp.source_id AND s.deleting = 0
        WHERE wp.profile_id = ?${wpSrcFilter}
          AND NOT EXISTS (SELECT 1 FROM live l WHERE l.source_id = wp.source_id AND l.key = wp.item_key AND l.is_hidden = 1)
          AND NOT EXISTS (SELECT 1 FROM movies m WHERE m.source_id = wp.source_id AND m.key = wp.item_key AND m.is_hidden = 1)
          AND NOT EXISTS (SELECT 1 FROM series ser WHERE ser.source_id = wp.source_id AND ser.key = COALESCE(NULLIF(wp.series_key, ''), wp.item_key) AND ser.is_hidden = 1)
        ORDER BY wp.updated_at DESC
        LIMIT ?`,
      [profileId, ...(sourceId === undefined ? [] : [sourceId]), limit],
    ),
    db.all<{
      source_id: string;
      item_key: string;
      name: string;
      watched_at: number;
    }>(
      `SELECT rc.source_id, rc.item_key, l.name, rc.watched_at
         FROM recent_channels rc
         JOIN sources s ON s.id = rc.source_id AND s.deleting = 0
         JOIN live l ON l.source_id = rc.source_id AND l.key = rc.item_key AND l.is_hidden = 0
        WHERE rc.profile_id = ?${rcSrcFilter}
        ORDER BY rc.watched_at DESC
        LIMIT ?`,
      [profileId, ...(sourceId === undefined ? [] : [sourceId]), limit],
    ),
    db.all<{
      source_id: string;
      kind: ContentKind;
      provider_id: string;
      name: string;
      item_count: number;
    }>(
      `SELECT c.source_id, c.kind, c.provider_id, c.name, COUNT(*) AS item_count
         FROM categories c
         JOIN sources s ON s.id = c.source_id AND s.deleting = 0
         JOIN placements pl
           ON pl.source_id = c.source_id
          AND pl.kind = c.kind
          AND pl.category_id = c.provider_id
          AND pl.is_hidden = 0
        WHERE c.is_hidden = 0${catSrcFilter}
        GROUP BY c.source_id, c.kind, c.provider_id
        ORDER BY item_count DESC, c.position ASC, c.provider_id ASC
        LIMIT ?`,
      [...(sourceId === undefined ? [] : [sourceId]), limit],
    ),
  ]);

  const out: SearchSuggestion[] = [];
  const seenFolds = new Set<string>();
  const seenKeys = new Set<string>();

  const pushUnique = (suggestion: SearchSuggestion): void => {
    if (out.length >= limit) return;
    const label = suggestion.label.trim();
    if (label === '') return;
    const folded = foldText(label);
    if (folded === '' || seenFolds.has(folded)) return;
    if (suggestion.itemKey !== undefined && seenKeys.has(suggestion.itemKey)) return;
    seenFolds.add(folded);
    if (suggestion.itemKey !== undefined) seenKeys.add(suggestion.itemKey);
    out.push({ ...suggestion, label, query: suggestion.query.trim() || label });
  };

  for (const fav of favRows) {
    pushUnique({
      kind: 'favorite',
      label: fav.title,
      query: fav.title,
      itemKind: fav.kind,
      sourceId: fav.source_id,
      itemKey: fav.item_key,
    });
  }

  const recentCandidates: Array<{ ts: number; suggestion: SearchSuggestion }> = [];
  for (const wp of wpRows) {
    const itemKind: ContentKind =
      wp.kind === 'live' ? 'live' : wp.kind === 'movie' ? 'movie' : 'series';
    const itemKey = wp.kind === 'episode' && wp.series_key ? wp.series_key : wp.item_key;
    recentCandidates.push({
      ts: wp.updated_at,
      suggestion: {
        kind: 'recent',
        label: wp.title,
        query: wp.title,
        itemKind,
        sourceId: wp.source_id,
        itemKey,
      },
    });
  }
  for (const rc of rcRows) {
    recentCandidates.push({
      ts: rc.watched_at,
      suggestion: {
        kind: 'recent',
        label: rc.name,
        query: rc.name,
        itemKind: 'live',
        sourceId: rc.source_id,
        itemKey: rc.item_key,
      },
    });
  }
  recentCandidates.sort((a, b) => b.ts - a.ts);
  for (const entry of recentCandidates) {
    pushUnique(entry.suggestion);
  }

  for (const cat of catRows) {
    pushUnique({
      kind: 'category',
      label: cat.name,
      query: cat.name,
      itemKind: cat.kind,
      sourceId: cat.source_id,
      categoryId: `${cat.source_id}|${cat.kind}|${cat.provider_id}`,
    });
  }

  return out;
}
