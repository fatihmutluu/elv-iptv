import type { SqlDriver, SqlValue } from '@elv/domain';
import { CUSTOM_GROUP_CATEGORY_PREFIX, parseCustomGroupCategoryId } from './custom-groups-repo';
import type { ElvEnrichmentStore, ElvQualityMemoryRecord } from './elv-enrichment-repo';
import { UNRELIABLE_FAIL_COUNT_THRESHOLD } from './elv-quality-memory';
import { parseLiveVariant } from './live-variants';
import { isAdultKeywordMatch, type ParentalQueryOptions } from './parental-policy';
import {
  buildSqlAdultKeywordExclusionClause,
  buildSqlItemRestrictionClause,
  isCategoryRestricted,
  isItemRestricted,
  loadActiveParentalFilter,
} from './parental-repo';
import { parseCategoryId, sourceOfKey } from './queries';
import { resolveQueryProfileId } from './queries-shared';
import { parseVodVersion } from './vod-versions';

/** One selectable quality variant of a live channel (`#218`, `#511`). */
export interface LiveVariantOption {
  readonly key: string;
  readonly title: string;
  readonly qualityLabel: string;
  readonly qualityRank: number;
  readonly sourceId?: string;
  readonly sourceName?: string;
  readonly failCount?: number;
  readonly isUnreliable?: boolean;
}

/** Options for {@link queryLiveVariants} extending parental filtering with Live TV ELV Mode (`#511`). */
export interface QueryLiveVariantsOptions extends ParentalQueryOptions {
  /** When `true`, collapses identical `variant_base_fold` channels across ALL categories (default `false`). */
  readonly crossCategory?: boolean;
  /** When `true` alongside `crossCategory`, includes matching variants from other active sources. */
  readonly crossSource?: boolean;
  /** Optional quality/failure map (`elv_quality_memory`) ranking healthy variants ahead of failed ones. */
  readonly qualityByKey?: ReadonlyMap<string, ElvQualityMemoryRecord>;
  /** Optional isolated ELV enrichment store used to load failure counts when `qualityByKey` is omitted. */
  readonly enrichmentStore?: ElvEnrichmentStore;
}

/** One selectable version of a multi-version VOD movie (`#404`). */
export interface VodVersionOption {
  readonly key: string;
  readonly title: string;
  readonly versionLabel: string;
  readonly year: number | null;
  readonly qualityRank: number;
}

interface RawLiveVariantRow {
  readonly id?: number;
  readonly key: string;
  readonly source_id?: string;
  readonly source_name?: string;
  readonly display_name: string;
  readonly raw_name: string;
  readonly quality_rank: number;
}

/**
 * Lists all visible quality variants of a live channel sharing its `variant_base_fold` (`#218`, `#511`).
 * - Default (`opts.crossCategory !== true`): strictly scopes to `categoryId` (custom group or provider
 *   category within the same source), ordered highest `quality_rank` first.
 * - Live TV ELV Mode (`opts.crossCategory === true`): collapses identical `variant_base_fold` variants
 *   across ALL categories (and across all active sources when `opts.crossSource === true`), ranking
 *   healthy variants strictly ahead of unreliable/failing ones (`failCount >= 2`) for clean failover.
 */
export async function queryLiveVariants(
  db: SqlDriver,
  itemKey: string,
  categoryId?: string,
  opts?: QueryLiveVariantsOptions,
): Promise<LiveVariantOption[]> {
  const sourceId = sourceOfKey(itemKey);
  if (sourceId === undefined) return [];
  const seed = (
    await db.all<{ variant_base_fold: string }>(
      'SELECT variant_base_fold FROM live WHERE source_id = ? AND key = ? AND is_hidden = 0 LIMIT 1',
      [sourceId, itemKey],
    )
  )[0];
  if (seed === undefined || seed.variant_base_fold === '') return [];

  const crossCategory = opts?.crossCategory === true;
  const crossSource = crossCategory && opts?.crossSource === true;

  let customGroupId: string | undefined;
  let providerCategoryId: string | undefined;
  if (!crossCategory && categoryId !== undefined && categoryId !== '') {
    if (categoryId.startsWith(CUSTOM_GROUP_CATEGORY_PREFIX)) {
      customGroupId = parseCustomGroupCategoryId(categoryId);
      if (customGroupId === undefined) return [];
    } else {
      const parsed = parseCategoryId(categoryId);
      providerCategoryId = parsed !== undefined ? parsed.providerId : categoryId;
    }
  }

  const profileId = resolveQueryProfileId(opts?.profileId);
  const filter = await loadActiveParentalFilter(db, profileId, opts?.parentalUnlocked);
  if (filter !== null) {
    if (
      providerCategoryId !== undefined &&
      isCategoryRestricted(filter, sourceId, 'live', providerCategoryId)
    ) {
      return [];
    }
    if (await isItemRestricted(db, filter, itemKey)) {
      return [];
    }
  }

  const restrict =
    filter === null
      ? { clause: '', params: [] as readonly SqlValue[] }
      : buildSqlItemRestrictionClause(
          filter,
          'live',
          'l.source_id',
          'l.key',
          crossSource ? undefined : sourceId,
        );
  const adultExcl = buildSqlAdultKeywordExclusionClause(filter, 'l.name', 'l.name_fold');

  const rows: RawLiveVariantRow[] = crossCategory
    ? crossSource
      ? await db.all<RawLiveVariantRow>(
          `SELECT l.id, l.key, l.source_id, s.name AS source_name,
                  COALESCE(NULLIF(co.custom_name, ''), l.name) AS display_name,
                  l.name AS raw_name, l.quality_rank
             FROM live l
             JOIN sources s ON s.id = l.source_id AND s.deleting = 0
             LEFT JOIN channel_overrides co ON co.profile_id = ? AND co.item_key = l.key
            WHERE l.is_hidden = 0 AND COALESCE(co.is_hidden, 0) = 0 AND l.variant_base_fold = ?${restrict.clause}${adultExcl}
            ORDER BY l.quality_rank DESC, l.id ASC`,
          [profileId, seed.variant_base_fold, ...restrict.params],
        )
      : await db.all<RawLiveVariantRow>(
          `SELECT l.id, l.key, l.source_id, s.name AS source_name,
                  COALESCE(NULLIF(co.custom_name, ''), l.name) AS display_name,
                  l.name AS raw_name, l.quality_rank
             FROM live l
             JOIN sources s ON s.id = l.source_id AND s.deleting = 0
             LEFT JOIN channel_overrides co ON co.profile_id = ? AND co.item_key = l.key
            WHERE l.source_id = ? AND l.is_hidden = 0 AND COALESCE(co.is_hidden, 0) = 0 AND l.variant_base_fold = ?${restrict.clause}${adultExcl}
            ORDER BY l.quality_rank DESC, l.id ASC`,
          [profileId, sourceId, seed.variant_base_fold, ...restrict.params],
        )
    : customGroupId !== undefined
      ? await db.all<RawLiveVariantRow>(
          `SELECT l.key, COALESCE(NULLIF(co.custom_name, ''), l.name) AS display_name, l.name AS raw_name, l.quality_rank
             FROM custom_group_items cgi
             JOIN custom_groups g ON g.id = cgi.group_id
             JOIN live l
               ON l.source_id = cgi.source_id AND l.key = cgi.item_key
             LEFT JOIN channel_overrides co ON co.profile_id = g.profile_id AND co.item_key = l.key
            WHERE cgi.group_id = ? AND g.profile_id = ? AND g.is_hidden = 0
              AND l.source_id = ? AND l.is_hidden = 0 AND COALESCE(co.is_hidden, 0) = 0 AND l.variant_base_fold = ?
              AND EXISTS (SELECT 1 FROM sources s WHERE s.id = l.source_id AND s.deleting = 0)${restrict.clause}${adultExcl}
            ORDER BY l.quality_rank DESC, cgi.position ASC, l.id ASC`,
          [customGroupId, profileId, sourceId, seed.variant_base_fold, ...restrict.params],
        )
      : providerCategoryId !== undefined
        ? await db.all<RawLiveVariantRow>(
            `SELECT l.key, COALESCE(NULLIF(co.custom_name, ''), l.name) AS display_name, l.name AS raw_name, l.quality_rank
               FROM live l
               JOIN placements p
                 ON p.source_id = l.source_id AND p.kind = 'live' AND p.item_key = l.key
               LEFT JOIN channel_overrides co ON co.profile_id = ? AND co.item_key = l.key
              WHERE l.source_id = ? AND l.is_hidden = 0 AND COALESCE(co.is_hidden, 0) = 0 AND l.variant_base_fold = ?
                AND p.category_id = ? AND p.is_hidden = 0
                AND EXISTS (SELECT 1 FROM sources s WHERE s.id = l.source_id AND s.deleting = 0)${restrict.clause}${adultExcl}
              ORDER BY l.quality_rank DESC, p.position ASC, l.id ASC`,
            [profileId, sourceId, seed.variant_base_fold, providerCategoryId, ...restrict.params],
          )
        : await db.all<RawLiveVariantRow>(
            `SELECT l.key, COALESCE(NULLIF(co.custom_name, ''), l.name) AS display_name, l.name AS raw_name, l.quality_rank
               FROM live l
               LEFT JOIN channel_overrides co ON co.profile_id = ? AND co.item_key = l.key
              WHERE l.source_id = ? AND l.is_hidden = 0 AND COALESCE(co.is_hidden, 0) = 0 AND l.variant_base_fold = ?
                AND EXISTS (SELECT 1 FROM sources s WHERE s.id = l.source_id AND s.deleting = 0)${restrict.clause}${adultExcl}
              ORDER BY l.quality_rank DESC, l.id ASC`,
            [profileId, sourceId, seed.variant_base_fold, ...restrict.params],
          );

  const allowed =
    filter?.blockAdultKeywords === true
      ? rows.filter((r) => !isAdultKeywordMatch(r.raw_name) && !isAdultKeywordMatch(r.display_name))
      : rows;

  const qualityByKey: ReadonlyMap<string, ElvQualityMemoryRecord> | undefined =
    opts?.qualityByKey ??
    (opts?.enrichmentStore !== undefined && allowed.length > 0
      ? await opts.enrichmentStore.getQualityMemoryForKeys(allowed.map((r) => r.key))
      : undefined);

  if (!crossCategory && qualityByKey === undefined) {
    return allowed.map((r) => {
      const parsed = parseLiveVariant(r.raw_name);
      return {
        key: r.key,
        title: r.display_name,
        qualityLabel: parsed.qualityLabel,
        qualityRank: r.quality_rank,
      };
    });
  }

  return allowed
    .map((r, index) => {
      const parsed = parseLiveVariant(r.raw_name);
      const failCount = qualityByKey?.get(r.key)?.failCount ?? 0;
      const isUnreliable = failCount >= UNRELIABLE_FAIL_COUNT_THRESHOLD;
      return {
        index,
        rowSourceId: r.source_id ?? sourceId,
        failCount,
        isUnreliable,
        option: {
          key: r.key,
          title: r.display_name,
          qualityLabel: parsed.qualityLabel,
          qualityRank: r.quality_rank,
          ...(r.source_id !== undefined ? { sourceId: r.source_id } : {}),
          ...(r.source_name !== undefined ? { sourceName: r.source_name } : {}),
          ...(qualityByKey !== undefined ? { failCount, isUnreliable } : {}),
        } satisfies LiveVariantOption,
      };
    })
    .sort((a, b) => {
      if (a.isUnreliable !== b.isUnreliable) return a.isUnreliable ? 1 : -1;
      if (a.failCount !== b.failCount) return a.failCount - b.failCount;
      if (b.option.qualityRank !== a.option.qualityRank) {
        return b.option.qualityRank - a.option.qualityRank;
      }
      const aSame = a.rowSourceId === sourceId ? 0 : 1;
      const bSame = b.rowSourceId === sourceId ? 0 : 1;
      if (aSame !== bSame) return aSame - bSame;
      return a.index - b.index;
    })
    .map((entry) => entry.option);
}

/**
 * Lists all visible versions of a VOD movie sharing its `version_group_key` within the same source (`#404`),
 * ordered highest `qualityRank` first.
 */
export async function queryItemVersions(
  db: SqlDriver,
  itemKey: string,
  opts?: ParentalQueryOptions,
): Promise<VodVersionOption[]> {
  const sourceId = sourceOfKey(itemKey);
  if (sourceId === undefined) return [];
  const seed = (
    await db.all<{ version_group_key: string }>(
      'SELECT version_group_key FROM movies WHERE source_id = ? AND key = ? AND is_hidden = 0 LIMIT 1',
      [sourceId, itemKey],
    )
  )[0];
  if (seed === undefined || seed.version_group_key === '') return [];

  const filter = await loadActiveParentalFilter(db, opts?.profileId, opts?.parentalUnlocked);
  if (filter !== null && (await isItemRestricted(db, filter, itemKey))) {
    return [];
  }

  const restrict =
    filter === null
      ? { clause: '', params: [] as readonly SqlValue[] }
      : buildSqlItemRestrictionClause(filter, 'movie', 'movies.source_id', 'movies.key', sourceId);
  const adultExcl = buildSqlAdultKeywordExclusionClause(filter, 'movies.name', 'movies.name_fold');

  const rows = await db.all<{
    id: number;
    key: string;
    name: string;
    year: number | null;
    version_label: string | null;
  }>(
    `SELECT id, key, name, year, version_label
       FROM movies
      WHERE source_id = ? AND is_hidden = 0 AND version_group_key = ?
        AND EXISTS (SELECT 1 FROM sources s WHERE s.id = movies.source_id AND s.deleting = 0)${restrict.clause}${adultExcl}
      ORDER BY id ASC`,
    [sourceId, seed.version_group_key, ...restrict.params],
  );

  const allowed =
    filter?.blockAdultKeywords === true ? rows.filter((r) => !isAdultKeywordMatch(r.name)) : rows;

  return allowed
    .map((r) => {
      const parsed = parseVodVersion(r.name, r.year);
      return {
        id: r.id,
        key: r.key,
        title: r.name,
        versionLabel: r.version_label ?? parsed.versionLabel,
        year: r.year,
        qualityRank: parsed.qualityRank,
      };
    })
    .sort((a, b) => b.qualityRank - a.qualityRank || a.id - b.id)
    .map(({ key, title, versionLabel, year, qualityRank }) => ({
      key,
      title,
      versionLabel,
      year,
      qualityRank,
    }));
}
