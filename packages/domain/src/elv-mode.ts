/** Supported ELV Mode title display formats for VOD and Series (`#511`). */
export const ELV_TITLE_FORMATS = [
  'original',
  'system',
  'english',
  'english_system',
  'original_system',
  'system_english',
  'system_original',
] as const;

/** User-selectable ELV Mode title display format (`#511`). */
export type ElvTitleFormat = (typeof ELV_TITLE_FORMATS)[number];

/** Supported ELV Mode category grouping sources (`#511`). */
export const ELV_CATEGORY_SOURCES = ['imdb', 'provider'] as const;

/** User-selectable ELV Mode category source (`#511`). */
export type ElvCategorySource = (typeof ELV_CATEGORY_SOURCES)[number];

/** User-configurable ELV Mode preferences (`#511`). */
export interface ElvModePreferences {
  readonly elvModeEnabled: boolean;
  readonly elvMergeVersions: boolean;
  readonly elvEnrichMetadata: boolean;
  readonly elvTitleFormat: ElvTitleFormat;
  readonly elvCategorySource: ElvCategorySource;
  readonly elvSmartRecommendations: boolean;
  readonly elvXrayEnabled: boolean;
  readonly elvLiveEnhance: boolean;
  readonly elvVerifyRealQuality: boolean;
}

/** Default ELV Mode preferences (`elvModeEnabled` is false in raw defaults; onboarding enables it). */
export const DEFAULT_ELV_MODE_PREFERENCES: ElvModePreferences = Object.freeze({
  elvModeEnabled: false,
  elvMergeVersions: true,
  elvEnrichMetadata: true,
  elvTitleFormat: 'original',
  elvCategorySource: 'imdb',
  elvSmartRecommendations: true,
  elvXrayEnabled: true,
  elvLiveEnhance: true,
  elvVerifyRealQuality: true,
});

/** Input to {@link formatElvDisplayTitle}. */
export interface ElvDisplayTitleInput {
  readonly originalTitle?: string | null | undefined;
  readonly englishTitle?: string | null | undefined;
  readonly localizedTitle?: string | null | undefined;
  readonly fallbackTitle: string;
  readonly format: ElvTitleFormat;
}

/** Input to {@link collectElvSearchAliases}. */
export interface ElvSearchAliasesInput {
  readonly originalTitle?: string | null | undefined;
  readonly englishTitle?: string | null | undefined;
  readonly localizedTitle?: string | null | undefined;
  readonly fallbackTitle?: string | null | undefined;
}

/** Returns true when `value` is a supported {@link ElvTitleFormat}. */
export function isElvTitleFormat(value: unknown): value is ElvTitleFormat {
  return typeof value === 'string' && (ELV_TITLE_FORMATS as readonly string[]).includes(value);
}

/** Returns true when `value` is a supported {@link ElvCategorySource}. */
export function isElvCategorySource(value: unknown): value is ElvCategorySource {
  return typeof value === 'string' && (ELV_CATEGORY_SOURCES as readonly string[]).includes(value);
}

function cleanTitle(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function foldTitle(value: string): string {
  return value
    .replace(/\u0130/g, 'i')
    .replace(/I/g, 'i')
    .replace(/\u0131/g, 'i')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function combineTitles(primary: string, secondary: string | undefined): string {
  if (secondary === undefined) return primary;
  const foldedPrimary = foldTitle(primary);
  const foldedSecondary = foldTitle(secondary);
  if (foldedSecondary.length === 0 || foldedPrimary === foldedSecondary) {
    return primary;
  }
  return `${primary} (${secondary})`;
}

/**
 * Formats a VOD or Series title according to the chosen {@link ElvTitleFormat},
 * eliding the parenthetical secondary title whenever both fold identically.
 */
export function formatElvDisplayTitle(input: ElvDisplayTitleInput): string {
  const orig = cleanTitle(input.originalTitle);
  const eng = cleanTitle(input.englishTitle);
  const loc = cleanTitle(input.localizedTitle);
  const fallback = cleanTitle(input.fallbackTitle) ?? '';

  switch (input.format) {
    case 'original':
      return orig ?? eng ?? loc ?? fallback;
    case 'system':
      return loc ?? eng ?? orig ?? fallback;
    case 'english':
      return eng ?? orig ?? loc ?? fallback;
    case 'english_system':
      return combineTitles(eng ?? orig ?? loc ?? fallback, loc);
    case 'original_system':
      return combineTitles(orig ?? eng ?? loc ?? fallback, loc);
    case 'system_english':
      return combineTitles(loc ?? eng ?? orig ?? fallback, eng);
    case 'system_original':
      return combineTitles(loc ?? orig ?? eng ?? fallback, orig);
  }
}

/**
 * Returns deduplicated, non-empty search aliases across original, English, localized,
 * and fallback titles so search matches every title variant together.
 */
export function collectElvSearchAliases(input: ElvSearchAliasesInput): readonly string[] {
  const candidates = [
    input.originalTitle,
    input.englishTitle,
    input.localizedTitle,
    input.fallbackTitle,
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of candidates) {
    const cleaned = cleanTitle(raw);
    if (cleaned === undefined) continue;
    const key = foldTitle(cleaned);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return Object.freeze(out);
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function parseElvModePreferences(
  parsed: Record<string, unknown>,
  defaults: ElvModePreferences,
): ElvModePreferences {
  return {
    elvModeEnabled: boolOr(parsed.elvModeEnabled, defaults.elvModeEnabled),
    elvMergeVersions: boolOr(parsed.elvMergeVersions, defaults.elvMergeVersions),
    elvEnrichMetadata: boolOr(parsed.elvEnrichMetadata, defaults.elvEnrichMetadata),
    elvTitleFormat: isElvTitleFormat(parsed.elvTitleFormat)
      ? parsed.elvTitleFormat
      : defaults.elvTitleFormat,
    elvCategorySource: isElvCategorySource(parsed.elvCategorySource)
      ? parsed.elvCategorySource
      : defaults.elvCategorySource,
    elvSmartRecommendations: boolOr(
      parsed.elvSmartRecommendations,
      defaults.elvSmartRecommendations,
    ),
    elvXrayEnabled: boolOr(parsed.elvXrayEnabled, defaults.elvXrayEnabled),
    elvLiveEnhance: boolOr(parsed.elvLiveEnhance, defaults.elvLiveEnhance),
    elvVerifyRealQuality: boolOr(parsed.elvVerifyRealQuality, defaults.elvVerifyRealQuality),
  };
}

export function serializeElvModePreferences(
  snapshot: ElvModePreferences,
  defaults: ElvModePreferences,
): Partial<ElvModePreferences> {
  const elvModeEnabled = Boolean(snapshot.elvModeEnabled);
  const elvMergeVersions = Boolean(snapshot.elvMergeVersions);
  const elvEnrichMetadata = Boolean(snapshot.elvEnrichMetadata);
  const elvTitleFormat = isElvTitleFormat(snapshot.elvTitleFormat)
    ? snapshot.elvTitleFormat
    : defaults.elvTitleFormat;
  const elvCategorySource = isElvCategorySource(snapshot.elvCategorySource)
    ? snapshot.elvCategorySource
    : defaults.elvCategorySource;
  const elvSmartRecommendations = Boolean(snapshot.elvSmartRecommendations);
  const elvXrayEnabled = Boolean(snapshot.elvXrayEnabled);
  const elvLiveEnhance = Boolean(snapshot.elvLiveEnhance);
  const elvVerifyRealQuality = Boolean(snapshot.elvVerifyRealQuality);

  return {
    ...(elvModeEnabled === defaults.elvModeEnabled ? {} : { elvModeEnabled }),
    ...(elvMergeVersions === defaults.elvMergeVersions ? {} : { elvMergeVersions }),
    ...(elvEnrichMetadata === defaults.elvEnrichMetadata ? {} : { elvEnrichMetadata }),
    ...(elvTitleFormat === defaults.elvTitleFormat ? {} : { elvTitleFormat }),
    ...(elvCategorySource === defaults.elvCategorySource ? {} : { elvCategorySource }),
    ...(elvSmartRecommendations === defaults.elvSmartRecommendations
      ? {}
      : { elvSmartRecommendations }),
    ...(elvXrayEnabled === defaults.elvXrayEnabled ? {} : { elvXrayEnabled }),
    ...(elvLiveEnhance === defaults.elvLiveEnhance ? {} : { elvLiveEnhance }),
    ...(elvVerifyRealQuality === defaults.elvVerifyRealQuality ? {} : { elvVerifyRealQuality }),
  };
}

export function mergeElvModePreferences(
  base: ElvModePreferences,
  patch: Partial<ElvModePreferences>,
): ElvModePreferences {
  return {
    elvModeEnabled: boolOr(patch.elvModeEnabled, base.elvModeEnabled),
    elvMergeVersions: boolOr(patch.elvMergeVersions, base.elvMergeVersions),
    elvEnrichMetadata: boolOr(patch.elvEnrichMetadata, base.elvEnrichMetadata),
    elvTitleFormat: isElvTitleFormat(patch.elvTitleFormat)
      ? patch.elvTitleFormat
      : base.elvTitleFormat,
    elvCategorySource: isElvCategorySource(patch.elvCategorySource)
      ? patch.elvCategorySource
      : base.elvCategorySource,
    elvSmartRecommendations: boolOr(patch.elvSmartRecommendations, base.elvSmartRecommendations),
    elvXrayEnabled: boolOr(patch.elvXrayEnabled, base.elvXrayEnabled),
    elvLiveEnhance: boolOr(patch.elvLiveEnhance, base.elvLiveEnhance),
    elvVerifyRealQuality: boolOr(patch.elvVerifyRealQuality, base.elvVerifyRealQuality),
  };
}
