import { describe, expect, it } from 'vitest';
import { createAppI18n, type MessageId } from './index';

describe('Wave P7 i18n strings (Kids Mode, Profiles, Settings Dropdown, Saved Sources Advanced)', () => {
  it('localizes updated labels and new Wave P7 keys in English and Turkish', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');

    const cases: ReadonlyArray<readonly [MessageId, string, string]> = [
      ['parental.title', 'Kids Mode', 'Çocuk Modu'],
      ['settings.section.profiles', 'Kids Mode', 'Çocuk Modu'],
      ['player.deinterlace', 'Deinterlace', 'Deinterlace (Çizgi Düzeltme)'],
      [
        'settings.audioNormalizationHint',
        'Balances quiet dialogue and overly loud channels.',
        'Kısık diyalogları ve aşırı yüksek kanalları dengeler.',
      ],
      [
        'settings.playback.preferHevcOverDvDesc',
        'Skip Dolby Vision and use standard HEVC on devices with color or black-screen issues.',
        "Renk veya siyah ekran sorunu yaşayan cihazlarda Dolby Vision'ı atlayıp doğrudan standart HEVC kullanır.",
      ],
      [
        'feedback.attachDiagnosticsLabel',
        'Attach redacted device & codec diagnostics',
        'Kişisel bilgileri temizlenmiş cihaz ve kodek bilgilerini ekle',
      ],
      ['profiles.whoIsWatching', "Who's Watching?", 'Kim İzliyor?'],
      ['profiles.addNew', 'Add profile', 'Yeni profil'],
      ['profiles.chooseTypeTitle', 'Choose profile type', 'Profil türünü seçin'],
      ['profiles.typeAdultTitle', 'Standard profile', 'Standart profil'],
      ['profiles.typeKidsTitle', 'Kids profile', 'Çocuk profili'],
      ['profiles.editProfileTitle', 'Edit profile', 'Profili düzenle'],
      ['profiles.kidsToggleLabel', 'Kids Mode', 'Çocuk Modu'],
      ['profiles.pinManageLabel', 'Manage PIN', "PIN'i yönet"],
      ['profiles.setPinOnCreate', 'Set a PIN for this profile', 'Bu profil için PIN belirle'],
      ['profiles.deleteProfileAction', 'Delete profile', 'Profili sil'],
      ['profiles.continueAction', 'Continue', 'Devam et'],
      ['profiles.cancelAction', 'Cancel', 'İptal'],
      ['settings.dropdown.selectHint', 'Select an option', 'Bir seçenek belirleyin'],
      ['settings.playback.advancedAudioTitle', 'Advanced audio', 'Gelişmiş ses'],
      ['settings.liveTv.refreshNow', 'Refresh now', 'Şimdi yenile'],
      ['settings.liveTv.refreshing', 'Refreshing…', 'Yenileniyor…'],
      ['settings.liveTv.refreshed', 'Refreshed', 'Yenilendi'],
      ['sources.action.refreshShort', 'Refresh', 'Yenile'],
      ['sources.action.removeShort', 'Remove', 'Kaldır'],
      ['sources.action.advanced', 'Advanced', 'Gelişmiş'],
      ['sources.advanced.title', 'Source settings', 'Kaynak ayarları'],
      ['sources.advanced.rename', 'Rename source', 'Kaynağı yeniden adlandır'],
      ['sources.advanced.renamePlaceholder', 'Enter source name', 'Kaynak adını girin'],
      ['sources.advanced.renameSave', 'Save name', 'Adı kaydet'],
      ['sources.advanced.sharedProfiles', 'Shared with profiles', 'Paylaşılan profiller'],
      [
        'sources.advanced.allProfilesShared',
        'Shared with all profiles',
        'Tüm profillerle paylaşılıyor',
      ],
      ['settings.language.en', 'English', 'English'],
      ['settings.language.tr', 'Türkçe', 'Türkçe'],
    ];

    for (const [id, expectedEn, expectedTr] of cases) {
      expect(en.t(id)).toBe(expectedEn);
      expect(tr.t(id)).toBe(expectedTr);
    }

    expect(en.t('settings.artworkCacheUsage', { usedMb: 42, limitMb: 512 })).toBe(
      '42 MB of 512 MB used',
    );
    expect(tr.t('settings.artworkCacheUsage', { usedMb: 42, limitMb: 512 })).toBe(
      '512 MB içinden 42 MB kullanılıyor',
    );
    expect(en.t('parental.modeDescription')).toContain('PIN');
    expect(tr.t('parental.modeDescription')).toContain('PIN');
    expect(en.t('settings.about.statement')).toContain('100% free');
    expect(tr.t('settings.about.statement')).toContain('%100 ücretsiz');
  });
});
