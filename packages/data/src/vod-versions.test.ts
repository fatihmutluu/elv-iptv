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

  it('merges multilingual noisy prefixes, mixed year+noise brackets, bare trailing years, and trailing quality suffixes', () => {
    expect(parseVodVersion('Dune Part Two 2024 4K').groupKey).toBe('dune part two::2024');
    expect(parseVodVersion('Dune Part Two (2024) FHD').groupKey).toBe('dune part two::2024');
    expect(parseVodVersion('Dune Part Two 2024 4K', 2024).groupKey).toBe('dune part two::2024');
    expect(parseVodVersion('TR | FHD | Dune Part Two [2024 - Altyazılı]').groupKey).toBe(
      'dune part two::2024',
    );
    expect(parseVodVersion('TUR | 4K - Dune Part Two (2024 Türkçe Dublaj)').groupKey).toBe(
      'dune part two::2024',
    );
    expect(parseVodVersion('[FR] Dune Part Two (2024 FR 4K) VOSTFR').groupKey).toBe(
      'dune part two::2024',
    );
    expect(parseVodVersion('Dune Part Two [4K 2024 DUAL] DDP5.1').groupKey).toBe(
      'dune part two::2024',
    );
    expect(parseVodVersion('(PT-BR) Dune Part Two (2024 - VOSTFR)').groupKey).toBe(
      'dune part two::2024',
    );

    expect(parseVodVersion('Movie Title - 4K').groupKey).toBe('movie title');
    expect(parseVodVersion('Movie Title - Türkçe Dublaj').groupKey).toBe('movie title');
    expect(parseVodVersion('Movie Title - Dual Audio').groupKey).toBe('movie title');
    expect(parseVodVersion('Movie Title - VOSTFR').groupKey).toBe('movie title');
    expect(parseVodVersion('The Matrix - Reloaded (2003) [4K]').groupKey).toBe(
      'the matrix reloaded::2003',
    );

    expect(parseVodVersion('The Boys (2019) AMZN WEB-DL 1080p').groupKey).toBe('the boys::2019');
    expect(parseVodVersion('The Boys (2019) [NF] [1080p]').groupKey).toBe('the boys::2019');
  });

  it('preserves short English titles, sequel numbers, Roman numerals, and numeric titles in multilingual mode', () => {
    expect(parseVodVersion('It (2017) [4K]').groupKey).toBe('it::2017');
    expect(parseVodVersion('IT (2017) [1080p]').groupKey).toBe('it::2017');
    expect(parseVodVersion('Up (2009) [FHD]').groupKey).toBe('up::2009');
    expect(parseVodVersion('Us (2019) [HEVC]').groupKey).toBe('us::2019');
    expect(parseVodVersion('Her (2013) WEB-DL').groupKey).toBe('her::2013');
    expect(parseVodVersion('Top Gun (1986) [4K]').groupKey).toBe('top gun::1986');
    expect(parseVodVersion('New York (2009) [1080p]').groupKey).toBe('new york::2009');
    expect(parseVodVersion('Original Sin (2001) [FHD]').groupKey).toBe('original sin::2001');
    expect(parseVodVersion('In Time (2011) [4K]').groupKey).toBe('in time::2011');
    expect(parseVodVersion('300 (2006) [4K]').groupKey).toBe('300::2006');
    expect(parseVodVersion('Dune 2 (2024) [4K]').groupKey).toBe('dune 2::2024');
    expect(parseVodVersion('Spider-Man: Part 2 (2024) [1080p]').groupKey).toBe(
      'spider man part 2::2024',
    );
    expect(parseVodVersion('Title - It').groupKey).toBe('title it');
    expect(parseVodVersion('Title - Us').groupKey).toBe('title us');
    expect(parseVodVersion('Blade Runner 2049').groupKey).toBe('blade runner 2049');
    expect(parseVodVersion('Blade Runner 2049 (2017) [4K]').groupKey).toBe(
      'blade runner 2049::2017',
    );
  });
});
