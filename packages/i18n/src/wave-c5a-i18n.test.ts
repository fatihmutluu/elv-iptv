import { describe, expect, it } from 'vitest';
import { createAppI18n, type MessageId } from './index';

describe('Wave C5A i18n parity (#243, #332)', () => {
  it('localizes deinterlace mode, pitch lock, loudness normalization, and window aspect ratio lock strings in English and Turkish', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const cases: ReadonlyArray<readonly [MessageId, string, string]> = [
      ['settings.deinterlaceMode', 'Deinterlacing', 'Taramasızlaştırma'],
      [
        'settings.deinterlaceModeHint',
        'Smooth interlaced 50i/60i live broadcast feeds on desktop',
        'Masaüstünde geçmeli 50i/60i canlı yayınları akıcılaştırır',
      ],
      ['settings.deinterlaceOff', 'Off', 'Kapalı'],
      ['settings.deinterlaceAuto', 'Auto', 'Otomatik'],
      ['settings.deinterlaceBwdif', 'Broadcast (bwdif)', 'Yayın (bwdif)'],
      ['settings.pitchLock', 'Preserve audio pitch', 'Ses tonunu koru'],
      [
        'settings.pitchLockHint',
        'Keep voices natural when changing playback speed',
        'Oynatma hızı değiştiğinde ses tonunu doğal tutar',
      ],
      ['settings.audioNormalization', 'Loudness normalization', 'Ses seviyesi dengeleme'],
      [
        'settings.audioNormalizationHint',
        'Balance quiet dialogue and loud channels using EBU R128',
        'EBU R128 ile kısık diyalogları ve yüksek kanalları dengeler',
      ],
      [
        'settings.windowAspectRatioLock',
        'Lock window aspect ratio',
        'Pencere en-boy oranını kilitle',
      ],
      [
        'settings.windowAspectRatioLockHint',
        'Keep windowed playback bar-free when resizing on desktop',
        'Masaüstünde pencereyi boyutlandırırken siyah kenarlıkları önler',
      ],
    ];

    for (const [id, expectedEn, expectedTr] of cases) {
      expect(en.t(id)).toBe(expectedEn);
      expect(tr.t(id)).toBe(expectedTr);
    }
  });
});
