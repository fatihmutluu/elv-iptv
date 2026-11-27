import type { WaveP9MessageId } from './en-wave-p9';

/** Turkish (`tr`) messages for Wave P9 unified diagnostics, auto-sync, and bidirectional X25519 pairing (`#509`, `#510`). */
export const trWaveP9Messages: Readonly<Record<WaveP9MessageId, string>> = {
  // Unified Diagnostics & Privacy Consent ([1.6])
  'settings.diagnostics.unifiedTitle': 'Tanılama ve performans',
  'settings.diagnostics.unifiedToggle': 'Anonim tanılama ve performans verisi paylaş',
  'settings.diagnostics.unifiedDescription':
    'Çökmeleri, yavaş yüklemeleri ve oynatma hatalarını hızla düzeltmemize yardımcı olur. Çalma listeleri, izleme geçmişi veya kişisel veriler asla gönderilmez.',
  'privacy.consent.title': 'Gizlilik ve Tanılama',
  'privacy.consent.body':
    'ELV IPTV çalma listelerinizi ve izleme geçmişinizi cihazınızda gizli tutar (giriş yaptığınızda uçtan uca şifrelenir). Kararlılığı iyileştirmek için isteğe bağlı olarak anonim çökme ve performans verisi paylaşabilirsiniz.',
  'privacy.consent.telemetryToggle':
    "Anonim tanılama verisiyle ELV IPTV'yi geliştirmeye yardımcı ol",
  'privacy.consent.continue': 'Devam et',

  // Automatic E2EE Sync ([1.44])
  'account.sync.autoBadge': 'Otomatik eşitleme etkin',
  'account.sync.statusSyncing': 'Şifreli kasa eşitleniyor…',
  'account.sync.statusUpToDate': 'Tüm cihazlar güncel',
  'account.sync.statusPending': 'Değişiklikler eşitleme kuyruğunda',
  'account.sync.statusOffline': 'Çevrimdışı — bağlantı kurulduğunda otomatik eşitlenecek',
  'account.sync.lastSynced': 'Son eşitleme: {time}',
  'account.sync.manualFallback': 'Şimdi eşitle',

  // Bidirectional Single-QR + 8-Digit X25519 Pairing ([1.45])
  'pair.title': 'Başka cihazla eşleştir',
  'pair.subtitle':
    'Bu QR kodu tarayın veya 8 haneli kodu diğer cihazınızda girin. Aktarım yönü otomatik algılanır.',
  'pair.codeLabel': '8 haneli eşleştirme kodu',
  'pair.enterCodeLabel': 'Veya başka cihazdaki kodu girin',
  'pair.enterCodePlaceholder': '0000 0000',
  'pair.connectButton': 'Bağlan',
  'pair.scanQrButton': 'QR kod tara',
  'pair.cameraUnavailable':
    'Bu cihazda kamera taraması kullanılamıyor — 8 haneli kodu girebilirsiniz.',
  'pair.sasTitle': 'Güvenlik kodunu doğrula',
  'pair.sasBody':
    'Şifreli hesabınızı aktarmadan önce her iki cihazda da aynı 4 haneli güvenlik kodunun göründüğünü doğrulayın:',
  'pair.sasConfirm': 'Kodlar eşleşiyor — onayla',
  'pair.sasCancel': 'İptal',
  'pair.caseNeitherTitle': 'Önce bir cihazda giriş yapın',
  'pair.caseNeitherBody':
    'Henüz iki cihazda da oturum açık değil. Cihazlardan birinde giriş yapın veya hesap oluşturun, ardından tekrar eşleştirin.',
  'pair.caseSameAccountTitle': 'Zaten aynı hesaptasınız',
  'pair.caseSameAccountBody':
    'Her iki cihaz da {email} hesabında açık. Şimdi anlık eşitleme başlatılıyor.',
  'pair.caseTransferToOther': 'Diğer cihazda {email} hesabıyla oturum açılsın mı?',
  'pair.caseReceiveFromOther': 'Bu cihazda {email} hesabıyla oturum açılsın mı?',
  'pair.caseDifferentTitle': 'İki farklı hesap algılandı',
  'pair.caseDifferentBody':
    'Her iki cihazın hangi hesabı kullanacağını seçin. Değiştirilen cihaz seçili hesaba geçecektir.',
  'pair.useThisAccount': 'Bu cihazın hesabını kullan ({email})',
  'pair.useOtherAccount': 'Diğer cihazın hesabına geç ({email})',
  'pair.waitingApproval': 'Diğer cihazdan onay bekleniyor…',
  'pair.success': 'Cihazlar eşleştirildi ve eşitlendi!',
  'pair.errorExpired': 'Eşleştirme kodunun süresi doldu. Tekrar denemek için yeni kod oluşturun.',
  'pair.errorLocked': 'Çok fazla hatalı deneme. Kod güvenlik için kilitlendi — yeni kod oluşturun.',
  'pair.errorInvalidCode': 'Geçerli bir 8 haneli eşleştirme kodu girin.',
  'pair.errorRejected': 'Eşleştirme diğer cihazda iptal edildi.',
};
