import { describe, expect, it } from 'vitest';
import { createAppI18n, type MessageId } from './index';

describe('Wave F0B i18n parity (#59)', () => {
  it('localizes audio delay, subtitle delay, and video quality strings in English and Turkish', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const cases: ReadonlyArray<readonly [MessageId, string, string]> = [
      ['player.audioDelay', 'Audio delay', 'Ses gecikmesi'],
      ['player.subtitleDelay', 'Subtitle delay', 'Altyazı gecikmesi'],
      ['player.videoQuality', 'Video quality', 'Video kalitesi'],
      ['player.videoQualityAuto', 'Auto', 'Otomatik'],
      ['player.delayReset', 'Reset (0 ms)', 'Sıfırla (0 ms)'],
    ];

    for (const [id, expectedEn, expectedTr] of cases) {
      expect(en.t(id)).toBe(expectedEn);
      expect(tr.t(id)).toBe(expectedTr);
    }
  });
});
