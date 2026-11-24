import type { WaveF5bMessageId } from './en-wave-f5b';

/** Turkish (`tr`) messages for Wave F5B Stalker Portals, VOD Enrichment & Collections (`#29`, `#215`, `#403`). */
export const trWaveF5bMessages: Readonly<Record<WaveF5bMessageId, string>> = {
  // #29 Stalker / Ministra MAC Portals
  'sources.mode.stalker': 'Stalker / MAC',
  'sources.stalker.portalUrlLabel': 'Portal adresi',
  'sources.stalker.portalUrlPlaceholder': 'http://portal.example.test/c/',
  'sources.stalker.macLabel': 'MAC adresi',
  'sources.stalker.macPlaceholder': '00:1A:79:00:00:01',
  'sources.stalker.serialLabel': 'Seri numarası (isteğe bağlı)',
  'sources.stalker.serialPlaceholder': 'İsteğe bağlı cihaz seri numarası',
  'sources.stalker.invalidMac': 'Geçerli bir MAC adresi girin.',
  'sources.stalker.invalidMacHint':
    'İki nokta ile ayrılmış 6 onaltılık çift kullanın, örn. 00:1A:79:00:00:01.',
  'sources.stalker.kindBadge': 'Stalker',

  // #215 Key-Free VOD Enrichment
  'settings.appearance.vodEnrichmentTitle': 'Film ve dizi bilgilerini zenginleştir',
  'settings.appearance.vodEnrichmentDescription':
    'Eksik puanları, yapım yıllarını ve türleri API anahtarı olmadan yerel olarak tamamlar.',
  'detail.enrichment.badge': 'Zenginleştirildi',
  'detail.enrichment.ratingLabel': 'Puan',
  'detail.enrichment.genresLabel': 'Türler',

  // #403 Custom VOD Collections
  'collections.title': 'Koleksiyonlar',
  'collections.subtitle': 'Film ve dizileri kişisel listelerde düzenleyin.',
  'collections.empty':
    'Henüz koleksiyon yok. Favori film ve dizilerinizi gruplamak için bir koleksiyon oluşturun.',
  'collections.addToCollection': 'Koleksiyona ekle',
  'collections.inCollections': 'Koleksiyonlarda',
  'collections.manageTitle': 'Koleksiyonları yönet',
  'collections.createPlaceholder': 'Yeni koleksiyon adı',
  'collections.createAction': 'Oluştur',
  'collections.rename': 'Yeniden adlandır',
  'collections.save': 'Kaydet',
  'collections.cancel': 'İptal',
  'collections.delete': 'Sil',
  'collections.moveUp': 'Yukarı taşı',
  'collections.moveDown': 'Aşağı taşı',
  'collections.removeItem': 'Koleksiyondan çıkar',
  'collections.itemCount': '{count} yapım',
  'collections.saved': 'Koleksiyon güncellendi',
  'collections.close': 'Kapat',
  'collections.emptyCollection': 'Bu koleksiyonda henüz yapım yok.',
  'collections.viewAll': 'Tümünü gör',
};
