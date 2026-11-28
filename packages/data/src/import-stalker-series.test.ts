import {
  type HttpClient,
  type HttpRequestOptions,
  type HttpResponse,
  ok,
  type Result,
  type Scheduler,
  type SecretStore,
  type SqlDriver,
} from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createCatalogService } from './catalog';
import { importCatalog, loadSeriesEpisodes } from './import-xtream';
import { openCatalog } from './migrate';
import { addStalkerSource, secretKey } from './sources';
import { testDb } from './test-db';

const utf8 = (s: string) => new TextEncoder().encode(s);

function jsonBody(data: unknown): AsyncIterable<Uint8Array> {
  const bytes = utf8(JSON.stringify(data));
  return {
    async *[Symbol.asyncIterator]() {
      yield bytes;
    },
  };
}

function memorySecrets(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(key) {
      return data.get(key);
    },
    async set(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
  };
}

const immediateScheduler: Scheduler = { yieldNow: async () => undefined };

async function dumpAllSqliteStrings(db: SqlDriver): Promise<string> {
  const tables = ['sources', 'categories', 'live', 'movies', 'series', 'episodes', 'placements'];
  const parts: string[] = [];
  for (const t of tables) {
    parts.push(JSON.stringify(await db.all<Record<string, unknown>>(`SELECT * FROM ${t}`)));
  }
  return parts.join('\n');
}

describe('STK-1 & STK-3: Stalker discovery persistence, VOD-series, embedded series[], and Ministra is_file', () => {
  it('discovers token-free /server/load.php portal, persists discovery in SecretStore only, and self-repairs on endpoint move', async () => {
    const { db } = testDb();
    const secrets = memorySecrets();
    expect((await openCatalog(db)).ok).toBe(true);

    const added = await addStalkerSource(
      {
        name: 'Simple Portal',
        portalUrl: 'http://simple.example.test',
        mac: '001a.7911.2233',
      },
      { db, secrets, clock: () => 1_700_000_000_000, newId: () => 'simp1' },
    );
    expect(added.ok).toBe(true);

    let migrated = false;
    const seenPaths: string[] = [];
    const http: HttpClient = {
      async get(url: string, options?: HttpRequestOptions): Promise<Result<HttpResponse>> {
        const parsed = new URL(url);
        seenPaths.push(parsed.pathname);
        const type = parsed.searchParams.get('type') ?? '';
        const action = parsed.searchParams.get('action') ?? '';
        const respond = (payload: unknown, status = 200) =>
          ok({
            status,
            headers: { 'content-type': 'application/json' },
            body: jsonBody(payload),
            finalUrl: url,
          });

        if (!migrated) {
          if (parsed.pathname !== '/server/load.php') return respond('Not Found', 404);
        } else {
          if (parsed.pathname !== '/stalker_portal/server/load.php') {
            return respond('Not Found', 404);
          }
          if (action === 'handshake') return respond({ js: { token: 'MIGRATED-TOK' } });
          if (options?.headers?.Authorization !== 'Bearer MIGRATED-TOK') {
            return respond('Authorization failed.', 401);
          }
        }

        if (action === 'get_profile') return respond({ js: { status: 0, blocked: 0 } });
        if (type === 'itv' && action === 'get_genres') {
          return respond({ js: [{ id: '1', title: 'Live' }] });
        }
        if (type === 'itv' && action === 'get_all_channels') {
          return respond({
            js: {
              data: [{ id: '10', name: 'Ch 1', tv_genre_id: '1', cmd: 'http://cdn.test/1.ts' }],
            },
          });
        }
        if (action === 'get_categories') return respond({ js: [] });
        return respond({ js: { total_items: 0, max_page_items: 14, data: [] } });
      },
    };

    const deps = {
      db,
      secrets,
      scheduler: immediateScheduler,
      http,
      clock: () => 1_700_000_000_000,
    };
    const first = await importCatalog('simp1', deps);
    expect(first.ok).toBe(true);

    const storedAfterFirst = JSON.parse(secrets.data.get(secretKey('simp1', 'stalker')) ?? '{}');
    expect(storedAfterFirst.discoveredEndpoint).toBe('http://simple.example.test/server/load.php');
    expect(storedAfterFirst.portalMode).toBe('simple');

    // Second import uses persisted endpoint directly (never hits /portal.php!)
    seenPaths.length = 0;
    const second = await importCatalog('simp1', deps);
    expect(second.ok).toBe(true);
    expect(seenPaths.includes('/portal.php')).toBe(false);

    // Portal migrates to /stalker_portal/server/load.php with full auth -> self-repairs & updates secret
    migrated = true;
    const third = await importCatalog('simp1', deps);
    expect(third.ok).toBe(true);
    const storedAfterRepair = JSON.parse(secrets.data.get(secretKey('simp1', 'stalker')) ?? '{}');
    expect(storedAfterRepair.discoveredEndpoint).toBe(
      'http://simple.example.test/stalker_portal/server/load.php',
    );
    expect(storedAfterRepair.portalMode).toBe('full');

    const dump = await dumpAllSqliteStrings(db);
    expect(dump).not.toContain('simple.example.test');
    expect(dump).not.toContain('MIGRATED-TOK');
  });

  it('ingests vod.isSeries, embedded vod.series[], season.series[], multi-page seasons, and Ministra is_file/custom resolution', async () => {
    const { db } = testDb();
    const secrets = memorySecrets();
    expect((await openCatalog(db)).ok).toBe(true);

    const createLinkCalls: Array<{ type: string; cmd: string; series: string | null }> = [];
    const seasonEpisodeCalls: string[] = [];

    const http: HttpClient = {
      async get(url: string): Promise<Result<HttpResponse>> {
        const parsed = new URL(url);
        const type = parsed.searchParams.get('type') ?? '';
        const action = parsed.searchParams.get('action') ?? '';
        const movieId = parsed.searchParams.get('movie_id');
        const seasonId = parsed.searchParams.get('season_id');
        const episodeId = parsed.searchParams.get('episode_id');
        const page = Number(parsed.searchParams.get('p') ?? '1');

        const respond = (payload: unknown) =>
          ok({
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: jsonBody(payload),
            finalUrl: url,
          });

        if (action === 'get_profile') return respond({ js: { status: 0, blocked: 0 } });
        if (type === 'itv' && action === 'get_genres') {
          return respond({ js: [{ id: '1', title: 'Live' }] });
        }
        if (type === 'itv' && action === 'get_all_channels') {
          return respond({
            js: { data: [{ id: '1', name: 'Ch 1', tv_genre_id: '1', cmd: 'http://cdn.test/ch1' }] },
          });
        }
        if (type === 'vod' && action === 'get_categories') {
          return respond({ js: [{ id: '30', title: 'VOD Boxsets' }] });
        }
        if (type === 'series' && action === 'get_categories') {
          return respond({ js: [{ id: '40', title: 'Classic Series' }] });
        }

        if (type === 'vod' && action === 'get_ordered_list') {
          if (movieId === '500' && seasonId === '500:s1' && episodeId === '500:e1') {
            return respond({
              js: {
                total_items: 2,
                max_page_items: 14,
                data: [
                  { id: '999', is_file: 1, file_type: 'subtitle', protocol: 'http', cmd: '' },
                  { id: '8899', is_file: 1, file_type: 'video', protocol: 'custom', cmd: '' },
                ],
              },
            });
          }
          if (movieId === '500' && seasonId) {
            return respond({
              js: {
                total_items: 1,
                max_page_items: 14,
                data: [
                  {
                    id: seasonId === '500:s1' ? '500:e1' : `${seasonId}:e1`,
                    series_number: 1,
                    name: seasonId === '500:s1' ? 'Ministra Ep 1' : `Ep of ${seasonId}`,
                    cmd: seasonId === '500:s1' ? '' : `ffmpeg /media/${seasonId}.mp4`,
                  },
                ],
              },
            });
          }
          if (movieId === '500') {
            if (page === 1) {
              return respond({
                js: {
                  total_items: 15,
                  max_page_items: 14,
                  data: Array.from({ length: 14 }, (_, i) => ({
                    id: `500:s${i + 1}`,
                    name: `Season ${i + 1}`,
                    season_number: i + 1,
                  })),
                },
              });
            }
            return respond({
              js: {
                total_items: 15,
                max_page_items: 14,
                data: [{ id: '500:s15', name: 'Season 15', season_number: 15 }],
              },
            });
          }
          if (movieId === '501') {
            // Flat embedded VOD-series has no sub-seasons
            return respond({ js: { total_items: 0, max_page_items: 14, data: [] } });
          }

          // Top-level VOD listing containing movie + Ministra is_series + embedded series[] item
          // Also tests seen-ID no-progress guard (total_items inflated to 10, page 2 repeats page 1)
          return respond({
            js: {
              total_items: 10,
              max_page_items: 3,
              data: [
                {
                  id: '201',
                  name: 'Regular Movie',
                  category_id: '30',
                  cmd: 'ffmpeg http://cdn.test/movie201.mp4',
                },
                {
                  id: '500',
                  name: 'Ministra Multi-Season',
                  category_id: '30',
                  cmd: '',
                  is_series: 1,
                },
                {
                  id: '501',
                  name: 'Flat Anthology 1-2 Seasons',
                  category_id: '30',
                  cmd: 'ffmpeg /media/anthology_501.mpg',
                  series: [1, 2, 3],
                },
              ],
            },
          });
        }

        if (type === 'series' && action === 'get_ordered_list') {
          if (movieId === '600' && seasonId) {
            seasonEpisodeCalls.push(seasonId);
            return respond({ js: { total_items: 0, max_page_items: 14, data: [] } });
          }
          if (movieId === '600') {
            return respond({
              js: {
                total_items: 1,
                max_page_items: 14,
                data: [
                  {
                    id: '600:s1',
                    name: 'Season 1 (1-2 Seasons)',
                    season_number: 1,
                    cmd: 'ffmpeg http://portal.example.test/series/600_s1',
                    series: [1, 2, 3, 4],
                  },
                ],
              },
            });
          }
          return respond({
            js: {
              total_items: 1,
              max_page_items: 14,
              data: [{ id: '600', name: 'Embedded Season Show', category_id: '40' }],
            },
          });
        }

        if (action === 'create_link') {
          const cmd = parsed.searchParams.get('cmd') ?? '';
          const series = parsed.searchParams.get('series');
          createLinkCalls.push({ type, cmd, series });
          return respond({
            js: { cmd: `https://portal.example.test/play/${type}/${series ?? 'direct'}.mp4` },
          });
        }

        return respond({ js: [] });
      },
    };

    const service = createCatalogService({
      db,
      secrets,
      scheduler: immediateScheduler,
      http,
      clock: () => 1_700_000_000_000,
      newId: () => 'min1',
    });

    const added = await service.addSource({
      kind: 'stalker',
      name: 'Ministra Portal',
      portalUrl: 'https://portal.example.test/stalker_portal/server/load.php',
      mac: '00:1A:79:11:22:33',
    });
    expect(added.ok).toBe(true);

    const imp = await service.importSource('min1');
    expect(imp.ok).toBe(true);
    if (!imp.ok) return;
    // Regular movie stays in movies; Ministra is_series + embedded VOD series + regular series all in series!
    expect(imp.value.counts.movies).toBe(1);
    expect(imp.value.counts.series).toBe(3);

    // 1. Ministra VOD-series: loads all 15 seasons (page 1 + page 2) and resolves is_file=1 protocol='custom' -> /media/file_8899.mpg
    const epCountMinistra = await loadSeriesEpisodes('min1', 's:min1:series:500', {
      db,
      secrets,
      scheduler: immediateScheduler,
      http,
      clock: () => 1_700_000_000_000,
    });
    expect(epCountMinistra.ok).toBe(true);
    if (epCountMinistra.ok) expect(epCountMinistra.value).toBe(15);

    const ministraStream = await service.resolveStream('s:min1:episode:500:e1');
    expect(ministraStream.ok).toBe(true);
    expect(createLinkCalls[0]).toEqual({
      type: 'vod',
      cmd: '/media/file_8899.mpg',
      series: null,
    });

    // 2. Embedded VOD series[] with range-like title: synthesizes Season 1 with 3 episodes without splitting seasons
    const epCountFlat = await loadSeriesEpisodes('min1', 's:min1:series:501', {
      db,
      secrets,
      scheduler: immediateScheduler,
      http,
      clock: () => 1_700_000_000_000,
    });
    expect(epCountFlat.ok).toBe(true);
    if (epCountFlat.ok) expect(epCountFlat.value).toBe(3);
    const flatSeasons = await db.all<{ season: number; cnt: number }>(
      'SELECT season, COUNT(*) AS cnt FROM episodes WHERE series_key = ? GROUP BY season',
      ['s:min1:series:501'],
    );
    expect(flatSeasons).toEqual([{ season: 1, cnt: 3 }]);
    const flatEp2 = await db.all<{ key: string }>(
      'SELECT key FROM episodes WHERE series_key = ? AND episode = 2',
      ['s:min1:series:501'],
    );
    const flatStream = await service.resolveStream(flatEp2[0]?.key ?? '');
    expect(flatStream.ok).toBe(true);
    expect(createLinkCalls[1]).toEqual({
      type: 'vod',
      cmd: 'ffmpeg /media/anthology_501.mpg',
      series: '2',
    });

    // 3. Season with embedded series[] falls back to synthesis when seasonEpisodes returns empty
    const epCountEmbSeason = await loadSeriesEpisodes('min1', 's:min1:series:600', {
      db,
      secrets,
      scheduler: immediateScheduler,
      http,
      clock: () => 1_700_000_000_000,
    });
    expect(epCountEmbSeason.ok).toBe(true);
    if (epCountEmbSeason.ok) expect(epCountEmbSeason.value).toBe(4);
    expect(seasonEpisodeCalls).toEqual(['600:s1']);
    const embEp3 = await db.all<{ key: string }>(
      'SELECT key FROM episodes WHERE series_key = ? AND episode = 3',
      ['s:min1:series:600'],
    );
    const embStream = await service.resolveStream(embEp3[0]?.key ?? '');
    expect(embStream.ok).toBe(true);
    expect(createLinkCalls[2]).toEqual({
      type: 'series',
      cmd: 'ffmpeg http://portal.example.test/series/600_s1',
      series: '3',
    });

    // Zero-secret SQLite invariant: NO /media/file_, NO cmds, NO portal hosts in SQLite!
    const dump = await dumpAllSqliteStrings(db);
    expect(dump).not.toContain('/media/file_8899.mpg');
    expect(dump).not.toContain('anthology_501');
    expect(dump).not.toContain('portal.example.test');

    await service.close();
  });

  it('handles VOD-only portals with failing type=series, static link flags on import, unknown-series, direct isFile episodes, and stale episode pruning', async () => {
    const { db } = testDb();
    const secrets = memorySecrets();
    expect((await openCatalog(db)).ok).toBe(true);

    let episodeWave = 1;
    const http: HttpClient = {
      async get(url: string): Promise<Result<HttpResponse>> {
        const parsed = new URL(url);
        const type = parsed.searchParams.get('type') ?? '';
        const action = parsed.searchParams.get('action') ?? '';
        const movieId = parsed.searchParams.get('movie_id');
        const seasonId = parsed.searchParams.get('season_id');
        const respond = (payload: unknown, status = 200) =>
          ok({
            status,
            headers: { 'content-type': 'application/json' },
            body: jsonBody(payload),
            finalUrl: url,
          });

        if (action === 'get_profile') return respond({ js: { status: 0, blocked: 0 } });
        if (type === 'itv' && action === 'get_genres') {
          return respond({ js: [{ id: '1', title: 'Live' }] });
        }
        if (type === 'itv' && action === 'get_all_channels') {
          return respond({
            js: {
              data: [
                {
                  id: '10',
                  name: 'Static Live',
                  tv_genre_id: '1',
                  cmd: 'ffmpeg https://cdn.example.test/live/10.ts',
                  use_http_tmp_link: 0,
                  use_load_balancing: 0,
                },
              ],
            },
          });
        }
        if (type === 'vod' && action === 'get_categories') {
          return respond({ js: [{ id: '30', title: 'VOD' }] });
        }
        if (type === 'series') {
          return respond({ js: 'not supported' }, 500);
        }
        if (type === 'vod' && action === 'get_ordered_list') {
          if (movieId === '700' && seasonId) {
            const rows =
              episodeWave === 1
                ? [
                    {
                      id: '7001',
                      series_number: 1,
                      name: 'Direct File Ep 1',
                      is_file: 1,
                      protocol: 'custom',
                      cmd: '',
                    },
                    {
                      id: '7002',
                      series_number: 2,
                      name: 'Stale Ep 2',
                      cmd: 'ffmpeg /media/ep2.mpg',
                    },
                  ]
                : [
                    {
                      id: '7001',
                      series_number: 1,
                      name: 'Direct File Ep 1',
                      is_file: 1,
                      protocol: 'custom',
                      cmd: '',
                    },
                  ];
            return respond({ js: { total_items: rows.length, max_page_items: 14, data: rows } });
          }
          if (movieId === '700') {
            return respond({
              js: {
                total_items: 1,
                max_page_items: 14,
                data: [{ id: '700:s1', name: 'Season 1', season_number: 1 }],
              },
            });
          }
          return respond({
            js: {
              total_items: 2,
              max_page_items: 14,
              data: [
                {
                  id: '202',
                  name: 'Static Movie',
                  category_id: '30',
                  cmd: 'https://cdn.example.test/vod/202.mp4',
                  use_http_tmp_link: false,
                  use_load_balancing: false,
                },
                { id: '700', name: 'VOD Only Show', category_id: '30', is_series: 1, cmd: '' },
              ],
            },
          });
        }
        return respond({ js: [] });
      },
    };

    const added = await addStalkerSource(
      {
        name: 'VOD Only Portal',
        portalUrl: 'https://vodonly.example.test/portal.php',
        mac: '00:1A:79:22:33:44',
      },
      { db, secrets, clock: () => 1_700_000_000_000, newId: () => 'vodonly' },
    );
    expect(added.ok).toBe(true);

    const deps = {
      db,
      secrets,
      scheduler: immediateScheduler,
      http,
      clock: () => 1_700_000_000_000,
    };
    const imp = await importCatalog('vodonly', deps);
    expect(imp.ok).toBe(true);
    if (imp.ok) {
      expect(imp.value.counts.live).toBe(1);
      expect(imp.value.counts.movies).toBe(1);
      expect(imp.value.counts.series).toBe(1);
    }

    const rawCmds = secrets.data.get(secretKey('vodonly', 'stalker_cmds')) ?? '';
    expect(rawCmds).toContain('static:live:10');
    expect(rawCmds).toContain('static:movie:202');

    // Unknown series error path
    const missing = await loadSeriesEpisodes('vodonly', 's:vodonly:series:missing', deps);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('unknown-series');

    // Wave 1: 2 episodes (direct isFile custom -> /media/file_7001.mpg)
    const w1 = await loadSeriesEpisodes('vodonly', 's:vodonly:series:700', deps);
    expect(w1.ok).toBe(true);
    if (w1.ok) expect(w1.value).toBe(2);
    expect(secrets.data.get(secretKey('vodonly', 'stalker_cmds'))).toContain(
      '/media/file_7001.mpg',
    );

    // Wave 2: stale episode 7002 is pruned cleanly
    episodeWave = 2;
    const w2 = await loadSeriesEpisodes('vodonly', 's:vodonly:series:700', deps);
    expect(w2.ok).toBe(true);
    if (w2.ok) expect(w2.value).toBe(1);
  });

  it('prefers real seasonEpisodes over season.series[] summary, never fabricates /media/file_ without isFile=true, and preserves cmds on emptiedKinds', async () => {
    const { db } = testDb();
    const secrets = memorySecrets();
    expect((await openCatalog(db)).ok).toBe(true);

    let dropLiveAndMovies = false;
    const http: HttpClient = {
      async get(url: string): Promise<Result<HttpResponse>> {
        const parsed = new URL(url);
        const type = parsed.searchParams.get('type') ?? '';
        const action = parsed.searchParams.get('action') ?? '';
        const movieId = parsed.searchParams.get('movie_id');
        const seasonId = parsed.searchParams.get('season_id');
        const episodeId = parsed.searchParams.get('episode_id');
        const respond = (payload: unknown) =>
          ok({
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: jsonBody(payload),
            finalUrl: url,
          });

        if (action === 'get_profile') return respond({ js: { status: 0, blocked: 0 } });
        if (type === 'itv' && action === 'get_genres') {
          return respond({ js: [{ id: '1', title: 'Live' }] });
        }
        if (type === 'itv' && action === 'get_all_channels') {
          return respond({
            js: {
              data: dropLiveAndMovies
                ? []
                : [
                    {
                      id: '10',
                      name: 'Kept Live',
                      tv_genre_id: '1',
                      cmd: 'https://cdn.example.test/live/10.ts',
                      use_http_tmp_link: 0,
                      use_load_balancing: 0,
                    },
                  ],
            },
          });
        }
        if (type === 'vod' && action === 'get_categories') {
          return respond({ js: [{ id: '30', title: 'VOD' }] });
        }
        if (type === 'series' && action === 'get_categories') {
          return respond({ js: [{ id: '40', title: 'Series' }] });
        }
        if (type === 'vod' && action === 'get_ordered_list') {
          if (movieId === '800' && seasonId && episodeId) {
            return respond({ js: { total_items: 0, max_page_items: 14, data: [] } });
          }
          if (movieId === '800' && seasonId) {
            return respond({
              js: {
                total_items: 1,
                max_page_items: 14,
                // Container episode with protocol='custom' but NO is_file=1 -> must NOT fabricate /media/file_8001.mpg
                data: [
                  { id: '8001', series_number: 1, name: 'No File Ep', protocol: 'custom', cmd: '' },
                ],
              },
            });
          }
          if (movieId === '800') {
            return respond({
              js: {
                total_items: 1,
                max_page_items: 14,
                data: [{ id: '800:s1', name: 'Season 1', season_number: 1 }],
              },
            });
          }
          return respond({
            js: {
              total_items: dropLiveAndMovies ? 0 : 2,
              max_page_items: 14,
              data: dropLiveAndMovies
                ? []
                : [
                    {
                      id: '20',
                      name: 'Kept Movie',
                      category_id: '30',
                      cmd: 'https://cdn.example.test/vod/20.mp4',
                      use_http_tmp_link: 0,
                      use_load_balancing: 0,
                    },
                    { id: '800', name: 'Container Show', category_id: '30', is_series: 1, cmd: '' },
                  ],
            },
          });
        }
        if (type === 'series' && action === 'get_ordered_list') {
          if (movieId === '900' && seasonId === '900:1') {
            return respond({
              js: {
                total_items: 2,
                max_page_items: 14,
                data: [
                  {
                    id: '400001',
                    series_number: 1,
                    name: 'Real Pilot',
                    cmd: 'ffmpeg http://localhost/series/400001',
                    time: 42,
                  },
                  {
                    id: '400002',
                    series_number: 2,
                    name: 'Real Second',
                    cmd: 'ffmpeg http://localhost/series/400002',
                    time: 45,
                  },
                ],
              },
            });
          }
          if (movieId === '900') {
            return respond({
              js: {
                total_items: 1,
                max_page_items: 14,
                // Simulator-style season row carrying BOTH series: [1, 2] summary AND real seasonEpisodes
                data: [{ id: '900:1', name: 'Season 1', season_number: 1, series: [1, 2] }],
              },
            });
          }
          return respond({
            js: {
              total_items: 1,
              max_page_items: 14,
              data: [{ id: '900', name: 'Titled Show', category_id: '40' }],
            },
          });
        }
        return respond({ js: [] });
      },
    };

    expect(
      (
        await addStalkerSource(
          {
            name: 'Reg Portal',
            portalUrl: 'https://reg.example.test/portal.php',
            mac: '00:1A:79:44:55:66',
          },
          { db, secrets, clock: () => 1_700_000_000_000, newId: () => 'reg1' },
        )
      ).ok,
    ).toBe(true);
    const deps = {
      db,
      secrets,
      scheduler: immediateScheduler,
      http,
      clock: () => 1_700_000_000_000,
    };
    expect((await importCatalog('reg1', deps)).ok).toBe(true);

    // 1. Real seasonEpisodes MUST win over season.series[] summary
    const realEpsRes = await loadSeriesEpisodes('reg1', 's:reg1:series:900', deps);
    expect(realEpsRes.ok).toBe(true);
    const epRows = await db.all<{ provider_id: string; title: string }>(
      'SELECT provider_id, title FROM episodes WHERE series_key = ? ORDER BY episode ASC',
      ['s:reg1:series:900'],
    );
    expect(epRows).toEqual([
      { provider_id: '400001', title: 'Real Pilot' },
      { provider_id: '400002', title: 'Real Second' },
    ]);

    // 2. Non-isFile custom episode container MUST NOT fabricate /media/file_8001.mpg
    expect((await loadSeriesEpisodes('reg1', 's:reg1:series:800', deps)).ok).toBe(true);
    const cmdsAfter800 = secrets.data.get(secretKey('reg1', 'stalker_cmds')) ?? '';
    expect(cmdsAfter800).not.toContain('/media/file_8001.mpg');

    // 3. Emptied live/movie kinds preserve live:/static:live:/movie:/static:movie: cmds alongside kept SQLite rows
    dropLiveAndMovies = true;
    const secondImp = await importCatalog('reg1', deps);
    expect(secondImp.ok).toBe(true);
    const preservedCmds = JSON.parse(secrets.data.get(secretKey('reg1', 'stalker_cmds')) ?? '{}');
    expect(preservedCmds['live:10']).toBe('https://cdn.example.test/live/10.ts');
    expect(preservedCmds['static:live:10']).toBe('1');
    expect(preservedCmds['movie:20']).toBe('https://cdn.example.test/vod/20.mp4');
    expect(preservedCmds['static:movie:20']).toBe('1');
  });
});
