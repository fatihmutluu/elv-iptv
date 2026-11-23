import { describe, expect, it } from 'vitest';
import { createAppI18n, type MessageId } from './index';

describe('Wave C4A i18n parity (#397, #407)', () => {
  it('localizes Wave C4A expanded search (#397) and A–Z alphabetical jump rail (#407) strings in English and Turkish', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const cases: ReadonlyArray<readonly [MessageId, string, string]> = [
      ['search.scopeEpg', 'On Now & Guide', 'Şimdi ve Rehber'],
      ['search.scopeEpisodes', 'Episodes', 'Bölümler'],
      ['search.sectionEpg', 'On Now & Guide', 'Şimdi ve Rehber'],
      ['search.sectionEpisodes', 'Episodes', 'Bölümler'],
      ['search.suggestionsTitle', 'Quick picks', 'Hızlı öneriler'],
      ['search.suggestionFavorites', 'Favorites', 'Favoriler'],
      ['search.suggestionRecent', 'Recently watched', 'Son izlenenler'],
      ['search.suggestionCategory', 'Category', 'Kategori'],
      ['search.clearHistory', 'Clear history', 'Geçmişi temizle'],
      ['search.matchedInCast', 'Cast & crew', 'Oyuncular ve yönetmen'],
      ['search.airingNow', 'On now', 'Şimdi yayında'],
      ['search.upcoming', 'Upcoming', 'Yaklaşan'],
      ['catalog.alphabetJumpLabel', 'Jump to letter', 'Harfe git'],
      ['live.sortDefault', 'Channel order', 'Kanal sırası'],
      ['live.sortAlpha', 'A–Z', 'A–Z'],
      ['catalog.sortAlpha', 'A–Z', 'A–Z'],
    ];
    for (const [id, expectedEn, expectedTr] of cases) {
      expect(en.t(id)).toBe(expectedEn);
      expect(tr.t(id)).toBe(expectedTr);
    }

    expect(en.t('search.episodeLabel', { season: 2, episode: 5 })).toBe('S2 E5');
    expect(tr.t('search.episodeLabel', { season: 2, episode: 5 })).toBe('S2 B5');
    expect(en.t('catalog.alphabetJumpToLetter', { letter: 'M' })).toBe('Jump to M');
    expect(tr.t('catalog.alphabetJumpToLetter', { letter: 'M' })).toBe('M harfine git');
  });
});
