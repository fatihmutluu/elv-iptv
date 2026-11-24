import type { ContentKind, SqlDriver, SqlValue } from '@elv/domain';
import {
  buildSqlAdultKeywordExclusionClause,
  buildSqlItemRestrictionClause,
  isCategoryRestricted,
  loadActiveParentalFilter,
} from './parental-repo';
import { ITEM_TABLE, parseCategoryId, watchedFilterClause } from './queries-shared';

/** Input parameters for {@link queryAlphabetIndex} and `CatalogService.alphabetIndex` (`#407`, `#31`). */
export interface AlphabetIndexInput {
  readonly sourceId?: string;
  readonly kind: ContentKind;
  readonly categoryId?: string;
  readonly collapseVariants?: boolean;
  readonly groupVersions?: boolean;
  readonly excludeWatched?: boolean;
  readonly profileId?: string;
  readonly parentalUnlocked?: boolean;
}

/** One non-empty `#` (`< 'a'`), `A..Z`, or trailing non-Latin (`…`, `> 'z'`) prefix bucket with its exact 0-based offset in `'alpha'` sort order (`#407`). */
export interface AlphabetBucket {
  readonly letter: string;
  readonly offset: number;
  readonly count: number;
}

const BUCKET_ORDER = [
  '#',
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'I',
  'J',
  'K',
  'L',
  'M',
  'N',
  'O',
  'P',
  'Q',
  'R',
  'S',
  'T',
  'U',
  'V',
  'W',
  'X',
  'Y',
  'Z',
  '…',
] as const;

const LETTER_CASE_EXPR = (col: string) =>
  `CASE WHEN substr(COALESCE(${col}, ''), 1, 1) < 'a' THEN '#' WHEN substr(COALESCE(${col}, ''), 1, 1) <= 'z' THEN upper(substr(COALESCE(${col}, ''), 1, 1)) ELSE '…' END`;

function categoryDedupSpec(
  kind: ContentKind,
  input: AlphabetIndexInput,
): { readonly groupExpr: string; readonly rankOrder: string } | undefined {
  if (kind === 'live' && input.collapseVariants === true) {
    return {
      groupExpr: "COALESCE(NULLIF(t.variant_base_fold, ''), t.key)",
      rankOrder: 't.quality_rank DESC, p.position ASC, t.key ASC',
    };
  }
  if (kind === 'movie' && input.groupVersions === true) {
    return {
      groupExpr: "COALESCE(NULLIF(t.version_group_key, ''), t.key)",
      rankOrder: 'p.position ASC, t.key ASC',
    };
  }
  return undefined;
}

function tableDedupSpec(
  kind: ContentKind,
  input: AlphabetIndexInput,
): { readonly groupExpr: string; readonly rankOrder: string } | undefined {
  if (kind === 'live' && input.collapseVariants === true) {
    return {
      groupExpr: "t.source_id, COALESCE(NULLIF(t.variant_base_fold, ''), t.key)",
      rankOrder: 't.quality_rank DESC, t.id ASC, t.key ASC',
    };
  }
  if (kind === 'movie' && input.groupVersions === true) {
    return {
      groupExpr: "t.source_id, COALESCE(NULLIF(t.version_group_key, ''), t.key)",
      rankOrder: 't.id ASC, t.key ASC',
    };
  }
  return undefined;
}

function toSortedBuckets(rows: readonly { letter: string; count: number }[]): AlphabetBucket[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.count > 0) {
      counts.set(row.letter, (counts.get(row.letter) ?? 0) + row.count);
    }
  }
  const out: AlphabetBucket[] = [];
  let offset = 0;
  for (const letter of BUCKET_ORDER) {
    const count = counts.get(letter) ?? 0;
    if (count <= 0) continue;
    out.push({ letter, offset, count });
    offset += count;
  }
  return out;
}

/**
 * Computes the non-empty `#`, `A..Z` prefix buckets and cumulative 0-based row offsets for
 * alphabetical (`sortBy: 'alpha'`) catalog browsing in a single SQL `GROUP BY` query (`#407`).
 * Applies the exact same `is_hidden = 0`, category `placements`, `excludeWatched`,
 * parental controls (`#31`), `collapseVariants`, and `groupVersions` predicates as `items()` and `allSourcesItems()`.
 */
export async function queryAlphabetIndex(
  db: SqlDriver,
  input: AlphabetIndexInput,
): Promise<readonly AlphabetBucket[]> {
  const { kind } = input;
  if (kind !== 'live' && kind !== 'movie' && kind !== 'series') return [];

  let resolvedSourceId = input.sourceId?.trim() || undefined;
  let providerCategoryId: string | undefined;

  if (input.categoryId !== undefined && input.categoryId.trim() !== '') {
    const rawCat = input.categoryId.trim();
    const parsed = parseCategoryId(rawCat);
    if (parsed !== undefined) {
      if (parsed.kind !== kind) return [];
      if (resolvedSourceId !== undefined && resolvedSourceId !== parsed.sourceId) return [];
      resolvedSourceId = parsed.sourceId;
      providerCategoryId = parsed.providerId;
    } else if (resolvedSourceId !== undefined) {
      providerCategoryId = rawCat;
    } else {
      return [];
    }
  }

  const filter = await loadActiveParentalFilter(db, input.profileId, input.parentalUnlocked);
  if (
    filter !== null &&
    providerCategoryId !== undefined &&
    resolvedSourceId !== undefined &&
    isCategoryRestricted(filter, resolvedSourceId, kind, providerCategoryId)
  ) {
    return [];
  }

  const table = ITEM_TABLE[kind];
  const watched = watchedFilterClause('t.key', input);
  const restrict =
    filter === null
      ? { clause: '', params: [] as readonly SqlValue[] }
      : buildSqlItemRestrictionClause(filter, kind, 't.source_id', 't.key', resolvedSourceId);
  const adultExcl = buildSqlAdultKeywordExclusionClause(filter, 't.name', 't.name_fold');

  if (providerCategoryId !== undefined && resolvedSourceId !== undefined) {
    const dedup = categoryDedupSpec(kind, input);
    const params: SqlValue[] = [
      resolvedSourceId,
      kind,
      providerCategoryId,
      ...watched.params,
      ...restrict.params,
    ];
    if (dedup !== undefined) {
      const rows = await db.all<{ letter: string; count: number }>(
        `WITH ranked AS (
           SELECT t.sort_title,
                  ROW_NUMBER() OVER (PARTITION BY ${dedup.groupExpr} ORDER BY ${dedup.rankOrder}) AS rn
             FROM placements p
             JOIN ${table} t ON t.source_id = p.source_id AND t.key = p.item_key
            WHERE p.source_id = ? AND p.kind = ? AND p.category_id = ? AND p.is_hidden = 0 AND t.is_hidden = 0
              AND EXISTS (SELECT 1 FROM sources s WHERE s.id = p.source_id AND s.deleting = 0)${watched.clause}${restrict.clause}${adultExcl}
         )
         SELECT ${LETTER_CASE_EXPR('sort_title')} AS letter, COUNT(*) AS count
           FROM ranked
          WHERE rn = 1
          GROUP BY letter`,
        params,
      );
      return toSortedBuckets(rows);
    }

    const rows = await db.all<{ letter: string; count: number }>(
      `SELECT ${LETTER_CASE_EXPR('t.sort_title')} AS letter, COUNT(*) AS count
         FROM placements p
         JOIN ${table} t ON t.source_id = p.source_id AND t.key = p.item_key
        WHERE p.source_id = ? AND p.kind = ? AND p.category_id = ? AND p.is_hidden = 0 AND t.is_hidden = 0
          AND EXISTS (SELECT 1 FROM sources s WHERE s.id = p.source_id AND s.deleting = 0)${watched.clause}${restrict.clause}${adultExcl}
        GROUP BY letter`,
      params,
    );
    return toSortedBuckets(rows);
  }

  const sourceClause = resolvedSourceId === undefined ? '' : 't.source_id = ? AND ';
  const params: SqlValue[] = [
    ...(resolvedSourceId === undefined ? [] : [resolvedSourceId]),
    ...watched.params,
    ...restrict.params,
  ];
  const dedup = tableDedupSpec(kind, input);
  if (dedup !== undefined) {
    const rows = await db.all<{ letter: string; count: number }>(
      `WITH ranked AS (
         SELECT t.sort_title,
                ROW_NUMBER() OVER (PARTITION BY ${dedup.groupExpr} ORDER BY ${dedup.rankOrder}) AS rn
           FROM ${table} t
           JOIN sources s ON s.id = t.source_id AND s.deleting = 0
          WHERE ${sourceClause}t.is_hidden = 0${watched.clause}${restrict.clause}${adultExcl}
       )
       SELECT ${LETTER_CASE_EXPR('sort_title')} AS letter, COUNT(*) AS count
         FROM ranked
        WHERE rn = 1
        GROUP BY letter`,
      params,
    );
    return toSortedBuckets(rows);
  }

  const rows = await db.all<{ letter: string; count: number }>(
    `SELECT ${LETTER_CASE_EXPR('t.sort_title')} AS letter, COUNT(*) AS count
       FROM ${table} t
       JOIN sources s ON s.id = t.source_id AND s.deleting = 0
      WHERE ${sourceClause}t.is_hidden = 0${watched.clause}${restrict.clause}${adultExcl}
      GROUP BY letter`,
    params,
  );
  return toSortedBuckets(rows);
}
