import type { enWaveE1Messages } from './en-wave-e1';

/** Turkish (`tr`) messages for Wave E1 ELV Mode Core Engine (`#511`). */
export const trWaveE1Messages: Readonly<Record<keyof typeof enWaveE1Messages, string>> = {
  'settings.section.elvMode': 'ELV Mode',
  'settings.elvMode.subtitle':
    'Herhangi bir IPTV listesini performans kaybı olmadan sinema kalitesinde bir kataloğa dönüştürün.',
  'settings.elvMode.masterTitle': 'ELV Mode',
  'settings.elvMode.masterDescription':
    'IMDb verileri ve akıllı çoklu kaynak birleştirme ile tahribatsız iyileştirme. İstediğiniz an kapatıp ham sağlayıcı görünümüne dönebilirsiniz.',
  'settings.elvMode.mergeVersions': 'Film ve dizi sürümlerini birleştir',
  'settings.elvMode.mergeVersionsDesc':
    'Aynı yapımın farklı sürümlerini ve birden fazla kaynaktaki kopyalarını tek kartta toplayıp detaydan seçtirir.',
  'settings.elvMode.enrichMetadata': 'Temiz posterler, puanlar ve zengin detay',
  'settings.elvMode.enrichMetadataDesc':
    'Sağlayıcı görsellerini tekrar indirmeden doğrudan temiz IMDb posterlerini, puanlarını ve yerel dil özetlerini yükler.',
  'settings.elvMode.titleFormat': 'Başlık gösterim formatı',
  'settings.elvMode.titleFormatDesc':
    'Film ve dizi adlarının göz atma, detay ve aramada nasıl görüneceğini seçin.',
  'settings.elvMode.titleFormat.original': 'Orijinal ad',
  'settings.elvMode.titleFormat.system': 'Sistem dili',
  'settings.elvMode.titleFormat.english': 'İngilizce',
  'settings.elvMode.titleFormat.english_system': 'İngilizce (Sistem)',
  'settings.elvMode.titleFormat.original_system': 'Orijinal (Sistem)',
  'settings.elvMode.titleFormat.system_english': 'Sistem (İngilizce)',
  'settings.elvMode.titleFormat.system_original': 'Sistem (Orijinal)',
  'settings.elvMode.categorySource': 'Kategori kaynağı',
  'settings.elvMode.categorySourceDesc':
    "Filmler ve Diziler'de temiz IMDb türlerini veya IPTV sağlayıcınızın kendi klasörlerini kullanın.",
  'settings.elvMode.categorySource.imdb': 'IMDb türleri',
  'settings.elvMode.categorySource.provider': 'Sağlayıcı klasörleri',
  'settings.elvMode.smartRecommendations': 'Akıllı öneriler ve ana sayfa gündem vitrini',
  'settings.elvMode.smartRecommendationsDesc':
    'Kütüphanenizdeki yapımlardan ve IMDb gündem listelerinden kişisel öneriler sunar, beğenmediklerinizi gizler.',
  'settings.elvMode.xray': 'Oynatıcı içi X-Ray (oyuncular ve bölüm bilgisi)',
  'settings.elvMode.xrayDesc':
    'Oynatmayı duraklattığınızda tıklanabilir oyuncu kadrosu ve bölüm bilgilerini gösterir.',
  'settings.elvMode.liveEnhance': 'Canlı TV temizleme, kalite gruplama ve otomatik yedek',
  'settings.elvMode.liveEnhanceDesc':
    'Sağlayıcı etiketlerini temizler, kategoriler arası kalite kopyalarını birleştirir, kopunca yedeğe geçer ve bozuk yayınları alta alır.',
  'settings.elvMode.verifyRealQuality': 'Gerçek kalite doğrulama ve bozuk sürüm hafızası',
  'settings.elvMode.verifyRealQualityDesc':
    'Gerçek yayın çözünürlüğünü kaydedip sahte 4K etiketlerini düzeltir ve sürekli hata veren sürümleri alta iter.',
  'elv.quality.verified': 'Doğrulanmış {resolution}',
  'elv.quality.fake4k': 'Gerçek {resolution} (4K etiketli)',
  'elv.quality.unreliable': 'Sorunlu',
  'elv.source.from': '{source} kaynağından',
  'elv.versions.title': 'Kaynaklar ve sürümler ({count})',
  'elv.matching.background': 'Katalog arka planda zenginleştiriliyor…',
};
