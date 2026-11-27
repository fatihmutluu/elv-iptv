import { describe, expect, it } from 'vitest';
import {
  collectElvSearchAliases,
  DEFAULT_ELV_MODE_PREFERENCES,
  ELV_CATEGORY_SOURCES,
  ELV_TITLE_FORMATS,
  formatElvDisplayTitle,
  isElvCategorySource,
  isElvTitleFormat,
} from './index';

describe('ELV Mode title formatter & aliases', () => {
  it('exposes the 7 title formats, 2 category sources, and type guards', () => {
    expect(ELV_TITLE_FORMATS).toEqual([
      'original',
      'system',
      'english',
      'english_system',
      'original_system',
      'system_english',
      'system_original',
    ]);
    expect(ELV_CATEGORY_SOURCES).toEqual(['imdb', 'provider']);

    for (const fmt of ELV_TITLE_FORMATS) {
      expect(isElvTitleFormat(fmt)).toBe(true);
    }
    expect(isElvTitleFormat('bogus')).toBe(false);
    expect(isElvTitleFormat(42)).toBe(false);
    expect(isElvTitleFormat(null)).toBe(false);

    expect(isElvCategorySource('imdb')).toBe(true);
    expect(isElvCategorySource('provider')).toBe(true);
    expect(isElvCategorySource('tmdb')).toBe(false);
    expect(isElvCategorySource(undefined)).toBe(false);

    expect(DEFAULT_ELV_MODE_PREFERENCES).toEqual({
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
  });

  it('formats all 7 title formats when original, English, and localized titles are distinct', () => {
    const base = {
      originalTitle: 'La Casa de Papel',
      englishTitle: 'Money Heist',
      localizedTitle: 'Kağıt Ev',
      fallbackTitle: 'TR | La Casa de Papel 4K',
    };

    expect(formatElvDisplayTitle({ ...base, format: 'original' })).toBe('La Casa de Papel');
    expect(formatElvDisplayTitle({ ...base, format: 'system' })).toBe('Kağıt Ev');
    expect(formatElvDisplayTitle({ ...base, format: 'english' })).toBe('Money Heist');
    expect(formatElvDisplayTitle({ ...base, format: 'english_system' })).toBe(
      'Money Heist (Kağıt Ev)',
    );
    expect(formatElvDisplayTitle({ ...base, format: 'original_system' })).toBe(
      'La Casa de Papel (Kağıt Ev)',
    );
    expect(formatElvDisplayTitle({ ...base, format: 'system_english' })).toBe(
      'Kağıt Ev (Money Heist)',
    );
    expect(formatElvDisplayTitle({ ...base, format: 'system_original' })).toBe(
      'Kağıt Ev (La Casa de Papel)',
    );
  });

  it('elides parenthetical title when primary and secondary fold identically (case, diacritics, Turkish İ/I/ı, punctuation)', () => {
    expect(
      formatElvDisplayTitle({
        originalTitle: 'Inception',
        englishTitle: 'Inception',
        localizedTitle: 'INCEPTION',
        fallbackTitle: 'Inception (2010)',
        format: 'english_system',
      }),
    ).toBe('Inception');

    expect(
      formatElvDisplayTitle({
        originalTitle: 'İstanbul',
        englishTitle: 'Istanbul',
        localizedTitle: 'ISTANBUL',
        fallbackTitle: 'Istanbul',
        format: 'original_system',
      }),
    ).toBe('İstanbul');

    expect(
      formatElvDisplayTitle({
        originalTitle: 'Işık',
        englishTitle: 'Isik',
        localizedTitle: 'ISIK',
        fallbackTitle: 'Isik',
        format: 'system_original',
      }),
    ).toBe('ISIK');

    expect(
      formatElvDisplayTitle({
        originalTitle: 'Amélie',
        englishTitle: 'Amelie',
        localizedTitle: 'Amélie!',
        fallbackTitle: 'Amelie',
        format: 'system_english',
      }),
    ).toBe('Amélie!');

    expect(
      formatElvDisplayTitle({
        originalTitle: 'Spider-Man: No Way Home',
        englishTitle: 'Spider Man No Way Home',
        localizedTitle: 'Spider-Man: No Way Home',
        fallbackTitle: 'Spiderman',
        format: 'english_system',
      }),
    ).toBe('Spider Man No Way Home');
  });

  it('preserves non-Latin scripts without falsely eliding distinct titles', () => {
    expect(
      formatElvDisplayTitle({
        originalTitle: '千と千尋の神隠し',
        englishTitle: 'Spirited Away',
        localizedTitle: 'Ruhların Kaçışı',
        fallbackTitle: 'Spirited Away',
        format: 'original_system',
      }),
    ).toBe('千と千尋の神隠し (Ruhların Kaçışı)');

    expect(
      formatElvDisplayTitle({
        originalTitle: '기생충',
        englishTitle: 'Parasite',
        localizedTitle: 'Parazit',
        fallbackTitle: 'Parasite',
        format: 'system_original',
      }),
    ).toBe('Parazit (기생충)');
  });

  it('falls back cleanly when some or all enriched titles are missing or blank', () => {
    expect(
      formatElvDisplayTitle({
        originalTitle: '  ',
        englishTitle: null,
        localizedTitle: undefined,
        fallbackTitle: '  Provider Title  ',
        format: 'original_system',
      }),
    ).toBe('Provider Title');

    expect(
      formatElvDisplayTitle({
        originalTitle: 'Dark',
        englishTitle: null,
        localizedTitle: '',
        fallbackTitle: 'Dark S01',
        format: 'system_english',
      }),
    ).toBe('Dark');

    expect(
      formatElvDisplayTitle({
        originalTitle: null,
        englishTitle: 'The Matrix',
        localizedTitle: null,
        fallbackTitle: 'Matrix',
        format: 'original',
      }),
    ).toBe('The Matrix');

    expect(
      formatElvDisplayTitle({
        originalTitle: null,
        englishTitle: null,
        localizedTitle: 'Başlangıç',
        fallbackTitle: 'Inception',
        format: 'english',
      }),
    ).toBe('Başlangıç');
  });

  it('collects deduplicated non-empty search aliases across all title variants', () => {
    expect(
      collectElvSearchAliases({
        originalTitle: 'La Casa de Papel',
        englishTitle: 'Money Heist',
        localizedTitle: 'Kağıt Ev',
        fallbackTitle: 'la casa de papel',
      }),
    ).toEqual(['La Casa de Papel', 'Money Heist', 'Kağıt Ev']);

    expect(
      collectElvSearchAliases({
        originalTitle: '  İstanbul  ',
        englishTitle: 'Istanbul',
        localizedTitle: '',
        fallbackTitle: 'ISTANBUL',
      }),
    ).toEqual(['İstanbul']);

    expect(
      collectElvSearchAliases({
        originalTitle: null,
        englishTitle: undefined,
        localizedTitle: '   ',
        fallbackTitle: 'Fallback Movie',
      }),
    ).toEqual(['Fallback Movie']);
  });
});
