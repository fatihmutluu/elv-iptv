import { describe, expect, it } from 'vitest';
import { parseVodVersion } from './vod-versions';

describe('parseVodVersion (#404)', () => {
  it('groups multi-version VOD titles with quality, codec, edition, and language tags', () => {
    const v1 = parseVodVersion('Dune (2021) [4K] HDR HEVC', 2021);
    const v2 = parseVodVersion('Dune (2021) (1080p) WEB-DL', 2021);
    const v3 = parseVodVersion('[TR] Dune (2021) 1080p Dubbed', 2021);
    const v4 = parseVodVersion('Dune (2021) [4K REMUX] Subtitled', 2021);

    expect(v1.groupKey).toBe('dune::2021');
    expect(v2.groupKey).toBe('dune::2021');
    expect(v3.groupKey).toBe('dune::2021');
    expect(v4.groupKey).toBe('dune::2021');

    expect(v4.qualityRank).toBeGreaterThan(v1.qualityRank);
    expect(v1.qualityRank).toBeGreaterThan(v2.qualityRank);
    expect(v1.versionLabel).toContain('4K');
    expect(v2.versionLabel).toContain('1080p');
    expect(v3.versionLabel).toContain('TR');
    expect(v3.versionLabel).toContain('Dubbed');
  });

  it('keeps distinct release years separate', () => {
    const oldMovie = parseVodVersion('Total Recall (1990) [1080p]');
    const remake = parseVodVersion('Total Recall (2012) [4K]');
    expect(oldMovie.groupKey).toBe('total recall::1990');
    expect(remake.groupKey).toBe('total recall::2012');
    expect(oldMovie.groupKey).not.toBe(remake.groupKey);
  });

  it('preserves sequel numbers, Roman numerals, and numeric titles', () => {
    const part1 = parseVodVersion('Dune (2021) 4K');
    const part2 = parseVodVersion('Dune: Part 2 (2024) 4K');
    const godfather2 = parseVodVersion('The Godfather II (1974) [1080p]');
    const godfather3 = parseVodVersion('The Godfather III (1990) [1080p]');
    const odyssey = parseVodVersion('2001: A Space Odyssey (1968) [4K]');
    const war = parseVodVersion('1917 (2019) [4K]');
    const warNoYear = parseVodVersion('1917 [4K]');

    expect(part1.groupKey).toBe('dune::2021');
    expect(part2.groupKey).toBe('dune part 2::2024');
    expect(godfather2.groupKey).toBe('the godfather ii::1974');
    expect(godfather3.groupKey).toBe('the godfather iii::1990');
    expect(odyssey.groupKey).toBe('2001 a space odyssey::1968');
    expect(war.groupKey).toBe('1917::2019');
    expect(warNoYear.groupKey).toBe('1917');
  });

  it('handles plain untagged titles cleanly', () => {
    const plain = parseVodVersion('Inception', 2010);
    expect(plain).toEqual({
      groupKey: 'inception::2010',
      versionLabel: '',
      qualityRank: 15,
    });
  });

  it('recognizes bracketed hyphenated release tags and preserves parenthesized Roman numerals', () => {
    const base = parseVodVersion('Inception (2010)', 2010);
    const webDl = parseVodVersion('Inception (2010) [TR WEB-DL]', 2010);
    const bluRay = parseVodVersion('Inception (2010) [TR Blu-Ray]', 2010);
    const hdRip = parseVodVersion('Inception (2010) [EN-HD-RIP]', 2010);

    expect(webDl.groupKey).toBe(base.groupKey);
    expect(bluRay.groupKey).toBe(base.groupKey);
    expect(hdRip.groupKey).toBe(base.groupKey);
    expect(webDl.versionLabel).toBe('TR WEB-DL');
    expect(bluRay.versionLabel).toBe('TR BluRay');
    expect(hdRip.versionLabel).toBe('EN HDRip');

    expect(parseVodVersion('Movie (II) [1080p]').groupKey).toBe('movie ii');
    expect(parseVodVersion('Part (IV) [4K]').groupKey).toBe('part iv');
    expect(parseVodVersion('Rocky (VI) (2006) [1080p]').groupKey).toBe('rocky vi::2006');
  });
});
