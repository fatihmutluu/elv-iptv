import type { enWaveE3Messages } from './en-wave-e3';

/** Turkish (`tr`) messages for Wave E3 Smart Onboarding, Live ELV Mode Preview & Returning-User Startup (`#513`). */
export const trWaveE3Messages: Readonly<Record<keyof typeof enWaveE3Messages, string>> = {
  // Shared Interactive ELV Mode Preview
  'elv.preview.badgeClean': 'ELV Mode Aktif',
  'elv.preview.badgeRaw': 'Ham IPTV Listesi',
  'elv.preview.captionAllOn': 'Temiz afişler, IMDb puanları, birleşik sürümler ve düzenli türler.',
  'elv.preview.captionChaos':
    'Kopya filmleri, bozuk afişleri ve karmaşık klasörleri toparlamak için ELV Mode özelliklerini açın.',
  'elv.preview.genre.scifi': 'Bilim Kurgu',
  'elv.preview.genre.drama': 'Dram',
  'elv.preview.genre.thriller': 'Gerilim',
  'elv.preview.genre.mystery': 'Gizem',
  'elv.preview.rawCat1': '### === TR VIP FILM 2026 === ###',
  'elv.preview.rawCat2': '*** 4K_YENI_KARISIK_2025 ***',
  'elv.preview.rawCat3': 'TR | FILMLER | YEDEK 2',
  'elv.preview.film1.title': 'Kadife Meridyen',
  'elv.preview.film2.title': 'Güneş Sürüklenişi',
  'elv.preview.film3.title': 'Cam Liman',
  'elv.preview.film4.title': 'Kül Valsi',
  'elv.preview.rawNoPoster': 'AFIS_YOK_404.jpg',
  'elv.preview.rawNoRating': '???',
  'elv.preview.duplicateTag': '4 kopya',

  // Onboarding Screen 1 — Smart Welcome & Auth
  'onboarding.welcome.title': "ELV IPTV'ye Hoş Geldiniz",
  'onboarding.welcome.subtitle':
    'Şifreli kütüphanenizi tüm ekranlarınızda eşitlemek için giriş yapın veya doğrudan yerel olarak başlayın.',
  'onboarding.welcome.emailOption': 'E-posta ile devam et',
  'onboarding.welcome.emailContinue': 'Devam Et',
  'onboarding.welcome.checkingEmail': 'Hesap kontrol ediliyor…',
  'onboarding.welcome.existingAccountHint':
    'Tekrar hoş geldiniz — şifreli kasanızı açmak için parolanızı girin.',
  'onboarding.welcome.notFoundPrompt':
    'Bu e-posta ile kayıtlı hesap bulunamadı — yeni hesap oluşturmak ister misiniz?',
  'onboarding.welcome.createWithEmailAction': 'Bu e-posta ile hesap oluştur',
  'onboarding.welcome.backToEmail': 'Farklı bir e-posta kullan',
  'onboarding.welcome.guestAction': 'Hesapsız devam et',
  'onboarding.welcome.transferAction': 'Başka cihazdan aktar',
  'onboarding.welcome.privacyStripPrefix': 'Devam ederek şunu kabul etmiş olursunuz:',
  'onboarding.welcome.privacyPolicyLink': 'Gizlilik Politikası',
  'onboarding.welcome.diagnosticsLabel': 'Anonim oynatma ve çökme tanılamalarını paylaş',

  // Privacy Policy Modal
  'onboarding.privacy.title': 'Gizlilik ve Veri Bildirimi',
  'onboarding.privacy.summary':
    'ELV IPTV gizlilik odaklı tasarlanmıştır. Çalma listeleriniz, sağlayıcı bilgileriniz ve izleme geçmişiniz şifreli olarak ve tamamen sizin kontrolünüzde kalır.',
  'onboarding.privacy.sectionDataTitle': 'Sıfır Bilgili Eşitleme ve Yerel Depolama',
  'onboarding.privacy.sectionDataBody':
    'Hesap olmadan tüm listeleriniz ve kimlik bilgileriniz yalnızca cihazınızda kalır. Giriş yaptığınızda eşitleme verileri yüklenmeden önce cihazınızda uçtan uca şifrelenir; bağlantılarınızı, parolalarınızı veya izleme geçmişinizi asla okuyamayız.',
  'onboarding.privacy.sectionDiagnosticsTitle': 'İsteğe Bağlı Anonim Tanılama',
  'onboarding.privacy.sectionDiagnosticsBody':
    'Etkinleştirildiğinde anonim performans ölçümleri ve çözücü hata kodları oynatma kararlılığını iyileştirmeye yardımcı olur. Sağlayıcı adresleri, kimlik bilgileri, IP adresleri ve içerik adları asla toplanmaz. Bu tercihi Ayarlar bölümünden istediğiniz zaman değiştirebilirsiniz.',
  'onboarding.privacy.sectionRightsTitle': 'Haklarınız (KVKK ve GDPR)',
  'onboarding.privacy.sectionRightsBody':
    'Eşitleme hesabınızı ve şifreli kasanızı istediğiniz zaman Ayarlar > Hesap ve Eşitleme bölümünden inceleyebilir veya kalıcı olarak silebilirsiniz.',
  'onboarding.privacy.close': 'Kapat',

  // Onboarding Syncing Step
  'onboarding.syncing.title': 'Verileriniz eşitleniyor…',
  'onboarding.syncing.subtitle': 'Şifreli kasanız ve tercihleriniz indiriliyor.',

  // Onboarding Screen 2 — Add First Source
  'onboarding.source.title': 'İlk Kaynağınızı Ekleyin',
  'onboarding.source.subtitle':
    'Kendi M3U listenizi, Xtream Codes hesabınızı veya Stalker portalınızı ekleyin. ELV IPTV içerik sunmaz.',
  'onboarding.source.continueAction': 'Ekle ve Devam Et',
  'onboarding.source.browseWithoutSource': 'Şimdilik kaynak eklemeden göz at',
  'onboarding.source.pairPhoneAction': 'Telefondan liste gönder',

  // Onboarding Screen 3 — ELV Mode
  'onboarding.elv.title': 'ELV Mode ile Tanışın',
  'onboarding.elv.subtitle':
    'Ham IPTV listelerini temiz afişler, puanlar, birleştirilmiş kopyalar ve düzenli türlerle sinema kalitesinde bir kütüphaneye dönüştürün.',
  'onboarding.elv.masterToggle': 'ELV Mode',
  'onboarding.elv.mergeToggle': 'Film ve dizi sürümlerini birleştir',
  'onboarding.elv.postersToggle': 'Afişleri ve puanları zenginleştir',
  'onboarding.elv.categoriesToggle': 'Kategorileri türlere göre düzenle',

  // Onboarding Top Import Bar & Dynamic CTA
  'onboarding.import.loading': 'Kütüphaneniz içe aktarılıyor…',
  'onboarding.import.ready': 'Kütüphaneniz hazır!',
  'onboarding.import.failed': 'Kaynağınız içe aktarılamadı.',
  'onboarding.import.providerWaitHint':
    'Sağlayıcınız bekleniyor, sorun bizden kaynaklı değil — beklerken kişiselleştirmeye devam edebilirsiniz.',
  'onboarding.import.continueAction': 'Devam Et',
  'onboarding.import.enterAppAction': 'Uygulamaya Geç',
  'onboarding.import.continueCustomizing': 'Kişiselleştirmeye devam et',
  'onboarding.import.retryAction': 'Tekrar Dene',
  'onboarding.import.editSourceAction': 'Bilgileri Düzenle',

  // Onboarding Personalization Cards 1–4
  'onboarding.personalize.stepCounter': 'Adım {step} / {total}',
  'onboarding.personalize.profileTitle': 'Profilinizi Kişiselleştirin',
  'onboarding.personalize.profileSubtitle':
    'Bu izleyici profili için bir ad ve avatar seçin. İstediğiniz zaman yeni profiller ekleyebilirsiniz.',
  'onboarding.personalize.profileNameLabel': 'Profil adı',
  'onboarding.personalize.avatarLabel': 'Avatar',
  'onboarding.personalize.themeTitle': 'Sinema Temanızı Seçin',
  'onboarding.personalize.themeSubtitle':
    'Karanlık odalar ve her ekranda net okunabilirlik için tasarlandı.',
  'onboarding.personalize.layoutTitle': 'Ana Ekran Düzeni',
  'onboarding.personalize.layoutSubtitle':
    'Ana ekran satırlarınızın ve öne çıkan alanın nasıl düzenleneceğini seçin.',
  'onboarding.personalize.layoutPreviewLabel': 'Canlı düzen önizlemesi',
  'onboarding.personalize.tipsTitle': 'Ekranınız İçin Hızlı İpuçları',
  'onboarding.personalize.tipsSubtitle':
    "ELV IPTV'den en iyi şekilde yararlanmak için birkaç pratik ipucu.",
  'onboarding.personalize.tipDesktop1':
    'Duraklatmak için Boşluk, tam ekran için F ve satırlar arasında gezinmek için yön tuşlarını kullanın.',
  'onboarding.personalize.tipDesktop2':
    'Hızlı favori ekleme, sürüm seçimi ve ses veya altyazı ayarları için herhangi bir kanal veya yapıma sağ tıklayın.',
  'onboarding.personalize.tipMobile1':
    'Oynatma sırasında parlaklık için sol kenarda, ses seviyesi için sağ kenarda yukarı veya aşağı kaydırın.',
  'onboarding.personalize.tipMobile2':
    '2× hız için videoya basılı tutun veya hassas sarma için çubukta yukarı doğru kaydırın.',
  'onboarding.personalize.tipTv1':
    'Tam ekran için canlı kanalda OK tuşuna iki kez basın; anında geçiş için CH+/CH- veya rakam tuşlarını kullanın.',
  'onboarding.personalize.tipTv2':
    'Hızlı seçenekler için herhangi bir kanal veya film kartında OK tuşuna basılı tutun; kolayca dönmek için Geri tuşunu kullanın.',

  // Onboarding Centered Waiting Stage & Returning-User Startup Refresh
  'onboarding.waiting.title': 'Kütüphane İçe Aktarımı Tamamlanıyor',
  'onboarding.waiting.subtitle':
    'Ayarlarınız kaydedildi. Sağlayıcınız yanıt vermeyi bitirdiği anda izleme odanız açılacak.',
  'startup.refresh.title': 'Kütüphaneniz Güncelleniyor',
  'startup.refresh.subtitle':
    'En güncel kanallar, filmler, diziler ve TV rehberi için kaynaklarınız kontrol ediliyor.',
  'startup.refresh.cancelContinue': 'İptal et / Eski verilerle devam et',
  'startup.refresh.backgroundNote': 'Yenileme arka planda sessizce devam edecektir.',

  // Original Evening & Cinema Quotes
  'onboarding.quote.1':
    'Işıkları kısın — güzel hikâyeler sakin bir odayı ve net bir görüntüyü hak eder.',
  'onboarding.quote.2': 'Unutulmaz her akşam, doğru film ve sıfır dikkat dağınıklığıyla başlar.',
  'onboarding.quote.3':
    'Sinema, oynatıcının geri çekilip görüntünün nefes almasına izin verdiği an en güzel hâlindedir.',
  'onboarding.quote.4':
    'Derin bir nefes alın, yerinize yerleşin; bu gece uykusuz kalmaya değer bir hikâye getirsin.',
  'onboarding.quote.5':
    'Sizin kütüphaneniz, sizin ritminiz — daha az kaydırıp daha çok izlemeniz için özenle düzenlendi.',
  'onboarding.quote.6':
    'Sinemanın en iyi koltuğu her zaman tam da oturma odanızda sizi bekleyendir.',
};
