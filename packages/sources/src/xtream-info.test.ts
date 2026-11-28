import { describe, expect, it } from 'vitest';
import { client, expectErr, value } from './xtream-test-helpers';

describe('seriesInfo', () => {
  it('flattens episodes sorted by season then episode', async () => {
    const { c, requests } = client(() => ({
      json: {
        seasons: [{ season_number: 2 }, 1],
        episodes: {
          '2': [
            {
              id: '21',
              episode_num: '1',
              title: 'S2E1',
              container_extension: 'mkv',
              info: { duration_secs: '1500' },
            },
          ],
          '1': [
            { id: '12', episode_num: 2, title: 'Two', container_extension: 'mp4' },
            { id: '11', episode_num: 1, title: ' One &amp; ', info: [] },
            { episode_num: 3 },
          ],
        },
      },
    }));
    const info = value(await c.seriesInfo(42));
    expect(info.seasons).toEqual([1, 2]);
    expect(info.episodes).toEqual([
      { id: 11, season: 1, episode: 1, title: 'One &', extension: 'mp4' },
      { id: 12, season: 1, episode: 2, title: 'Two', extension: 'mp4' },
      { id: 21, season: 2, episode: 1, title: 'S2E1', extension: 'mkv', durationSec: 1500 },
    ]);
    expect(requests[0]?.url).toContain('action=get_series_info&series_id=42');
  });

  it('derives seasons from the episode keys and accepts an array of seasons', async () => {
    const { c } = client(() => ({
      json: { episodes: [[{ id: 1, season: 3, episode_num: 1, title: 'x' }], 'junk'] },
    }));
    const info = value(await c.seriesInfo(1));
    expect(info.seasons).toEqual([3]);
    const { c: c2 } = client(() => ({ json: { episodes: { '4': [{ id: 1, episode_num: 1 }] } } }));
    const i2 = value(await c2.seriesInfo(1));
    expect(i2.seasons).toEqual([4]);
    expect(i2.episodes[0]?.title).toBe('');
  });

  it('tolerates a series without episodes and rejects non-objects', async () => {
    expect(value(await client(() => ({ json: {} })).c.seriesInfo(1))).toEqual({
      seasons: [],
      episodes: [],
    });
    expect(value(await client(() => ({ json: [] })).c.seriesInfo(1))).toEqual({
      seasons: [],
      episodes: [],
    });
    expectErr(
      await client(() => ({ json: [1] })).c.seriesInfo(1),
      'source-format',
      'unexpected-shape',
    );
  });

  it('preserves season 0 in array-encoded episodes, supports flat episode arrays and deduplicates ids', async () => {
    const { c: byIndex } = client(() => ({
      json: {
        episodes: [
          [{ id: '100', episode_num: 1, title: 'Special' }],
          [
            { id: '101', episode_num: 1, title: 'Pilot' },
            { id: '100', episode_num: 2, title: 'Duplicate special' },
          ],
        ],
      },
    }));
    expect(value(await byIndex.seriesInfo(7))).toEqual({
      seasons: [0, 1],
      episodes: [
        { id: 100, season: 0, episode: 1, title: 'Special', extension: 'mp4' },
        { id: 101, season: 1, episode: 1, title: 'Pilot', extension: 'mp4' },
      ],
    });

    const { c: flat } = client(() => ({
      json: {
        episodes: [
          { id: 50, season: 0, episode_num: 1, title: 'Zero' },
          { id: 51, season: 2, episode_num: 3, title: 'Flat', container_extension: 'mkv' },
          { id: 51, season: 2, episode_num: 4, title: 'Dup' },
        ],
      },
    }));
    expect(value(await flat.seriesInfo(8))).toEqual({
      seasons: [0, 2],
      episodes: [
        { id: 50, season: 0, episode: 1, title: 'Zero', extension: 'mp4' },
        { id: 51, season: 2, episode: 3, title: 'Flat', extension: 'mkv' },
      ],
    });
  });

  it('extracts optional cast (or actors) and director on seriesInfo (#397)', async () => {
    const info1 = value(
      await client(() => ({
        json: {
          info: {
            cast: 'Haluk Bilginer, Cansu Dere',
            director: 'Onur Saylak',
          },
          episodes: {},
        },
      })).c.seriesInfo(10),
    );
    expect(info1.cast).toBe('Haluk Bilginer, Cansu Dere');
    expect(info1.director).toBe('Onur Saylak');

    const info2 = value(
      await client(() => ({
        json: {
          info: {
            actors: ['Ali Atay', ' Serkan Keskin '],
          },
          director: 'Onur Ünlü',
          episodes: {},
        },
      })).c.seriesInfo(11),
    );
    expect(info2.cast).toBe('Ali Atay, Serkan Keskin');
    expect(info2.director).toBe('Onur Ünlü');
  });

  it('extracts optional backdrop from backdrop_path (string or string[]) or explicit backdrop without falling back to cover', async () => {
    const withArray = value(
      await client(() => ({
        json: {
          info: {
            cover: 'https://img.example/vertical-cover.jpg',
            backdrop_path: [
              'javascript:alert(1)',
              '',
              'https://img.example/series-bg-1.jpg',
              'https://img.example/series-bg-2.jpg',
            ],
          },
          episodes: {},
        },
      })).c.seriesInfo(12),
    );
    expect(withArray.backdrop).toBe('https://img.example/series-bg-1.jpg');

    const withFallback = value(
      await client(() => ({
        json: {
          info: { cover: 'https://img.example/vertical-cover.jpg' },
          backdrop: 'https://img.example/series-explicit-bg.jpg',
          episodes: {},
        },
      })).c.seriesInfo(13),
    );
    expect(withFallback.backdrop).toBe('https://img.example/series-explicit-bg.jpg');

    const withoutBackdrop = value(
      await client(() => ({
        json: {
          info: {
            cover: 'https://img.example/vertical-cover.jpg',
            movie_image: 'https://img.example/poster.jpg',
          },
          episodes: {},
        },
      })).c.seriesInfo(14),
    );
    expect(withoutBackdrop.backdrop).toBeUndefined();
  });
});

describe('vodInfo', () => {
  it('maps info and movie data', async () => {
    const { c, requests } = client(() => ({
      json: {
        info: {
          duration_secs: '5400',
          plot: ' Plot ',
          releasedate: '2020-03-04',
          actors: ['Cem Yılmaz', 'Ozan Güven'],
          director: ' Ali Taner Baltacı ',
        },
        movie_data: { container_extension: 'mkv' },
      },
    }));
    expect(value(await c.vodInfo(8))).toEqual({
      durationSec: 5400,
      plot: 'Plot',
      year: 2020,
      cast: 'Cem Yılmaz, Ozan Güven',
      director: 'Ali Taner Baltacı',
      extension: 'mkv',
    });
    expect(requests[0]?.url).toContain('action=get_vod_info&vod_id=8');
  });
  it('preserves omitted extension as undefined, prefers year, and extracts valid direct_source (XC-4)', async () => {
    const { c } = client(() => ({ json: { info: { year: '1999', releasedate: '2020-01-01' } } }));
    expect(value(await c.vodInfo(1))).toEqual({ year: 1999 });
    expect(value(await client(() => ({ json: {} })).c.vodInfo(1))).toEqual({});
    expect(value(await client(() => ({ json: [] })).c.vodInfo(1))).toEqual({});
    expect(
      value(
        await client(() => ({
          json: { movie_data: { direct_source: 'http://cdn.example/movie/42.mp4' } },
        })).c.vodInfo(42),
      ),
    ).toEqual({ directSource: 'http://cdn.example/movie/42.mp4' });
  });

  it('extracts optional backdrop from backdrop_path (string or string[]) or explicit backdrop without falling back to vertical cover/movie_image', async () => {
    const fromArray = value(
      await client(() => ({
        json: {
          info: {
            movie_image: 'https://img.example/vertical-poster.jpg',
            cover_big: 'https://img.example/vertical-cover.jpg',
            backdrop_path: ['   ', 'ftp://bad.example/bg.jpg', 'https://img.example/vod-bg-1.jpg'],
          },
          movie_data: { container_extension: 'mp4' },
        },
      })).c.vodInfo(20),
    );
    expect(fromArray.backdrop).toBe('https://img.example/vod-bg-1.jpg');

    const fromMovieData = value(
      await client(() => ({
        json: {
          info: {
            stream_icon: 'https://img.example/icon.jpg',
            movie_image: 'https://img.example/poster.jpg',
          },
          movie_data: {
            container_extension: 'mkv',
            backdrop_path: 'https://img.example/vod-bg-2.jpg',
          },
        },
      })).c.vodInfo(21),
    );
    expect(fromMovieData.backdrop).toBe('https://img.example/vod-bg-2.jpg');

    const noBackdrop = value(
      await client(() => ({
        json: {
          info: {
            stream_icon: 'https://img.example/icon.jpg',
            cover: 'https://img.example/cover.jpg',
            movie_image: 'https://img.example/poster.jpg',
          },
        },
      })).c.vodInfo(22),
    );
    expect(noBackdrop.backdrop).toBeUndefined();
  });
});

describe('shortEpg', () => {
  const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  it('decodes base64 as UTF-8 and converts seconds to ms', async () => {
    const { c, requests } = client(() => ({
      json: {
        epg_listings: [
          {
            title: b64('Çay saati ☕'),
            description: b64('Açıklama'),
            start_timestamp: '1700000000',
            stop_timestamp: 1700003600,
          },
          { title: '!!notbase64!!', description: '', start_timestamp: 1, stop_timestamp: 2 },
          { title: b64('bad'), start_timestamp: 'x', stop_timestamp: 2 },
        ],
      },
    }));
    expect(value(await c.shortEpg(5, 3))).toEqual([
      { start: 1700000000000, stop: 1700003600000, title: 'Çay saati ☕', desc: 'Açıklama' },
      { start: 1000, stop: 2000, title: '!!notbase64!!' },
    ]);
    expect(requests[0]?.url).toContain('action=get_short_epg&stream_id=5&limit=3');
    await c.shortEpg(5);
    expect(requests[1]?.url).not.toContain('limit');
  });
  it('returns an empty list without listings', async () => {
    expect(value(await client(() => ({ json: {} })).c.shortEpg(1))).toEqual([]);
    expect(value(await client(() => ({ json: [] })).c.shortEpg(1))).toEqual([]);
    expect(value(await client(() => ({ json: { epg_listings: [] } })).c.shortEpg(1))).toEqual([]);
  });
});

describe('plain-text EPG fields', () => {
  const b64 = (s: string) => btoa(s);
  it('keeps text that is not base64 of valid UTF-8 text', async () => {
    const { c } = client(() => ({
      json: {
        epg_listings: [
          { title: 'News', description: b64('ÿþ'), start_timestamp: 1, stop_timestamp: 2 },
          { title: b64('\u0001\u0002\u0003'), start_timestamp: 1, stop_timestamp: 2 },
          { title: b64('Line\tone\ntwo'), start_timestamp: 1, stop_timestamp: 2 },
        ],
      },
    }));
    const list = value(await c.shortEpg(1));
    expect(list[0]).toMatchObject({ title: 'News', desc: b64('ÿþ') });
    expect(list[1]?.title).toBe(b64('\u0001\u0002\u0003'));
    expect(list[2]?.title).toBe('Line\tone\ntwo');
  });
});
