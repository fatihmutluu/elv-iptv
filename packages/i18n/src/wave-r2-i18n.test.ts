import { describe, expect, it } from 'vitest';
import { createAppI18n } from './index';

describe('Wave R2 i18n strings (detail hero trailer & inline synopsis)', () => {
  it('defines EN and TR keys for detail inline synopsis and trailer mute toggle', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');

    expect(en.t('detail.seeMoreInline')).toBe('see more...');
    expect(tr.t('detail.seeMoreInline')).toBe('devamını gör...');

    expect(en.t('detail.trailer.mute')).toBe('Mute preview');
    expect(tr.t('detail.trailer.mute')).toBe('Önizleme sesini kapat');

    expect(en.t('detail.trailer.unmute')).toBe('Unmute preview');
    expect(tr.t('detail.trailer.unmute')).toBe('Önizleme sesini aç');
  });
});
