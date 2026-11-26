import { describe, expect, it } from 'vitest';
import enPo from '../locales/en/messages.po?raw';
import trPo from '../locales/tr/messages.po?raw';
import { createAppI18n, type MessageId } from './index';
import { enWaveF9Messages } from './locales/en-wave-f9';
import { trWaveF9Messages } from './locales/tr-wave-f9';

const EXPECTED_PAIRS: ReadonlyArray<readonly [MessageId, string, string]> = [
  // Settings tabs
  ['settings.section.account', 'Account & Sync', 'Hesap ve Eşitleme'],
  ['settings.section.feedback', 'Feedback & Telemetry', 'Geri Bildirim ve Telemetri'],

  // First-run Welcome Sign In / Create Account screen
  ['welcome.title', 'Sync Across Every Screen', 'Tüm Ekranlarınızda Eşitleyin'],
  [
    'welcome.subtitle',
    'Sign in to keep your playlists, favorites, and watch progress end-to-end encrypted across TV, mobile, and desktop.',
    'Oynatma listelerinizi, favorilerinizi ve izleme ilerlemenizi TV, mobil ve masaüstünde uçtan uca şifreli olarak eşitlemek için giriş yapın.',
  ],
  ['welcome.tabSignIn', 'Sign In', 'Giriş Yap'],
  ['welcome.tabCreateAccount', 'Create Account', 'Hesap Oluştur'],
  ['welcome.tabPairQr', 'Pair via QR', 'QR ile Eşleştir'],
  ['welcome.continueWithoutAccount', 'Continue without account', 'Hesapsız devam et'],
  [
    'welcome.localOnlyNote',
    'All playback and playlist features work 100% locally without an account.',
    'Tüm oynatma ve liste özellikleri hesap olmadan tamamen yerel olarak çalışır.',
  ],

  // Auth & Account form/panel
  ['account.title', 'Sync Account', 'Eşitleme Hesabı'],
  [
    'account.subtitle',
    'Zero-knowledge end-to-end encrypted sync. Provider credentials never leave your devices unencrypted.',
    'Sıfır bilgili uçtan uca şifreli eşitleme. Sağlayıcı bilgileriniz cihazınızdan şifresiz çıkmaz.',
  ],
  ['account.emailLabel', 'Email', 'E-posta'],
  ['account.emailPlaceholder', 'you@example.com', 'ornek@eposta.com'],
  ['account.passwordLabel', 'Password', 'Şifre'],
  ['account.passwordPlaceholder', 'At least 10 characters', 'En az 10 karakter'],
  ['account.confirmPasswordLabel', 'Confirm password', 'Şifreyi onayla'],
  ['account.confirmPasswordPlaceholder', 'Re-enter password', 'Şifreyi tekrar girin'],
  ['account.signInAction', 'Sign In', 'Giriş Yap'],
  ['account.createAccountAction', 'Create Account', 'Hesap Oluştur'],
  ['account.signOutAction', 'Sign Out', 'Çıkış Yap'],
  ['account.syncNowAction', 'Sync Now', 'Şimdi Eşitle'],
  ['account.syncingStatus', 'Syncing encrypted vault...', 'Şifreli kasa eşitleniyor...'],
  ['account.syncedStatus', 'Encrypted vault up to date', 'Şifreli kasa güncel'],
  ['account.signedInAs', 'Signed in as', 'Giriş yapılan hesap'],
  [
    'account.serverUrlLabel',
    'Sync server URL (optional)',
    'Eşitleme sunucusu adresi (isteğe bağlı)',
  ],
  [
    'account.oauthComingSoon',
    'Sign in with your email and password, or pair this device with a QR code.',
    'E-posta ve şifrenizle giriş yapın veya bu cihazı QR kod ile eşleştirin.',
  ],
  ['account.recoveryTitle', 'Save Your Recovery Code', 'Kurtarma Kodunuzu Kaydedin'],
  [
    'account.recoveryBody',
    'Store this recovery code offline. Because sync is end-to-end encrypted, we cannot reset your vault key without it.',
    'Bu kurtarma kodunu çevrimdışı saklayın. Eşitleme uçtan uca şifreli olduğu için bu kod olmadan kasa anahtarınız sıfırlanamaz.',
  ],
  ['account.recoverySavedAction', 'I Saved My Recovery Code', 'Kurtarma Kodumu Kaydettim'],
  ['account.qrTitle', 'Pair Another Device via QR', 'QR ile Başka Cihaz Eşleştir'],
  [
    'account.qrBody',
    'Scan this QR code from a signed-in ELV IPTV app on your phone, tablet, or desktop to sign in automatically.',
    'Otomatik giriş yapmak için telefon, tablet veya masaüstündeki giriş yapılmış ELV IPTV uygulamasından bu QR kodu tarayın.',
  ],
  ['account.qrGenerateAction', 'Show Pairing QR', 'Eşleştirme QR Göster'],
  ['account.qrClaimTitle', 'Approve Device Pairing', 'Cihaz Eşleştirmeyi Onayla'],
  ['account.qrClaimInputLabel', 'Pairing code or QR link', 'Eşleştirme kodu veya QR bağlantısı'],
  ['account.qrClaimAction', 'Approve Pairing', 'Eşleştirmeyi Onayla'],
  [
    'account.qrClaimSignInFirst',
    'Sign in or create an account first to finish pairing this device.',
    'Bu cihazı eşleştirmeyi tamamlamak için önce giriş yapın veya hesap oluşturun.',
  ],
  ['account.qrClaimSuccess', 'Device paired securely.', 'Cihaz güvenle eşleştirildi.'],
  [
    'account.qrExpired',
    'Pairing code expired. Generate a new code.',
    'Eşleştirme kodunun süresi doldu. Yeni kod oluşturun.',
  ],
  ['account.deleteTitle', 'Delete Account Permanently', 'Hesabı Kalıcı Olarak Sil'],
  [
    'account.deleteBody',
    'Permanently erases your sync account, encrypted vault, and active sessions from the server. Local playlists on this device stay untouched.',
    'Eşitleme hesabınızı, şifreli kasanızı ve aktif oturumlarınızı sunucudan kalıcı olarak siler. Bu cihazdaki yerel listeleriniz korunur.',
  ],
  ['account.deleteAction', 'Delete Account Permanently', 'Hesabı Kalıcı Olarak Sil'],
  ['account.deleteConfirmAction', 'Confirm Permanent Deletion', 'Kalıcı Silmeyi Onayla'],
  ['account.deleteCancelAction', 'Cancel', 'İptal'],
  [
    'account.deleteSuccess',
    'Your account has been permanently deleted.',
    'Hesabınız kalıcı olarak silindi.',
  ],
  [
    'account.errorInvalidEmail',
    'Enter a valid email address.',
    'Geçerli bir e-posta adresi girin.',
  ],
  [
    'account.errorWeakPassword',
    'Password must be at least 10 characters.',
    'Şifre en az 10 karakter olmalıdır.',
  ],
  ['account.errorPasswordMismatch', 'Passwords do not match.', 'Şifreler eşleşmiyor.'],
  [
    'account.errorGeneric',
    'Sync request failed. Check your connection and try again.',
    'Eşitleme isteği başarısız oldu. Bağlantınızı kontrol edip tekrar deneyin.',
  ],

  // Telemetry & Feedback panel
  ['telemetry.title', 'Opt-In Runtime Telemetry', 'İsteğe Bağlı Çalışma Telemetrisi'],
  [
    'telemetry.subtitle',
    'Help improve startup speed, smoothness, and playback codec compatibility. Strictly opt-in; never collects URLs, credentials, or watched titles.',
    'Açılış hızını, akıcılığı ve oynatma kodek uyumluluğunu iyileştirmemize yardımcı olun. Tamamen isteğe bağlıdır; asla adres, şifre veya izlenen içerik adlarını toplamaz.',
  ],
  [
    'telemetry.optInLabel',
    'Share anonymous performance & codec diagnostics',
    'Anonim performans ve kodek tanılamalarını paylaş',
  ],
  ['telemetry.previewAction', 'Preview JSON Payload', 'JSON Verisini Önizle'],
  ['telemetry.hidePreviewAction', 'Hide Preview', 'Önizlemeyi Gizle'],
  ['telemetry.queuedLabel', 'Queued events', 'Kuyruktaki olaylar'],
  ['feedback.title', 'Feedback & Report Issue', 'Geri Bildirim ve Sorun Bildir'],
  [
    'feedback.subtitle',
    'Report a playback bug, EPG mismatch, or suggest an improvement directly to the ELV IPTV team.',
    'Oynatma hatası, EPG uyumsuzluğu veya geliştirme önerinizi doğrudan ELV IPTV ekibine iletin.',
  ],
  ['feedback.categoryLabel', 'Category', 'Kategori'],
  ['feedback.catPlayback', 'Playback Issue', 'Oynatma Sorunu'],
  ['feedback.catChannelEpg', 'Channel / EPG', 'Kanal / EPG'],
  ['feedback.catUiRemote', 'UI & Remote', 'Arayüz ve Kumanda'],
  ['feedback.catSyncAccount', 'Sync & Account', 'Eşitleme ve Hesap'],
  ['feedback.catFeature', 'Feature Request', 'Özellik İsteği'],
  ['feedback.catOther', 'Other', 'Diğer'],
  ['feedback.messageLabel', 'Details', 'Açıklama'],
  [
    'feedback.messagePlaceholder',
    'Describe what happened or what we can improve...',
    'Ne olduğunu veya neyi iyileştirebileceğimizi yazın...',
  ],
  [
    'feedback.attachDiagnosticsLabel',
    'Attach redacted device & codec diagnostics',
    'Kişisel bilgileri temizlenmiş cihaz ve kodek bilgilerini ekle',
  ],
  ['feedback.submitAction', 'Send Feedback', 'Geri Bildirim Gönder'],
  ['feedback.sendingStatus', 'Sending feedback...', 'Geri bildirim gönderiliyor...'],
  [
    'feedback.sentSuccess',
    'Thank you! Your feedback has been received.',
    'Teşekkürler! Geri bildiriminiz alındı.',
  ],
  [
    'feedback.errorEmpty',
    'Please write a brief description before sending.',
    'Göndermeden önce lütfen kısa bir açıklama yazın.',
  ],
  [
    'feedback.errorFailed',
    'Could not send feedback right now. Please try again later.',
    'Geri bildirim şu an gönderilemedi. Lütfen daha sonra tekrar deneyin.',
  ],
];

const WAVE_F9_KEYS: readonly MessageId[] = EXPECTED_PAIRS.map(([id]) => id);

function parsePoEntries(raw: string): Record<string, string> {
  const entries: Record<string, string> = {};
  let currentKey: 'msgid' | 'msgstr' | null = null;
  let msgid = '';
  let msgstr = '';

  const flush = () => {
    if (msgid !== '') entries[msgid] = msgstr;
    msgid = '';
    msgstr = '';
    currentKey = null;
  };

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      if (line === '') flush();
      continue;
    }
    if (line.startsWith('msgid ')) {
      flush();
      currentKey = 'msgid';
      msgid += JSON.parse(line.slice('msgid '.length).trim()) as string;
    } else if (line.startsWith('msgstr ')) {
      currentKey = 'msgstr';
      msgstr += JSON.parse(line.slice('msgstr '.length).trim()) as string;
    } else if (line.startsWith('"') && currentKey !== null) {
      if (currentKey === 'msgid') msgid += JSON.parse(line) as string;
      else msgstr += JSON.parse(line) as string;
    }
  }
  flush();
  return entries;
}

describe('Wave F9 E2EE sync, welcome, QR pairing, telemetry & feedback i18n (#26, #458)', () => {
  it('defines all 71 EN and TR keys with strict parity, .po sync, and clean copy', () => {
    expect(WAVE_F9_KEYS).toHaveLength(71);
    expect(Object.keys(enWaveF9Messages).sort()).toEqual([...WAVE_F9_KEYS].sort());
    expect(Object.keys(trWaveF9Messages).sort()).toEqual([...WAVE_F9_KEYS].sort());

    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const enPoMap = parsePoEntries(enPo);
    const trPoMap = parsePoEntries(trPo);

    const forbidden = new RegExp(
      `\\b(${['d' + 'vr', 'record' + 'ing', 'tivi' + 'mate', 'smar' + 'ters', 'v' + 'lc', 'ko' + 'di', 'pl' + 'ex', 'em' + 'by', 'jelly' + 'fin', 'inf' + 'use'].join('|')})\\b`,
      'i',
    );

    for (const [key, expectedEn, expectedTr] of EXPECTED_PAIRS) {
      const enRaw = enWaveF9Messages[key as keyof typeof enWaveF9Messages];
      const trRaw = trWaveF9Messages[key as keyof typeof trWaveF9Messages];
      expect(enRaw).toBe(expectedEn);
      expect(trRaw).toBe(expectedTr);
      expect(enRaw.trim().length, `empty EN for ${key}`).toBeGreaterThan(0);
      expect(trRaw.trim().length, `empty TR for ${key}`).toBeGreaterThan(0);
      expect(enRaw, `forbidden word in EN ${key}`).not.toMatch(forbidden);
      expect(trRaw, `forbidden word in TR ${key}`).not.toMatch(forbidden);
      expect(enPoMap[key], `missing/mismatched EN .po for ${key}`).toBe(enRaw);
      expect(trPoMap[key], `missing/mismatched TR .po for ${key}`).toBe(trRaw);
      expect(en.t(key)).toBe(expectedEn);
      expect(tr.t(key)).toBe(expectedTr);
    }
  });
});
