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
    expectErr(
      await client(() => ({ json: [1] })).c.seriesInfo(1),
      'source-format',
      'unexpected-shape',
    );
  });
});

describe('vodInfo', () => {
  it('maps info and movie data', async () => {
    const { c, requests } = client(() => ({
      json: {
        info: { duration_secs: '5400', plot: ' Plot ', releasedate: '2020-03-04' },
        movie_data: { container_extension: 'mkv' },
      },
    }));
    expect(value(await c.vodInfo(8))).toEqual({
      durationSec: 5400,
      plot: 'Plot',
      year: 2020,
      extension: 'mkv',
    });
    expect(requests[0]?.url).toContain('action=get_vod_info&vod_id=8');
  });
  it('defaults the extension and prefers year', async () => {
    const { c } = client(() => ({ json: { info: { year: '1999', releasedate: '2020-01-01' } } }));
    expect(value(await c.vodInfo(1))).toEqual({ year: 1999, extension: 'mp4' });
    expect(value(await client(() => ({ json: {} })).c.vodInfo(1))).toEqual({ extension: 'mp4' });
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
