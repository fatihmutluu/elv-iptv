import { describe, expect, it } from 'vitest';
import { parseLiveVariant } from './live-variants';

describe('parseLiveVariant (#218)', () => {
  it('extracts quality tiers and normalizes baseFold across variants', () => {
    const v4k = parseLiveVariant('BBC One 4K');
    const vUhd = parseLiveVariant('BBC One [UHD]');
    const v2160 = parseLiveVariant('BBC One (2160p)');
    const vFhd = parseLiveVariant('BBC One FHD');
    const v1080 = parseLiveVariant('BBC One - 1080p');
    const vHd = parseLiveVariant('BBC One HD');
    const v720 = parseLiveVariant('BBC One | 720p');
    const vSd = parseLiveVariant('BBC One SD');
    const v480 = parseLiveVariant('BBC One 480p');
    const vLow = parseLiveVariant('BBC One LOW');
    const v360 = parseLiveVariant('BBC One 360p');
    const vPlain = parseLiveVariant('BBC One');

    expect(v4k).toEqual({ baseFold: 'bbc one', qualityLabel: '4K', qualityRank: 40 });
    expect(vUhd).toEqual({ baseFold: 'bbc one', qualityLabel: '4K', qualityRank: 40 });
    expect(v2160).toEqual({ baseFold: 'bbc one', qualityLabel: '4K', qualityRank: 40 });
    expect(vFhd).toEqual({ baseFold: 'bbc one', qualityLabel: 'FHD', qualityRank: 30 });
    expect(v1080).toEqual({ baseFold: 'bbc one', qualityLabel: 'FHD', qualityRank: 30 });
    expect(vHd).toEqual({ baseFold: 'bbc one', qualityLabel: 'HD', qualityRank: 20 });
    expect(v720).toEqual({ baseFold: 'bbc one', qualityLabel: 'HD', qualityRank: 20 });
    expect(vSd).toEqual({ baseFold: 'bbc one', qualityLabel: 'SD', qualityRank: 10 });
    expect(v480).toEqual({ baseFold: 'bbc one', qualityLabel: 'SD', qualityRank: 10 });
    expect(vLow).toEqual({ baseFold: 'bbc one', qualityLabel: 'LOW', qualityRank: 5 });
    expect(v360).toEqual({ baseFold: 'bbc one', qualityLabel: 'LOW', qualityRank: 5 });
    expect(vPlain).toEqual({ baseFold: 'bbc one', qualityLabel: '', qualityRank: 15 });
  });

  it('never strips quality substrings inside words like 4KIDS or HGTV', () => {
    expect(parseLiveVariant('4KIDS TV')).toEqual({
      baseFold: '4kids tv',
      qualityLabel: '',
      qualityRank: 15,
    });
    expect(parseLiveVariant('HGTV')).toEqual({
      baseFold: 'hgtv',
      qualityLabel: '',
      qualityRank: 15,
    });
    expect(parseLiveVariant('HGTV HD')).toEqual({
      baseFold: 'hgtv',
      qualityLabel: 'HD',
      qualityRank: 20,
    });
  });

  it('preserves East/West, +1/+2 timeshifts, Backup, and language/country tags', () => {
    const east = parseLiveVariant('HBO East HD');
    const west = parseLiveVariant('HBO West HD');
    expect(east.baseFold).not.toBe(west.baseFold);

    const main = parseLiveVariant('Sky Sports HD');
    const plus1 = parseLiveVariant('Sky Sports +1 HD');
    const plus2 = parseLiveVariant('Sky Sports +2 HD');
    const ch1 = parseLiveVariant('Sky Sports 1 HD');
    expect(new Set([main.baseFold, plus1.baseFold, plus2.baseFold, ch1.baseFold]).size).toBe(4);

    const primary = parseLiveVariant('CNN FHD');
    const backup = parseLiveVariant('CNN Backup FHD');
    expect(primary.baseFold).not.toBe(backup.baseFold);

    const tr = parseLiveVariant('[TR] Eurosport HD');
    const de = parseLiveVariant('[DE] Eurosport HD');
    expect(tr.baseFold).not.toBe(de.baseFold);
  });

  it('never returns empty baseFold for quality-only or whitespace titles', () => {
    expect(parseLiveVariant('4K')).toEqual({
      baseFold: '4k',
      qualityLabel: '4K',
      qualityRank: 40,
    });
    expect(parseLiveVariant('   ')).toEqual({
      baseFold: '',
      qualityLabel: '',
      qualityRank: 15,
    });
  });
});
