import type { enWaveQ7bMessages } from './en-wave-q7b';

/** Wave Q7-B Turkish messages. */
export const trWaveQ7bMessages: Readonly<Record<keyof typeof enWaveQ7bMessages, string>> = {
  'settings.playback.autoReplaceSingleConnection':
    'Tek bağlantılı hesaplarda yayını otomatik değiştir',
  'settings.playback.autoReplaceSingleConnectionDesc':
    '1 bağlantılı kaynakta başka bir kanala geçerken aktif yerel yayını otomatik durdur.',
  'settings.liveTv.clearRecentChannels': 'Son izlenen kanallar geçmişi',
  'settings.liveTv.clearRecentChannelsDesc':
    'Aktif profil için son izlenen Canlı TV kanalları listesini temizle.',
  'settings.liveTv.clearRecentChannelsAction': 'Son kanalları temizle',
  'settings.liveTv.clearRecentChannelsCleared': 'Temizlendi',
  'live.context.removeFromRecent': 'Son İzlenenlerden Kaldır',
  'live.folders.all': 'Tümü',
  'live.folders.unfiled': 'Klasörsüz',
  'live.folders.createTooltip': 'Yeni favori klasörü',
  'live.folders.createTitle': 'Yeni favori klasörü',
  'live.folders.renameTitle': 'Klasörü yeniden adlandır',
  'live.folders.deleteTitle': 'Klasörü sil',
  'live.folders.deleteBody':
    '"{name}" klasöründeki kanallar Favoriler içinde Klasörsüz altında kalır.',
  'live.folders.namePlaceholder': 'Klasör adı (örn. Spor, Haber)',
  'live.folders.moveToFolder': 'Klasöre taşı…',
  'live.folders.addToFolder': 'Klasöre ekle…',
  'live.folders.moveModalTitle': 'Klasöre taşı',
  'live.folders.createAndMove': 'Oluştur ve taşı',
  'live.folders.createFolder': 'Klasör oluştur',
  'live.folders.manageFolder': 'Klasörü yönet',
  'live.folders.rename': 'Yeniden adlandır',
  'live.folders.delete': 'Sil',
  'live.folders.save': 'Kaydet',
  'live.folders.cancel': 'İptal',
  'live.folders.emptyFolder': 'Bu klasörde henüz favori kanal yok.',
  'live.folders.currentBadge': 'Mevcut',
};
