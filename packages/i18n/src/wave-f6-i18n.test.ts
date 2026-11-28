import { describe, expect, it } from 'vitest';
import enPo from '../locales/en/messages.po?raw';
import trPo from '../locales/tr/messages.po?raw';
import { createAppI18n, type MessageId } from './index';
import { enWaveF6Messages } from './locales/en-wave-f6';
import { trWaveF6Messages } from './locales/tr-wave-f6';

const EXPECTED_PAIRS: ReadonlyArray<readonly [MessageId, string, string]> = [
  // #34 OS Picture-in-Picture
  ['player.pip.enter', 'Picture-in-Picture', 'Pencere içinde pencere'],
  [
    'player.pip.unsupported',
    'Picture-in-Picture is unavailable for this stream',
    'Pencere içinde pencere bu yayın için kullanılamıyor',
  ],
  [
    'settings.playback.autoEnterPipTitle',
    'Auto-enter Picture-in-Picture',
    'Otomatik pencere içinde pencere',
  ],
  [
    'settings.playback.autoEnterPipDescription',
    'Keep video playing in a floating window when leaving the app.',
    'Uygulamadan çıkarken videoyu yüzen pencerede oynatmaya devam eder.',
  ],

  // #233 Floating Corner Mini-Player
  ['player.miniPlayer.minimize', 'Minimize player', 'Oynatıcıyı küçült'],
  ['player.miniPlayer.expand', 'Expand player', 'Oynatıcıyı büyüt'],
  ['player.miniPlayer.close', 'Close mini-player', 'Mini oynatıcıyı kapat'],
  ['player.miniPlayer.activeLabel', 'Mini-player active', 'Mini oynatıcı etkin'],

  // #34, #221, #232 Multi-View Grid + Connection & Thermal Clamps
  ['player.multiView.title', 'Multi-View', 'Çoklu Görünüm'],
  ['player.multiView.enter', 'Multi-View', 'Çoklu Görünüm'],
  ['player.multiView.exit', 'Exit Multi-View', 'Çoklu Görünümden çık'],
  ['player.multiView.addChannel', 'Add channel', 'Kanal ekle'],
  ['player.multiView.replaceChannel', 'Replace channel', 'Kanalı değiştir'],
  ['player.multiView.removeTile', 'Remove screen', 'Ekranı kaldır'],
  ['player.multiView.swapAudio', 'Switch audio here', 'Sesi buraya al'],
  ['player.multiView.activeAudio', 'Audio active', 'Ses etkin'],
  ['player.multiView.muted', 'Muted', 'Sessiz'],
  ['player.multiView.emptySlot', 'Add channel', 'Kanal ekle'],
  [
    'player.multiView.tileCount',
    '{count, plural, one {# screen} other {# screens}}',
    '{count} ekran',
  ],
  [
    'player.multiView.connectionLimitTitle',
    'Connection limit reached',
    'Bağlantı sınırına ulaşıldı',
  ],
  [
    'player.multiView.connectionLimitBody',
    'This source allows {active} / {max} active connections. Pick a channel from another source or close an open screen.',
    'Bu kaynak {active} / {max} etkin bağlantıya izin verir. Başka bir kaynaktan kanal seçin veya açık bir ekranı kapatın.',
  ],
  [
    'player.multiView.thermalSerious',
    'Device is warm — adding more screens is temporarily paused.',
    'Cihaz ısındı — yeni ekran ekleme geçici olarak duraklatıldı.',
  ],
  [
    'player.multiView.thermalCriticalShed',
    'Device overheated — secondary screens were closed to protect playback.',
    'Cihaz aşırı ısındı — oynatmayı korumak için ikincil ekranlar kapatıldı.',
  ],
  [
    'player.multiView.lowRamUnsupported',
    'Multi-View is unavailable on this low-memory device.',
    'Çoklu Görünüm bu düşük bellekli cihazda kullanılamıyor.',
  ],
  [
    'player.multiView.deviceCapReached',
    'This device supports up to {max} simultaneous screens.',
    'Bu cihaz en fazla {max} eşzamanlı ekranı destekler.',
  ],

  // #158 Desktop Popout Player Window & System Tray
  ['player.popout.open', 'Pop out player', 'Ayrı pencerede aç'],
  ['player.popout.dock', 'Return to main window', 'Ana pencereye dön'],
  ['player.popout.close', 'Close popout', 'Pencereyi kapat'],
  ['settings.desktop.minimizeToTrayTitle', 'Minimize to system tray', 'Sistem tepsisine küçült'],
  [
    'settings.desktop.minimizeToTrayDescription',
    'Keep the app running in the system tray when closing the main window.',
    'Ana pencere kapatıldığında uygulamayı sistem tepsisinde çalışır tutar.',
  ],
  ['desktop.tray.restore', 'Restore ELV IPTV', 'ELV IPTV penceresini göster'],
  ['desktop.tray.quit', 'Quit', 'Çıkış'],
];

const WAVE_F6_KEYS: readonly MessageId[] = EXPECTED_PAIRS.map(([id]) => id);

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

describe('Wave F6 PiP, Multi-View, Mini-Player & Desktop Tray/Popout i18n (#34, #158, #221, #232, #233)', () => {
  it('defines all 32 EN and TR keys with strict parity, .po sync, clean copy, and placeholder formatting', () => {
    expect(WAVE_F6_KEYS).toHaveLength(32);
    expect(Object.keys(enWaveF6Messages).sort()).toEqual([...WAVE_F6_KEYS].sort());
    expect(Object.keys(trWaveF6Messages).sort()).toEqual([...WAVE_F6_KEYS].sort());

    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const enPoMap = parsePoEntries(enPo);
    const trPoMap = parsePoEntries(trPo);

    const forbidden = new RegExp(
      `\\b(${['d' + 'vr', 'record' + 'ing', 'tivi' + 'mate', 'smar' + 'ters', 'v' + 'lc', 'ko' + 'di', 'pl' + 'ex', 'em' + 'by', 'jelly' + 'fin'].join('|')})\\b`,
      'i',
    );

    for (const [key, expectedEn, expectedTr] of EXPECTED_PAIRS) {
      const enRaw = enWaveF6Messages[key as keyof typeof enWaveF6Messages];
      const trRaw = trWaveF6Messages[key as keyof typeof trWaveF6Messages];
      expect(enRaw).toBe(expectedEn);
      expect(trRaw).toBe(expectedTr);
      expect(enRaw.trim().length, `empty EN for ${key}`).toBeGreaterThan(0);
      expect(trRaw.trim().length, `empty TR for ${key}`).toBeGreaterThan(0);
      expect(enRaw, `forbidden word in EN ${key}`).not.toMatch(forbidden);
      expect(trRaw, `forbidden word in TR ${key}`).not.toMatch(forbidden);
      expect(enPoMap[key], `missing/mismatched EN .po for ${key}`).toBe(enRaw);
      expect(trPoMap[key], `missing/mismatched TR .po for ${key}`).toBe(trRaw);
    }

    expect(en.t('player.multiView.tileCount', { count: 1 })).toBe('1 screen');
    expect(en.t('player.multiView.tileCount', { count: 4 })).toBe('4 screens');
    expect(tr.t('player.multiView.tileCount', { count: 1 })).toBe('1 ekran');
    expect(tr.t('player.multiView.tileCount', { count: 4 })).toBe('4 ekran');
    expect(en.t('player.multiView.connectionLimitBody', { active: 1, max: 1 })).toContain('1 / 1');
    expect(tr.t('player.multiView.connectionLimitBody', { active: 1, max: 1 })).toContain('1 / 1');
    expect(en.t('player.multiView.deviceCapReached', { max: 2 })).toContain('2');
    expect(tr.t('player.multiView.deviceCapReached', { max: 2 })).toContain('2');
    expect(en.t('desktop.tray.restore')).toBe('Restore ELV IPTV');
    expect(tr.t('desktop.tray.quit')).toBe('Çıkış');
  });
});
