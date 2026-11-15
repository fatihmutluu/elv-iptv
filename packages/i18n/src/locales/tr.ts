import type { MessageId } from './en';

/** Turkish (`tr`) message catalog. */
export const trMessages: Readonly<Record<MessageId, string>> = {
  'sources.title': 'Kaynaklar',
  'sources.subtitle': 'Bir Xtream hesabı veya M3U çalma listesi adresi ekleyin.',
  'sources.openMenu': 'Kataloğa göz at',
  'sources.emptyList': 'Henüz kaynak eklenmedi.',
  'sources.section.add': 'Kaynak ekle',
  'sources.section.saved': 'Kayıtlı kaynaklar',
  'sources.section.advanced': 'Gelişmiş aktarım ayarları (isteğe bağlı)',
  'sources.mode.xtream': 'Xtream',
  'sources.mode.m3u': 'M3U Adresi',
  'sources.field.name': 'Kaynak adı (isteğe bağlı)',
  'sources.placeholder.name': 'Varsayılan olarak sunucu adresi kullanılır',
  'sources.field.server': 'Sunucu adresi',
  'sources.placeholder.server': 'http://example.invalid:8080',
  'sources.field.username': 'Kullanıcı adı',
  'sources.placeholder.username': 'Hesap kullanıcı adı',
  'sources.field.password': 'Parola',
  'sources.placeholder.password': 'Hesap parolası',
  'sources.field.playlistUrl': 'Çalma listesi adresi',
  'sources.placeholder.playlistUrl': 'http://example.invalid/playlist.m3u8',
  'sources.field.keepAsM3u': 'M3U olarak tut',
  'sources.notice.xtreamDetected':
    'Xtream bağlantısı algılandı — M3U olarak tut seçilmedikçe kategoriler, filmler, diziler ve rehber için Xtream API ile içe aktarılır.',
  'sources.field.guideUrl': 'XMLTV rehber adresi (isteğe bağlı)',
  'sources.placeholder.guideUrl': 'http://example.invalid/epg.xml.gz',
  'sources.field.userAgent': 'Özel User-Agent (isteğe bağlı)',
  'sources.placeholder.userAgent': 'Varsayılan için boş bırakın',
  'sources.field.referer': 'Referer adresi (isteğe bağlı)',
  'sources.placeholder.referer': 'http://example.invalid/',
  'sources.field.xtreamFormat': 'Canlı yayın biçimi',
  'sources.format.default': 'Varsayılan (MPEG-TS)',
  'sources.format.ts': 'MPEG-TS',
  'sources.format.m3u8': 'HLS (M3U8)',
  'sources.action.add': 'Ekle ve içe aktar',
  'sources.action.adding': 'Ekleniyor…',
  'sources.action.import': 'İçe aktar',
  'sources.action.refresh': 'Yenile',
  'sources.action.cancel': 'İptal',
  'sources.action.remove': 'Kaldır',
  'sources.action.toggleAdvancedShow': 'Gelişmiş seçenekleri göster',
  'sources.action.toggleAdvancedHide': 'Gelişmiş seçenekleri gizle',
  'sources.kind.xtream': 'Xtream',
  'sources.kind.m3u': 'M3U',
  'sources.status.needsImport': 'İçe aktarma gerekli',
  'sources.status.ready': 'Hazır',
  'sources.status.readyCounts':
    '{live, plural, one {# canlı kanal} other {# canlı kanal}}, {movies, plural, one {# film} other {# film}}, {series, plural, one {# dizi} other {# dizi}}',
  'sources.status.importing': '{phase} içe aktarılıyor ({done})',
  'sources.status.importingTotal': '{phase} içe aktarılıyor ({done}/{total})',
  'sources.status.cancelled': 'İçe aktarma iptal edildi.',
  'sources.phase.categories': 'kategoriler',
  'sources.phase.live': 'canlı kanallar',
  'sources.phase.movies': 'filmler',
  'sources.phase.series': 'diziler',
  'sources.phase.episodes': 'bölümler',
  'sources.phase.guideChannels': 'rehber kanalları',
  'sources.phase.programmes': 'yayın akışı',
  'sources.phase.cleanup': 'tamamlanıyor',
  'source.validation.missingServer': 'Xtream sunucu adresini girin.',
  'source.hint.missingServer':
    'Sağlayıcınız belirttiyse http:// veya https:// ile bağlantı noktasını ekleyin.',
  'source.validation.missingCredentials': 'Kullanıcı adı ve parolanın ikisini de girin.',
  'source.hint.missingCredentials':
    'Sağlayıcınızın verdiği Xtream hesap bilgilerini kontrol edin veya tam get.php bağlantısını yapıştırın.',
  'source.validation.missingUrl': 'M3U çalma listesi adresini girin.',
  'source.hint.missingUrl': 'Tam bir http:// veya https:// çalma listesi bağlantısı yapıştırın.',
  'source.validation.missingScheme':
    'Sunucu veya çalma listesi adresi http:// ya da https:// ile başlamalıdır.',
  'source.hint.missingScheme': 'Adresin başına http:// (veya https://) ekleyip tekrar deneyin.',
  'source.validation.unsupportedScheme': 'Yalnızca http:// ve https:// adresleri desteklenir.',
  'source.hint.unsupportedScheme': 'Adres şemasını http:// veya https:// ile değiştirin.',
  'source.validation.invalidAddress': 'Sunucu veya bağlantı adresi geçerli değil.',
  'source.hint.invalidAddress':
    'Sunucu adını kontrol edin ve bağlantı noktası numarasının 1 ile 65535 arasında olduğundan emin olun.',
  'source.validation.invalidGuideUrl': 'XMLTV rehber adresi geçerli değil.',
  'source.hint.invalidGuideUrl':
    'Varsayılan rehberi kullanmak için boş bırakın veya tam bir http:// ya da https:// adresi girin.',
  'source.validation.invalidCharacters':
    'Alanlardan biri desteklenmeyen kontrol karakterleri içeriyor.',
  'source.hint.invalidCharacters':
    'Yapıştırılan metindeki satır sonlarını veya gizli karakterleri kaldırıp tekrar deneyin.',
  'source.validation.m3uInXtream':
    'Bu adres bir Xtream sunucusu değil, M3U çalma listesi dosyası gibi görünüyor.',
  'source.hint.m3uInXtream':
    '.m3u veya .m3u8 listesi eklemek için M3U Adresi kipine geçin ya da yalnızca Xtream sunucu kök adresini girin.',
  'source.error.invalidCredentials':
    'Giriş başarısız: kullanıcı adı, parola veya erişim anahtarı geçersiz.',
  'source.hint.invalidCredentials':
    'Bilgilerinizi sağlayıcınızla doğrulayın, ardından kaynağı kaldırıp yeniden ekleyin.',
  'source.error.accountExpired': 'Bu sağlayıcı hesabının süresi dolmuş veya hesap etkin değil.',
  'source.hint.accountExpired':
    'Sağlayıcınızdan abonelik durumunuzu kontrol edin ve etkinleştiğinde yenileyin.',
  'source.error.rateLimited': 'Sağlayıcı, bağlantı veya istek sınırı nedeniyle isteği reddetti.',
  'source.hint.rateLimited':
    'Diğer cihazlardaki yayınları kapatın, biraz bekleyin ve Yenile düğmesine basın.',
  'source.error.timeout': 'Sunucu yanıt vermekte gecikti.',
  'source.hint.timeout':
    'Ağ bağlantınızı ve sunucu adresini kontrol edin, ardından Yenile düğmesine basın.',
  'source.error.notFound': 'Çalma listesi veya panel uç noktası sunucuda bulunamadı (HTTP 404).',
  'source.hint.notFound':
    'Adres yolunu ve bağlantı noktasını kontrol edin, ardından kaynağı kaldırıp yeniden ekleyin.',
  'source.error.unreachable': 'Sunucuya ulaşılamadı.',
  'source.hint.unreachable':
    'Sunucu adresini, bağlantı noktasını ve ağ bağlantınızı kontrol edip Yenile düğmesine basın.',
  'source.error.aborted': 'İçe aktarma iptal edildi.',
  'source.hint.aborted': 'Tekrar denemek istediğinizde İçe aktar veya Yenile düğmesine basın.',
  'source.error.emptyPlaylist':
    'Kaynak yanıt verdi ancak içinde hiç kanal, film veya dizi bulunamadı.',
  'source.hint.emptyPlaylist':
    'Çalma listesine veya hesaba etkin kanallar tanımlandığını sağlayıcınızla doğrulayın.',
  'source.error.tooLarge': 'Çalma listesi veya sunucu yanıtı cihaz boyut sınırını aştı.',
  'source.hint.tooLarge':
    'Bu bir Xtream sağlayıcısıysa ham M3U dosyası yerine Xtream kipinde ekleyin.',
  'source.error.invalidFormat':
    'Sunucu yanıtı geçerli bir M3U çalma listesi veya Xtream kataloğu değil.',
  'source.hint.invalidFormat':
    'Adresin bir web sayfasına değil, doğrudan M3U listesine veya Xtream sunucusuna işaret ettiğini kontrol edin.',
  'source.error.importInProgress': 'Bu kaynak için zaten devam eden bir içe aktarma var.',
  'source.hint.importInProgress': 'Mevcut içe aktarmanın bitmesini bekleyin veya önce iptal edin.',
  'source.error.secretStore': 'Bu cihazda güvenli kimlik bilgisi deposu kullanılamıyor.',
  'source.hint.secretStore':
    'İşletim sistemi anahtarlığının veya ekran kilidi şifrelemesinin etkin olduğundan emin olup uygulamayı yeniden başlatın.',
  'source.error.storage': 'Katalog verileri yerel depolamaya kaydedilemedi.',
  'source.hint.storage': 'Boş disk alanını kontrol edip kaynağı yenilemeyi deneyin.',
};
