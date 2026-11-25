import { describe, expect, it } from 'vitest';
import enPo from '../locales/en/messages.po?raw';
import trPo from '../locales/tr/messages.po?raw';
import { createAppI18n, type MessageId } from './index';
import { enWaveF7aMessages } from './locales/en-wave-f7a';
import { trWaveF7aMessages } from './locales/tr-wave-f7a';

const EXPECTED_PAIRS: ReadonlyArray<readonly [MessageId, string, string]> = [
  // #116, #188, #199, #214 Display AFR & HDR
  ['settings.playback.autoFrameRateTitle', 'Match frame rate', 'Kare hızını eşleştir'],
  [
    'settings.playback.autoFrameRateDescription',
    'Switch display refresh rate to match video frame rate for smoother motion.',
    'Daha akıcı görüntü için ekran yenileme hızını video kare hızıyla eşleştirir.',
  ],
  ['settings.playback.autoFrameRateOff', 'Off', 'Kapalı'],
  ['settings.playback.autoFrameRateSeamless', 'Seamless only', 'Yalnızca kesintisiz'],
  ['settings.playback.autoFrameRateAlways', 'Always', 'Her zaman'],
  ['settings.playback.autoDynamicRangeTitle', 'Match dynamic range', 'Dinamik aralığı eşleştir'],
  [
    'settings.playback.autoDynamicRangeDescription',
    'Automatically switch display output between SDR, HDR10, HLG, and Dolby Vision.',
    'Ekran çıkışını SDR, HDR10, HLG ve Dolby Vision arasında otomatik değiştirir.',
  ],

  // #115 Night-Mode DRC & Per-Refresh-Rate Audio Delay
  [
    'settings.playback.nightModeDrcTitle',
    'Night mode (dynamic range)',
    'Gece modu (dinamik aralık)',
  ],
  [
    'settings.playback.nightModeDrcDescription',
    'Compress loud sound effects and boost quiet dialogue for late-night viewing.',
    'Gece izlerken yüksek ses efektlerini kısar ve alçak diyalogları netleştirir.',
  ],
  ['settings.playback.nightModeDrcOff', 'Off', 'Kapalı'],
  ['settings.playback.nightModeDrcLight', 'Light', 'Hafif'],
  ['settings.playback.nightModeDrcNight', 'Night', 'Gece'],
  [
    'settings.playback.refreshRateAudioDelayTitle',
    'Per-refresh-rate audio delay',
    'Yenileme hızına göre ses gecikmesi',
  ],
  [
    'settings.playback.refreshRateAudioDelayDescription',
    'Apply fine audio sync offsets automatically for each display refresh rate.',
    'Her ekran yenileme hızı için ayrı ses eşitleme gecikmesini otomatik uygular.',
  ],

  // #213 Desktop Audio Passthrough & Channel Layout
  [
    'settings.desktop.audioPassthroughTitle',
    'Audio passthrough (bitstream)',
    'Ses doğrudan aktarımı (bit akışı)',
  ],
  [
    'settings.desktop.audioPassthroughDescription',
    'Send encoded surround audio directly to an external receiver over HDMI or optical.',
    'Kodlanmış çevresel sesi HDMI veya optik çıkışla doğrudan harici alıcıya gönderir.',
  ],
  [
    'settings.desktop.audioPassthroughCodecsTitle',
    'Passthrough codecs',
    'Doğrudan aktarım çözücüleri',
  ],
  ['settings.desktop.audioExclusiveTitle', 'Exclusive audio device', 'Özel ses aygıtı modu'],
  [
    'settings.desktop.audioExclusiveDescription',
    'Request exclusive OS audio output to bypass system mixing during playback.',
    'Oynatma sırasında sistem karıştırıcısını atlamak için ses çıkışını özel modda kullanır.',
  ],
  [
    'settings.desktop.audioAc3EncodeTitle',
    'Real-time AC-3 encoding',
    'Gerçek zamanlı AC-3 kodlama',
  ],
  [
    'settings.desktop.audioAc3EncodeDescription',
    'Encode multichannel audio to AC-3 for optical S/PDIF receivers.',
    'Çok kanallı sesi optik S/PDIF alıcılar için gerçek zamanlı AC-3 olarak kodlar.',
  ],
  ['settings.desktop.audioChannelLayoutTitle', 'Speaker channel layout', 'Hoparlör kanal düzeni'],
  ['settings.desktop.audioChannelLayoutAuto', 'Auto', 'Otomatik'],
  ['settings.desktop.audioChannelLayoutStereo', 'Stereo (2.0)', 'Stereo (2.0)'],
  ['settings.desktop.audioChannelLayout51', '5.1 Surround', '5.1 Çevresel'],
  ['settings.desktop.audioChannelLayout71', '7.1 Surround', '7.1 Çevresel'],

  // Player notices & errors (#213, #272)
  [
    'player.audio.passthroughFallbackNotice',
    'Audio passthrough unavailable on this device — switched to PCM.',
    'Bu cihazda ses doğrudan aktarımı kullanılamıyor — PCM çıkışına geçildi.',
  ],
  [
    'player.error.drmUnsupported',
    'Protected stream cannot be played on this device.',
    'Korumalı yayın bu cihazda oynatılamıyor.',
  ],
];

const WAVE_F7A_KEYS: readonly MessageId[] = EXPECTED_PAIRS.map(([id]) => id);

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

describe('Wave F7A AFR/HDR, Desktop Audio Passthrough, Night-Mode DRC & DRM i18n (#115, #116, #188, #199, #213, #214, #272)', () => {
  it('defines all 28 EN and TR keys with strict parity, .po sync, and clean copy', () => {
    expect(WAVE_F7A_KEYS).toHaveLength(28);
    expect(Object.keys(enWaveF7aMessages).sort()).toEqual([...WAVE_F7A_KEYS].sort());
    expect(Object.keys(trWaveF7aMessages).sort()).toEqual([...WAVE_F7A_KEYS].sort());

    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const enPoMap = parsePoEntries(enPo);
    const trPoMap = parsePoEntries(trPo);

    const forbidden = new RegExp(
      `\\b(${['d' + 'vr', 'record' + 'ing', 'tivi' + 'mate', 'smar' + 'ters', 'v' + 'lc', 'ko' + 'di', 'pl' + 'ex', 'em' + 'by', 'jelly' + 'fin'].join('|')})\\b`,
      'i',
    );

    for (const [key, expectedEn, expectedTr] of EXPECTED_PAIRS) {
      const enRaw = enWaveF7aMessages[key as keyof typeof enWaveF7aMessages];
      const trRaw = trWaveF7aMessages[key as keyof typeof trWaveF7aMessages];
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
