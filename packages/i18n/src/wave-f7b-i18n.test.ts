import { describe, expect, it } from 'vitest';
import enPo from '../locales/en/messages.po?raw';
import trPo from '../locales/tr/messages.po?raw';
import { createAppI18n, type MessageId } from './index';
import { enWaveF7bMessages } from './locales/en-wave-f7b';
import { trWaveF7bMessages } from './locales/tr-wave-f7b';

const EXPECTED_PAIRS: ReadonlyArray<readonly [MessageId, string, string]> = [
  // #258 External display
  ['player.externalDisplay.title', 'Playing on external display', 'Harici ekranda oynatılıyor'],
  [
    'player.externalDisplay.subtitle',
    'Video is routed to your connected TV or monitor.',
    'Video bağlı TV veya monitöre aktarılıyor.',
  ],
  [
    'player.externalDisplay.hint',
    'Use the controls below to pause, seek, or switch tracks.',
    'Duraklatmak, sarmak veya parça değiştirmek için aşağıdaki kontrolleri kullanın.',
  ],

  // #304 Multi-program MPEG-TS
  ['player.tracks.program', 'Program', 'Program'],
  ['player.tracks.programNumber', 'Program {number}', 'Program {number}'],

  // #406 External player
  ['settings.playback.externalPlayerTitle', 'External player', 'Harici oynatıcı'],
  [
    'settings.playback.externalPlayerHint',
    'Hand off stream playback to another installed media player app.',
    'Yayın oynatmayı cihazda yüklü başka bir medya oynatıcı uygulamasına devreder.',
  ],
  ['settings.playback.externalPlayerOff', 'Off', 'Kapalı'],
  ['settings.playback.externalPlayerAsk', 'Ask every time', 'Her seferinde sor'],
  ['settings.playback.externalPlayerAlways', 'Always', 'Her zaman'],
  [
    'settings.playback.externalPlayerSchemeLabel',
    'Custom player URL scheme (optional)',
    'Özel oynatıcı URL şeması (isteğe bağlı)',
  ],
  ['settings.playback.externalPlayerSchemePlaceholder', 'e.g. myplayer', 'örn. oynatici'],
  ['player.externalPrompt.title', 'Open stream with', 'Yayını şununla aç'],
  [
    'player.externalPrompt.subtitle',
    'Choose whether to play inside ELV IPTV or hand off to an external player.',
    'ELV IPTV içinde oynatmayı veya harici bir oynatıcıya devretmeyi seçin.',
  ],
  ['player.externalPrompt.integrated', 'Built-in player', 'Dahili oynatıcı'],
  ['player.externalPrompt.external', 'External player', 'Harici oynatıcı'],
  ['player.externalPrompt.cancel', 'Cancel', 'İptal'],
  [
    'player.externalHandoff.failed',
    'Could not open the external player on this device.',
    'Bu cihazda harici oynatıcı açılamadı.',
  ],

  // #226 Crash diagnostics
  ['settings.diagnostics.title', 'Crash diagnostics', 'Çökme tanılama'],
  [
    'settings.diagnostics.optInLabel',
    'Enable diagnostic crash reports',
    'Tanılama çökme raporlarını etkinleştir',
  ],
  [
    'settings.diagnostics.optInHint',
    'Generate redacted Markdown reports locally when an unexpected error occurs.',
    'Beklenmeyen bir hata oluştuğunda yerel olarak gizlenmiş Markdown raporları oluşturur.',
  ],
  [
    'settings.diagnostics.includeLogsLabel',
    'Include recent redacted logs',
    'Son gizlenmiş günlükleri ekle',
  ],
  [
    'settings.diagnostics.includeLogsHint',
    'Attach up to 250 recent redacted log lines when preparing a report.',
    'Rapor hazırlarken en fazla 250 son gizlenmiş günlük satırı ekler.',
  ],
  ['settings.diagnostics.previewAction', 'Preview diagnostic report', 'Tanılama raporunu önizle'],
  ['crash.diagnosticsAction', 'View diagnostics', 'Tanılamayı görüntüle'],
  ['crash.report.title', 'Diagnostic report', 'Tanılama raporu'],
  [
    'crash.report.subtitle',
    'Credentials, stream URLs, and home paths are redacted before display or export.',
    'Kimlik bilgileri, yayın adresleri ve kullanıcı yolları görüntüleme veya dışa aktarma öncesinde gizlenir.',
  ],
  ['crash.report.includeLogsToggle', 'Include recent logs', 'Son günlükleri ekle'],
  ['crash.report.copy', 'Copy report', 'Raporu kopyala'],
  ['crash.report.copied', 'Copied to clipboard', 'Panoya kopyalandı'],
  ['crash.report.export', 'Export Markdown', 'Markdown dışa aktar'],
  ['crash.report.exported', 'Report exported', 'Rapor dışa aktarıldı'],
  ['crash.report.close', 'Close', 'Kapat'],
  [
    'crash.report.emptyLogs',
    'No recent diagnostic logs captured.',
    'Yakalanan son tanılama günlüğü yok.',
  ],
];

const WAVE_F7B_KEYS: readonly MessageId[] = EXPECTED_PAIRS.map(([id]) => id);

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

describe('Wave F7B external display, multi-program TS, external player & crash diagnostics i18n (#258, #304, #406, #226)', () => {
  it('defines all 34 EN and TR keys with strict parity, .po sync, and clean copy', () => {
    expect(WAVE_F7B_KEYS).toHaveLength(34);
    expect(Object.keys(enWaveF7bMessages).sort()).toEqual([...WAVE_F7B_KEYS].sort());
    expect(Object.keys(trWaveF7bMessages).sort()).toEqual([...WAVE_F7B_KEYS].sort());

    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const enPoMap = parsePoEntries(enPo);
    const trPoMap = parsePoEntries(trPo);

    const forbidden = new RegExp(
      `\\b(${['d' + 'vr', 'record' + 'ing', 'tivi' + 'mate', 'smar' + 'ters', 'v' + 'lc', 'ko' + 'di', 'pl' + 'ex', 'em' + 'by', 'jelly' + 'fin', 'inf' + 'use'].join('|')})\\b`,
      'i',
    );

    for (const [key, expectedEn, expectedTr] of EXPECTED_PAIRS) {
      const enRaw = enWaveF7bMessages[key as keyof typeof enWaveF7bMessages];
      const trRaw = trWaveF7bMessages[key as keyof typeof trWaveF7bMessages];
      expect(enRaw).toBe(expectedEn);
      expect(trRaw).toBe(expectedTr);
      expect(enRaw.trim().length, `empty EN for ${key}`).toBeGreaterThan(0);
      expect(trRaw.trim().length, `empty TR for ${key}`).toBeGreaterThan(0);
      expect(enRaw, `forbidden word in EN ${key}`).not.toMatch(forbidden);
      expect(trRaw, `forbidden word in TR ${key}`).not.toMatch(forbidden);
      expect(enPoMap[key], `missing/mismatched EN .po for ${key}`).toBe(enRaw);
      expect(trPoMap[key], `missing/mismatched TR .po for ${key}`).toBe(trRaw);
      if (key === 'player.tracks.programNumber') {
        expect(en.t(key, { number: 3 })).toBe('Program 3');
        expect(tr.t(key, { number: 3 })).toBe('Program 3');
      } else {
        expect(en.t(key)).toBe(expectedEn);
        expect(tr.t(key)).toBe(expectedTr);
      }
    }
  });
});
