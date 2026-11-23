import { describe, expect, it } from 'vitest';
import { createAppI18n, type MessageId } from './index';

describe('Wave C4B i18n parity (#163, #133, #416)', () => {
  it('localizes accessibility fonts, TV overscan, remaining time, and ambient clock strings in English and Turkish', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const cases: ReadonlyArray<readonly [MessageId, string, string]> = [
      ['settings.uiFont', 'Interface font', 'Arayüz yazı tipi'],
      [
        'settings.uiFontHint',
        'High-legibility typeface for menus, lists, and guide',
        'Menüler, listeler ve rehber için yüksek okunabilirlikli yazı tipi',
      ],
      ['settings.subtitleFont', 'Subtitle font', 'Altyazı yazı tipi'],
      [
        'settings.subtitleFontHint',
        'Typeface used for closed captions and text subtitles',
        'Metin altyazılar için kullanılan yazı tipi',
      ],
      ['settings.fontSystem', 'System default', 'Sistem varsayılanı'],
      ['settings.fontAtkinson', 'Atkinson Hyperlegible', 'Atkinson Hyperlegible'],
      ['settings.fontOpenDyslexic', 'OpenDyslexic', 'OpenDyslexic'],
      ['settings.overscanX', 'Horizontal overscan', 'Yatay ekran kenar boşluğu'],
      ['settings.overscanY', 'Vertical overscan', 'Dikey ekran kenar boşluğu'],
      [
        'settings.overscanHint',
        'Adjust TV safe margins so menus and player bars never clip',
        'Menü ve oynatıcı çubuklarının kesilmemesi için TV güvenli kenar boşluklarını ayarlayın',
      ],
      ['settings.tvClockMode', 'TV ambient clock', 'TV ortam saati'],
      [
        'settings.tvClockModeHint',
        'Show current time in the top-right corner on TV',
        "TV'de sağ üst köşede güncel saati göster",
      ],
      ['settings.tvClockAlways', 'Always', 'Her zaman'],
      ['settings.tvClockMenus', 'Menus only', 'Yalnızca menülerde'],
      ['settings.tvClockPlayer', 'Player only', 'Yalnızca oynatıcıda'],
      ['settings.tvClockNever', 'Never', 'Kapalı'],
    ];

    for (const [id, expectedEn, expectedTr] of cases) {
      expect(en.t(id)).toBe(expectedEn);
      expect(tr.t(id)).toBe(expectedTr);
    }

    expect(en.t('settings.overscanValue', { pct: 5 })).toBe('5%');
    expect(tr.t('settings.overscanValue', { pct: 5 })).toBe('%5');
    expect(en.t('player.remainingTimeAnnouncement', { time: '12:30' })).toBe('12:30 remaining');
    expect(tr.t('player.remainingTimeAnnouncement', { time: '12:30' })).toBe('12:30 kaldı');
  });
});
