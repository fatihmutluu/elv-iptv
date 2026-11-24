import { describe, expect, it } from 'vitest';
import { createAppI18n, type MessageId } from './index';

describe('Wave F1 Profiles & Parental Controls i18n (#15, #31)', () => {
  it('localizes profiles and settings section strings in English and Turkish', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const cases: ReadonlyArray<readonly [MessageId, string, string]> = [
      ['settings.section.profiles', 'Profiles & Parental', 'Profiller ve Ebeveyn'],
      ['profiles.title', 'Profiles', 'Profiller'],
      [
        'profiles.subtitle',
        'Switch viewers or manage local profiles on this device.',
        'İzleyici değiştirin veya bu cihazdaki yerel profilleri yönetin.',
      ],
      ['profiles.switchTitle', 'Switch profile', 'Profil değiştir'],
      ['profiles.switchButton', 'Switch', 'Geç'],
      ['profiles.activeBadge', 'Active', 'Aktif'],
      ['profiles.kidsBadge', 'Kids', 'Çocuk'],
      ['profiles.addProfile', 'Add profile', 'Profil ekle'],
      ['profiles.editProfile', 'Edit profile', 'Profili düzenle'],
      ['profiles.deleteProfile', 'Delete profile', 'Profili sil'],
      ['profiles.deleteConfirmTitle', 'Delete this profile?', 'Bu profil silinsin mi?'],
      [
        'profiles.deleteConfirmBody',
        'Watch history, favorites, preferences, and parental locks for this profile will be permanently removed.',
        'Bu profile ait izleme geçmişi, favoriler, tercihler ve ebeveyn kilitleri kalıcı olarak silinecektir.',
      ],
      [
        'profiles.cannotDeleteLast',
        'At least one profile must remain on this device.',
        'Bu cihazda en az bir profil bulunmalıdır.',
      ],
      ['profiles.nameLabel', 'Profile name', 'Profil adı'],
      ['profiles.namePlaceholder', 'Enter profile name', 'Profil adını girin'],
      ['profiles.avatarLabel', 'Avatar color', 'Avatar rengi'],
      ['profiles.kidsToggle', 'Kids profile', 'Çocuk profili'],
      [
        'profiles.kidsHint',
        'Enables parental controls and age filtering by default.',
        'Varsayılan olarak ebeveyn denetimlerini ve yaş filtrelemesini etkinleştirir.',
      ],
      ['profiles.save', 'Save', 'Kaydet'],
      ['profiles.cancel', 'Cancel', 'İptal'],
      ['profiles.defaultName', 'Default', 'Varsayılan'],
      ['profiles.manageInSettings', 'Manage profiles in Settings', "Profilleri Ayarlar'dan yönet"],
    ];

    for (const [id, expectedEn, expectedTr] of cases) {
      expect(en.t(id)).toBe(expectedEn);
      expect(tr.t(id)).toBe(expectedTr);
    }
  });

  it('localizes parental controls static and parameterized strings in English and Turkish', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const staticCases: ReadonlyArray<readonly [MessageId, string, string]> = [
      ['parental.title', 'Parental Controls', 'Ebeveyn Denetimleri'],
      [
        'parental.subtitle',
        'Restrict categories, adult keywords, and age-rated programs with a PIN.',
        'Kategorileri, yetişkin anahtar kelimelerini ve yaş sınırlı programları PIN ile kısıtlayın.',
      ],
      ['parental.enabledToggle', 'Enable parental controls', 'Ebeveyn denetimlerini etkinleştir'],
      [
        'parental.enabledHint',
        'Hides restricted channels, titles, and categories while locked.',
        'Kilitliyken kısıtlı kanalları, yapımları ve kategorileri gizler.',
      ],
      ['parental.pinTitle', 'Parental PIN', "Ebeveyn PIN'i"],
      ['parental.pinNotSet', 'No PIN set', 'PIN ayarlanmadı'],
      ['parental.pinSet', 'PIN protected', 'PIN ile korunuyor'],
      ['parental.setPin', 'Set PIN', 'PIN belirle'],
      ['parental.changePin', 'Change PIN', 'PIN değiştir'],
      ['parental.removePin', 'Remove PIN', "PIN'i kaldır"],
      ['parental.enterPin', 'Enter PIN', 'PIN girin'],
      ['parental.createPin', 'Create a 4–8 digit PIN', '4–8 haneli bir PIN oluşturun'],
      ['parental.confirmPin', 'Confirm PIN', "PIN'i onaylayın"],
      [
        'parental.pinMismatch',
        'PINs do not match. Try again.',
        "PIN'ler eşleşmiyor. Tekrar deneyin.",
      ],
      [
        'parental.pinInvalid',
        'PIN must be 4 to 8 digits.',
        'PIN 4 ile 8 rakam arasında olmalıdır.',
      ],
      ['parental.pinWrong', 'Incorrect PIN.', 'Hatalı PIN.'],
      ['parental.unlockTitle', 'Unlock parental controls', 'Ebeveyn kilidini aç'],
      ['parental.unlockButton', 'Unlock', 'Kilidi aç'],
      ['parental.lockNow', 'Lock now', 'Şimdi kilitle'],
      ['parental.unlockedBadge', 'Unlocked', 'Kilit açık'],
      ['parental.lockedBadge', 'Locked', 'Kilitli'],
      [
        'parental.lockedMessage',
        'This content is restricted by parental controls.',
        'Bu içerik ebeveyn denetimleriyle kısıtlanmıştır.',
      ],
      [
        'parental.adultKeywordsToggle',
        'Block adult keywords',
        'Yetişkin anahtar kelimelerini engelle',
      ],
      [
        'parental.adultKeywordsHint',
        'Automatically hides categories and titles containing adult keywords.',
        'Yetişkin anahtar kelimeleri içeren kategori ve yapımları otomatik olarak gizler.',
      ],
      ['parental.maxAgeLabel', 'Maximum age rating', 'En yüksek yaş sınırı'],
      ['parental.maxAgeOff', 'Off', 'Kapalı'],
      ['parental.unlockTimeoutLabel', 'Unlock duration', 'Kilit açık kalma süresi'],
      ['parental.timeoutSession', 'Until restart', 'Yeniden başlatana kadar'],
      ['parental.lockedCategoriesTitle', 'Locked categories', 'Kilitli kategoriler'],
      [
        'parental.lockedCategoriesEmpty',
        'No categories available to lock yet.',
        'Henüz kilitlenebilecek kategori yok.',
      ],
      ['parental.categoryLocked', 'Locked', 'Kilitli'],
      ['parental.categoryUnlocked', 'Unlocked', 'Açık'],
      ['parental.backspace', 'Backspace', 'Sil'],
      ['parental.clear', 'Clear', 'Temizle'],
    ];

    for (const [id, expectedEn, expectedTr] of staticCases) {
      expect(en.t(id)).toBe(expectedEn);
      expect(tr.t(id)).toBe(expectedTr);
    }

    expect(en.t('parental.pinLockedOut', { seconds: 30 })).toBe(
      'Too many attempts. Try again in 30s.',
    );
    expect(tr.t('parental.pinLockedOut', { seconds: 30 })).toBe(
      'Çok fazla deneme. 30 sn sonra tekrar deneyin.',
    );
    expect(en.t('parental.maxAgeOption', { age: 12 })).toBe('12+');
    expect(tr.t('parental.maxAgeOption', { age: 12 })).toBe('12+');
    expect(en.t('parental.timeoutMinutes', { minutes: 30 })).toBe('30 min');
    expect(tr.t('parental.timeoutMinutes', { minutes: 30 })).toBe('30 dk');
  });
});
