import { describe, expect, it } from 'vitest';
import { cleanVodTitle } from './vod-title-cleaner';

describe('cleanVodTitle streaming-rip & edition tags (Wave E1)', () => {
  it('strips NF, AMZN, DSNP, ATVP, IMAX, EXTENDED, REMASTERED, UNCUT, UNRATED tags', () => {
    expect(cleanVodTitle('Dune (2021) [NF] [IMAX] 4K')).toEqual({
      cleanTitle: 'Dune',
      releaseYear: 2021,
      foldedTitle: 'dune',
    });
    expect(cleanVodTitle('The Boys (2019) AMZN WEB-DL 1080p')).toEqual({
      cleanTitle: 'The Boys',
      releaseYear: 2019,
      foldedTitle: 'the boys',
    });
    expect(cleanVodTitle('Andor [DSNP] (2022) HEVC')).toEqual({
      cleanTitle: 'Andor',
      releaseYear: 2022,
      foldedTitle: 'andor',
    });
    expect(cleanVodTitle('Severance (2022) [ATVP] 4K HDR')).toEqual({
      cleanTitle: 'Severance',
      releaseYear: 2022,
      foldedTitle: 'severance',
    });
    expect(cleanVodTitle('The Lord of the Rings (2001) (EXTENDED) REMASTERED')).toEqual({
      cleanTitle: 'The Lord of the Rings',
      releaseYear: 2001,
      foldedTitle: 'the lord of the rings',
    });
    expect(cleanVodTitle('Blade Runner (1982) [UNCUT] UNRATED IMAX')).toEqual({
      cleanTitle: 'Blade Runner',
      releaseYear: 1982,
      foldedTitle: 'blade runner',
    });
    expect(cleanVodTitle('AMZN | Reacher (2022) [FHD]')).toEqual({
      cleanTitle: 'Reacher',
      releaseYear: 2022,
      foldedTitle: 'reacher',
    });
    expect(cleanVodTitle('DSNP: The Mandalorian (2019) 4K')).toEqual({
      cleanTitle: 'The Mandalorian',
      releaseYear: 2019,
      foldedTitle: 'the mandalorian',
    });
    expect(cleanVodTitle('ATVP - Ted Lasso (2020) 1080p')).toEqual({
      cleanTitle: 'Ted Lasso',
      releaseYear: 2020,
      foldedTitle: 'ted lasso',
    });
    expect(cleanVodTitle('NF | Stranger Things (2016) [4K]')).toEqual({
      cleanTitle: 'Stranger Things',
      releaseYear: 2016,
      foldedTitle: 'stranger things',
    });
  });

  it('preserves existing vod-title-cleaner behavior for sequel numbers and numeric titles', () => {
    expect(cleanVodTitle('TR: [4K] Solaris (1972) HEVC x265 TR-DUB')).toEqual({
      cleanTitle: 'Solaris',
      releaseYear: 1972,
      foldedTitle: 'solaris',
    });
    expect(cleanVodTitle('2001: A Space Odyssey (1968) [UHD] REMASTERED')).toEqual({
      cleanTitle: '2001: A Space Odyssey',
      releaseYear: 1968,
      foldedTitle: '2001 a space odyssey',
    });
    expect(cleanVodTitle('Blade Runner 2049 (2017) [IMAX] [4K]')).toEqual({
      cleanTitle: 'Blade Runner 2049',
      releaseYear: 2017,
      foldedTitle: 'blade runner 2049',
    });
  });

  it('handles stacked leading multilingual/quality prefixes and preserves non-empty fallback', () => {
    expect(cleanVodTitle('TR | FHD | [4K] The Matrix (1999)')).toEqual({
      cleanTitle: 'The Matrix',
      releaseYear: 1999,
      foldedTitle: 'the matrix',
    });
    expect(cleanVodTitle('TUR | 4K - (FR) Amélie (2001) [VOSTFR]')).toEqual({
      cleanTitle: 'Amélie',
      releaseYear: 2001,
      foldedTitle: 'amelie',
    });
    expect(cleanVodTitle('[PT-BR] [VIP] (DE) (HDR10) Dark (2017) DDP5.1')).toEqual({
      cleanTitle: 'Dark',
      releaseYear: 2017,
      foldedTitle: 'dark',
    });
    expect(cleanVodTitle('ENG: (GER) [MULTISUB] [SDR] Parasite (2019) DVDRIP AC3 5.1')).toEqual({
      cleanTitle: 'Parasite',
      releaseYear: 2019,
      foldedTitle: 'parasite',
    });
    expect(cleanVodTitle('CASTELLANO | 4K - El Secreto (2009) VOSE')).toEqual({
      cleanTitle: 'El Secreto',
      releaseYear: 2009,
      foldedTitle: 'el secreto',
    });
    expect(cleanVodTitle('[TR] [4K]').cleanTitle).not.toBe('');
  });

  it('extracts years and strips noise from mixed year+noise brackets and trailing hyphen/pipe suffixes', () => {
    expect(cleanVodTitle('Gora [2024 - Altyazılı]')).toEqual({
      cleanTitle: 'Gora',
      releaseYear: 2024,
      foldedTitle: 'gora',
    });
    expect(cleanVodTitle('Inception (2024 Türkçe Dublaj)')).toEqual({
      cleanTitle: 'Inception',
      releaseYear: 2024,
      foldedTitle: 'inception',
    });
    expect(cleanVodTitle('Le Mans (2024 FR 4K) TRUEFRENCH')).toEqual({
      cleanTitle: 'Le Mans',
      releaseYear: 2024,
      foldedTitle: 'le mans',
    });
    expect(cleanVodTitle('Oppenheimer [4K 2024 DUAL] DTS 7.1')).toEqual({
      cleanTitle: 'Oppenheimer',
      releaseYear: 2024,
      foldedTitle: 'oppenheimer',
    });
    expect(cleanVodTitle('Portrait (2024 - VOSTFR) VFF')).toEqual({
      cleanTitle: 'Portrait',
      releaseYear: 2024,
      foldedTitle: 'portrait',
    });
    expect(cleanVodTitle('Movie Title - 4K')).toEqual({
      cleanTitle: 'Movie Title',
      releaseYear: null,
      foldedTitle: 'movie title',
    });
    expect(cleanVodTitle('Movie Title - Türkçe Dublaj')).toEqual({
      cleanTitle: 'Movie Title',
      releaseYear: null,
      foldedTitle: 'movie title',
    });
    expect(cleanVodTitle('Movie Title - Dual Audio')).toEqual({
      cleanTitle: 'Movie Title',
      releaseYear: null,
      foldedTitle: 'movie title',
    });
    expect(cleanVodTitle('Movie Title - VOSTFR')).toEqual({
      cleanTitle: 'Movie Title',
      releaseYear: null,
      foldedTitle: 'movie title',
    });
    expect(cleanVodTitle('Movie Title | OMU SubEsp')).toEqual({
      cleanTitle: 'Movie Title',
      releaseYear: null,
      foldedTitle: 'movie title',
    });
  });

  it('strips multilingual codec/lang/edition atoms while NEVER corrupting real short-word titles, language titles, sequels, or numeric titles', () => {
    expect(cleanVodTitle('Cinema Paradiso (1988) [IT] HDRIP 3D SDR AAC')).toEqual({
      cleanTitle: 'Cinema Paradiso',
      releaseYear: 1988,
      foldedTitle: 'cinema paradiso',
    });
    expect(cleanVodTitle('Oldboy (2003) [KO] (JA) MULTISUB WEB')).toEqual({
      cleanTitle: 'Oldboy',
      releaseYear: 2003,
      foldedTitle: 'oldboy',
    });
    expect(cleanVodTitle('RRR (2022) [HINDI] (IN) 10BIT 5.1')).toEqual({
      cleanTitle: 'RRR',
      releaseYear: 2022,
      foldedTitle: 'rrr',
    });
    expect(cleanVodTitle('The Matrix - Reloaded (2003) [4K]')).toEqual({
      cleanTitle: 'The Matrix - Reloaded',
      releaseYear: 2003,
      foldedTitle: 'the matrix reloaded',
    });
    expect(cleanVodTitle('It (2017) [1080p]')).toEqual({
      cleanTitle: 'It',
      releaseYear: 2017,
      foldedTitle: 'it',
    });
    expect(cleanVodTitle('IT (2017) [4K]')).toEqual({
      cleanTitle: 'IT',
      releaseYear: 2017,
      foldedTitle: 'it',
    });
    expect(cleanVodTitle('Up (2009) HEVC')).toEqual({
      cleanTitle: 'Up',
      releaseYear: 2009,
      foldedTitle: 'up',
    });
    expect(cleanVodTitle('Us (2019) [FHD]')).toEqual({
      cleanTitle: 'Us',
      releaseYear: 2019,
      foldedTitle: 'us',
    });
    expect(cleanVodTitle('Her (2013) WEB-DL')).toEqual({
      cleanTitle: 'Her',
      releaseYear: 2013,
      foldedTitle: 'her',
    });
    expect(cleanVodTitle('Top Gun (1986) 4K')).toEqual({
      cleanTitle: 'Top Gun',
      releaseYear: 1986,
      foldedTitle: 'top gun',
    });
    expect(cleanVodTitle('New York (2009) [1080p]')).toEqual({
      cleanTitle: 'New York',
      releaseYear: 2009,
      foldedTitle: 'new york',
    });
    expect(cleanVodTitle('Original Sin (2001) [FHD]')).toEqual({
      cleanTitle: 'Original Sin',
      releaseYear: 2001,
      foldedTitle: 'original sin',
    });
    expect(cleanVodTitle('In Time (2011) [4K]')).toEqual({
      cleanTitle: 'In Time',
      releaseYear: 2011,
      foldedTitle: 'in time',
    });
    expect(cleanVodTitle('The French Connection (1971) [1080p]')).toEqual({
      cleanTitle: 'The French Connection',
      releaseYear: 1971,
      foldedTitle: 'the french connection',
    });
    expect(cleanVodTitle("Charlotte's Web (2006) [1080p]")).toEqual({
      cleanTitle: "Charlotte's Web",
      releaseYear: 2006,
      foldedTitle: 'charlotte s web',
    });
    expect(cleanVodTitle('1917 (2019) [4K]')).toEqual({
      cleanTitle: '1917',
      releaseYear: 2019,
      foldedTitle: '1917',
    });
    expect(cleanVodTitle('300 (2006) HDR10+')).toEqual({
      cleanTitle: '300',
      releaseYear: 2006,
      foldedTitle: '300',
    });
    expect(cleanVodTitle('Dune 2 (2024) [4K]')).toEqual({
      cleanTitle: 'Dune 2',
      releaseYear: 2024,
      foldedTitle: 'dune 2',
    });
    expect(cleanVodTitle('Spider-Man: Part 2 (2024) [FHD]')).toEqual({
      cleanTitle: 'Spider-Man: Part 2',
      releaseYear: 2024,
      foldedTitle: 'spider man part 2',
    });
    expect(cleanVodTitle('Title - It')).toEqual({
      cleanTitle: 'Title - It',
      releaseYear: null,
      foldedTitle: 'title it',
    });
    expect(cleanVodTitle('Title - Us')).toEqual({
      cleanTitle: 'Title - Us',
      releaseYear: null,
      foldedTitle: 'title us',
    });
    expect(cleanVodTitle('Title - In')).toEqual({
      cleanTitle: 'Title - In',
      releaseYear: null,
      foldedTitle: 'title in',
    });
    expect(cleanVodTitle('Blade Runner 2049')).toEqual({
      cleanTitle: 'Blade Runner 2049',
      releaseYear: null,
      foldedTitle: 'blade runner 2049',
    });
    expect(cleanVodTitle('Blade Runner 2049 (2017) [4K]')).toEqual({
      cleanTitle: 'Blade Runner 2049',
      releaseYear: 2017,
      foldedTitle: 'blade runner 2049',
    });
  });
});
