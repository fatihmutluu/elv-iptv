import { type ElvError, type HttpClient, ok, type Result } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createStalkerClient } from './stalker';

const MAC = '00:1A:79:00:00:01';
const PORTAL = 'http://portal.example.test:8080';

function mockJsonPortal(handler: (url: string) => unknown): HttpClient {
  return {
    async get(url) {
      const bytes = new TextEncoder().encode(JSON.stringify(handler(url)));
      return ok({
        status: 200,
        headers: {},
        body: {
          async *[Symbol.asyncIterator]() {
            yield bytes;
          },
        },
      });
    },
  };
}

function unwrap<T>(r: Result<T>): T {
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(`${r.error.category}/${r.error.code}`);
  return r.value;
}

function expectErr<T>(r: Result<T>, category: ElvError['category'], code: string): void {
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error('expected error');
  expect(r.error.category).toBe(category);
  expect(r.error.code).toBe(code);
}

function paramOf(url: string, name: string): string | null {
  return new URL(url).searchParams.get(name);
}

describe('StalkerClient catalog, pagination, and EPG APIs', () => {
  it('parses genres, live pages, allLiveChannels, VOD, series, seasons, and episodes', async () => {
    const http = mockJsonPortal((url) => {
      const type = paramOf(url, 'type');
      const action = paramOf(url, 'action');
      if (action === 'handshake') return { js: { token: 'T1' } };
      if (type === 'itv' && action === 'get_genres') {
        return {
          js: [
            { id: '*', title: 'All', alias: 'all' },
            { id: '10', title: 'Sports', alias: 'sports', censored: 0 },
            { id: '11', title: 'Adult', alias: 'adult', censored: '1' },
          ],
        };
      }
      if (type === 'itv' && action === 'get_ordered_list') {
        return {
          js: {
            total_items: '28',
            max_page_items: 14,
            data: [
              {
                id: '101',
                number: '1',
                name: 'ELV One HD',
                tv_genre_id: '10',
                cmd: 'ffrt http://portal.example.test/ch/101',
                logo: 'https://cdn.example.test/101.png',
                xmltv_id: 'elv-1',
                enable_tv_archive: 1,
                tv_archive_duration: 168,
              },
              {
                id: '102',
                number: '2',
                name: 'Bad Logo',
                tv_genre_id: '10',
                cmd: 'ffmpeg http://portal.example.test/ch/102',
                logo: 'javascript:alert(1)',
                enable_tv_archive: 0,
              },
            ],
          },
        };
      }
      if (type === 'itv' && action === 'get_all_channels') {
        return {
          js: {
            data: [
              {
                id: '101',
                number: 1,
                name: 'ELV One HD',
                tv_genre_id: '10',
                cmd: 'ffrt http://portal.example.test/ch/101',
              },
            ],
          },
        };
      }
      if (type === 'vod' && action === 'get_categories') {
        return {
          js: [
            { id: '*', title: 'All' },
            { id: '20', title: 'Action' },
          ],
        };
      }
      if (type === 'vod' && action === 'get_ordered_list') {
        return {
          js: {
            total_items: 1,
            max_page_items: 14,
            data: [
              {
                id: '500',
                name: 'Star Horizon',
                category_id: '20',
                cmd: 'ffmpeg http://portal.example.test/vod/500',
                screenshot_uri: 'https://cdn.example.test/vod500.jpg',
                rating_imdb: '8.2',
                year: '2024',
                description: 'A sci-fi journey.',
                actors: 'Ada, Bob',
                director: 'Pat',
                time: '125',
              },
            ],
          },
        };
      }
      if (type === 'series' && action === 'get_categories') {
        return { js: [{ id: '30', title: 'Drama' }] };
      }
      if (type === 'series' && action === 'get_ordered_list') {
        if (paramOf(url, 'season_id')) {
          return {
            js: {
              total_items: 1,
              max_page_items: 14,
              data: [
                {
                  id: '9001',
                  series_number: 1,
                  name: 'Pilot',
                  cmd: 'ffmpeg http://portal.example.test/series/9001',
                  time: '45',
                },
              ],
            },
          };
        }
        if (paramOf(url, 'movie_id')) {
          return {
            js: {
              data: [
                {
                  id: '700:1',
                  name: 'Season 1',
                  season_number: 1,
                  cmd: 'ffmpeg http://portal.example.test/series/700:1',
                  series: [1, 2, 3],
                },
              ],
            },
          };
        }
        return {
          js: {
            total_items: 1,
            max_page_items: 14,
            data: [
              {
                id: '700',
                name: 'Signal Run',
                category_id: '30',
                screenshot_uri: 'https://cdn.example.test/s700.jpg',
                rating_imdb: '8.7',
                year: '2025',
                description: 'Episodic thriller.',
              },
            ],
          },
        };
      }
      return { js: [] };
    });

    const client = createStalkerClient({ http, portalUrl: PORTAL, mac: MAC });

    expect(unwrap(await client.genres())).toEqual([
      { id: '10', title: 'Sports', alias: 'sports' },
      { id: '11', title: 'Adult', alias: 'adult', censored: true },
    ]);

    expect(unwrap(await client.liveChannels({ genreId: '10', page: 2 }))).toEqual({
      page: 2,
      totalItems: 28,
      maxPageItems: 14,
      items: [
        {
          id: '101',
          number: 1,
          name: 'ELV One HD',
          genreId: '10',
          cmd: 'ffrt http://portal.example.test/ch/101',
          logo: 'https://cdn.example.test/101.png',
          epgId: 'elv-1',
          catchupDays: 7,
        },
        {
          id: '102',
          number: 2,
          name: 'Bad Logo',
          genreId: '10',
          cmd: 'ffmpeg http://portal.example.test/ch/102',
          catchupDays: 0,
        },
      ],
    });

    expect(unwrap(await client.allLiveChannels())).toHaveLength(1);
    expect(unwrap(await client.vodCategories())).toEqual([{ id: '20', title: 'Action' }]);
    expect(unwrap(await client.vodItems({ categoryId: '20', page: 1 })).items[0]).toMatchObject({
      id: '500',
      name: 'Star Horizon',
      cover: 'https://cdn.example.test/vod500.jpg',
      rating: 8.2,
      year: 2024,
      durationSec: 7500,
    });
    expect(unwrap(await client.seriesCategories())).toEqual([{ id: '30', title: 'Drama' }]);
    expect(unwrap(await client.seriesItems({ categoryId: '30' })).items[0]).toMatchObject({
      id: '700',
      name: 'Signal Run',
      cover: 'https://cdn.example.test/s700.jpg',
    });
    expect(unwrap(await client.seriesSeasons('700'))).toEqual([
      {
        id: '700:1',
        seriesId: '700',
        seasonNumber: 1,
        name: 'Season 1',
        cmd: 'ffmpeg http://portal.example.test/series/700:1',
        seriesEpisodeNumbers: [1, 2, 3],
      },
    ]);
    expect(unwrap(await client.seasonEpisodes('700', '700:1', 1)).items).toEqual([
      {
        id: '9001',
        seriesId: '700',
        seasonId: '700:1',
        episodeNumber: 1,
        title: 'Pilot',
        cmd: 'ffmpeg http://portal.example.test/series/9001',
        durationSec: 2700,
      },
    ]);
  });

  it('parses get_short_epg and get_epg_info and rejects empty IDs or malformed shapes', async () => {
    const http = mockJsonPortal((url) => {
      const action = paramOf(url, 'action');
      if (action === 'handshake') return { js: { token: 'T1' } };
      if (action === 'get_short_epg') {
        return {
          js: [
            {
              id: '1',
              ch_id: '101',
              start_timestamp: 1_700_000_000,
              stop_timestamp: 1_700_003_600,
              name: 'Evening News',
              descr: 'Daily update',
            },
          ],
        };
      }
      if (action === 'get_epg_info') {
        return {
          js: {
            data: {
              '101': [
                {
                  id: '2',
                  ch_id: '101',
                  time: '2026-11-24 20:00:00',
                  time_to: '2026-11-24 21:00:00',
                  name: 'Prime Time',
                  descr: 'Live studio',
                },
              ],
              __proto__: [{ id: 'x', start_timestamp: 1, stop_timestamp: 2, name: 'Bad' }],
            },
          },
        };
      }
      return { js: [] };
    });

    const client = createStalkerClient({ http, portalUrl: PORTAL, mac: MAC });
    expect(unwrap(await client.shortEpg('101', 5))).toEqual([
      {
        start: 1_700_000_000_000,
        stop: 1_700_003_600_000,
        title: 'Evening News',
        desc: 'Daily update',
      },
    ]);

    const info = unwrap(await client.epgInfo(12));
    expect(info['101']).toEqual([
      {
        start: Date.UTC(2026, 10, 24, 20, 0, 0),
        stop: Date.UTC(2026, 10, 24, 21, 0, 0),
        title: 'Prime Time',
        desc: 'Live studio',
      },
    ]);
    expect(Object.hasOwn(info, '__proto__')).toBe(false);

    expectErr(await client.seriesSeasons('  '), 'source-format', 'invalid-id');
    expectErr(await client.seasonEpisodes('', '1'), 'source-format', 'invalid-id');
    expectErr(await client.shortEpg(''), 'source-format', 'invalid-id');

    const emptyEpgClient = createStalkerClient({
      http: mockJsonPortal((u) =>
        paramOf(u, 'action') === 'handshake' ? { js: { token: 'T1' } } : { js: [] },
      ),
      portalUrl: PORTAL,
      mac: MAC,
    });
    expect(Object.keys(unwrap(await emptyEpgClient.epgInfo()))).toEqual([]);

    const badShapeClient = createStalkerClient({
      http: mockJsonPortal((u) =>
        paramOf(u, 'action') === 'handshake' ? { js: { token: 'T1' } } : { js: 42 },
      ),
      portalUrl: PORTAL,
      mac: MAC,
    });
    expectErr(await badShapeClient.profile(), 'source-format', 'unexpected-shape');
    expectErr(await badShapeClient.genres(), 'source-format', 'unexpected-shape');
    expectErr(await badShapeClient.liveChannels(), 'source-format', 'unexpected-shape');
    expectErr(await badShapeClient.vodItems(), 'source-format', 'unexpected-shape');
    expectErr(await badShapeClient.seriesItems(), 'source-format', 'unexpected-shape');
    expectErr(await badShapeClient.seasonEpisodes('1', '2'), 'source-format', 'unexpected-shape');
    expectErr(await badShapeClient.epgInfo(), 'source-format', 'unexpected-shape');
  });
});
