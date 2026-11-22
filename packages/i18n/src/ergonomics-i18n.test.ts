import { describe, expect, it } from 'vitest';
import { createAppI18n, type MessageId } from './index';

describe('@elv/i18n Wave P4 desktop & TV ergonomics strings (#409, #408, #410, #55)', () => {
  it('localizes always-on-top, audio output device, quick-play, unplayed badge, and exit confirmation in EN and TR', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');

    const staticCases: ReadonlyArray<readonly [MessageId, string, string]> = [
      ['player.alwaysOnTop', 'Pin window on top', 'Pencereyi üstte tut'],
      ['player.exitAlwaysOnTop', 'Unpin window', 'Sabitlemeyi kaldır'],
      ['player.audioDevice', 'Audio output', 'Ses çıkışı'],
      ['player.audioDeviceAuto', 'System default', 'Sistem varsayılanı'],
      ['shell.backToExitToast', 'Press Back again to exit', "Çıkmak için tekrar Geri'ye basın"],
      [
        'settings.appearance.confirmExitOnBack',
        'Confirm before exiting with Back',
        'Geri tuşuyla çıkmadan önce sor',
      ],
      ['settings.playback.audioDevice', 'Audio output device', 'Ses çıkış aygıtı'],
    ];

    for (const [id, expectedEn, expectedTr] of staticCases) {
      expect(en.t(id)).toBe(expectedEn);
      expect(tr.t(id)).toBe(expectedTr);
    }

    expect(en.t('card.quickPlay', { title: 'Dune' })).toBe('Play Dune');
    expect(tr.t('card.quickPlay', { title: 'Dune' })).toBe('Dune oynat');
    expect(en.t('card.unplayedCount', { count: 4 })).toBe('4 unwatched');
    expect(tr.t('card.unplayedCount', { count: 4 })).toBe('4 izlenmemiş');
  });
});
