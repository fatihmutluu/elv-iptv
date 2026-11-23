import { describe, expect, it } from 'vitest';
import { createAppI18n, type MessageId } from './index';

describe('Wave C6 i18n parity (#412)', () => {
  it('localizes background audio playback strings in English and Turkish', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const cases: ReadonlyArray<readonly [MessageId, string, string]> = [
      ['settings.backgroundAudio', 'Background audio playback', 'Arka planda ses oynatma'],
      [
        'settings.backgroundAudioHint',
        'Keep audio playing when the app moves to the background on mobile',
        'Uygulama mobilde arka plana alındığında sesi oynatmaya devam eder',
      ],
    ];

    for (const [id, expectedEn, expectedTr] of cases) {
      expect(en.t(id)).toBe(expectedEn);
      expect(tr.t(id)).toBe(expectedTr);
    }
  });
});
