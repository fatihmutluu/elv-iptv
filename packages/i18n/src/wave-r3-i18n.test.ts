import { describe, expect, it } from 'vitest';
import { createAppI18n } from './index';

describe('Wave R3 i18n strings (card hover preview & dismissal)', () => {
  it('defines EN and TR keys for recommendation dismissal and hover preview actions', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');

    expect(en.t('card.dontRecommend')).toBe("Don't recommend again");
    expect(tr.t('card.dontRecommend')).toBe('Bir daha önerme');

    expect(en.t('card.dontRecommendDone')).toBe('Hidden from recommendations');
    expect(tr.t('card.dontRecommendDone')).toBe('Önerilerden gizlendi');

    expect(en.t('card.hoverPlay')).toBe('Play');
    expect(tr.t('card.hoverPlay')).toBe('Oynat');

    expect(en.t('card.hoverTrailer')).toBe('Trailer');
    expect(tr.t('card.hoverTrailer')).toBe('Fragman');

    expect(en.t('card.hoverUnavailable')).toBe('No trailer');
    expect(tr.t('card.hoverUnavailable')).toBe('Fragman yok');
  });
});
