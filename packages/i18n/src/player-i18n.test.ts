import { describe, expect, it } from 'vitest';
import { createAppI18n, type MessageId } from './index';

describe('@elv/i18n Cinema Quietude v2 player strings (#391, #58, #394, #114, #57, #392)', () => {
  it('localizes Cinema Quietude v2 player OSD, info sheet, channel drawer, gestures, and next-up strings in EN and TR', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const cases: ReadonlyArray<readonly [MessageId, string, string]> = [
      ['player.info', 'Programme info', 'Program bilgisi'],
      ['player.channelList', 'Channels', 'Kanallar'],
      ['player.channelListEmpty', 'No channels in this group', 'Bu grupta kanal yok'],
      ['player.nowPlaying', 'On now', 'Şimdi yayında'],
      ['player.upNext', 'Up next', 'Sıradaki'],
      [
        'player.noProgrammeInfo',
        'No programme information available',
        'Program bilgisi mevcut değil',
      ],
      ['player.streamQuality', 'Stream quality', 'Yayın kalitesi'],
      ['player.volume', 'Volume', 'Ses seviyesi'],
      ['player.brightness', 'Brightness', 'Parlaklık'],
      ['player.holdSpeedActive', '2× speed', '2× hız'],
      ['player.autoSubtitlesOnSkipBack', 'Subtitles on skip back', 'Geri sararken altyazı'],
      ['player.playNextNow', 'Play now', 'Şimdi oynat'],
      ['player.exitFullscreen', 'Exit fullscreen', 'Tam ekrandan çık'],
    ];

    for (const [id, expectedEn, expectedTr] of cases) {
      expect(en.t(id)).toBe(expectedEn);
      expect(tr.t(id)).toBe(expectedTr);
    }

    expect(en.t('player.nextUpCountdown', { seconds: 10 })).toBe('Next episode in 10s');
    expect(tr.t('player.nextUpCountdown', { seconds: 10 })).toBe('10 sn sonra sonraki bölüm');
    expect(en.t('player.nextUpCountdown', { seconds: 3 })).toBe('Next episode in 3s');
    expect(tr.t('player.nextUpCountdown', { seconds: 3 })).toBe('3 sn sonra sonraki bölüm');
  });
});
