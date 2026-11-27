import { describe, expect, it } from 'vitest';
import enPo from '../locales/en/messages.po?raw';
import trPo from '../locales/tr/messages.po?raw';
import { createAppI18n, type MessageId } from './index';
import { enWaveP9Messages } from './locales/en-wave-p9';
import { trWaveP9Messages } from './locales/tr-wave-p9';

const EXPECTED_PAIRS: ReadonlyArray<readonly [MessageId, string, string]> = [
  // Unified Diagnostics & Privacy Consent ([1.6])
  ['settings.diagnostics.unifiedTitle', 'Diagnostics & performance', 'Tanılama ve performans'],
  [
    'settings.diagnostics.unifiedToggle',
    'Share anonymous diagnostics & performance data',
    'Anonim tanılama ve performans verisi paylaş',
  ],
  [
    'settings.diagnostics.unifiedDescription',
    'Helps us catch crashes, slow loads, and playback errors faster. Zero playlists, watch history, or personal info are ever sent.',
    'Çökmeleri, yavaş yüklemeleri ve oynatma hatalarını hızla düzeltmemize yardımcı olur. Çalma listeleri, izleme geçmişi veya kişisel veriler asla gönderilmez.',
  ],
  ['privacy.consent.title', 'Privacy & Diagnostics', 'Gizlilik ve Tanılama'],
  [
    'privacy.consent.body',
    'ELV IPTV keeps your playlists and watch history private on your device (or end-to-end encrypted when you sign in). You can optionally share anonymous crash and performance metrics to help improve stability.',
    'ELV IPTV çalma listelerinizi ve izleme geçmişinizi cihazınızda gizli tutar (giriş yaptığınızda uçtan uca şifrelenir). Kararlılığı iyileştirmek için isteğe bağlı olarak anonim çökme ve performans verisi paylaşabilirsiniz.',
  ],
  [
    'privacy.consent.telemetryToggle',
    'Help improve ELV IPTV with anonymous diagnostics',
    "Anonim tanılama verisiyle ELV IPTV'yi geliştirmeye yardımcı ol",
  ],
  ['privacy.consent.continue', 'Continue', 'Devam et'],

  // Automatic E2EE Sync ([1.44])
  ['account.sync.autoBadge', 'Automatic sync active', 'Otomatik eşitleme etkin'],
  ['account.sync.statusSyncing', 'Syncing encrypted vault…', 'Şifreli kasa eşitleniyor…'],
  ['account.sync.statusUpToDate', 'All devices up to date', 'Tüm cihazlar güncel'],
  ['account.sync.statusPending', 'Changes queued for sync', 'Değişiklikler eşitleme kuyruğunda'],
  [
    'account.sync.statusOffline',
    'Offline — will sync automatically when connected',
    'Çevrimdışı — bağlantı kurulduğunda otomatik eşitlenecek',
  ],
  ['account.sync.lastSynced', 'Last synced: {time}', 'Son eşitleme: {time}'],
  ['account.sync.manualFallback', 'Sync now', 'Şimdi eşitle'],

  // Bidirectional Single-QR + 8-Digit X25519 Pairing ([1.45])
  ['pair.title', 'Pair another device', 'Başka cihazla eşleştir'],
  [
    'pair.subtitle',
    'Scan this QR code or enter the 8-digit code on your other device. Account direction is detected automatically.',
    'Bu QR kodu tarayın veya 8 haneli kodu diğer cihazınızda girin. Aktarım yönü otomatik algılanır.',
  ],
  ['pair.codeLabel', '8-digit pairing code', '8 haneli eşleştirme kodu'],
  ['pair.enterCodeLabel', 'Or enter a code from another device', 'Veya başka cihazdaki kodu girin'],
  ['pair.enterCodePlaceholder', '0000 0000', '0000 0000'],
  ['pair.connectButton', 'Connect', 'Bağlan'],
  ['pair.scanQrButton', 'Scan QR code', 'QR kod tara'],
  [
    'pair.cameraUnavailable',
    'Camera scanning is unavailable on this device — enter the 8-digit code instead.',
    'Bu cihazda kamera taraması kullanılamıyor — 8 haneli kodu girebilirsiniz.',
  ],
  ['pair.sasTitle', 'Verify security code', 'Güvenlik kodunu doğrula'],
  [
    'pair.sasBody',
    'Confirm both devices show the same 4-digit security code before transferring your encrypted account:',
    'Şifreli hesabınızı aktarmadan önce her iki cihazda da aynı 4 haneli güvenlik kodunun göründüğünü doğrulayın:',
  ],
  ['pair.sasConfirm', 'Codes match — confirm', 'Kodlar eşleşiyor — onayla'],
  ['pair.sasCancel', 'Cancel', 'İptal'],
  ['pair.caseNeitherTitle', 'Sign in on one device first', 'Önce bir cihazda giriş yapın'],
  [
    'pair.caseNeitherBody',
    'Neither device is signed in yet. Sign in or create an account on either device, then pair again.',
    'Henüz iki cihazda da oturum açık değil. Cihazlardan birinde giriş yapın veya hesap oluşturun, ardından tekrar eşleştirin.',
  ],
  ['pair.caseSameAccountTitle', 'Already on the same account', 'Zaten aynı hesaptasınız'],
  [
    'pair.caseSameAccountBody',
    'Both devices are signed in to {email}. Triggering an immediate sync now.',
    'Her iki cihaz da {email} hesabında açık. Şimdi anlık eşitleme başlatılıyor.',
  ],
  [
    'pair.caseTransferToOther',
    'Sign in the other device as {email}?',
    'Diğer cihazda {email} hesabıyla oturum açılsın mı?',
  ],
  [
    'pair.caseReceiveFromOther',
    'Sign in this device as {email}?',
    'Bu cihazda {email} hesabıyla oturum açılsın mı?',
  ],
  ['pair.caseDifferentTitle', 'Two different accounts detected', 'İki farklı hesap algılandı'],
  [
    'pair.caseDifferentBody',
    'Choose which account both devices should use. The replaced device will switch to the selected account.',
    'Her iki cihazın hangi hesabı kullanacağını seçin. Değiştirilen cihaz seçili hesaba geçecektir.',
  ],
  [
    'pair.useThisAccount',
    "Keep this device's account ({email})",
    'Bu cihazın hesabını kullan ({email})',
  ],
  [
    'pair.useOtherAccount',
    "Switch to other device's account ({email})",
    'Diğer cihazın hesabına geç ({email})',
  ],
  [
    'pair.waitingApproval',
    'Waiting for confirmation on the other device…',
    'Diğer cihazdan onay bekleniyor…',
  ],
  ['pair.success', 'Devices paired and synced!', 'Cihazlar eşleştirildi ve eşitlendi!'],
  [
    'pair.errorExpired',
    'Pairing code expired. Generate a new code to try again.',
    'Eşleştirme kodunun süresi doldu. Tekrar denemek için yeni kod oluşturun.',
  ],
  [
    'pair.errorLocked',
    'Too many failed attempts. Code locked for security — generate a new one.',
    'Çok fazla hatalı deneme. Kod güvenlik için kilitlendi — yeni kod oluşturun.',
  ],
  [
    'pair.errorInvalidCode',
    'Enter a valid 8-digit pairing code.',
    'Geçerli bir 8 haneli eşleştirme kodu girin.',
  ],
  [
    'pair.errorRejected',
    'Pairing was cancelled on the other device.',
    'Eşleştirme diğer cihazda iptal edildi.',
  ],
];

const WAVE_P9_KEYS: readonly MessageId[] = EXPECTED_PAIRS.map(([id]) => id);

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

describe('Wave P9 unified diagnostics, auto-sync, and bidirectional X25519 pairing i18n (#509, #510)', () => {
  it('defines all 42 EN and TR keys with strict parity, .po sync, and zero forbidden copy', () => {
    expect(WAVE_P9_KEYS).toHaveLength(42);
    expect(Object.keys(enWaveP9Messages).sort()).toEqual([...WAVE_P9_KEYS].sort());
    expect(Object.keys(trWaveP9Messages).sort()).toEqual([...WAVE_P9_KEYS].sort());

    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const enPoMap = parsePoEntries(enPo);
    const trPoMap = parsePoEntries(trPo);

    const forbidden = new RegExp(
      `\\b(${['d' + 'vr', 'record' + 'ing', 'tivi' + 'mate', 'smar' + 'ters', 'v' + 'lc', 'ko' + 'di', 'pl' + 'ex', 'em' + 'by', 'jelly' + 'fin', 'inf' + 'use'].join('|')})\\b`,
      'i',
    );

    for (const [key, expectedEn, expectedTr] of EXPECTED_PAIRS) {
      const enRaw = enWaveP9Messages[key as keyof typeof enWaveP9Messages];
      const trRaw = trWaveP9Messages[key as keyof typeof trWaveP9Messages];
      expect(enRaw).toBe(expectedEn);
      expect(trRaw).toBe(expectedTr);
      expect(enRaw.trim().length, `empty EN for ${key}`).toBeGreaterThan(0);
      expect(trRaw.trim().length, `empty TR for ${key}`).toBeGreaterThan(0);
      expect(enRaw, `forbidden word in EN ${key}`).not.toMatch(forbidden);
      expect(trRaw, `forbidden word in TR ${key}`).not.toMatch(forbidden);
      expect(enPoMap[key], `missing/mismatched EN .po for ${key}`).toBe(enRaw);
      expect(trPoMap[key], `missing/mismatched TR .po for ${key}`).toBe(trRaw);
      if (!expectedEn.includes('{')) {
        expect(en.t(key)).toBe(expectedEn);
        expect(tr.t(key)).toBe(expectedTr);
      }
    }
  });

  it('interpolates Wave P9 sync time and masked email placeholders cleanly in EN and TR', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');

    expect(en.t('account.sync.lastSynced', { time: '12:34' })).toBe('Last synced: 12:34');
    expect(tr.t('account.sync.lastSynced', { time: '12:34' })).toBe('Son eşitleme: 12:34');

    const masked = 'a***@example.com';
    expect(en.t('pair.caseSameAccountBody', { email: masked })).toBe(
      'Both devices are signed in to a***@example.com. Triggering an immediate sync now.',
    );
    expect(tr.t('pair.caseSameAccountBody', { email: masked })).toBe(
      'Her iki cihaz da a***@example.com hesabında açık. Şimdi anlık eşitleme başlatılıyor.',
    );
    expect(en.t('pair.caseTransferToOther', { email: masked })).toBe(
      'Sign in the other device as a***@example.com?',
    );
    expect(tr.t('pair.caseTransferToOther', { email: masked })).toBe(
      'Diğer cihazda a***@example.com hesabıyla oturum açılsın mı?',
    );
    expect(en.t('pair.caseReceiveFromOther', { email: masked })).toBe(
      'Sign in this device as a***@example.com?',
    );
    expect(tr.t('pair.caseReceiveFromOther', { email: masked })).toBe(
      'Bu cihazda a***@example.com hesabıyla oturum açılsın mı?',
    );
    expect(en.t('pair.useThisAccount', { email: masked })).toBe(
      "Keep this device's account (a***@example.com)",
    );
    expect(tr.t('pair.useThisAccount', { email: masked })).toBe(
      'Bu cihazın hesabını kullan (a***@example.com)',
    );
    expect(en.t('pair.useOtherAccount', { email: masked })).toBe(
      "Switch to other device's account (a***@example.com)",
    );
    expect(tr.t('pair.useOtherAccount', { email: masked })).toBe(
      'Diğer cihazın hesabına geç (a***@example.com)',
    );
  });
});
