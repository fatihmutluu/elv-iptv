import { createCatalogService, openCatalog } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { type HttpClient, ok } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { type DevSeedPayload, readEmbeddedDevSeed, runDevSeedOnce } from './dev-seeder';

function createStubSimHttp(): HttpClient {
  return {
    async get(rawUrl) {
      const url = new URL(rawUrl);
      const bodyText =
        url.pathname === '/player_api.php'
          ? JSON.stringify(
              url.searchParams.get('action') === 'get_live_categories'
                ? [{ category_id: '1', category_name: 'General' }]
                : url.searchParams.get('action') === 'get_live_streams'
                  ? [{ stream_id: 101, name: 'Channel One', category_id: '1', num: 1 }]
                  : !url.searchParams.get('action')
                    ? { user_info: { auth: 1, status: 'Active' }, server_info: {} }
                    : [],
            )
          : '#EXTM3U\n#EXTINF:-1,Channel One\nhttp://127.0.0.1:7878/live/demo/demo/101.ts\n';
      const bytes = new TextEncoder().encode(bodyText);
      return ok({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: {
          async *[Symbol.asyncIterator]() {
            yield bytes;
          },
        },
      });
    },
  };
}

async function makeCatalogHarness() {
  const handle = testDb();
  const migrated = await openCatalog(handle.db);
  if (!migrated.ok) throw new Error('migration failed');
  const secrets = memorySecrets();
  const catalog = createCatalogService({
    db: handle.db,
    secrets,
    scheduler: countingScheduler(),
    http: createStubSimHttp(),
    clock: () => 1_700_000_000_000,
  });
  return {
    catalog,
    secrets,
    async close() {
      await catalog.close();
      handle.close();
    },
  };
}

describe('dev-seeder (#10)', () => {
  it('returns seeded: false when seed is undefined', async () => {
    const env = await makeCatalogHarness();
    try {
      const result = await runDevSeedOnce({
        seed: undefined,
        catalog: env.catalog,
        secrets: env.secrets,
      });
      expect(result).toEqual({ seeded: false });
      expect(await env.catalog.listSources()).toEqual([]);
      expect(env.secrets.dump()).toEqual({});
    } finally {
      await env.close();
    }
  });

  it('seeds once on empty first launch, imports, and never re-seeds after removeSource', async () => {
    const env = await makeCatalogHarness();
    const seed: DevSeedPayload = {
      kind: 'xtream',
      name: 'Local Sim',
      server: 'http://127.0.0.1:7878',
      username: 'demo',
      password: 'demo',
    };
    let changedCalls = 0;

    try {
      const first = await runDevSeedOnce({
        seed,
        catalog: env.catalog,
        secrets: env.secrets,
        onChanged: () => {
          changedCalls += 1;
        },
      });
      expect(first.seeded).toBe(true);
      expect(typeof first.sourceId).toBe('string');
      expect(changedCalls).toBeGreaterThanOrEqual(2);
      expect(await env.secrets.get('elv.dev.seeded')).toBe('1');

      const sources = await env.catalog.listSources();
      expect(sources).toHaveLength(1);
      expect(sources[0]?.needsImport).toBe(false);

      // Developer removes the seeded source to test empty state
      await env.catalog.removeSource(sources[0]?.id ?? '');
      expect(await env.catalog.listSources()).toEqual([]);

      // Next launch does NOT re-seed because elv.dev.seeded === '1'
      const second = await runDevSeedOnce({
        seed,
        catalog: env.catalog,
        secrets: env.secrets,
      });
      expect(second).toEqual({ seeded: false });
      expect(await env.catalog.listSources()).toEqual([]);
    } finally {
      await env.close();
    }
  });

  it('marks elv.dev.seeded and skips seeding when listSources() already has user rows', async () => {
    const env = await makeCatalogHarness();
    try {
      await env.catalog.addSource({
        kind: 'm3u',
        name: 'Existing Playlist',
        playlistUrl: 'http://127.0.0.1:7878/playlists/demo.m3u8',
      });

      const res = await runDevSeedOnce({
        seed: {
          kind: 'm3u',
          name: 'Dev M3U',
          playlistUrl: 'http://127.0.0.1:7878/playlists/other.m3u8',
        },
        catalog: env.catalog,
        secrets: env.secrets,
      });

      expect(res).toEqual({ seeded: false });
      expect(await env.secrets.get('elv.dev.seeded')).toBe('1');
      const rows = await env.catalog.listSources();
      expect(rows.map((r) => r.name)).toEqual(['Existing Playlist']);
    } finally {
      await env.close();
    }
  });

  it('supports M3U seed payloads and validates readEmbeddedDevSeed', async () => {
    const env = await makeCatalogHarness();
    try {
      expect(readEmbeddedDevSeed(undefined)).toBeUndefined();
      expect(readEmbeddedDevSeed({})).toBeUndefined();
      expect(readEmbeddedDevSeed({ seed: { kind: 'unknown' } })).toBeUndefined();

      const m3uSeed = readEmbeddedDevSeed({
        seed: {
          kind: 'm3u',
          name: 'Sim M3U',
          playlistUrl: 'http://127.0.0.1:7878/playlists/demo.m3u8',
          guideUrl: 'http://127.0.0.1:7878/xmltv.xml',
        },
      });
      expect(m3uSeed).toEqual({
        kind: 'm3u',
        name: 'Sim M3U',
        playlistUrl: 'http://127.0.0.1:7878/playlists/demo.m3u8',
        guideUrl: 'http://127.0.0.1:7878/xmltv.xml',
      });

      const res = await runDevSeedOnce({
        seed: m3uSeed,
        catalog: env.catalog,
        secrets: env.secrets,
      });
      expect(res.seeded).toBe(true);
    } finally {
      await env.close();
    }
  });
});
