import type { SqlDriver, SqlValue } from '@elv/domain';
import type {
  ElvEnrichmentStore,
  ElvItemEnrichment,
  ElvQualityMemoryRecord,
} from './elv-enrichment-repo';
import { escapeLikePattern } from './elv-enrichment-search';
import { formatVerifiedResolution, scoreMergedVariant } from './elv-quality-memory';
import { isAdultKeywordMatch, type ParentalQueryOptions } from './parental-policy';
import {
  type ActiveParentalFilter,
  findRestrictedItemKeys,
  isItemRestricted,
  loadActiveParentalFilter,
} from './parental-repo';
import { type ItemRow, resolveQueryProfileId, sourceOfKey } from './queries-shared';
import { parseVodVersion } from './vod-versions';

/** Minimum match confidence required before merging copies under the same IMDb ID (`#511`). */
export const ELV_MERGE_MIN_CONFIDENCE = 0.78;

/** One selectable multi-source VOD/series variant returned by {@link queryMergedVodVersions}. */
export interface MergedVodVariant {
  readonly itemKey: string;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly rawTitle: string;
  readonly versionLabel: string;
  readonly verifiedResolution: string | null;
  readonly actualVideoCodec: string | null;
  readonly actualAudioCodec: string | null;
  readonly isFake4k: boolean;
  readonly failCount: number;
  readonly qualityRank: number;
  readonly score: number;
}

/** Catalog page item optionally deduplicated by verified IMDb ID with optional IMDb poster substitution. */
export type DeduplicatedCatalogItem<T extends ItemRow = ItemRow> = T & {
  readonly mergedCount?: number;
  readonly mergedItemKeys?: readonly string[];
  readonly imdbId?: string;
};

/** Options for {@link deduplicateCatalogPageByImdb}. */
export interface DeduplicateCatalogPageOptions {
  /**
   * When `true` (default), substitutes the enriched IMDb `posterUrl` on the representative card.
   * Set to `false` to preserve the original provider poster when metadata enrichment is disabled (`#511`).
   */
  readonly replacePoster?: boolean;
}

interface RawCatalogVariantRow {
  readonly key: string;
  readonly source_id: string;
  readonly source_name: string;
  readonly name: string;
  readonly year: number | null;
  readonly version_label: string | null;
  readonly version_group_key?: string | null;
}

const MAX_OFFLINE_CANDIDATES = 250;

function selectFoldTokens(groupKey: string): string[] {
  const base = groupKey.split('::')[0]?.trim() ?? '';
  if (base === '') return [];
  const words = base.split(/\s+/g).filter(Boolean);
  const longWords = words.filter((w) => w.length >= 3).sort((a, b) => b.length - a.length);
  if (longWords.length > 0) return longWords.slice(0, 2);
  return words.slice(0, 2);
}

async function filterVisibleVariantRows<T extends { readonly key: string; readonly name: string }>(
  catalogDb: SqlDriver,
  filter: ActiveParentalFilter | null,
  rows: readonly T[],
): Promise<T[]> {
  if (filter === null || rows.length === 0) return [...rows];
  const restricted = await findRestrictedItemKeys(
    catalogDb,
    filter,
    rows.map((r) => ({ itemKey: r.key })),
  );
  return rows.filter(
    (r) => !restricted.has(r.key) && !(filter.blockAdultKeywords && isAdultKeywordMatch(r.name)),
  );
}

async function buildSortedMergedVariants(
  rows: readonly RawCatalogVariantRow[],
  enrichmentStore: ElvEnrichmentStore | undefined,
): Promise<MergedVodVariant[]> {
  if (rows.length === 0) return [];
  const qualityMap =
    enrichmentStore === undefined
      ? new Map<string, ElvQualityMemoryRecord>()
      : await enrichmentStore.getQualityMemoryForKeys(rows.map((r) => r.key));
  return sortMergedVariants(
    rows.map((r) =>
      toMergedVariant(
        {
          itemKey: r.key,
          sourceId: r.source_id,
          sourceName: r.source_name,
          rawTitle: r.name,
          year: r.year,
          storedVersionLabel: r.version_label,
        },
        qualityMap.get(r.key),
      ),
    ),
  );
}

async function queryOfflineCrossSourceRows(
  catalogDb: SqlDriver,
  seedSourceId: string,
  itemKey: string,
): Promise<RawCatalogVariantRow[]> {
  const movieSeed = (
    await catalogDb.all<{
      name: string;
      year: number | null;
      version_group_key: string | null;
    }>(
      'SELECT name, year, version_group_key FROM movies WHERE source_id = ? AND key = ? AND is_hidden = 0 LIMIT 1',
      [seedSourceId, itemKey],
    )
  )[0];

  if (movieSeed !== undefined) {
    const parsedSeed = parseVodVersion(movieSeed.name, movieSeed.year);
    const seedGroupKey = parsedSeed.groupKey;
    const storedGroup = movieSeed.version_group_key?.trim() ?? '';
    const tokens = selectFoldTokens(seedGroupKey);

    const clauses: string[] = ['t.key = ?'];
    const params: SqlValue[] = [itemKey];
    if (storedGroup !== '') {
      clauses.push('(t.source_id = ? AND t.version_group_key = ?)');
      params.push(seedSourceId, storedGroup);
    }
    if (seedGroupKey !== '' && tokens.length > 0) {
      const tokenClause = tokens.map(() => "t.name_fold LIKE ? ESCAPE '\\'").join(' AND ');
      clauses.push(`(${tokenClause})`);
      for (const tok of tokens) params.push(`%${escapeLikePattern(tok)}%`);
    }

    const candidates = await catalogDb.all<RawCatalogVariantRow>(
      `SELECT t.key, t.source_id, s.name AS source_name, t.name, t.year, t.version_label, t.version_group_key
         FROM movies t
         JOIN sources s ON s.id = t.source_id AND s.deleting = 0
        WHERE t.is_hidden = 0 AND (${clauses.join(' OR ')})
        LIMIT ?`,
      [...params, MAX_OFFLINE_CANDIDATES],
    );

    return candidates.filter(
      (r) =>
        r.key === itemKey ||
        (storedGroup !== '' &&
          r.source_id === seedSourceId &&
          r.version_group_key === storedGroup) ||
        (seedGroupKey !== '' && parseVodVersion(r.name, r.year).groupKey === seedGroupKey),
    );
  }

  const seriesSeed = (
    await catalogDb.all<{ name: string; year: number | null }>(
      'SELECT name, year FROM series WHERE source_id = ? AND key = ? AND is_hidden = 0 LIMIT 1',
      [seedSourceId, itemKey],
    )
  )[0];
  if (seriesSeed === undefined) return [];

  const seedGroupKey = parseVodVersion(seriesSeed.name, seriesSeed.year).groupKey;
  const tokens = selectFoldTokens(seedGroupKey);
  const clauses: string[] = ['t.key = ?'];
  const params: SqlValue[] = [itemKey];
  if (seedGroupKey !== '' && tokens.length > 0) {
    const tokenClause = tokens.map(() => "t.name_fold LIKE ? ESCAPE '\\'").join(' AND ');
    clauses.push(`(${tokenClause})`);
    for (const tok of tokens) params.push(`%${escapeLikePattern(tok)}%`);
  }

  const candidates = await catalogDb.all<RawCatalogVariantRow>(
    `SELECT t.key, t.source_id, s.name AS source_name, t.name, t.year, NULL AS version_label
       FROM series t
       JOIN sources s ON s.id = t.source_id AND s.deleting = 0
      WHERE t.is_hidden = 0 AND (${clauses.join(' OR ')})
      LIMIT ?`,
    [...params, MAX_OFFLINE_CANDIDATES],
  );
  return candidates.filter(
    (r) =>
      r.key === itemKey ||
      (seedGroupKey !== '' && parseVodVersion(r.name, r.year).groupKey === seedGroupKey),
  );
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function isMergeEligible(match: {
  readonly confidence: number;
  readonly manualLock: boolean;
}): boolean {
  return match.manualLock || match.confidence >= ELV_MERGE_MIN_CONFIDENCE;
}

function toMergedVariant(
  row: {
    readonly itemKey: string;
    readonly sourceId: string;
    readonly sourceName: string;
    readonly rawTitle: string;
    readonly year: number | null;
    readonly storedVersionLabel: string | null;
  },
  quality: ElvQualityMemoryRecord | undefined,
): MergedVodVariant {
  const parsed = parseVodVersion(row.rawTitle, row.year);
  const versionLabel =
    row.storedVersionLabel !== null && row.storedVersionLabel !== ''
      ? row.storedVersionLabel
      : parsed.versionLabel;
  const verifiedResolution = formatVerifiedResolution(quality?.actualWidth, quality?.actualHeight);
  const isFake4k = quality?.isFake4k ?? false;
  const failCount = quality?.failCount ?? 0;
  const score = scoreMergedVariant({
    verifiedResolution,
    actualHeight: quality?.actualHeight ?? null,
    actualVideoCodec: quality?.actualVideoCodec ?? null,
    actualHdr: quality?.actualHdr ?? null,
    claimedQualityRank: parsed.qualityRank,
    isFake4k,
    failCount,
  });
  return {
    itemKey: row.itemKey,
    sourceId: row.sourceId,
    sourceName: row.sourceName,
    rawTitle: row.rawTitle,
    versionLabel,
    verifiedResolution,
    actualVideoCodec: quality?.actualVideoCodec ?? null,
    actualAudioCodec: quality?.actualAudioCodec ?? null,
    isFake4k,
    failCount,
    qualityRank: parsed.qualityRank,
    score,
  };
}

function sortMergedVariants(variants: MergedVodVariant[]): MergedVodVariant[] {
  return variants.sort(
    (a, b) =>
      b.score - a.score || b.qualityRank - a.qualityRank || a.itemKey.localeCompare(b.itemKey),
  );
}

/**
 * Resolves all cross-source copies sharing a verified `(imdb_id, media_type)` match (`confidence >= 0.78`
 * or `manual_lock = 1`), joining `catalog.db` (`movies`/`series` + `sources.name`) with `elv_quality_memory`
 * so verified real 4K/1080p variants rank first and fake-4K or repeatedly failing variants sink cleanly.
 * Falls back to single-source {@link queryItemVersions} when unmatched (`#511`).
 */
export async function queryMergedVodVersions(
  catalogDb: SqlDriver,
  enrichmentStore: ElvEnrichmentStore | undefined,
  itemKey: string,
  opts?: ParentalQueryOptions,
): Promise<MergedVodVariant[]> {
  const seedSourceId = sourceOfKey(itemKey);
  if (seedSourceId === undefined) return [];

  const profileId = resolveQueryProfileId(opts?.profileId);
  const filter = await loadActiveParentalFilter(catalogDb, profileId, opts?.parentalUnlocked);
  if (filter !== null && (await isItemRestricted(catalogDb, filter, itemKey))) {
    return [];
  }

  if (enrichmentStore !== undefined) {
    const seedMatch = await enrichmentStore.getMatchForKey(itemKey);
    if (seedMatch !== null && isMergeEligible(seedMatch)) {
      const siblingMatches = await enrichmentStore.listMatchesByImdbId(
        seedMatch.imdbId,
        seedMatch.mediaType,
        ELV_MERGE_MIN_CONFIDENCE,
      );
      const keySet = new Set<string>([itemKey]);
      for (const m of siblingMatches) keySet.add(m.itemKey);
      const keys = [...keySet];

      const table = seedMatch.mediaType === 'series' ? 'series' : 'movies';
      const versionCol =
        seedMatch.mediaType === 'series' ? 'NULL AS version_label' : 't.version_label';
      const rows = await catalogDb.all<RawCatalogVariantRow>(
        `SELECT t.key, t.source_id, s.name AS source_name, t.name, t.year, ${versionCol}
           FROM ${table} t
           JOIN sources s ON s.id = t.source_id AND s.deleting = 0
          WHERE t.is_hidden = 0 AND t.key IN (${placeholders(keys.length)})`,
        keys,
      );

      const visibleImdb = await filterVisibleVariantRows(catalogDb, filter, rows);
      const offlineRows = await queryOfflineCrossSourceRows(catalogDb, seedSourceId, itemKey);
      const visibleOffline = await filterVisibleVariantRows(catalogDb, filter, offlineRows);
      const seenKeys = new Set(visibleImdb.map((r) => r.key));
      const extraKeys = visibleOffline.filter((r) => !seenKeys.has(r.key)).map((r) => r.key);
      if (extraKeys.length > 0) {
        const extraMatches = await enrichmentStore.getEnrichmentForKeys(extraKeys);
        for (const r of visibleOffline) {
          if (seenKeys.has(r.key)) continue;
          const m = extraMatches.get(r.key);
          if (m !== undefined && isMergeEligible(m) && m.imdbId !== seedMatch.imdbId) {
            continue;
          }
          seenKeys.add(r.key);
          visibleImdb.push(r);
        }
      }
      if (visibleImdb.length > 0) {
        return buildSortedMergedVariants(visibleImdb, enrichmentStore);
      }
    }
  }

  // Offline fallback: merge matching clean-title copies across ALL active sources for movies & series
  const offlineRows = await queryOfflineCrossSourceRows(catalogDb, seedSourceId, itemKey);
  const visibleOffline = await filterVisibleVariantRows(catalogDb, filter, offlineRows);
  return buildSortedMergedVariants(visibleOffline, enrichmentStore);
}

/**
 * Collapses duplicate catalog cards sharing the same verified `imdb_id` (`confidence >= 0.78` or
 * `manual_lock = 1`) on a page into one canonical representative card (selecting the highest-ranked
 * healthy variant, exposing `mergedCount`, and substituting the IMDb `posterUrl` directly so zero
 * IPTV poster is fetched). Unmatched VOD/series cards fall back cleanly to grouping by
 * `parseVodVersion(name, year).groupKey` when non-empty so duplicates merge offline too (`#511`).
 */
export function deduplicateCatalogPageByImdb<T extends ItemRow>(
  items: readonly T[],
  enrichmentByKey: ReadonlyMap<string, ElvItemEnrichment>,
  qualityByKey?: ReadonlyMap<string, ElvQualityMemoryRecord>,
  opts?: DeduplicateCatalogPageOptions,
): DeduplicatedCatalogItem<T>[] {
  const replacePoster = opts?.replacePoster !== false;
  interface GroupBucket {
    readonly imdbId: string | null;
    readonly posterUrl: string | null;
    readonly members: T[];
  }

  const buckets: GroupBucket[] = [];
  const byImdbGroup = new Map<string, GroupBucket>();
  const byOfflineGroup = new Map<string, GroupBucket>();

  for (const item of items) {
    const enrich = enrichmentByKey.get(item.key);
    if (enrich === undefined || !isMergeEligible(enrich)) {
      if (item.kind === 'movie' || item.kind === 'series') {
        const parsed = parseVodVersion(item.name, item.year);
        if (parsed.groupKey.length > 0) {
          const fallbackKey = `${item.kind}:${parsed.groupKey}`;
          const existingOffline = byOfflineGroup.get(fallbackKey);
          if (existingOffline !== undefined) {
            existingOffline.members.push(item);
          } else {
            const created: GroupBucket = { imdbId: null, posterUrl: null, members: [item] };
            byOfflineGroup.set(fallbackKey, created);
            buckets.push(created);
          }
          continue;
        }
      }
      buckets.push({ imdbId: null, posterUrl: null, members: [item] });
      continue;
    }
    const groupKey = `${enrich.mediaType}:${enrich.imdbId}`;
    const posterUrl =
      enrich.title?.posterUrl !== null &&
      enrich.title?.posterUrl !== undefined &&
      enrich.title.posterUrl !== ''
        ? enrich.title.posterUrl
        : null;
    const existing = byImdbGroup.get(groupKey);
    if (existing !== undefined) {
      existing.members.push(item);
    } else {
      const created: GroupBucket = { imdbId: enrich.imdbId, posterUrl, members: [item] };
      byImdbGroup.set(groupKey, created);
      buckets.push(created);
    }
  }

  const out: DeduplicatedCatalogItem<T>[] = [];
  for (const bucket of buckets) {
    if (bucket.members.length === 1 && bucket.imdbId === null) {
      const only = bucket.members[0];
      if (only !== undefined) out.push(only);
      continue;
    }

    let best = bucket.members[0] as T;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const candidate of bucket.members) {
      const q = qualityByKey?.get(candidate.key);
      const parsed = parseVodVersion(candidate.name, candidate.year);
      const score = scoreMergedVariant({
        verifiedResolution: formatVerifiedResolution(q?.actualWidth, q?.actualHeight),
        actualHeight: q?.actualHeight ?? null,
        actualVideoCodec: q?.actualVideoCodec ?? null,
        actualHdr: q?.actualHdr ?? null,
        claimedQualityRank: parsed.qualityRank,
        isFake4k: q?.isFake4k ?? false,
        failCount: q?.failCount ?? 0,
      });
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    out.push({
      ...best,
      ...(replacePoster && bucket.posterUrl !== null ? { logo: bucket.posterUrl } : {}),
      ...(bucket.imdbId !== null ? { imdbId: bucket.imdbId } : {}),
      ...(bucket.members.length > 1
        ? {
            mergedCount: bucket.members.length,
            mergedItemKeys: bucket.members.map((m) => m.key),
          }
        : {}),
    });
  }

  return out;
}
