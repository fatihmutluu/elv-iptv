import type { SqlDriver } from '@elv/domain';
import type {
  ElvEnrichmentStore,
  ElvItemEnrichment,
  ElvQualityMemoryRecord,
} from './elv-enrichment-repo';
import { formatVerifiedResolution, scoreMergedVariant } from './elv-quality-memory';
import { isAdultKeywordMatch, type ParentalQueryOptions } from './parental-policy';
import {
  findRestrictedItemKeys,
  isItemRestricted,
  loadActiveParentalFilter,
} from './parental-repo';
import { type ItemRow, resolveQueryProfileId, sourceOfKey } from './queries-shared';
import { queryItemVersions } from './queries-variants';
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

      let visibleRows = rows;
      if (filter !== null && visibleRows.length > 0) {
        const restricted = await findRestrictedItemKeys(
          catalogDb,
          filter,
          visibleRows.map((r) => ({ itemKey: r.key })),
        );
        visibleRows = visibleRows.filter(
          (r) =>
            !restricted.has(r.key) && !(filter.blockAdultKeywords && isAdultKeywordMatch(r.name)),
        );
      }

      if (visibleRows.length > 0) {
        const qualityMap = await enrichmentStore.getQualityMemoryForKeys(
          visibleRows.map((r) => r.key),
        );
        return sortMergedVariants(
          visibleRows.map((r) =>
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
    }
  }

  // Fallback: single-source version grouping via queryItemVersions (movies) or single series row
  const singleSourceVersions = await queryItemVersions(catalogDb, itemKey, opts);
  const srcRow = (
    await catalogDb.all<{ name: string }>(
      'SELECT name FROM sources WHERE id = ? AND deleting = 0 LIMIT 1',
      [seedSourceId],
    )
  )[0];
  const sourceName = srcRow?.name ?? seedSourceId;

  if (singleSourceVersions.length > 0) {
    const qualityMap =
      enrichmentStore === undefined
        ? new Map<string, ElvQualityMemoryRecord>()
        : await enrichmentStore.getQualityMemoryForKeys(singleSourceVersions.map((v) => v.key));
    return sortMergedVariants(
      singleSourceVersions.map((v) =>
        toMergedVariant(
          {
            itemKey: v.key,
            sourceId: seedSourceId,
            sourceName,
            rawTitle: v.title,
            year: v.year,
            storedVersionLabel: v.versionLabel,
          },
          qualityMap.get(v.key),
        ),
      ),
    );
  }

  // Fallback for unmatched series item
  const seriesRows = await catalogDb.all<{ key: string; name: string; year: number | null }>(
    `SELECT sr.key, sr.name, sr.year
       FROM series sr
       JOIN sources s ON s.id = sr.source_id AND s.deleting = 0
      WHERE sr.source_id = ? AND sr.key = ? AND sr.is_hidden = 0 LIMIT 1`,
    [seedSourceId, itemKey],
  );
  const sr = seriesRows[0];
  if (sr === undefined) return [];
  const quality =
    enrichmentStore === undefined
      ? undefined
      : ((await enrichmentStore.getQualityMemory(sr.key)) ?? undefined);
  return [
    toMergedVariant(
      {
        itemKey: sr.key,
        sourceId: seedSourceId,
        sourceName,
        rawTitle: sr.name,
        year: sr.year,
        storedVersionLabel: null,
      },
      quality,
    ),
  ];
}

/**
 * Collapses duplicate catalog cards sharing the same verified `imdb_id` (`confidence >= 0.78` or
 * `manual_lock = 1`) on a page into one canonical representative card (selecting the highest-ranked
 * healthy variant, exposing `mergedCount`, and substituting the IMDb `posterUrl` directly so zero
 * IPTV poster is fetched). Unmatched items pass through unchanged (`#511`).
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

  for (const item of items) {
    const enrich = enrichmentByKey.get(item.key);
    if (enrich === undefined || !isMergeEligible(enrich)) {
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
    if (bucket.imdbId === null) {
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
      imdbId: bucket.imdbId,
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
