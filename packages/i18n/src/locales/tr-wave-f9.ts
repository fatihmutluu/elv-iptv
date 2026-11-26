import type { WaveF9MessageId } from './en-wave-f9';

/** Turkish (`tr`) messages for Wave F9 E2EE sync, welcome, QR pairing, telemetry & feedback (`#26`, `#458`). */
export const trWaveF9Messages: Readonly<Record<WaveF9MessageId, string>> = {
  // Settings tabs
  'settings.section.account': 'Hesap ve Eşitleme',
  'settings.section.feedback': 'Geri Bildirim ve Telemetri',

  // First-run Welcome Sign In / Create Account screen
  'welcome.title': 'Tüm Ekranlarınızda Eşitleyin',
  'welcome.subtitle':
    'Oynatma listelerinizi, favorilerinizi ve izleme ilerlemenizi TV, mobil ve masaüstünde uçtan uca şifreli olarak eşitlemek için giriş yapın.',
  'welcome.tabSignIn': 'Giriş Yap',
  'welcome.tabCreateAccount': 'Hesap Oluştur',
  'welcome.tabPairQr': 'QR ile Eşleştir',
  'welcome.continueWithoutAccount': 'Hesapsız devam et',
  'welcome.localOnlyNote':
    'Tüm oynatma ve liste özellikleri hesap olmadan tamamen yerel olarak çalışır.',

  // Auth & Account form/panel
  'account.title': 'Eşitleme Hesabı',
  'account.subtitle':
    'Sıfır bilgili uçtan uca şifreli eşitleme. Sağlayıcı bilgileriniz cihazınızdan şifresiz çıkmaz.',
  'account.emailLabel': 'E-posta',
  'account.emailPlaceholder': 'ornek@eposta.com',
  'account.passwordLabel': 'Şifre',
  'account.passwordPlaceholder': 'En az 10 karakter',
  'account.confirmPasswordLabel': 'Şifreyi onayla',
  'account.confirmPasswordPlaceholder': 'Şifreyi tekrar girin',
  'account.signInAction': 'Giriş Yap',
  'account.createAccountAction': 'Hesap Oluştur',
  'account.signOutAction': 'Çıkış Yap',
  'account.syncNowAction': 'Şimdi Eşitle',
  'account.syncingStatus': 'Şifreli kasa eşitleniyor...',
  'account.syncedStatus': 'Şifreli kasa güncel',
  'account.signedInAs': 'Giriş yapılan hesap',
  'account.serverUrlLabel': 'Eşitleme sunucusu adresi (isteğe bağlı)',
  'account.oauthComingSoon':
    'E-posta ve şifrenizle giriş yapın veya bu cihazı QR kod ile eşleştirin.',
  'account.recoveryTitle': 'Kurtarma Kodunuzu Kaydedin',
  'account.recoveryBody':
    'Bu kurtarma kodunu çevrimdışı saklayın. Eşitleme uçtan uca şifreli olduğu için bu kod olmadan kasa anahtarınız sıfırlanamaz.',
  'account.recoverySavedAction': 'Kurtarma Kodumu Kaydettim',
  'account.qrTitle': 'QR ile Başka Cihaz Eşleştir',
  'account.qrBody':
    'Otomatik giriş yapmak için telefon, tablet veya masaüstündeki giriş yapılmış ELV IPTV uygulamasından bu QR kodu tarayın.',
  'account.qrGenerateAction': 'Eşleştirme QR Göster',
  'account.qrClaimTitle': 'Cihaz Eşleştirmeyi Onayla',
  'account.qrClaimInputLabel': 'Eşleştirme kodu veya QR bağlantısı',
  'account.qrClaimAction': 'Eşleştirmeyi Onayla',
  'account.qrClaimSignInFirst':
    'Bu cihazı eşleştirmeyi tamamlamak için önce giriş yapın veya hesap oluşturun.',
  'account.qrClaimSuccess': 'Cihaz güvenle eşleştirildi.',
  'account.qrExpired': 'Eşleştirme kodunun süresi doldu. Yeni kod oluşturun.',
  'account.deleteTitle': 'Hesabı Kalıcı Olarak Sil',
  'account.deleteBody':
    'Eşitleme hesabınızı, şifreli kasanızı ve aktif oturumlarınızı sunucudan kalıcı olarak siler. Bu cihazdaki yerel listeleriniz korunur.',
  'account.deleteAction': 'Hesabı Kalıcı Olarak Sil',
  'account.deleteConfirmAction': 'Kalıcı Silmeyi Onayla',
  'account.deleteCancelAction': 'İptal',
  'account.deleteSuccess': 'Hesabınız kalıcı olarak silindi.',
  'account.errorInvalidEmail': 'Geçerli bir e-posta adresi girin.',
  'account.errorWeakPassword': 'Şifre en az 10 karakter olmalıdır.',
  'account.errorPasswordMismatch': 'Şifreler eşleşmiyor.',
  'account.errorGeneric':
    'Eşitleme isteği başarısız oldu. Bağlantınızı kontrol edip tekrar deneyin.',

  // Telemetry & Feedback panel
  'telemetry.title': 'İsteğe Bağlı Çalışma Telemetrisi',
  'telemetry.subtitle':
    'Açılış hızını, akıcılığı ve oynatma kodek uyumluluğunu iyileştirmemize yardımcı olun. Tamamen isteğe bağlıdır; asla adres, şifre veya izlenen içerik adlarını toplamaz.',
  'telemetry.optInLabel': 'Anonim performans ve kodek tanılamalarını paylaş',
  'telemetry.previewAction': 'JSON Verisini Önizle',
  'telemetry.hidePreviewAction': 'Önizlemeyi Gizle',
  'telemetry.queuedLabel': 'Kuyruktaki olaylar',
  'feedback.title': 'Geri Bildirim ve Sorun Bildir',
  'feedback.subtitle':
    'Oynatma hatası, EPG uyumsuzluğu veya geliştirme önerinizi doğrudan ELV IPTV ekibine iletin.',
  'feedback.categoryLabel': 'Kategori',
  'feedback.catPlayback': 'Oynatma Sorunu',
  'feedback.catChannelEpg': 'Kanal / EPG',
  'feedback.catUiRemote': 'Arayüz ve Kumanda',
  'feedback.catSyncAccount': 'Eşitleme ve Hesap',
  'feedback.catFeature': 'Özellik İsteği',
  'feedback.catOther': 'Diğer',
  'feedback.messageLabel': 'Açıklama',
  'feedback.messagePlaceholder': 'Ne olduğunu veya neyi iyileştirebileceğimizi yazın...',
  'feedback.attachDiagnosticsLabel':
    'Kişisel bilgileri temizlenmiş cihaz ve kodek bilgilerini ekle',
  'feedback.submitAction': 'Geri Bildirim Gönder',
  'feedback.sendingStatus': 'Geri bildirim gönderiliyor...',
  'feedback.sentSuccess': 'Teşekkürler! Geri bildiriminiz alındı.',
  'feedback.errorEmpty': 'Göndermeden önce lütfen kısa bir açıklama yazın.',
  'feedback.errorFailed': 'Geri bildirim şu an gönderilemedi. Lütfen daha sonra tekrar deneyin.',
};
