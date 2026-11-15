import { createCatalogService, openCatalog } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { elvError, err, type HttpClient, ok } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import {
  type DevSeedPayload,
  normalizeSeedForTarget,
  readEmbeddedDevSeed,
  runDevSeedOnce,
} from './dev-seeder';

function createStubSimHttp(options: { reachable?: boolean } = {}): HttpClient {
  return {
    async get(rawUrl) {
      if (options.reachable === false) {
        return err(elvError('network', 'unreachable'));
      }
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

  it('rewrites localhost and 127.0.0.1 to 10.0.2.2 strictly on Android emulators', () => {
    const xtreamLoopback: DevSeedPayload = {
      kind: 'xtream',
      name: 'Local Sim',
      server: 'http://127.0.0.1:7878',
      username: 'demo',
      password: 'demo',
    };
    const m3uLoopback: DevSeedPayload = {
      kind: 'm3u',
      name: 'Local M3U',
      playlistUrl: 'http://localhost:7878/playlists/demo.m3u8?a=1',
      guideUrl: 'http://127.0.0.1:7878/xmltv.xml',
    };

    expect(normalizeSeedForTarget(xtreamLoopback, { os: 'android', isDevice: false })).toEqual({
      ...xtreamLoopback,
      server: 'http://10.0.2.2:7878',
    });
    expect(normalizeSeedForTarget(m3uLoopback, { os: 'android', isDevice: false })).toEqual({
      ...m3uLoopback,
      playlistUrl: 'http://10.0.2.2:7878/playlists/demo.m3u8?a=1',
      guideUrl: 'http://10.0.2.2:7878/xmltv.xml',
    });

    // Never rewrite on physical Android, iOS/tvOS Simulator, physical Apple, or LAN addresses
    expect(normalizeSeedForTarget(xtreamLoopback, { os: 'android', isDevice: true })).toEqual(
      xtreamLoopback,
    );
    expect(normalizeSeedForTarget(xtreamLoopback, { os: 'ios', isDevice: false })).toEqual(
      xtreamLoopback,
    );
    expect(
      normalizeSeedForTarget(
        { ...xtreamLoopback, server: 'http://192.168.1.25:7878' },
        { os: 'android', isDevice: false },
      ),
    ).toEqual({ ...xtreamLoopback, server: 'http://192.168.1.25:7878' });
  });

  it('rolls back the source and leaves elv.dev.seeded unset when the seed host is unreachable', async () => {
    const handle = testDb();
    const migrated = await openCatalog(handle.db);
    if (!migrated.ok) throw new Error('migration failed');
    const secrets = memorySecrets();
    let reachable = false;
    const catalog = createCatalogService({
      db: handle.db,
      secrets,
      scheduler: countingScheduler(),
      http: {
        get: (url) => createStubSimHttp({ reachable }).get(url),
      },
      clock: () => 1_700_000_000_000,
    });

    const seed: DevSeedPayload = {
      kind: 'xtream',
      name: 'Offline Sim',
      server: 'http://127.0.0.1:7878',
      username: 'demo',
      password: 'demo',
    };
    let changedCalls = 0;

    try {
      // First launch while simulator is offline -> rolled back cleanly, elv.dev.seeded unset
      const offlineRun = await runDevSeedOnce({
        seed,
        catalog,
        secrets,
        onChanged: () => {
          changedCalls += 1;
        },
      });
      expect(offlineRun).toEqual({ seeded: false });
      expect(await catalog.listSources()).toEqual([]);
      expect(await secrets.get('elv.dev.seeded')).toBeUndefined();
      expect(changedCalls).toBeGreaterThanOrEqual(1);

      // Next launch once simulator is running -> seeds and imports cleanly!
      reachable = true;
      const onlineRun = await runDevSeedOnce({
        seed,
        catalog,
        secrets,
      });
      expect(onlineRun.seeded).toBe(true);
      expect(await secrets.get('elv.dev.seeded')).toBe('1');
      const rows = await catalog.listSources();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.needsImport).toBe(false);
    } finally {
      await catalog.close();
      handle.close();
    }
  });
});
