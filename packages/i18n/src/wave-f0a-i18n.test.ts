import { describe, expect, it } from 'vitest';
import { createAppI18n, type MessageId } from './index';

describe('Wave F0A i18n parity (#6, #25)', () => {
  it('localizes guide row density and empty EPG gap strings in English and Turkish', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const cases: ReadonlyArray<readonly [MessageId, string, string]> = [
      ['settings.epgRowDensity', 'Guide row density', 'Rehber satır yoğunluğu'],
      ['settings.epgRowDensityCompact', 'Compact', 'Kompakt'],
      ['settings.epgRowDensityComfortable', 'Comfortable', 'Rahat'],
      ['settings.epgRowDensityCinematic', 'Cinematic', 'Sinematik'],
      ['epg.noInfoGap', 'No info', 'Bilgi yok'],
    ];

    for (const [id, expectedEn, expectedTr] of cases) {
      expect(en.t(id)).toBe(expectedEn);
      expect(tr.t(id)).toBe(expectedTr);
    }
  });
});
