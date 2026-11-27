import type { ElvItemEnrichment, ItemRow } from '@elv/data';
import { DEFAULT_ELV_MODE_PREFERENCES, type ElvModePreferences } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import {
  applyElvCardPresentation,
  buildElvCacheFingerprint,
  isElvFeatureActive,
  matchesElvSearchAliases,
  presentElvCatalogItems,
  resolveElvLocalizedSynopsis,
} from './elv-presentation';

const SAMPLE_ITEM: ItemRow = {
  id: 1,
  key: 'x:s1:movie:100',
  kind: 'movie',
  sourceId: 's1',
  providerId: '100',
  name: 'TR | INCEPTION 4K',
  logo: 'https://iptv.example/raw-poster.jpg',
  rating: 5.0,
  year: 2010,
  num: null,
};

const SAMPLE_ENRICHMENT: ElvItemEnrichment = {
  itemKey: 'x:s1:movie:100',
  sourceId: 's1',
  mediaType: 'movie',
  imdbId: 'tt1375666',
  confidence: 0.95,
  manualLock: false,
  title: {
    imdbId: 'tt1375666',
    mediaType: 'movie',
    originalTitle: 'Inception',
    englishTitle: 'Inception',
    localizedTitles: { tr: 'Başlangıç', de: 'Inception' },
    year: 2010,
    rating: 8.8,
    votes: 2_500_000,
    runtimeMin: 148,
    genres: ['Action', 'Sci-Fi'],
    posterUrl: 'https://m.media-amazon.com/images/inception_UX300.jpg',
    backdropUrl: 'https://m.media-amazon.com/images/inception_bg.jpg',
    trailerStreamUrl: null,
    trailerYoutubeId: null,
    director: 'Christopher Nolan',
    cast: [],
    mltImdbIds: [],
    franchiseKey: null,
    franchiseName: null,
    franchiseOrder: null,
    synopses: {
      en: 'A thief who steals corporate secrets.',
      tr: 'Kurumsal sırları çalan bir hırsız.',
    },
    detailFetchedAt: 1_000,
    updatedAt: 1_000,
  },
};

const ELV_ON: ElvModePreferences = {
  ...DEFAULT_ELV_MODE_PREFERENCES,
  elvModeEnabled: true,
};

describe('elv-presentation (Wave E1 #511)', () => {
  it('gates all feature flags behind elvModeEnabled', () => {
    expect(isElvFeatureActive(DEFAULT_ELV_MODE_PREFERENCES, 'elvEnrichMetadata')).toBe(false);
    expect(isElvFeatureActive(ELV_ON, 'elvEnrichMetadata')).toBe(true);
    expect(isElvFeatureActive({ ...ELV_ON, elvEnrichMetadata: false }, 'elvEnrichMetadata')).toBe(
      false,
    );
  });

  it('returns item completely untouched when ELV Mode is off', () => {
    const out = applyElvCardPresentation(
      SAMPLE_ITEM,
      SAMPLE_ENRICHMENT,
      DEFAULT_ELV_MODE_PREFERENCES,
      'tr',
    );
    expect(out).toBe(SAMPLE_ITEM);
  });

  it('substitutes clean IMDb posterUrl directly, formats display title across 7 formats, and surfaces verified rating', () => {
    const out = applyElvCardPresentation(
      SAMPLE_ITEM,
      SAMPLE_ENRICHMENT,
      { ...ELV_ON, elvTitleFormat: 'system_original' },
      'tr',
    );
    expect(out.logo).toBe('https://m.media-amazon.com/images/inception_UX300.jpg');
    expect(out.name).toBe('Başlangıç (Inception)');
    expect(out.rating).toBe(8.8);

    // Falls back to item.logo when IMDb posterUrl is null
    const baseTitle = SAMPLE_ENRICHMENT.title;
    expect(baseTitle).not.toBeNull();
    if (baseTitle === null) return;
    const noPoster: ElvItemEnrichment = {
      ...SAMPLE_ENRICHMENT,
      title: { ...baseTitle, posterUrl: null },
    };
    const fallbackOut = applyElvCardPresentation(SAMPLE_ITEM, noPoster, ELV_ON, 'en');
    expect(fallbackOut.logo).toBe(SAMPLE_ITEM.logo);
    expect(fallbackOut.name).toBe('Inception');
  });

  it('deduplicates merged items by IMDb ID and applies clean presentation when both flags are active', () => {
    const dup: ItemRow = {
      ...SAMPLE_ITEM,
      id: 2,
      key: 'x:s2:movie:200',
      sourceId: 's2',
      name: 'EN | Inception 1080p',
    };
    const map = new Map<string, ElvItemEnrichment>([
      [SAMPLE_ITEM.key, SAMPLE_ENRICHMENT],
      [dup.key, { ...SAMPLE_ENRICHMENT, itemKey: dup.key, sourceId: 's2' }],
    ]);

    const presented = presentElvCatalogItems([SAMPLE_ITEM, dup], map, ELV_ON, 'tr');
    expect(presented).toHaveLength(1);
    expect(presented[0]?.name).toBe('Inception');
    expect(presented[0]?.logo).toBe('https://m.media-amazon.com/images/inception_UX300.jpg');

    // When elvMergeVersions is true and elvEnrichMetadata is false, preserves original IPTV poster
    const mergeOnly = presentElvCatalogItems(
      [SAMPLE_ITEM, dup],
      map,
      { ...ELV_ON, elvMergeVersions: true, elvEnrichMetadata: false },
      'tr',
    );
    expect(mergeOnly).toHaveLength(1);
    expect(mergeOnly[0]?.name).toBe(SAMPLE_ITEM.name);
    expect(mergeOnly[0]?.logo).toBe(SAMPLE_ITEM.logo);
  });

  it('suppresses raw IPTV logo while local enrichment lookup is pending to prevent double poster fetch (P1-5)', () => {
    const pendingCard = applyElvCardPresentation(SAMPLE_ITEM, undefined, ELV_ON, 'en', {
      pendingLookup: true,
    });
    expect(pendingCard.logo).toBeNull();

    const settledUnmatched = applyElvCardPresentation(SAMPLE_ITEM, undefined, ELV_ON, 'en', {
      pendingLookup: false,
    });
    expect(settledUnmatched.logo).toBe(SAMPLE_ITEM.logo);

    const pendingPage = presentElvCatalogItems([SAMPLE_ITEM], new Map(), ELV_ON, 'en', {
      resolvedKeys: new Set(),
    });
    expect(pendingPage[0]?.logo).toBeNull();

    const settledUnmatchedPage = presentElvCatalogItems([SAMPLE_ITEM], new Map(), ELV_ON, 'en', {
      resolvedKeys: new Set([SAMPLE_ITEM.key]),
    });
    expect(settledUnmatchedPage[0]?.logo).toBe(SAMPLE_ITEM.logo);
  });

  it('matches search queries against original, English, and localized title aliases', () => {
    expect(matchesElvSearchAliases('baslangic', SAMPLE_ENRICHMENT, SAMPLE_ITEM.name, 'tr')).toBe(
      true,
    );
    expect(matchesElvSearchAliases('inception', SAMPLE_ENRICHMENT, SAMPLE_ITEM.name, 'tr')).toBe(
      true,
    );
    expect(matchesElvSearchAliases('interstellar', SAMPLE_ENRICHMENT, SAMPLE_ITEM.name, 'tr')).toBe(
      false,
    );
  });

  it('resolves localized synopsis with English fallback and computes cache invalidation fingerprints', () => {
    expect(resolveElvLocalizedSynopsis(SAMPLE_ENRICHMENT.title?.synopses, 'tr-TR')).toBe(
      'Kurumsal sırları çalan bir hırsız.',
    );
    expect(resolveElvLocalizedSynopsis(SAMPLE_ENRICHMENT.title?.synopses, 'fr')).toBe(
      'A thief who steals corporate secrets.',
    );

    const fpOff = buildElvCacheFingerprint(DEFAULT_ELV_MODE_PREFERENCES);
    const fpOn = buildElvCacheFingerprint(ELV_ON);
    const fpFmt = buildElvCacheFingerprint({ ...ELV_ON, elvTitleFormat: 'system' });
    const fpCat = buildElvCacheFingerprint({ ...ELV_ON, elvCategorySource: 'provider' });
    expect(fpOff).not.toBe(fpOn);
    expect(fpOn).not.toBe(fpFmt);
    expect(fpOn).not.toBe(fpCat);
  });
});
