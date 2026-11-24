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
import { discoverSourceCategories } from './discover-categories';
import { queryNowNext } from './guide-queries';
import { importGuide } from './import-guide';
import { importCatalog, loadSeriesEpisodes } from './import-xtream';
import { openCatalog } from './migrate';
import { addStalkerSource, getSource, secretKey } from './sources';
import { testDb } from './test-db';

const utf8 = (s: string) => new TextEncoder().encode(s);
const portalStreamUrl = (kind: string, file: string, token?: string): string => {
  const base = ['http://portal.example.test', 'stream', kind, file].join('/');
  return token === undefined ? base : `${base}?play_token=${token}`;
};

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

const immediateScheduler: Scheduler = {
  yieldNow: async () => undefined,
};

interface FakePortalConfig {
  token?: string;
  failAllLive?: boolean;
  failVodOnCall?: number;
  emptyEpgInfo?: boolean;
  profileOverride?: Record<string, unknown>;
  createLinkCalls: Array<{ type: string; cmd: string; series?: string | null }>;
  handshakeCalls: number;
}

function createFakeStalkerHttp(cfg: FakePortalConfig): HttpClient {
  const token = cfg.token ?? 'STALKER_SECRET_TOKEN_XYZ';
  let vodCalls = 0;
  return {
    async get(url: string, options?: HttpRequestOptions): Promise<Result<HttpResponse>> {
      const parsed = new URL(url);
      const type = parsed.searchParams.get('type') ?? '';
      const action = parsed.searchParams.get('action') ?? '';
      const headers = options?.headers ?? {};

      const respond = (payload: unknown, status = 200): Result<HttpResponse> =>
        ok({
          status,
          headers: { 'content-type': 'application/json' },
          body: jsonBody(payload),
          finalUrl: url,
        });

      if (type === 'stb' && action === 'handshake') {
        cfg.handshakeCalls += 1;
        return respond({ js: { token } });
      }

      const auth = headers.Authorization ?? headers.authorization;
      if (auth !== `Bearer ${token}`) {
        return respond({ js: 'Authorization failed.' }, 401);
      }

      if (type === 'stb' && action === 'get_profile') {
        return respond({
          js: cfg.profileOverride ?? {
            status: '1',
            blocked: '0',
            expire_billing_date: '2028-01-01 00:00:00',
            max_connections: '3',
            default_timezone: 'Europe/Istanbul',
          },
        });
      }

      if (type === 'itv' && action === 'get_genres') {
        return respond({
          js: [
            { id: '*', title: 'All' },
            { id: '10', title: 'News' },
            { id: '20', title: 'Sports' },
          ],
        });
      }

      if (type === 'itv' && action === 'get_all_channels') {
        if (cfg.failAllLive) {
          return respond({ js: 'unsupported' }, 500);
        }
        return respond({
          js: {
            data: [
              {
                id: '101',
                number: '1',
                name: 'World News HD',
                tv_genre_id: '10',
                cmd: 'ffrt http://portal.example.test/ch/101?token=secret1',
                logo: 'http://cdn.example.test/logos/news.png',
                xmltv_id: 'news.1',
                enable_tv_archive: 1,
                tv_archive_duration: 72,
              },
              {
                id: '102',
                number: '2',
                name: 'Arena Sports',
                tv_genre_id: '20',
                cmd: 'ffmpeg http://portal.example.test/ch/102',
                xmltv_id: 'sports.2',
                enable_tv_archive: 0,
                tv_archive_duration: 0,
              },
            ],
          },
        });
      }

      if (type === 'itv' && action === 'get_ordered_list') {
        const page = Number(parsed.searchParams.get('p') ?? '1');
        if (page === 1) {
          return respond({
            js: {
              total_items: 2,
              max_page_items: 1,
              data: [
                {
                  id: '101',
                  number: '1',
                  name: 'World News HD',
                  tv_genre_id: '10',
                  cmd: 'ffrt http://portal.example.test/ch/101?token=secret1',
                  xmltv_id: 'news.1',
                  enable_tv_archive: 1,
                  tv_archive_duration: 72,
                },
              ],
            },
          });
        }
        return respond({
          js: {
            total_items: 2,
            max_page_items: 1,
            data: [
              {
                id: '102',
                number: '2',
                name: 'Arena Sports',
                tv_genre_id: '20',
                cmd: 'ffmpeg http://portal.example.test/ch/102',
                xmltv_id: 'sports.2',
                enable_tv_archive: 0,
                tv_archive_duration: 0,
              },
            ],
          },
        });
      }

      if (type === 'vod' && action === 'get_categories') {
        return respond({
          js: [
            { id: '*', title: 'All' },
            { id: '30', title: 'Cinema' },
          ],
        });
      }

      if (type === 'vod' && action === 'get_ordered_list') {
        vodCalls += 1;
        if (cfg.failVodOnCall !== undefined && vodCalls >= cfg.failVodOnCall) {
          return respond({ js: 'boom' }, 500);
        }
        return respond({
          js: {
            total_items: 1,
            max_page_items: 14,
            data: [
              {
                id: '201',
                name: 'Solaris',
                category_id: '30',
                cmd: 'ffmpeg http://portal.example.test/vod/201',
                screenshot_uri: 'http://cdn.example.test/posters/solaris.jpg',
                rating_imdb: '8.1',
                year: '1972',
                description: 'A psychologist is sent to a space station.',
                actors: 'Donatas Banionis',
                director: 'Andrei Tarkovsky',
              },
            ],
          },
        });
      }

      if (type === 'series' && action === 'get_categories') {
        return respond({
          js: [{ id: '40', title: 'Drama Series' }],
        });
      }

      if (type === 'series' && action === 'get_ordered_list') {
        const movieId = parsed.searchParams.get('movie_id');
        const seasonId = parsed.searchParams.get('season_id');
        if (movieId && seasonId) {
          return respond({
            js: {
              total_items: 2,
              max_page_items: 14,
              data: [
                {
                  id: '4001',
                  series_number: 1,
                  name: 'Pilot',
                  cmd: 'ffmpeg http://portal.example.test/series/301/s1e1',
                  time: 45,
                },
                {
                  id: '4002',
                  series_number: 2,
                  name: 'Second Wind',
                  cmd: 'ffmpeg http://portal.example.test/series/301/s1e2',
                  time: 48,
                },
              ],
            },
          });
        }
        if (movieId) {
          return respond({
            js: {
              total_items: 1,
              max_page_items: 14,
              data: [
                {
                  id: 's1',
                  name: 'Season 1',
                  season_number: 1,
                  cmd: 'ffmpeg http://portal.example.test/series/301/s1',
                },
              ],
            },
          });
        }
        return respond({
          js: {
            total_items: 1,
            max_page_items: 14,
            data: [
              {
                id: '301',
                name: 'Signal Tower',
                category_id: '40',
                screenshot_uri: 'http://cdn.example.test/posters/tower.jpg',
                rating_imdb: '8.4',
                year: '2024',
                description: 'Signals across the mountain.',
              },
            ],
          },
        });
      }

      if (type === 'itv' && action === 'get_epg_info') {
        if (cfg.emptyEpgInfo) return respond({ js: { data: {} } });
        return respond({
          js: {
            data: {
              '101': [
                {
                  start_timestamp: 1_700_000_000,
                  stop_timestamp: 1_700_003_600,
                  name: 'Evening Bulletin',
                  descr: 'Top headlines.',
                },
              ],
            },
          },
        });
      }

      if (type === 'itv' && action === 'get_short_epg') {
        const chId = parsed.searchParams.get('ch_id');
        if (chId === '101') {
          return respond({
            js: [
              {
                start_timestamp: 1_700_000_000,
                stop_timestamp: 1_700_003_600,
                name: 'Short EPG News',
                descr: 'Fallback short EPG.',
              },
            ],
          });
        }
        return respond({ js: [] });
      }

      if (action === 'create_link') {
        const cmd = parsed.searchParams.get('cmd') ?? '';
        const series = parsed.searchParams.get('series');
        cfg.createLinkCalls.push({ type, cmd, series });
        if (type === 'itv') {
          return respond({
            js: { cmd: `ffmpeg ${portalStreamUrl('live', '101.ts', 'ephem1')}` },
          });
        }
        if (type === 'vod') {
          return respond({
            js: { cmd: portalStreamUrl('vod', '201.mp4', 'ephem2') },
          });
        }
        return respond({
          js: {
            cmd: `http://portal.example.test/stream/series/301/ep${series ?? '1'}.mp4?play_token=ephem3`,
          },
        });
      }

      return respond({ js: [] });
    },
  };
}

async function dumpAllSqliteStrings(db: SqlDriver): Promise<string> {
  const tables = [
    'sources',
    'categories',
    'live',
    'movies',
    'series',
    'episodes',
    'placements',
    'import_runs',
    'guide_channels',
    'channel_guide',
    'programmes',
  ];
  const chunks: string[] = [];
  for (const t of tables) {
    const rows = await db.all<Record<string, unknown>>(`SELECT * FROM ${t}`);
    chunks.push(JSON.stringify(rows));
  }
  return chunks.join('\n');
}

describe('Stalker / Ministra MAC portal support (#29, ADR 0015)', () => {
  it('validates portal URL and MAC address and keeps all secrets strictly out of SQLite', async () => {
    const { db } = testDb();
    const secrets = memorySecrets();
    expect((await openCatalog(db)).ok).toBe(true);
    const addDeps = { db, secrets, clock: () => 1_700_000_000_000, newId: () => 'st1' };

    const badMac = await addStalkerSource(
      { name: 'Portal', portalUrl: 'http://portal.example.test/c/', mac: 'not-a-mac' },
      addDeps,
    );
    expect(badMac.ok).toBe(false);
    if (!badMac.ok) expect(badMac.error.code).toBe('invalid-mac');

    const badUrl = await addStalkerSource(
      { name: 'Portal', portalUrl: 'ftp://portal.example.test/', mac: '00:1a:79:aa:bb:cc' },
      addDeps,
    );
    expect(badUrl.ok).toBe(false);

    const added = await addStalkerSource(
      {
        name: 'My Stalker Portal',
        portalUrl: 'http://portal.example.test/c/',
        mac: '00-1a-79-aa-bb-cc',
        serialNumber: 'SN-SECRET-999',
        transport: { hostOverride: '10.0.0.5', dnsFamily: 'ipv4' },
      },
      addDeps,
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.value.kind).toBe('stalker');
    expect(added.value.settings.credentialFingerprint).toMatch(/^fp:[0-9a-f]{64}$/);
    expect(added.value.settings.transport).toEqual({ hostOverride: '10.0.0.5', dnsFamily: 'ipv4' });

    const storedSecret = JSON.parse(secrets.data.get(secretKey('st1', 'stalker')) ?? '{}');
    expect(storedSecret).toEqual({
      portalUrl: 'http://portal.example.test/c/',
      mac: '00:1A:79:AA:BB:CC',
      serialNumber: 'SN-SECRET-999',
    });

    const sqlDump = await dumpAllSqliteStrings(db);
    expect(sqlDump).not.toContain('portal.example.test');
    expect(sqlDump).not.toContain('00:1A:79');
    expect(sqlDump).not.toContain('00-1a-79');
    expect(sqlDump).not.toContain('SN-SECRET-999');
  });

  it('imports live, VOD, series, lazy episodes, and portal EPG atomically with zero credentials in SQLite and resolves streams at play time', async () => {
    const { db } = testDb();
    const secrets = memorySecrets();
    expect((await openCatalog(db)).ok).toBe(true);

    const cfg: FakePortalConfig = { createLinkCalls: [], handshakeCalls: 0 };
    const http = createFakeStalkerHttp(cfg);
    const service = createCatalogService({
      db,
      secrets,
      scheduler: immediateScheduler,
      http,
      clock: () => 1_700_000_500_000,
      newId: () => 'st1',
    });

    const added = await service.addSource({
      kind: 'stalker',
      name: 'Living Room Portal',
      portalUrl: 'http://portal.example.test/c/',
      mac: '00:1a:79:00:00:01',
      transport: { hostOverride: '10.1.2.3' },
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const discovered = await discoverSourceCategories('st1', {
      db,
      secrets,
      scheduler: immediateScheduler,
      http,
      clock: () => 1_700_000_500_000,
    });
    expect(discovered.ok).toBe(true);
    if (discovered.ok) {
      expect(discovered.value.some((c) => c.kind === 'live' && c.name === 'News')).toBe(true);
      expect(discovered.value.some((c) => c.kind === 'movie' && c.name === 'Cinema')).toBe(true);
      expect(discovered.value.some((c) => c.kind === 'series' && c.name === 'Drama Series')).toBe(
        true,
      );
    }

    const imported = await service.importSource('st1');
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.counts.live).toBe(2);
    expect(imported.value.counts.movies).toBe(1);
    expect(imported.value.counts.series).toBe(1);

    const source = await getSource(db, 'st1');
    expect(source?.settings.accountMeta?.maxConnections).toBe(3);
    expect(source?.settings.serverTimezone).toBe('Europe/Istanbul');

    const liveCats = await service.categories('st1', 'live');
    expect(liveCats.map((c) => c.name)).toEqual(['News', 'Sports']);
    const newsCat = liveCats[0];
    if (newsCat === undefined) throw new Error('expected News category');
    const newsItems = await service.items(newsCat.id, 0, 10);
    expect(newsItems).toHaveLength(1);
    const newsCh = newsItems[0];
    if (newsCh === undefined) throw new Error('expected news channel');
    expect(newsCh.name).toBe('World News HD');
    expect(newsCh.catchupDays).toBe(3);

    const seriesCats = await service.categories('st1', 'series');
    const seriesCat = seriesCats[0];
    if (seriesCat === undefined) throw new Error('expected series category');
    const seriesItems = await service.items(seriesCat.id, 0, 10);
    expect(seriesItems).toHaveLength(1);
    const seriesItem = seriesItems[0];
    if (seriesItem === undefined) throw new Error('expected series item');

    // Lazy load episodes via seasons()
    const seasonsRes = await service.seasons(seriesItem.id);
    expect(seasonsRes.ok).toBe(true);
    if (seasonsRes.ok) {
      expect(seasonsRes.value).toEqual([{ season: 1, episodeCount: 2 }]);
    }
    const eps = await service.episodes(seriesItem.id, 1);
    expect(eps).toHaveLength(2);
    expect(eps[0]?.title).toBe('Pilot');

    // Import Stalker portal EPG
    const guideRes = await importGuide(
      'st1',
      { db, secrets, scheduler: immediateScheduler, http, clock: () => 1_700_000_500_000 },
      { now: 1_700_000_500_000 },
    );
    expect(guideRes.ok).toBe(true);
    const nowNext = await queryNowNext(db, [newsCh.key], 1_700_000_500_000);
    expect(nowNext[0]?.now?.title).toBe('Evening Bulletin');

    // CRITICAL zero-credential DB audit: ZERO URLs, hosts, cmds, MACs, or tokens in SQLite!
    const sqlDump = await dumpAllSqliteStrings(db);
    expect(sqlDump).not.toContain('portal.example.test');
    expect(sqlDump).not.toContain('00:1A:79');
    expect(sqlDump).not.toContain('00:1a:79');
    expect(sqlDump).not.toContain('STALKER_SECRET_TOKEN_XYZ');
    expect(sqlDump).not.toContain('ffrt ');
    expect(sqlDump).not.toContain('ffmpeg ');
    expect(sqlDump).not.toContain('play_token=');
    expect(sqlDump).not.toContain('secret1');

    // Play-time create_link for live, movie, and episode
    const liveStream = await service.resolveStream(newsCh.key);
    expect(liveStream.ok).toBe(true);
    if (liveStream.ok) {
      expect(liveStream.value.url).toBe(portalStreamUrl('live', '101.ts', 'ephem1'));
      expect(liveStream.value.hostOverride).toBe('10.1.2.3');
      expect(liveStream.value.maxConnections).toBe(3);
    }

    const movieCats = await service.categories('st1', 'movie');
    const movieCat = movieCats[0];
    if (movieCat === undefined) throw new Error('expected movie category');
    const movieItems = await service.items(movieCat.id, 0, 10);
    const movieItem = movieItems[0];
    if (movieItem === undefined) throw new Error('expected movie item');
    const movieStream = await service.resolveStream(movieItem.key);
    expect(movieStream.ok).toBe(true);
    if (movieStream.ok) {
      expect(movieStream.value.url).toBe(portalStreamUrl('vod', '201.mp4', 'ephem2'));
    }

    const ep2 = eps[1];
    if (ep2 === undefined) throw new Error('expected second episode');
    const epStream = await service.resolveStream(ep2.key);
    expect(epStream.ok).toBe(true);
    if (epStream.ok) {
      expect(epStream.value.url).toBe(
        'http://portal.example.test/stream/series/301/ep2.mp4?play_token=ephem3',
      );
    }

    expect(cfg.createLinkCalls).toEqual([
      {
        type: 'itv',
        cmd: 'ffrt http://portal.example.test/ch/101?token=secret1',
        series: null,
      },
      {
        type: 'vod',
        cmd: 'ffmpeg http://portal.example.test/vod/201',
        series: null,
      },
      {
        type: 'series',
        cmd: 'ffmpeg http://portal.example.test/series/301/s1e2',
        series: '2',
      },
    ]);

    // Catch-up stream resolution
    const catchup = await service.resolveCatchupStream?.(newsCh.key, {
      startMs: 1_700_000_000_000 - 3_600_000,
      stopMs: 1_700_000_000_000,
    });
    expect(catchup?.ok).toBe(true);
    if (catchup?.ok) {
      expect(catchup.value.url).toContain(portalStreamUrl('live', '101.ts'));
      expect(catchup.value.url).toContain('utc=');
    }

    await service.close();
  });

  it('falls back to paginated liveChannels, shortEpg when epgInfo is empty, and rolls back safely on mid-import failure', async () => {
    const { db } = testDb();
    const secrets = memorySecrets();
    expect((await openCatalog(db)).ok).toBe(true);

    const cfg: FakePortalConfig = {
      failAllLive: true,
      emptyEpgInfo: true,
      createLinkCalls: [],
      handshakeCalls: 0,
    };
    const http = createFakeStalkerHttp(cfg);
    const deps = {
      db,
      secrets,
      scheduler: immediateScheduler,
      http,
      clock: () => 1_700_000_500_000,
    };

    const added = await addStalkerSource(
      {
        name: 'Fallback Portal',
        portalUrl: 'http://portal.example.test/c/',
        mac: '00:1A:79:00:00:01',
      },
      { db, secrets, clock: () => 1_700_000_500_000, newId: () => 'st2' },
    );
    expect(added.ok).toBe(true);

    const first = await importCatalog('st2', deps);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.value.counts.live).toBe(2);
    }

    // Fallback shortEpg path when epgInfo returns empty
    const guideRes = await importGuide('st2', deps, { now: 1_700_000_500_000 });
    expect(guideRes.ok).toBe(true);
    const nowNext = await queryNowNext(db, ['s:st2:live:101'], 1_700_000_500_000);
    expect(nowNext[0]?.now?.title).toBe('Short EPG News');

    // Second import fails during VOD fetch -> live catalog and stalker_cmds MUST remain intact!
    const failingCfg: FakePortalConfig = {
      failAllLive: true,
      failVodOnCall: 1,
      createLinkCalls: [],
      handshakeCalls: 0,
    };
    const failed = await importCatalog('st2', { ...deps, http: createFakeStalkerHttp(failingCfg) });
    expect(failed.ok).toBe(false);

    const liveRows = await db.all<{ key: string }>('SELECT key FROM live WHERE source_id = ?', [
      'st2',
    ]);
    expect(liveRows).toHaveLength(2);
    expect(secrets.data.get(secretKey('st2', 'stalker_cmds'))).toContain('live:101');

    // Direct loadSeriesEpisodes also works for Stalker
    const epRes = await loadSeriesEpisodes('st2', 's:st2:series:301', deps);
    expect(epRes.ok).toBe(true);
    if (epRes.ok) expect(epRes.value).toBe(2);
  });

  it('rejects expired and blocked Stalker profiles with categorized auth errors without mutating catalog', async () => {
    const { db } = testDb();
    const secrets = memorySecrets();
    expect((await openCatalog(db)).ok).toBe(true);

    const added = await addStalkerSource(
      {
        name: 'Expired Portal',
        portalUrl: 'http://portal.example.test/c/',
        mac: '00:1A:79:00:00:02',
      },
      { db, secrets, clock: () => 1_700_000_500_000, newId: () => 'st3' },
    );
    expect(added.ok).toBe(true);

    const expiredRes = await importCatalog('st3', {
      db,
      secrets,
      scheduler: immediateScheduler,
      http: createFakeStalkerHttp({
        profileOverride: {
          status: '1',
          blocked: '0',
          expire_billing_date: '2020-01-01 00:00:00',
        },
        createLinkCalls: [],
        handshakeCalls: 0,
      }),
      clock: () => 1_700_000_500_000,
    });
    expect(expiredRes.ok).toBe(false);
    if (!expiredRes.ok) {
      expect(expiredRes.error.category).toBe('auth');
      expect(expiredRes.error.code).toBe('account-expired');
    }

    const blockedRes = await importCatalog('st3', {
      db,
      secrets,
      scheduler: immediateScheduler,
      http: createFakeStalkerHttp({
        profileOverride: {
          status: '1',
          blocked: '1',
          expire_billing_date: '2028-01-01 00:00:00',
        },
        createLinkCalls: [],
        handshakeCalls: 0,
      }),
      clock: () => 1_700_000_500_000,
    });
    expect(blockedRes.ok).toBe(false);
    if (!blockedRes.ok) {
      expect(blockedRes.error.category).toBe('auth');
      expect(blockedRes.error.code).toBe('account-disabled');
    }
  });

  it('does not leave orphaned stalker_cmds keys when removeSource races with loadSeriesEpisodes', async () => {
    const { db } = testDb();
    const secrets = memorySecrets();
    expect((await openCatalog(db)).ok).toBe(true);

    const cfg: FakePortalConfig = { createLinkCalls: [], handshakeCalls: 0 };
    const baseHttp = createFakeStalkerHttp(cfg);
    const deps = {
      db,
      secrets,
      scheduler: immediateScheduler,
      http: baseHttp,
      clock: () => 1_700_000_500_000,
    };

    const added = await addStalkerSource(
      {
        name: 'Race Portal',
        portalUrl: 'http://portal.example.test/c/',
        mac: '00:1A:79:00:00:01',
      },
      { db, secrets, clock: () => 1_700_000_500_000, newId: () => 'strace' },
    );
    expect(added.ok).toBe(true);
    expect((await importCatalog('strace', deps)).ok).toBe(true);

    // Simulate concurrent removeSource firing right after season episodes are fetched, before mergeStalkerCmdMap
    const racingHttp: HttpClient = {
      async get(url, options) {
        const res = await baseHttp.get(url, options);
        const parsed = new URL(url);
        if (
          parsed.searchParams.get('type') === 'series' &&
          parsed.searchParams.get('action') === 'get_ordered_list' &&
          parsed.searchParams.get('season_id')
        ) {
          await db.run('UPDATE sources SET deleting = 1 WHERE id = ?', ['strace']);
          await secrets.delete(secretKey('strace', 'stalker_cmds'));
        }
        return res;
      },
    };

    const epRes = await loadSeriesEpisodes('strace', 's:strace:series:301', {
      ...deps,
      http: racingHttp,
    });
    expect(epRes.ok).toBe(false);
    if (!epRes.ok) {
      expect(epRes.error.category).toBe('storage');
      expect(epRes.error.code).toBe('source-not-found');
    }
    const leftoverCmdKeys = Array.from(secrets.data.keys()).filter((k) =>
      k.startsWith('source.strace.stalker_cmds'),
    );
    expect(leftoverCmdKeys).toEqual([]);
  });
});
