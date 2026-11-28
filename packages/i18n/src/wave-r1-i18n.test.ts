import { describe, expect, it } from 'vitest';
import { createAppI18n } from './index';

describe('Wave R1 i18n strings (4+3 nav profile menu & search popup)', () => {
  it('defines EN and TR keys for ProfileDropdownMenu and SearchPopupOverlay', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');

    expect(en.t('profile.menu.profiles')).toBe('Profiles');
    expect(tr.t('profile.menu.profiles')).toBe('Profiller');

    expect(en.t('profile.menu.addNew')).toBe('Add new');
    expect(tr.t('profile.menu.addNew')).toBe('Yeni ekle');

    expect(en.t('profile.menu.editProfiles')).toBe('Edit profiles');
    expect(tr.t('profile.menu.editProfiles')).toBe('Profilleri düzenle');

    expect(en.t('profile.menu.signOut')).toBe('Sign out');
    expect(tr.t('profile.menu.signOut')).toBe('Çıkış yap');

    expect(en.t('search.viewAll')).toBe('View all');
    expect(tr.t('search.viewAll')).toBe('Hepsini görüntüle');

    expect(en.t('search.popup.title')).toBe('Quick search');
    expect(tr.t('search.popup.title')).toBe('Hızlı arama');

    expect(en.t('search.popup.suggestions')).toBe('Suggestions');
    expect(tr.t('search.popup.suggestions')).toBe('Öneriler');
  });
});
