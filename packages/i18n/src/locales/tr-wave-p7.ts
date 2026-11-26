import type { WaveP7MessageId } from './en-wave-p7';

/** Turkish (`tr`) messages for Wave P7 Settings simplification, Kids Mode, Profiles & Sources Advanced. */
export const trWaveP7Messages: Readonly<Record<WaveP7MessageId, string>> = {
  'parental.modeDescription':
    'PIN korumalı kategori kilitleri, yaş sınırları ve otomatik yetişkin anahtar kelime filtresiyle çocuk izleyicileri güvende tutun.',
  'profiles.whoIsWatching': 'Kim İzliyor?',
  'profiles.addNew': 'Yeni profil',
  'profiles.chooseTypeTitle': 'Profil türünü seçin',
  'profiles.typeAdultTitle': 'Standart profil',
  'profiles.typeAdultDesc': 'Kişisel favoriler, izleme geçmişi ve ayarlarla tam katalog erişimi.',
  'profiles.typeKidsTitle': 'Çocuk profili',
  'profiles.typeKidsDesc':
    'Varsayılan olarak Çocuk Modu, yaş sınırları ve anahtar kelime filtresi açık güvenli izleme deneyimi.',
  'profiles.editProfileTitle': 'Profili düzenle',
  'profiles.kidsToggleLabel': 'Çocuk Modu',
  'profiles.pinManageLabel': "PIN'i yönet",
  'profiles.setPinOnCreate': 'Bu profil için PIN belirle',
  'profiles.deleteProfileAction': 'Profili sil',
  'profiles.continueAction': 'Devam et',
  'profiles.cancelAction': 'İptal',
  'settings.dropdown.selectHint': 'Bir seçenek belirleyin',
  'settings.artworkCacheUsage': '{limitMb} MB içinden {usedMb} MB kullanılıyor',
  'settings.playback.advancedAudioTitle': 'Gelişmiş ses',
  'settings.playback.advancedAudioDescription':
    'Çıkış cihazı, kanal düzeni, özel erişim modu ve doğrudan ses aktarımı.',
  'settings.liveTv.refreshNow': 'Şimdi yenile',
  'settings.liveTv.refreshing': 'Yenileniyor…',
  'settings.liveTv.refreshed': 'Yenilendi',
  'sources.action.refreshShort': 'Yenile',
  'sources.action.removeShort': 'Kaldır',
  'sources.action.advanced': 'Gelişmiş',
  'sources.advanced.title': 'Kaynak ayarları',
  'sources.advanced.rename': 'Kaynağı yeniden adlandır',
  'sources.advanced.renamePlaceholder': 'Kaynak adını girin',
  'sources.advanced.renameSave': 'Adı kaydet',
  'sources.advanced.sharedProfiles': 'Paylaşılan profiller',
  'sources.advanced.sharedProfilesHint':
    'Bu kaynaktaki kanal ve katalog içeriklerini hangi profillerin görebileceğini seçin.',
  'sources.advanced.allProfilesShared': 'Tüm profillerle paylaşılıyor',
};
