import {
  type CatalogService,
  createCatalogService,
  createSyncSqlDriver,
  openCatalog,
  secretKey,
  stalkerKey,
} from '@elv/data';
import type { HttpClient, Scheduler, SecretStore, SqlDriver } from '@elv/domain';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/sim/catalog.ts';
import { count, scanForSecrets } from './import-sim-helpers.ts';
import {
  createTestHttpClient,
  gunzipAdapter,
  must,
  SIM_CLOCK,
  type Sim,
  startTestSim,
} from './sources-sim-helpers.ts';

const NOW = SIM_CLOCK.getTime();
const DEMO_MAC = '00:1A:79:00:00:01';
const EXPIRED_MAC = '00:1A:79:00:00:02';
const UNAUTHORIZED_MAC = '00:1A:79:00:00:99';
const small = buildCatalog('small', 1);

interface TestEnv {
  raw: Database.Database;
  db: SqlDriver;
  secrets: SecretStore & { dump(): Record<string, string> };
  catalog: CatalogService;
  seenTokens: Set<string>;
  forbidden: string[];
  close(): Promise<void>;
}

function memorySecrets(): SecretStore & { dump(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    get: async (key) => map.get(key),
    set: async (key, value) => void map.set(key, value),
    delete: async (key) => void map.delete(key),
    dump: () => Object.fromEntries(map),
  };
}

const testScheduler = (): Scheduler => ({
  yieldNow: () => new Promise<void>((resolve) => setImmediate(resolve)),
});

/** Captures outbound Bearer tokens so the DB secret scan checks real session tokens too. */
function tokenCapturingHttp(inner: HttpClient, seenTokens: Set<string>): HttpClient {
  return {
    get(url, options) {
      const auth = options?.headers?.Authorization ?? options?.headers?.authorization;
      if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
        const token = auth.slice(7).trim();
        if (token.length > 0) seenTokens.add(token);
      }
      return inner.get(url, options);
    },
  };
}

let sim: Sim;
let seq = 0;
const openEnvs: TestEnv[] = [];

beforeAll(async () => {
  sim = await startTestSim();
});
afterAll(async () => {
  await sim.close();
});

async function createEnv(): Promise<TestEnv> {
  const raw = new Database(':memory:');
  const db = createSyncSqlDriver(raw);
  await openCatalog(db);
  const secrets = memorySecrets();
  const seenTokens = new Set<string>();
  const catalog = createCatalogService({
    db,
    secrets,
    scheduler: testScheduler(),
    http: tokenCapturingHttp(createTestHttpClient(), seenTokens),
    clock: () => NOW,
    newId: () => `stk${++seq}`,
    decompressor: gunzipAdapter,
  });
  const env: TestEnv = {
    raw,
    db,
    secrets,
    catalog,
    seenTokens,
    forbidden: [],
    async close() {
      await catalog.close();
      raw.close();
    },
  };
  openEnvs.push(env);
  return env;
}

const macNeedles = (mac: string, baseUrl: string): string[] => [
  mac,
  mac.toLowerCase(),
  mac.replace(/:/g, '-'),
  encodeURIComponent(mac),
  baseUrl,
  new URL(baseUrl).host,
];

const expectedMediaUrl = (baseUrl: string, kind: 'live' | 'movie' | 'series', file: string) =>
  [baseUrl, kind, 'demo', 'demo', file].join('/');

async function addSimStalker(env: TestEnv, name: string, path = '/portal.php', mac = DEMO_MAC) {
  env.forbidden.push(...macNeedles(mac, sim.url));
  return must(
    await env.catalog.addSource({
      kind: 'stalker',
      name,
      portalUrl: `${sim.url}${path}`,
      mac,
    }),
  );
}

afterEach(async () => {
  const hits: unknown[] = [];
  for (const env of openEnvs.splice(0)) {
    try {
      const needles = [...new Set([...env.forbidden, ...env.seenTokens])];
      if (needles.length > 0) {
        hits.push(...scanForSecrets(env.raw, needles));
      }
    } finally {
      await env.close();
    }
  }
  expect(hits).toEqual([]);
});

describe('Stalker portal simulator end-to-end integration', () => {
  it.each([
    { label: '/portal.php', path: '/portal.php' },
    { label: '/stalker_portal/server/load.php', path: '/stalker_portal/server/load.php' },
  ])(
    'imports live, VOD, series, lazy episodes, and keeps all credentials out of SQLite ($label)',
    async ({ path }) => {
      const env = await createEnv();
      const source = await addSimStalker(env, `Sim Stalker ${path}`, path);
      expect(source.kind).toBe('stalker');
      expect(env.secrets.dump()[secretKey(source.id, 'stalker')]).toContain(DEMO_MAC);

      const summary = must(await env.catalog.importSource(source.id));
      expect(summary.counts).toMatchObject({
        live: small.live.length,
        movies: small.movies.length,
        series: small.series.length,
        categories: small.categories.length,
      });

      const liveCats = await env.catalog.categories(source.id, 'live');
      const movieCats = await env.catalog.categories(source.id, 'movie');
      const seriesCats = await env.catalog.categories(source.id, 'series');
      expect(liveCats).toHaveLength(small.categories.filter((c) => c.kind === 'live').length);
      expect(movieCats).toHaveLength(small.categories.filter((c) => c.kind === 'vod').length);
      expect(seriesCats).toHaveLength(small.categories.filter((c) => c.kind === 'series').length);

      expect(await count(env.db, 'live')).toBe(small.live.length);
      expect(await count(env.db, 'movies')).toBe(small.movies.length);
      expect(await count(env.db, 'series')).toBe(small.series.length);
      expect(await count(env.db, 'categories')).toBe(small.categories.length);
      expect(await count(env.db, 'episodes')).toBe(0);

      // Lazy series seasons & episodes loading via CatalogService
      const firstSeries = small.series[0];
      if (firstSeries === undefined) throw new Error('expected synthetic series');
      const seriesRow = env.raw
        .prepare('SELECT id FROM series WHERE source_id = ? AND provider_id = ?')
        .get(source.id, String(firstSeries.id)) as { id: number } | undefined;
      if (seriesRow === undefined) throw new Error('expected imported series row');

      const seasons = must(await env.catalog.seasons(seriesRow.id));
      const expectedSeasons = new Set(firstSeries.episodes.map((e) => e.season)).size;
      expect(seasons).toHaveLength(expectedSeasons);

      const s1Episodes = await env.catalog.episodes(seriesRow.id, 1);
      const expectedS1 = firstSeries.episodes.filter((e) => e.season === 1);
      expect(s1Episodes).toHaveLength(expectedS1.length);
      expect(s1Episodes[0]?.title).toBe(expectedS1[0]?.title);
      expect(await count(env.db, 'episodes')).toBe(firstSeries.episodes.length);

      // Explicit zero-secrets check across core SQLite tables including captured Bearer token
      expect(env.seenTokens.size).toBeGreaterThan(0);
      const needles = [...macNeedles(DEMO_MAC, sim.url), ...env.seenTokens];
      const coreTables = new Set(['sources', 'live', 'movies', 'series', 'episodes', 'categories']);
      const hits = scanForSecrets(env.raw, needles).filter((h) => coreTables.has(h.table));
      expect(hits).toEqual([]);
    },
  );

  it('imports Stalker portal EPG and serves nowNext and epgWindow queries', async () => {
    const env = await createEnv();
    const source = await addSimStalker(env, 'Sim Stalker EPG');
    must(await env.catalog.importSource(source.id));

    if (!env.catalog.importGuide || !env.catalog.nowNext || !env.catalog.epgWindow) {
      throw new Error('expected guide methods on CatalogService');
    }
    const guide = must(await env.catalog.importGuide(source.id));
    const withEpg = small.live.filter((c) => c.epgId !== null).length;
    expect(guide.counts.mapped).toBe(withEpg);
    expect(await count(env.db, 'programmes')).toBeGreaterThan(withEpg);
    expect(await count(env.db, 'programmes_next')).toBe(0);

    const firstLive = small.live[0];
    if (firstLive === undefined) throw new Error('expected synthetic live channel');
    const channelKey = stalkerKey(source.id, 'live', String(firstLive.id));

    const nowNext = await env.catalog.nowNext([channelKey], NOW);
    expect(nowNext).toHaveLength(1);
    expect(nowNext[0]?.channelKey).toBe(channelKey);
    expect(nowNext[0]?.now).not.toBeNull();
    expect(nowNext[0]?.next).not.toBeNull();
    expect(nowNext[0]?.now?.start).toBeLessThanOrEqual(NOW);
    expect(nowNext[0]?.now?.stop).toBeGreaterThan(NOW);

    const window = await env.catalog.epgWindow([channelKey], NOW, NOW + 6 * 3_600_000);
    const channelProgrammes = window[channelKey] ?? [];
    expect(channelProgrammes.length).toBeGreaterThanOrEqual(2);
    expect(channelProgrammes.every((p) => p.stop > p.start)).toBe(true);
  });

  it('resolves play-time create_link streams for live, VOD movie, and series episode', async () => {
    const env = await createEnv();
    const source = await addSimStalker(
      env,
      'Sim Stalker Playback',
      '/stalker_portal/server/load.php',
    );
    must(await env.catalog.importSource(source.id));

    const liveItem = small.live[0];
    const movieItem = small.movies[0];
    const seriesItem = small.series[0];
    const epItem = seriesItem?.episodes[0];
    if (!liveItem || !movieItem || !seriesItem || !epItem) {
      throw new Error('expected synthetic live, movie, series, and episode');
    }

    const seriesRow = env.raw
      .prepare('SELECT id FROM series WHERE source_id = ? AND provider_id = ?')
      .get(source.id, String(seriesItem.id)) as { id: number };
    must(await env.catalog.seasons(seriesRow.id));

    const liveKey = stalkerKey(source.id, 'live', String(liveItem.id));
    const movieKey = stalkerKey(source.id, 'movie', String(movieItem.id));
    const epKey = stalkerKey(source.id, 'episode', String(epItem.id));

    const liveStream = must(await env.catalog.resolveStream(liveKey));
    const movieStream = must(await env.catalog.resolveStream(movieKey));
    const epStream = must(await env.catalog.resolveStream(epKey));

    expect(liveStream.url).toBe(expectedMediaUrl(sim.url, 'live', `${liveItem.id}.ts`));
    expect(movieStream.url).toBe(expectedMediaUrl(sim.url, 'movie', `${movieItem.id}.mp4`));
    expect(epStream.url).toBe(expectedMediaUrl(sim.url, 'series', `${epItem.id}.mp4`));

    // Verify resolved URLs hit real simulator media endpoints (503 when ffmpegPath: null, never 401/404)
    for (const url of [liveStream.url, movieStream.url, epStream.url]) {
      expect(url.startsWith('http://')).toBe(true);
      const res = await fetch(url);
      expect(res.status, url).toBe(503);
    }
  });

  it('auto-rehandshakes on token expiry (401) during play-time create_link', async () => {
    const env = await createEnv();
    const source = await addSimStalker(env, 'Sim Stalker Rehandshake');
    must(await env.catalog.importSource(source.id));

    const liveItem = small.live[0];
    if (!liveItem) throw new Error('expected synthetic live channel');
    const liveKey = stalkerKey(source.id, 'live', String(liveItem.id));

    // Prime the cached StalkerClient session token
    const expectedLiveUrl = expectedMediaUrl(sim.url, 'live', `${liveItem.id}.ts`);
    const first = must(await env.catalog.resolveStream(liveKey));
    expect(first.url).toBe(expectedLiveUrl);

    // Inject a one-shot 401 fault on the next portal request to simulate token expiry
    sim.clear();
    const faultRes = await fetch(`${sim.url}/_sim/faults`, {
      method: 'POST',
      body: JSON.stringify({ account: 'demo', stream: '*', spec: 'status=401', count: 1 }),
    });
    expect(faultRes.status).toBe(201);

    const recovered = must(await env.catalog.resolveStream(liveKey));
    expect(recovered.url).toBe(expectedLiveUrl);

    const portalCalls = sim.requests().filter((r) => r.path === '/portal.php');
    expect(portalCalls.some((r) => r.query.action === 'create_link' && r.status === 401)).toBe(
      true,
    );
    expect(portalCalls.some((r) => r.query.action === 'handshake' && r.status === 200)).toBe(true);
    expect(portalCalls.some((r) => r.query.action === 'create_link' && r.status === 200)).toBe(
      true,
    );
  });

  it('fails cleanly with categorized auth error and zero secret leakage for expired and unauthorized MACs', async () => {
    for (const [label, mac] of [
      ['expired', EXPIRED_MAC],
      ['unauthorized', UNAUTHORIZED_MAC],
    ] as const) {
      const env = await createEnv();
      const source = await addSimStalker(env, `Sim Stalker ${label}`, '/portal.php', mac);
      const result = await env.catalog.importSource(source.id);
      expect(result.ok, label).toBe(false);
      if (result.ok) continue;
      expect(result.error.category, label).toBe('auth');

      const serializedError = JSON.stringify(result.error);
      expect(serializedError).not.toContain(mac);
      expect(serializedError).not.toContain(mac.toLowerCase());
      expect(serializedError).not.toContain(encodeURIComponent(mac));
      for (const token of env.seenTokens) {
        expect(serializedError).not.toContain(token);
      }

      for (const table of ['live', 'movies', 'series', 'categories', 'placements']) {
        expect(await count(env.db, table), `${label}:${table}`).toBe(0);
      }
    }
  });

  it('removes both SQLite rows and SecretStore keys on removeSource', async () => {
    const env = await createEnv();
    const source = await addSimStalker(env, 'Sim Stalker Removable');
    must(await env.catalog.importSource(source.id));
    if (!env.catalog.importGuide) throw new Error('expected importGuide');
    must(await env.catalog.importGuide(source.id));

    const stalkerSecretKey = secretKey(source.id, 'stalker');
    const stalkerCmdsKey = secretKey(source.id, 'stalker_cmds');
    expect(env.secrets.dump()[stalkerSecretKey]).toBeDefined();
    expect(env.secrets.dump()[stalkerCmdsKey]).toBeDefined();

    must(await env.catalog.removeSource(source.id));

    expect(env.secrets.dump()[stalkerSecretKey]).toBeUndefined();
    expect(env.secrets.dump()[stalkerCmdsKey]).toBeUndefined();
    for (const table of [
      'sources',
      'live',
      'movies',
      'series',
      'episodes',
      'categories',
      'placements',
      'programmes',
      'channel_guide',
    ]) {
      expect(await count(env.db, table), table).toBe(0);
    }
  });
});
