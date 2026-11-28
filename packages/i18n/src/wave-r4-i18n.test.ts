import { describe, expect, it } from 'vitest';
import enPo from '../locales/en/messages.po?raw';
import trPo from '../locales/tr/messages.po?raw';
import { createAppI18n, enMessages, type MessageId, trMessages } from './index';

describe('Wave R4 i18n strings (player simplification & cleanup)', () => {
  it('defines EN and TR messages for Wave R4 player settings and window mode popup', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');

    const cases: ReadonlyArray<readonly [MessageId, string, string]> = [
      ['player.subtitleSettings', 'Subtitle settings', 'Altyazı ayarları'],
      ['player.audioSettings', 'Audio settings', 'Ses ayarları'],
      ['player.advancedSettings', 'Advanced settings', 'Gelişmiş ayarlar'],
      [
        'player.settings.desc.advanced',
        'Decoder, deinterlace and playback options',
        'Çözücü, taramasızlaştırma ve gelişmiş seçenekler',
      ],
      ['player.windowMode', 'Window mode', 'Pencere modu'],
      ['player.windowMode.mini', 'Mini player', 'Mini oynatıcı'],
      ['player.windowMode.popout', 'Separate window', 'Ayrı pencere'],
    ];

    for (const [id, expectedEn, expectedTr] of cases) {
      expect(en.t(id)).toBe(expectedEn);
      expect(tr.t(id)).toBe(expectedTr);
    }
  });

  it('removes deleted X-Ray, Chapters, and Always-on-top keys from TS catalogs and .po files', () => {
    const removedKeys = [
      'player.xray.button',
      'player.xray.title',
      'player.xray.cast',
      'player.xray.director',
      'player.xray.episode',
      'player.xray.viewLibrary',
      'player.xray.empty',
      'player.alwaysOnTop',
      'player.exitAlwaysOnTop',
      'player.settings.desc.alwaysOnTop',
      'player.popout.pin',
      'player.popout.unpin',
      'player.timeDisplayMode',
      'player.settings.desc.timeDisplay',
      'player.settings.desc.info',
      'player.chapters',
      'player.chapterCount',
      'player.prevChapter',
      'player.nextChapter',
      'player.settings.desc.chapters',
      'desktop.shortcuts.item.alwaysOnTop',
    ];

    const enRecord = enMessages as Record<string, string>;
    const trRecord = trMessages as Record<string, string>;
    for (const key of removedKeys) {
      expect(Object.hasOwn(enRecord, key), `unexpected key in enMessages: ${key}`).toBe(false);
      expect(Object.hasOwn(trRecord, key), `unexpected key in trMessages: ${key}`).toBe(false);
      expect(enPo, `unexpected msgid in en messages.po: ${key}`).not.toContain(`msgid "${key}"`);
      expect(trPo, `unexpected msgid in tr messages.po: ${key}`).not.toContain(`msgid "${key}"`);
    }
  });
});
