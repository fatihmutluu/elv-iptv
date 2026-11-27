import type { WaveP8MessageId } from './en-wave-p8';

/** Turkish (`tr`) messages for Wave P8 VOD Seek Bar, Live Stage, Folder Collections & ELV Picks. */
export const trWaveP8Messages: Readonly<Record<WaveP8MessageId, string>> = {
  'library.collections.create': 'Koleksiyon oluştur',
  'library.collections.createTitle': 'Yeni koleksiyon',
  'library.collections.rename': 'Yeniden adlandır',
  'library.collections.renameTitle': 'Koleksiyonu yeniden adlandır',
  'library.collections.delete': 'Koleksiyonu sil',
  'library.collections.deleteConfirmTitle': 'Koleksiyon silinsin mi?',
  'library.collections.deleteConfirmBody':
    "İçerikler Listem'de kalır ve genel Filmler ile Diziler satırlarına geri döner.",
  'library.collections.emptySection':
    'Boş koleksiyon — içerikleri menüden taşıyabilir veya buraya sürükleyebilirsiniz.',
  'library.collections.moveTo': 'Koleksiyona taşı',
  'library.collections.moveToNamed': '{name} koleksiyonuna taşı',
  'library.collections.removeFrom': 'Koleksiyondan çıkar',
  'library.collections.dropHere': 'Taşımak için buraya bırakın',
  'library.collections.namePlaceholder': 'Koleksiyon adı',
  'catalog.filter.elvPicks': 'ELV Öneri',
  'live.stage.fullscreen': 'Tam ekran',
  'live.stage.doubleClickHint': 'Tam ekran için videoya çift tıklayın',
  'live.zap.favoriteAdd': 'Favorilere ekle',
  'live.zap.favoriteRemove': 'Favorilerden çıkar',
};
