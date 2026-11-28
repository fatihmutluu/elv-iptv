import {
  cleanVodTitle,
  deduplicateCatalogPageByImdb,
  type ElvItemEnrichment,
  foldText,
  type ItemRow,
} from '@elv/data';
import {
  collectElvSearchAliases,
  type ElvModePreferences,
  formatElvDisplayTitle,
} from '@elv/domain';

/** Individual boolean feature flags gated behind the master `elvModeEnabled` switch (`#511`). */
type ElvBooleanFeatureFlag =
  | 'elvMergeVersions'
  | 'elvEnrichMetadata'
  | 'elvSmartRecommendations'
  | 'elvLiveEnhance'
  | 'elvVerifyRealQuality';

/** Returns `true` only when the master ELV Mode switch AND the specific `flag` are both enabled. */
export function isElvFeatureActive(
  prefs: Pick<ElvModePreferences, 'elvModeEnabled' | ElvBooleanFeatureFlag>,
  flag: ElvBooleanFeatureFlag,
): boolean {
  return prefs.elvModeEnabled && prefs[flag];
}

/** Resolves a localized string entry for `locale` (exact or base language prefix). */
export function resolveElvLocalizedValue(
  map: Readonly<Record<string, string>> | undefined,
  locale: string,
): string | null {
  if (map === undefined) return null;
  const normalized = locale.trim().toLowerCase();
  if (normalized === '') return null;
  const exact = map[normalized]?.trim();
  if (exact !== undefined && exact.length > 0) return exact;
  const base = normalized.split(/[-_]/)[0];
  if (base !== undefined && base !== normalized) {
    const baseHit = map[base]?.trim();
    if (baseHit !== undefined && baseHit.length > 0) return baseHit;
  }
  return null;
}

/** Resolves the localized synopsis for `locale`, falling back to English when unavailable. */
export function resolveElvLocalizedSynopsis(
  synopses: Readonly<Record<string, string>> | undefined,
  locale: string,
): string | null {
  if (synopses === undefined) return null;
  const localized = resolveElvLocalizedValue(synopses, locale);
  if (localized !== null) return localized;
  const english = synopses.en?.trim();
  return english !== undefined && english.length > 0 ? english : null;
}

/** Options for {@link applyElvCardPresentation}. */
export interface ApplyElvCardPresentationOptions {
  /**
   * When `true` (local `getElvEnrichmentForKeys` lookup has not settled yet), suppresses the raw
   * IPTV `item.logo` (`logo: null`) so `<ArtworkImage>` never fires a throwaway HTTP request
   * before IMDb artwork arrives (`#511`).
   */
  readonly pendingLookup?: boolean;
}

/** Options for {@link presentElvCatalogItems}. */
export interface PresentElvCatalogItemsOptions {
  /** Keys whose initial local SQLite enrichment lookup has settled (`#511`). */
  readonly resolvedKeys?: ReadonlySet<string>;
  /** Optional predicate overriding `resolvedKeys` to check whether a key's local lookup is pending. */
  readonly isKeyLookupPending?: (key: string) => boolean;
}

/**
 * Non-destructively transforms a catalog item card using cached ELV Mode IMDb metadata (`#511`):
 * - Substitutes `enrichment.title.posterUrl` directly as `logo` so `<ArtworkImage>` never
 *   double-fetches the raw IPTV poster, falling back to `item.logo` only when `posterUrl` is null.
 * - While `opts.pendingLookup === true`, yields `logo: null` (clean skeleton frame) until local
 *   SQLite enrichment lookup resolves.
 * - Formats `name` using `formatElvDisplayTitle` across all 7 title formats.
 * - Surfaces verified IMDb `rating` and `year`.
 * - Returns `item` completely untouched when ELV Mode metadata enrichment is off or unmatched.
 */
export function applyElvCardPresentation<T extends ItemRow>(
  item: T,
  enrichment: ElvItemEnrichment | undefined,
  prefs: ElvModePreferences,
  locale: string,
  opts?: ApplyElvCardPresentationOptions,
): T {
  if (!isElvFeatureActive(prefs, 'elvEnrichMetadata')) return item;
  const titleRec = enrichment?.title;
  if (titleRec === null || titleRec === undefined) {
    const cleaned = cleanVodTitle(item.name, item.year);
    const cleanName = cleaned.cleanTitle.length > 0 ? cleaned.cleanTitle : item.name;
    const cleanYear = item.year ?? cleaned.releaseYear;
    const cleanLogo = opts?.pendingLookup === true ? null : item.logo;
    if (cleanName === item.name && cleanLogo === item.logo && cleanYear === item.year) {
      return item;
    }
    return {
      ...item,
      name: cleanName,
      logo: cleanLogo,
      year: cleanYear,
    };
  }

  const localizedTitle = resolveElvLocalizedValue(titleRec.localizedTitles, locale);
  const formattedName = formatElvDisplayTitle({
    originalTitle: titleRec.originalTitle,
    englishTitle: titleRec.englishTitle,
    localizedTitle,
    fallbackTitle: item.name,
    format: prefs.elvTitleFormat,
  });
  const cleanLogo =
    titleRec.posterUrl !== null && titleRec.posterUrl.trim() !== ''
      ? titleRec.posterUrl
      : item.logo;
  const verifiedRating =
    titleRec.rating !== null && Number.isFinite(titleRec.rating) ? titleRec.rating : item.rating;
  const verifiedYear =
    titleRec.year !== null && Number.isFinite(titleRec.year) ? titleRec.year : item.year;

  if (
    formattedName === item.name &&
    cleanLogo === item.logo &&
    verifiedRating === item.rating &&
    verifiedYear === item.year
  ) {
    return item;
  }

  return {
    ...item,
    name: formattedName,
    logo: cleanLogo,
    rating: verifiedRating,
    year: verifiedYear,
  };
}

/**
 * Applies optional ELV Mode IMDb deduplication (`elvMergeVersions`) and clean poster/title
 * presentation (`elvEnrichMetadata`) to a page of catalog items in one pure pass (`#511`).
 */
export function presentElvCatalogItems<T extends ItemRow>(
  items: readonly T[],
  enrichmentByKey: ReadonlyMap<string, ElvItemEnrichment>,
  prefs: ElvModePreferences,
  locale: string,
  opts?: PresentElvCatalogItemsOptions,
): readonly T[] {
  if (!prefs.elvModeEnabled || items.length === 0) return items;
  const enrichActive = isElvFeatureActive(prefs, 'elvEnrichMetadata');
  const mergeActive = isElvFeatureActive(prefs, 'elvMergeVersions');
  if (!enrichActive && !mergeActive) return items;

  const merged: readonly T[] = mergeActive
    ? deduplicateCatalogPageByImdb(items, enrichmentByKey, undefined, {
        replacePoster: enrichActive,
      })
    : items;
  if (!enrichActive) return merged;
  return merged.map((item) => {
    const pendingLookup =
      opts?.isKeyLookupPending !== undefined
        ? opts.isKeyLookupPending(item.key)
        : opts?.resolvedKeys !== undefined
          ? !opts.resolvedKeys.has(item.key)
          : false;
    return applyElvCardPresentation(item, enrichmentByKey.get(item.key), prefs, locale, {
      pendingLookup,
    });
  });
}

/**
 * Checks whether a user search query matches any of an item's ELV Mode aliases
 * (original, English, localized, and fallback titles) using Turkish-tolerant folding (`#511`).
 */
export function matchesElvSearchAliases(
  query: string,
  enrichment: ElvItemEnrichment | undefined,
  fallbackTitle: string,
  locale: string,
): boolean {
  const foldedQuery = foldText(query);
  if (foldedQuery === '') return false;
  const titleRec = enrichment?.title;
  const aliases = collectElvSearchAliases({
    originalTitle: titleRec?.originalTitle,
    englishTitle: titleRec?.englishTitle,
    localizedTitle: resolveElvLocalizedValue(titleRec?.localizedTitles, locale),
    fallbackTitle,
  });
  return aliases.some((alias) => foldText(alias).includes(foldedQuery));
}

/**
 * Deterministic cache-invalidation fingerprint for ELV Mode display & grouping preferences (`#511`).
 * Changing any ELV Mode presentation or grouping toggle invalidates `CatalogUiCache` cleanly.
 */
export function buildElvCacheFingerprint(prefs: ElvModePreferences): string {
  if (!prefs.elvModeEnabled) return 'elv:0';
  return `elv:1:${prefs.elvMergeVersions ? 1 : 0}${prefs.elvEnrichMetadata ? 1 : 0}:${prefs.elvTitleFormat}:${prefs.elvCategorySource}`;
}
