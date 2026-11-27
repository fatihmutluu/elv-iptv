import type { SqlDriver } from '@elv/domain';
import { listMatchedTitleGenreCandidates } from './elv-enrichment-discovery-queries';
import type {
  ElvEnrichmentStore,
  ElvGenreSummary,
  ElvItemEnrichment,
  ElvMatchRecord,
  ElvMediaType,
  ElvTitleRecord,
} from './elv-enrichment-types';
import { parseStringArray, uniqueNonEmpty } from './elv-enrichment-types';
import { formatVerifiedResolution, scoreMergedVariant } from './elv-quality-memory';
import { isAdultKeywordMatch, parseRatingAge } from './parental-policy';
import { type ActiveParentalFilter, findRestrictedItemKeys } from './parental-repo';
import { type ItemRow, mapItemRow, type RawItemRow } from './queries-shared';
import { parseVodVersion } from './vod-versions';

const IN_CHUNK_SIZE = 400;

/** @internal Logo resolver callback matching `createPlaytimeResolverCache().resolveRowLogos`. */
export type RowLogoResolver = <T extends { sourceId: string; logo: string | null }>(
  rows: T[],
) => Promise<T[]>;

/** @internal Hydrated best playable variant and enrichment record for one IMDb ID. */
export interface HydratedPlayableMatch {
  readonly item: ItemRow;
  readonly enrichment: ElvItemEnrichment;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/** @internal Resolves active (`deleting = 0`) source IDs minus any excluded source IDs. */
export async function loadActiveSourceIds(
  catalogDb: SqlDriver,
  excludedSourceIds?: readonly string[],
): Promise<string[]> {
  const rows = await catalogDb.all<{ id: string }>(
    'SELECT id FROM sources WHERE deleting = 0 ORDER BY id ASC',
  );
  if (rows.length === 0) return [];
  const excluded = new Set(uniqueNonEmpty(excludedSourceIds ?? []));
  const out: string[] = [];
  for (const r of rows) {
    if (!excluded.has(r.id)) out.push(r.id);
  }
  return out;
}

function isTitleBlockedByParental(
  title: Pick<ElvTitleRecord, 'originalTitle' | 'englishTitle' | 'genres'> | null | undefined,
  itemName: string | null,
  maxRatingAge: number | null,
  blockAdultKeywords: boolean,
): boolean {
  const restrictAdult = blockAdultKeywords || (maxRatingAge !== null && maxRatingAge < 18);
  if (!restrictAdult) return false;
  if (itemName !== null && isAdultKeywordMatch(itemName)) return true;
  if (title !== null && title !== undefined) {
    if (isAdultKeywordMatch(title.originalTitle)) return true;
    if (title.englishTitle !== null && isAdultKeywordMatch(title.englishTitle)) return true;
    const lowerGenres = title.genres.map((g) => g.trim().toLowerCase());
    if (lowerGenres.some((g) => g === 'adult' || g === 'erotica' || g === 'erotic')) {
      return true;
    }
    if (
      maxRatingAge !== null &&
      maxRatingAge < 16 &&
      lowerGenres.includes('horror') &&
      !lowerGenres.includes('family') &&
      !lowerGenres.includes('animation')
    ) {
      return true;
    }
  }
  return false;
}

async function loadVodCertifications(
  catalogDb: SqlDriver,
  itemKeys: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (itemKeys.length === 0) return out;
  for (let i = 0; i < itemKeys.length; i += IN_CHUNK_SIZE) {
    const chunk = itemKeys.slice(i, i + IN_CHUNK_SIZE);
    const rows = await catalogDb.all<{ item_key: string; certification: string }>(
      `SELECT item_key, certification FROM vod_enrichment
        WHERE item_key IN (${placeholders(chunk.length)}) AND certification IS NOT NULL`,
      chunk,
    );
    for (const r of rows) out.set(r.item_key, r.certification);
  }
  return out;
}

/**
 * @internal Batch-hydrates playable `ItemRow`s from `catalog.db` for matched IMDb IDs, applies
 * visibility/parental/age filters, and selects the single highest-ranked healthy playable variant
 * per `imdbId` using `elv_quality_memory`.
 */
export async function hydrateBestPlayableMatches(deps: {
  readonly catalogDb: SqlDriver;
  readonly enrichmentStore: ElvEnrichmentStore;
  readonly orderedImdbIds: readonly string[];
  readonly matchesByImdb: ReadonlyMap<string, readonly ElvMatchRecord[]>;
  readonly titleByImdb: ReadonlyMap<string, ElvTitleRecord>;
  readonly kind?: ElvMediaType | undefined;
  readonly excludedItemKeys?: ReadonlySet<string> | undefined;
  readonly excludedSourceIds?: ReadonlySet<string> | undefined;
  readonly parentalFilter: ActiveParentalFilter | null;
  readonly maxRatingAge: number | null;
}): Promise<Map<string, HydratedPlayableMatch>> {
  const {
    catalogDb,
    enrichmentStore,
    orderedImdbIds,
    matchesByImdb,
    titleByImdb,
    kind,
    excludedItemKeys,
    excludedSourceIds,
    parentalFilter,
    maxRatingAge,
  } = deps;

  const movieKeys: string[] = [];
  const seriesKeys: string[] = [];
  const seenKeys = new Set<string>();

  for (const imdbId of orderedImdbIds) {
    const matches = matchesByImdb.get(imdbId);
    if (matches === undefined) continue;
    for (const m of matches) {
      if (kind !== undefined && m.mediaType !== kind) continue;
      if (excludedItemKeys?.has(m.itemKey)) continue;
      if (excludedSourceIds?.has(m.sourceId)) continue;
      if (seenKeys.has(m.itemKey)) continue;
      seenKeys.add(m.itemKey);
      if (m.mediaType === 'series') seriesKeys.push(m.itemKey);
      else movieKeys.push(m.itemKey);
    }
  }

  if (movieKeys.length === 0 && seriesKeys.length === 0) return new Map();

  const itemByKey = new Map<string, ItemRow>();

  const fetchKindRows = async (mediaKind: ElvMediaType, keys: readonly string[]) => {
    const table = mediaKind === 'series' ? 'series' : 'movies';
    const logoCol = mediaKind === 'series' ? 't.cover AS logo' : 't.logo AS logo';
    for (let i = 0; i < keys.length; i += IN_CHUNK_SIZE) {
      const chunk = keys.slice(i, i + IN_CHUNK_SIZE);
      const rows = await catalogDb.all<RawItemRow>(
        `SELECT t.id, t.key, t.source_id, t.provider_id, t.name, ${logoCol}, t.backdrop AS backdrop,
                t.rating, t.year, NULL AS num, NULL AS catchup_days
           FROM ${table} t
           JOIN sources s ON s.id = t.source_id AND s.deleting = 0
          WHERE t.is_hidden = 0 AND t.key IN (${placeholders(chunk.length)})`,
        chunk,
      );
      for (const raw of rows) {
        const mapped = mapItemRow(mediaKind, raw.source_id ?? '', raw);
        itemByKey.set(mapped.key, mapped);
      }
    }
  };

  await Promise.all([
    movieKeys.length > 0 ? fetchKindRows('movie', movieKeys) : Promise.resolve(),
    seriesKeys.length > 0 ? fetchKindRows('series', seriesKeys) : Promise.resolve(),
  ]);

  if (itemByKey.size === 0) return new Map();

  let restrictedKeys = new Set<string>();
  if (parentalFilter !== null) {
    restrictedKeys = await findRestrictedItemKeys(
      catalogDb,
      parentalFilter,
      [...itemByKey.values()].map((item) => ({
        itemKey: item.key,
        sourceId: item.sourceId,
        kind: item.kind,
        title: item.name,
      })),
    );
  }

  const certByKey =
    maxRatingAge !== null ? await loadVodCertifications(catalogDb, [...itemByKey.keys()]) : null;

  const ageBlockedImdbIds = new Set<string>();
  if (maxRatingAge !== null && certByKey !== null && certByKey.size > 0) {
    for (const imdbId of orderedImdbIds) {
      const matches = matchesByImdb.get(imdbId);
      if (matches === undefined) continue;
      for (const m of matches) {
        const cert = certByKey.get(m.itemKey);
        if (cert !== undefined) {
          const age = parseRatingAge(cert);
          if (age !== null && age > maxRatingAge) {
            ageBlockedImdbIds.add(imdbId);
            break;
          }
        }
      }
    }
  }

  const survivingKeys: string[] = [];
  for (const [key, item] of itemByKey) {
    if (restrictedKeys.has(key)) continue;
    if (parentalFilter?.blockAdultKeywords && isAdultKeywordMatch(item.name)) continue;
    if (maxRatingAge !== null) {
      const cert = certByKey?.get(key);
      if (cert !== undefined) {
        const age = parseRatingAge(cert);
        if (age !== null && age > maxRatingAge) continue;
      }
    }
    survivingKeys.push(key);
  }

  if (survivingKeys.length === 0) return new Map();
  const survivingSet = new Set(survivingKeys);
  const qualityByKey = await enrichmentStore.getQualityMemoryForKeys(survivingKeys);

  const out = new Map<string, HydratedPlayableMatch>();
  for (const imdbId of orderedImdbIds) {
    if (out.has(imdbId) || ageBlockedImdbIds.has(imdbId)) continue;
    const matches = matchesByImdb.get(imdbId);
    if (matches === undefined) continue;
    const title = titleByImdb.get(imdbId) ?? null;

    let bestItem: ItemRow | null = null;
    let bestMatch: ElvMatchRecord | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const match of matches) {
      if (kind !== undefined && match.mediaType !== kind) continue;
      if (!survivingSet.has(match.itemKey)) continue;
      const item = itemByKey.get(match.itemKey);
      if (item === undefined) continue;
      if (
        isTitleBlockedByParental(
          title,
          item.name,
          maxRatingAge,
          parentalFilter?.blockAdultKeywords ?? false,
        )
      ) {
        continue;
      }

      const q = qualityByKey.get(item.key);
      const parsed = parseVodVersion(item.name, item.year);
      const variantScore = scoreMergedVariant({
        verifiedResolution: formatVerifiedResolution(q?.actualWidth, q?.actualHeight),
        actualHeight: q?.actualHeight ?? null,
        actualVideoCodec: q?.actualVideoCodec ?? null,
        actualHdr: q?.actualHdr ?? null,
        claimedQualityRank: parsed.qualityRank,
        isFake4k: q?.isFake4k ?? false,
        failCount: q?.failCount ?? 0,
      });

      const isBetter =
        bestItem === null ||
        bestMatch === null ||
        variantScore > bestScore ||
        (variantScore === bestScore &&
          ((match.manualLock ? 1 : 0) > (bestMatch.manualLock ? 1 : 0) ||
            (match.manualLock === bestMatch.manualLock &&
              (match.confidence > bestMatch.confidence ||
                (match.confidence === bestMatch.confidence &&
                  item.key.localeCompare(bestItem.key) < 0)))));
      if (isBetter) {
        bestScore = variantScore;
        bestItem = item;
        bestMatch = match;
      }
    }

    if (bestItem !== null && bestMatch !== null) {
      out.set(imdbId, {
        item: bestItem,
        enrichment: {
          itemKey: bestItem.key,
          sourceId: bestItem.sourceId,
          mediaType: bestMatch.mediaType,
          imdbId,
          confidence: bestMatch.confidence,
          manualLock: bestMatch.manualLock,
          title,
        },
      });
    }
  }

  return out;
}

/**
 * @internal Computes exact visible IMDb genre counts strictly over playable (`is_hidden = 0`,
 * `sources.deleting = 0`) and non-parental-blocked library titles so `listElvImdbGenres` matches
 * `listElvItemsByImdbGenre` 1:1.
 */
export async function computeVisibleImdbGenreCounts(deps: {
  readonly catalogDb: SqlDriver;
  readonly enrichmentStore: ElvEnrichmentStore;
  readonly kind: ElvMediaType;
  readonly activeSourceIds: readonly string[];
  readonly parentalFilter: ActiveParentalFilter | null;
}): Promise<ElvGenreSummary[]> {
  const { catalogDb, enrichmentStore, kind, activeSourceIds, parentalFilter } = deps;
  if (activeSourceIds.length === 0) return [];

  const candidates = await listMatchedTitleGenreCandidates(enrichmentStore.driver, kind, {
    allowedSourceIds: activeSourceIds,
  });
  if (candidates.length === 0) return [];

  interface GroupedTitle {
    readonly originalTitle: string;
    readonly englishTitle: string | null;
    readonly genres: readonly string[];
    readonly itemKeys: string[];
  }
  const byImdb = new Map<string, GroupedTitle>();
  const allItemKeys: string[] = [];
  const seenItemKeys = new Set<string>();

  for (const row of candidates) {
    if (!seenItemKeys.has(row.item_key)) {
      seenItemKeys.add(row.item_key);
      allItemKeys.push(row.item_key);
    }
    let group = byImdb.get(row.imdb_id);
    if (group === undefined) {
      group = {
        originalTitle: row.original_title,
        englishTitle: row.english_title,
        genres: uniqueNonEmpty(parseStringArray(row.genres_json)),
        itemKeys: [],
      };
      byImdb.set(row.imdb_id, group);
    }
    group.itemKeys.push(row.item_key);
  }

  const table = kind === 'series' ? 'series' : 'movies';
  const visibleItems = new Map<string, { key: string; sourceId: string; name: string }>();
  for (let i = 0; i < allItemKeys.length; i += IN_CHUNK_SIZE) {
    const chunk = allItemKeys.slice(i, i + IN_CHUNK_SIZE);
    const rows = await catalogDb.all<{ key: string; source_id: string; name: string }>(
      `SELECT t.key, t.source_id, t.name
         FROM ${table} t
         JOIN sources s ON s.id = t.source_id AND s.deleting = 0
        WHERE t.is_hidden = 0 AND t.key IN (${placeholders(chunk.length)})`,
      chunk,
    );
    for (const r of rows) {
      visibleItems.set(r.key, { key: r.key, sourceId: r.source_id, name: r.name });
    }
  }
  if (visibleItems.size === 0) return [];

  const maxRatingAge = parentalFilter?.maxRatingAge ?? null;
  const blockAdultKeywords = parentalFilter?.blockAdultKeywords ?? false;

  let restrictedKeys = new Set<string>();
  if (parentalFilter !== null) {
    restrictedKeys = await findRestrictedItemKeys(
      catalogDb,
      parentalFilter,
      [...visibleItems.values()].map((item) => ({
        itemKey: item.key,
        sourceId: item.sourceId,
        kind,
        title: item.name,
      })),
    );
  }

  const certByKey =
    maxRatingAge !== null ? await loadVodCertifications(catalogDb, [...visibleItems.keys()]) : null;

  const counts = new Map<string, number>();
  for (const group of byImdb.values()) {
    if (group.genres.length === 0) continue;
    if (isTitleBlockedByParental(group, null, maxRatingAge, blockAdultKeywords)) continue;

    if (maxRatingAge !== null && certByKey !== null && certByKey.size > 0) {
      let ageBlocked = false;
      for (const itemKey of group.itemKeys) {
        const cert = certByKey.get(itemKey);
        if (cert !== undefined) {
          const age = parseRatingAge(cert);
          if (age !== null && age > maxRatingAge) {
            ageBlocked = true;
            break;
          }
        }
      }
      if (ageBlocked) continue;
    }

    let hasVisiblePlayable = false;
    for (const itemKey of group.itemKeys) {
      const item = visibleItems.get(itemKey);
      if (item === undefined) continue;
      if (restrictedKeys.has(itemKey)) continue;
      if (isTitleBlockedByParental(group, item.name, maxRatingAge, blockAdultKeywords)) continue;
      hasVisiblePlayable = true;
      break;
    }
    if (!hasVisiblePlayable) continue;

    for (const genre of group.genres) {
      counts.set(genre, (counts.get(genre) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([genre, itemCount]) => ({ genre, itemCount }))
    .sort((a, b) => b.itemCount - a.itemCount || a.genre.localeCompare(b.genre));
}

/** @internal Resolves M3U template logos on `ItemRow`s when a resolver is supplied. */
export async function resolveItemsLogos(
  items: ItemRow[],
  resolveRowLogos: RowLogoResolver | undefined,
): Promise<ItemRow[]> {
  if (resolveRowLogos === undefined || items.length === 0) return items;
  return resolveRowLogos(items);
}
