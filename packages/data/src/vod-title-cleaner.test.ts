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
});
