import type { SqlDriver, SqlValue } from '@elv/domain';
import { hasActiveCustomChannelNames } from './channel-overrides-repo';
import { foldText } from './fold';
import { isAdultKeywordMatch } from './parental-policy';
import {
  type ActiveParentalFilter,
  buildSqlAdultKeywordExclusionClause,
  buildSqlItemRestrictionClause,
} from './parental-repo';
import type { ItemRow } from './queries-shared';

/** Hard upper bound on per-kind search results returned by one query. */
export const MAX_SEARCH_LIMIT = 60;

/** Field that matched a movie or series search hit (`#397`). */
export type SearchMatchedBy = 'title' | 'cast' | 'director';

/** A live channel, movie, or series search hit with optional match attribution (`#397`). */
export interface SearchItemHit extends ItemRow {
  readonly matchedBy?: SearchMatchedBy;
}

/** Escapes SQLite `LIKE` wildcards (`%`, `_`, `\`) using `\` as the `ESCAPE` character. */
export function escapeLikePattern(token: string): string {
  return token.replace(/[\\%_]/g, '\\$&');
}

interface RawCustomNameHitRow {
  id: number;
  key: string;
  source_id: string;
  provider_id: string | null;
  custom_name: string;
  raw_name: string;
  name_fold: string;
  co_sort_order: number | null;
  logo: string | null;
  num: number | null;
  catchup_days: number | null;
}

/**
 * @internal Finds visible live channels whose per-profile `channel_overrides.custom_name`
 * matches all Turkish-folded query tokens while honoring `co.is_hidden = 0` and parental controls (`#60`, `#31`).
 */
export async function searchLiveCustomNames(
  db: SqlDriver,
  tokens: readonly string[],
  foldedQuery: string,
  limit: number,
  sourceId: string | undefined,
  profileId: string,
  filter: ActiveParentalFilter | null,
): Promise<SearchItemHit[]> {
  if (tokens.length === 0 || limit <= 0 || !hasActiveCustomChannelNames(db)) return [];
  const sourceClause = sourceId === undefined ? '' : ' AND co.source_id = ?';
  const restrict =
    filter === null
      ? { clause: '', params: [] as readonly SqlValue[] }
      : buildSqlItemRestrictionClause(filter, 'live', 't.source_id', 't.key', sourceId);
  const adultExcl = buildSqlAdultKeywordExclusionClause(filter, 't.name', 't.name_fold');

  const rows = await db.all<RawCustomNameHitRow>(
    `SELECT t.id, t.key, t.source_id, t.provider_id,
            co.custom_name, t.name AS raw_name, t.name_fold, co.sort_order AS co_sort_order,
            t.logo, t.num, t.catchup_days
       FROM channel_overrides co
       JOIN live t ON t.source_id = co.source_id AND t.key = co.item_key
       JOIN sources s ON s.id = t.source_id AND s.deleting = 0
      WHERE co.profile_id = ?
        AND co.custom_name IS NOT NULL AND co.custom_name != ''
        AND co.is_hidden = 0
        AND t.is_hidden = 0${sourceClause}${restrict.clause}${adultExcl}`,
    [profileId, ...(sourceId === undefined ? [] : [sourceId]), ...restrict.params],
  );

  const scored: Array<{ rank: number; name: string; hit: SearchItemHit }> = [];
  for (const r of rows) {
    if (
      filter?.blockAdultKeywords === true &&
      (isAdultKeywordMatch(r.raw_name) ||
        isAdultKeywordMatch(r.name_fold) ||
        isAdultKeywordMatch(r.custom_name))
    ) {
      continue;
    }
    const foldedCustom = foldText(r.custom_name);
    if (foldedCustom === '') continue;
    if (!tokens.every((tok) => foldedCustom.includes(tok))) continue;
    const rank = foldedCustom === foldedQuery ? 0 : foldedCustom.startsWith(foldedQuery) ? 1 : 2;
    scored.push({
      rank,
      name: r.custom_name,
      hit: {
        id: r.id,
        key: r.key,
        kind: 'live',
        sourceId: r.source_id,
        providerId: r.provider_id,
        name: r.custom_name,
        originalName: r.raw_name,
        ...(typeof r.co_sort_order === 'number' ? { customSortOrder: r.co_sort_order } : {}),
        logo: r.logo,
        rating: null,
        year: null,
        num: r.num,
        ...(typeof r.catchup_days === 'number' &&
        Number.isFinite(r.catchup_days) &&
        r.catchup_days > 0
          ? { catchupDays: r.catchup_days }
          : {}),
      },
    });
  }

  scored.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name) || a.hit.id - b.hit.id);
  return scored.slice(0, limit).map((s) => s.hit);
}

/** @internal Merges custom-name live search hits with catalog FTS/LIKE hits without duplicates. */
export function mergeLiveSearchHits(
  customHits: readonly SearchItemHit[],
  catalogHits: readonly SearchItemHit[],
  limit: number,
): SearchItemHit[] {
  if (customHits.length === 0) return catalogHits.slice(0, limit);
  const out: SearchItemHit[] = [];
  const seen = new Set<string>();
  for (const hit of customHits) {
    if (seen.has(hit.key)) continue;
    seen.add(hit.key);
    out.push(hit);
    if (out.length >= limit) return out;
  }
  for (const hit of catalogHits) {
    if (seen.has(hit.key)) continue;
    seen.add(hit.key);
    out.push(hit);
    if (out.length >= limit) return out;
  }
  return out;
}
