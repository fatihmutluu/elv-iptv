import type { SqlDriver, SqlValue } from '@elv/domain';
import {
  ADULT_KEYWORD_TOKENS,
  isAdultKeywordMatch,
  type ParentalLockRecord,
} from './parental-policy';
import {
  type BrowseKind,
  categoryId,
  ITEM_TABLE,
  parseCategoryId,
  sourceOfKey,
} from './queries-shared';

/** Pre-resolved parental filter active for one query invocation (`null` when unlocked or inactive). */
export interface ActiveParentalFilter {
  readonly profileId: string;
  readonly enabled: boolean;
  readonly blockAdultKeywords: boolean;
  readonly maxRatingAge: number | null;
  /** Composite `${sourceId}|${itemKind}|${providerId}` keys for explicitly locked categories. */
  readonly lockedCategories: ReadonlySet<string>;
  /** Composite `${sourceId}|${itemKind}|${providerId}` keys for all restricted categories (locked + adult-keyword). */
  readonly restrictedCategories: ReadonlySet<string>;
  /** Composite `${sourceId}|${itemKind}|${itemKey}` keys for explicitly locked items. */
  readonly lockedItems: ReadonlySet<string>;
  /** Raw locked item keys for O(1) lookup across mixed-kind queries. */
  readonly lockedItemKeys: ReadonlySet<string>;
  readonly locks: readonly ParentalLockRecord[];
}

const MAX_SQL_IN_PARAMS = 200;
const SQL_KEY_CHUNK_SIZE = 400;

const NORMALIZED_LOCK_CAT_EXPR =
  "CASE WHEN substr(plc.target_key, 1, length(plc.source_id) + length(plc.item_kind) + 2) = (plc.source_id || '|' || plc.item_kind || '|') THEN substr(plc.target_key, length(plc.source_id) + length(plc.item_kind) + 3) ELSE plc.target_key END";

/**
 * Builds a parameter-free SQLite boolean expression matching adult keywords with the same strict
 * token boundaries as {@link isAdultKeywordMatch} over `(name, name_fold)`.
 */
export function sqlAdultKeywordMatchExpr(nameExpr: string, nameFoldExpr: string): string {
  const paddedFold = `(' ' || COALESCE(${nameFoldExpr}, '') || ' ')`;
  const paddedName = `(' ' || COALESCE(${nameExpr}, '') || ' ')`;
  const parts = ADULT_KEYWORD_TOKENS.map((tok) => `INSTR(${paddedFold}, ' ${tok} ') > 0`);
  parts.push(
    `(INSTR(${paddedFold}, ' 18 ') > 0 AND (${paddedName} GLOB '*[^A-Za-z0-9]18+[^A-Za-z0-9]*' OR ${paddedName} GLOB '*[^A-Za-z0-9]+18[^A-Za-z0-9]*'))`,
  );
  return `(${parts.join(' OR ')})`;
}

/**
 * Builds a parameter-free ` AND NOT (...)` SQL clause excluding rows whose `(name, name_fold)`
 * match adult keywords when `filter.blockAdultKeywords` is enabled.
 */
export function buildSqlAdultKeywordExclusionClause(
  filter: ActiveParentalFilter | null,
  nameExpr: string,
  nameFoldExpr: string,
): string {
  if (filter === null || !filter.blockAdultKeywords) return '';
  return ` AND NOT ${sqlAdultKeywordMatchExpr(nameExpr, nameFoldExpr)}`;
}

/** Returns all restricted category `provider_id`s for `(sourceId, kind)`. */
export function restrictedProviderIdsForSourceKind(
  filter: ActiveParentalFilter,
  sourceId: string,
  kind: BrowseKind,
): string[] {
  const prefix = `${sourceId}|${kind}|`;
  const out: string[] = [];
  for (const composite of filter.restrictedCategories) {
    if (composite.startsWith(prefix)) {
      out.push(composite.slice(prefix.length));
    }
  }
  return out;
}

/** Returns all locked item keys for `(sourceId, kind)` (or across all sources when `sourceId` is omitted). */
export function lockedItemKeysForKind(
  filter: ActiveParentalFilter,
  kind: BrowseKind,
  sourceId?: string,
): string[] {
  const out: string[] = [];
  for (const lock of filter.locks) {
    if (lock.targetKind !== 'item' || lock.itemKind !== kind) continue;
    if (sourceId !== undefined && lock.sourceId !== sourceId) continue;
    out.push(lock.targetKey);
  }
  return out;
}

function hasLocksForKind(
  filter: ActiveParentalFilter,
  targetKind: 'item' | 'category',
  kind: BrowseKind,
  sourceId?: string,
): boolean {
  for (const lock of filter.locks) {
    if (lock.targetKind !== targetKind || lock.itemKind !== kind) continue;
    if (sourceId !== undefined && lock.sourceId !== sourceId) continue;
    return true;
  }
  return false;
}

/**
 * Builds parameterized SQL predicates excluding directly locked items and items placed in any
 * restricted category for `kind` (optionally scoped to `sourceId`).
 * Uses direct `parental_locks` subqueries and bounded `IN` clauses so bind parameters always
 * stay well below SQLite's 999-variable limit even with thousands of locks or categories.
 */
export function buildSqlItemRestrictionClause(
  filter: ActiveParentalFilter,
  kind: BrowseKind,
  sourceIdExpr: string,
  keyExpr: string,
  sourceId?: string,
): { readonly clause: string; readonly params: readonly SqlValue[] } {
  const parts: string[] = [];
  const params: SqlValue[] = [];

  if (hasLocksForKind(filter, 'item', kind, sourceId)) {
    parts.push(
      `NOT EXISTS (SELECT 1 FROM parental_locks plk WHERE plk.profile_id = ? AND plk.source_id = ${sourceIdExpr} AND plk.target_kind = 'item' AND plk.item_kind = ? AND plk.target_key = ${keyExpr})`,
    );
    params.push(filter.profileId, kind);
  }

  if (hasLocksForKind(filter, 'category', kind, sourceId)) {
    parts.push(
      `NOT EXISTS (SELECT 1 FROM parental_locks plc JOIN placements rp ON rp.source_id = plc.source_id AND rp.kind = plc.item_kind AND rp.category_id = ${NORMALIZED_LOCK_CAT_EXPR} WHERE plc.profile_id = ? AND plc.source_id = ${sourceIdExpr} AND plc.target_kind = 'category' AND plc.item_kind = ? AND rp.item_key = ${keyExpr})`,
    );
    params.push(filter.profileId, kind);
  }

  if (sourceId !== undefined) {
    const prefix = `${sourceId}|${kind}|`;
    const adultCatIds: string[] = [];
    for (const composite of filter.restrictedCategories) {
      if (filter.lockedCategories.has(composite)) continue;
      if (composite.startsWith(prefix)) adultCatIds.push(composite.slice(prefix.length));
    }
    if (adultCatIds.length > 0 && adultCatIds.length <= MAX_SQL_IN_PARAMS) {
      const ph = adultCatIds.map(() => '?').join(', ');
      parts.push(
        `NOT EXISTS (SELECT 1 FROM placements rp WHERE rp.source_id = ${sourceIdExpr} AND rp.kind = ? AND rp.category_id IN (${ph}) AND rp.item_key = ${keyExpr})`,
      );
      params.push(kind, ...adultCatIds);
    } else if (adultCatIds.length > MAX_SQL_IN_PARAMS) {
      parts.push(
        `NOT EXISTS (SELECT 1 FROM categories rc JOIN placements rp ON rp.source_id = rc.source_id AND rp.kind = rc.kind AND rp.category_id = rc.provider_id WHERE rc.source_id = ${sourceIdExpr} AND rc.kind = ? AND ${sqlAdultKeywordMatchExpr('rc.name', 'rc.name_fold')} AND rp.item_key = ${keyExpr})`,
      );
      params.push(kind);
    }
  } else {
    const bySource = new Map<string, string[]>();
    let totalAdultCats = 0;
    for (const composite of filter.restrictedCategories) {
      if (filter.lockedCategories.has(composite)) continue;
      const parsed = parseCategoryId(composite);
      if (parsed === undefined || parsed.kind !== kind) continue;
      const list = bySource.get(parsed.sourceId);
      if (list === undefined) bySource.set(parsed.sourceId, [parsed.providerId]);
      else list.push(parsed.providerId);
      totalAdultCats += 1;
    }
    if (totalAdultCats > 0 && totalAdultCats + bySource.size * 3 <= MAX_SQL_IN_PARAMS) {
      for (const [srcId, catIds] of bySource) {
        const ph = catIds.map(() => '?').join(', ');
        parts.push(
          `NOT (${sourceIdExpr} = ? AND EXISTS (SELECT 1 FROM placements rp WHERE rp.source_id = ? AND rp.kind = ? AND rp.category_id IN (${ph}) AND rp.item_key = ${keyExpr}))`,
        );
        params.push(srcId, srcId, kind, ...catIds);
      }
    } else if (totalAdultCats > 0) {
      parts.push(
        `NOT EXISTS (SELECT 1 FROM categories rc JOIN placements rp ON rp.source_id = rc.source_id AND rp.kind = rc.kind AND rp.category_id = rc.provider_id WHERE rc.source_id = ${sourceIdExpr} AND rc.kind = ? AND ${sqlAdultKeywordMatchExpr('rc.name', 'rc.name_fold')} AND rp.item_key = ${keyExpr})`,
      );
      params.push(kind);
    }
  }

  if (parts.length === 0) return { clause: '', params: [] };
  return { clause: ` AND ${parts.join(' AND ')}`, params };
}

/**
 * Checks whether a single catalog item (`live`, `movie`, `series`, or `episode`) is restricted
 * under `filter` via direct item lock, restricted category placement, parent series restriction,
 * or adult keyword match.
 */
export async function isItemRestricted(
  db: SqlDriver,
  filter: ActiveParentalFilter,
  itemKey: string,
): Promise<boolean> {
  if (itemKey === '') return false;
  if (filter.lockedItemKeys.has(itemKey)) return true;

  const sourceId = sourceOfKey(itemKey);
  const itemRows =
    sourceId !== undefined
      ? await db.all<{
          source_id: string;
          kind: BrowseKind | 'episode';
          name: string | null;
          name_fold: string | null;
          series_key: string | null;
        }>(
          `SELECT source_id, 'live' AS kind, name, name_fold, NULL AS series_key
             FROM live WHERE source_id = ? AND key = ?
           UNION ALL
           SELECT source_id, 'movie', name, name_fold, NULL
             FROM movies WHERE source_id = ? AND key = ?
           UNION ALL
           SELECT source_id, 'series', name, name_fold, NULL
             FROM series WHERE source_id = ? AND key = ?
           UNION ALL
           SELECT source_id, 'episode', title, title_fold, series_key
             FROM episodes WHERE source_id = ? AND key = ?
           LIMIT 1`,
          [sourceId, itemKey, sourceId, itemKey, sourceId, itemKey, sourceId, itemKey],
        )
      : await db.all<{
          source_id: string;
          kind: BrowseKind | 'episode';
          name: string | null;
          name_fold: string | null;
          series_key: string | null;
        }>(
          `SELECT source_id, 'live' AS kind, name, name_fold, NULL AS series_key
             FROM live WHERE key = ?
           UNION ALL
           SELECT source_id, 'movie', name, name_fold, NULL
             FROM movies WHERE key = ?
           UNION ALL
           SELECT source_id, 'series', name, name_fold, NULL
             FROM series WHERE key = ?
           UNION ALL
           SELECT source_id, 'episode', title, title_fold, series_key
             FROM episodes WHERE key = ?
           LIMIT 1`,
          [itemKey, itemKey, itemKey, itemKey],
        );

  const row = itemRows[0];
  if (row === undefined) return false;

  if (filter.blockAdultKeywords) {
    if (row.name !== null && isAdultKeywordMatch(row.name)) return true;
    if (row.name_fold !== null && isAdultKeywordMatch(row.name_fold)) return true;
  }

  if (row.kind === 'episode') {
    if (row.series_key !== null && row.series_key !== '' && row.series_key !== itemKey) {
      return isItemRestricted(db, filter, row.series_key);
    }
    return false;
  }

  if (filter.lockedItems.has(`${row.source_id}|${row.kind}|${itemKey}`)) {
    return true;
  }

  if (filter.restrictedCategories.size > 0) {
    const placements = await db.all<{ category_id: string }>(
      'SELECT category_id FROM placements WHERE source_id = ? AND kind = ? AND item_key = ?',
      [row.source_id, row.kind, itemKey],
    );
    for (const p of placements) {
      if (filter.restrictedCategories.has(categoryId(row.source_id, row.kind, p.category_id))) {
        return true;
      }
    }
  }

  return false;
}

function chunkKeys(keys: readonly string[], maxChunk: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < keys.length; i += maxChunk) {
    out.push(keys.slice(i, i + maxChunk));
  }
  return out;
}

function groupBySource(entries: ReadonlyMap<string, string | undefined>): Map<string, string[]> {
  const bySource = new Map<string, string[]>();
  for (const [key, src] of entries) {
    const bucketKey = src ?? '';
    const list = bySource.get(bucketKey);
    if (list === undefined) bySource.set(bucketKey, [key]);
    else list.push(key);
  }
  return bySource;
}

async function findRestrictedForKind(
  db: SqlDriver,
  filter: ActiveParentalFilter,
  kind: BrowseKind,
  candidates: ReadonlyMap<string, string | undefined>,
  alreadyCheckedKeywords: boolean,
): Promise<Set<string>> {
  const found = new Set<string>();
  if (candidates.size === 0) return found;
  const table = ITEM_TABLE[kind];
  const bySource = groupBySource(candidates);

  if (filter.blockAdultKeywords && !alreadyCheckedKeywords) {
    for (const [srcId, keys] of bySource) {
      const maxKeys = srcId === '' ? SQL_KEY_CHUNK_SIZE : SQL_KEY_CHUNK_SIZE - 1;
      for (const chunk of chunkKeys(keys, maxKeys)) {
        const ph = chunk.map(() => '?').join(', ');
        const rows =
          srcId !== ''
            ? await db.all<{ key: string; name: string; name_fold: string }>(
                `SELECT key, name, name_fold FROM ${table} WHERE source_id = ? AND key IN (${ph})`,
                [srcId, ...chunk],
              )
            : await db.all<{ key: string; name: string; name_fold: string }>(
                `SELECT key, name, name_fold FROM ${table} WHERE key IN (${ph})`,
                chunk,
              );
        for (const r of rows) {
          if (isAdultKeywordMatch(r.name) || isAdultKeywordMatch(r.name_fold)) {
            found.add(r.key);
          }
        }
      }
    }
  }

  if (filter.restrictedCategories.size === 0) return found;

  for (const [srcId, keys] of bySource) {
    const remaining = keys.filter((k) => !found.has(k));
    if (remaining.length === 0) continue;

    if (srcId !== '') {
      const catIds = restrictedProviderIdsForSourceKind(filter, srcId, kind);
      if (catIds.length === 0) continue;
      if (catIds.length <= MAX_SQL_IN_PARAMS) {
        const keyChunkSize = Math.max(1, SQL_KEY_CHUNK_SIZE - catIds.length - 2);
        const catPh = catIds.map(() => '?').join(', ');
        for (const chunk of chunkKeys(remaining, keyChunkSize)) {
          const keyPh = chunk.map(() => '?').join(', ');
          const rows = await db.all<{ item_key: string }>(
            `SELECT DISTINCT item_key
               FROM placements
              WHERE source_id = ? AND kind = ? AND category_id IN (${catPh}) AND item_key IN (${keyPh})`,
            [srcId, kind, ...catIds, ...chunk],
          );
          for (const r of rows) found.add(r.item_key);
        }
      } else {
        const adultSub = filter.blockAdultKeywords
          ? ` OR EXISTS (SELECT 1 FROM categories rc WHERE rc.source_id = rp.source_id AND rc.kind = rp.kind AND rc.provider_id = rp.category_id AND ${sqlAdultKeywordMatchExpr('rc.name', 'rc.name_fold')})`
          : '';
        for (const chunk of chunkKeys(remaining, SQL_KEY_CHUNK_SIZE - 4)) {
          const keyPh = chunk.map(() => '?').join(', ');
          const rows = await db.all<{ item_key: string }>(
            `SELECT DISTINCT rp.item_key
               FROM placements rp
              WHERE rp.source_id = ? AND rp.kind = ? AND rp.item_key IN (${keyPh})
                AND (
                  EXISTS (
                    SELECT 1 FROM parental_locks plc
                     WHERE plc.profile_id = ? AND plc.source_id = rp.source_id
                       AND plc.target_kind = 'category' AND plc.item_kind = rp.kind
                       AND rp.category_id = ${NORMALIZED_LOCK_CAT_EXPR}
                  )${adultSub}
                )`,
            [srcId, kind, ...chunk, filter.profileId],
          );
          for (const r of rows) found.add(r.item_key);
        }
      }
      continue;
    }

    for (const chunk of chunkKeys(remaining, SQL_KEY_CHUNK_SIZE - 1)) {
      const keyPh = chunk.map(() => '?').join(', ');
      const rows = await db.all<{ source_id: string; item_key: string; category_id: string }>(
        `SELECT source_id, item_key, category_id FROM placements WHERE kind = ? AND item_key IN (${keyPh})`,
        [kind, ...chunk],
      );
      for (const r of rows) {
        if (filter.restrictedCategories.has(categoryId(r.source_id, kind, r.category_id))) {
          found.add(r.item_key);
        }
      }
    }
  }

  return found;
}

function linkSeries(map: Map<string, Set<string>>, seriesKey: string, itemKey: string): void {
  let set = map.get(seriesKey);
  if (set === undefined) {
    set = new Set<string>();
    map.set(seriesKey, set);
  }
  set.add(itemKey);
}

/**
 * Batch-evaluates which item keys in `entries` are restricted under `filter`.
 * Uses bounded `<= 400`-key batched SQL queries against item tables and `placements`
 * plus deduplicated parent `series_key` evaluation (zero N+1 queries).
 */
export async function findRestrictedItemKeys(
  db: SqlDriver,
  filter: ActiveParentalFilter,
  entries: readonly {
    readonly itemKey: string;
    readonly sourceId?: string;
    readonly kind?: BrowseKind | 'episode';
    readonly title?: string | null;
    readonly seriesKey?: string | null;
  }[],
): Promise<Set<string>> {
  const restricted = new Set<string>();
  const knownByKind: Record<BrowseKind, Map<string, string | undefined>> = {
    live: new Map(),
    movie: new Map(),
    series: new Map(),
  };
  const episodeKeys = new Map<string, string | undefined>();
  const unknownKeys = new Set<string>();
  const seriesLinks = new Map<string, Set<string>>();
  const requestedItemKeys = new Set<string>();

  for (const entry of entries) {
    if (entry.itemKey === '') continue;
    requestedItemKeys.add(entry.itemKey);
    if (filter.lockedItemKeys.has(entry.itemKey)) {
      restricted.add(entry.itemKey);
      continue;
    }
    if (entry.seriesKey && filter.lockedItemKeys.has(entry.seriesKey)) {
      restricted.add(entry.itemKey);
      continue;
    }
    if (filter.blockAdultKeywords && entry.title && isAdultKeywordMatch(entry.title)) {
      restricted.add(entry.itemKey);
      continue;
    }
    if (entry.seriesKey && entry.seriesKey !== '' && entry.seriesKey !== entry.itemKey) {
      linkSeries(seriesLinks, entry.seriesKey, entry.itemKey);
    }
    const hintedSrc = entry.sourceId ?? sourceOfKey(entry.itemKey);
    if (entry.kind === 'live' || entry.kind === 'movie' || entry.kind === 'series') {
      knownByKind[entry.kind].set(entry.itemKey, hintedSrc);
    } else if (entry.kind === 'episode') {
      episodeKeys.set(entry.itemKey, hintedSrc);
    } else {
      unknownKeys.add(entry.itemKey);
    }
  }

  const discoveredByKind: Record<BrowseKind, Map<string, string | undefined>> = {
    live: new Map(),
    movie: new Map(),
    series: new Map(),
  };

  if (unknownKeys.size > 0) {
    const remaining = new Set(unknownKeys);
    for (const kind of ['live', 'movie', 'series'] as const) {
      if (remaining.size === 0) break;
      const table = ITEM_TABLE[kind];
      for (const chunk of chunkKeys([...remaining], SQL_KEY_CHUNK_SIZE)) {
        const ph = chunk.map(() => '?').join(', ');
        const rows = await db.all<{
          source_id: string;
          key: string;
          name: string;
          name_fold: string;
        }>(`SELECT source_id, key, name, name_fold FROM ${table} WHERE key IN (${ph})`, chunk);
        for (const r of rows) {
          remaining.delete(r.key);
          if (
            filter.blockAdultKeywords &&
            (isAdultKeywordMatch(r.name) || isAdultKeywordMatch(r.name_fold))
          ) {
            restricted.add(r.key);
          } else {
            discoveredByKind[kind].set(r.key, r.source_id);
          }
        }
      }
    }
    if (remaining.size > 0) {
      for (const key of remaining) {
        episodeKeys.set(key, sourceOfKey(key));
      }
    }
  }

  if (episodeKeys.size > 0) {
    const bySource = groupBySource(episodeKeys);
    for (const [srcId, keys] of bySource) {
      const maxKeys = srcId === '' ? SQL_KEY_CHUNK_SIZE : SQL_KEY_CHUNK_SIZE - 1;
      for (const chunk of chunkKeys(keys, maxKeys)) {
        const ph = chunk.map(() => '?').join(', ');
        const rows =
          srcId !== ''
            ? await db.all<{
                key: string;
                title: string | null;
                title_fold: string | null;
                series_key: string | null;
              }>(
                `SELECT key, title, title_fold, series_key FROM episodes WHERE source_id = ? AND key IN (${ph})`,
                [srcId, ...chunk],
              )
            : await db.all<{
                key: string;
                title: string | null;
                title_fold: string | null;
                series_key: string | null;
              }>(
                `SELECT key, title, title_fold, series_key FROM episodes WHERE key IN (${ph})`,
                chunk,
              );
        for (const r of rows) {
          if (
            filter.blockAdultKeywords &&
            ((r.title !== null && isAdultKeywordMatch(r.title)) ||
              (r.title_fold !== null && isAdultKeywordMatch(r.title_fold)))
          ) {
            restricted.add(r.key);
            continue;
          }
          if (r.series_key !== null && r.series_key !== '' && r.series_key !== r.key) {
            if (filter.lockedItemKeys.has(r.series_key)) {
              restricted.add(r.key);
            } else {
              linkSeries(seriesLinks, r.series_key, r.key);
            }
          }
        }
      }
    }
  }

  for (const [seriesKey, linked] of seriesLinks) {
    let anyPending = false;
    for (const itemKey of linked) {
      if (!restricted.has(itemKey)) {
        anyPending = true;
        break;
      }
    }
    if (anyPending && !knownByKind.series.has(seriesKey)) {
      knownByKind.series.set(seriesKey, sourceOfKey(seriesKey));
    }
  }

  const restrictedSeries = new Set<string>();
  for (const kind of ['live', 'movie', 'series'] as const) {
    if (knownByKind[kind].size > 0) {
      const hits = await findRestrictedForKind(db, filter, kind, knownByKind[kind], false);
      for (const key of hits) {
        if (kind === 'series') restrictedSeries.add(key);
        if (requestedItemKeys.has(key)) restricted.add(key);
      }
    }
    if (discoveredByKind[kind].size > 0) {
      const hits = await findRestrictedForKind(db, filter, kind, discoveredByKind[kind], true);
      for (const key of hits) {
        if (kind === 'series') restrictedSeries.add(key);
        if (requestedItemKeys.has(key)) restricted.add(key);
      }
    }
  }

  for (const [seriesKey, linked] of seriesLinks) {
    if (restrictedSeries.has(seriesKey) || filter.lockedItemKeys.has(seriesKey)) {
      for (const itemKey of linked) {
        restricted.add(itemKey);
      }
    }
  }

  return restricted;
}
