import { type HttpClient, ok, type Scheduler, type SecretStore } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createCatalogService, openCatalog } from './index';
import { testDb } from './test-db';

function memorySecrets(): SecretStore {
  const map = new Map<string, string>();
  return {
    async get(key) {
      return map.get(key);
    },
    async set(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

function noopScheduler(): Scheduler {
  return {
    async yieldNow() {},
  };
}

async function* chunksOf(text: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(text);
}

describe('updateSourceSettings playlist cache invalidation (#39)', () => {
  it('clears httpCache.playlist when categorySelection changes so remote M3U re-imports instead of 304 short-circuiting', async () => {
    const { db } = testDb();
    await openCatalog(db);
    const secrets = memorySecrets();

    const m3u = `#EXTM3U
#EXTINF:-1 group-title="Sports",ESPN HD
http://s.example.test/espn.ts
#EXTINF:-1 group-title="News",CNN HD
http://s.example.test/cnn.ts
`;
    const sentIfNoneMatch: Array<string | undefined> = [];
    const http: HttpClient = {
      async get(url, opts) {
        const inm = opts?.headers?.['if-none-match'] ?? opts?.headers?.['If-None-Match'];
        sentIfNoneMatch.push(inm);
        if (inm === '"v1"') {
          return ok({
            status: 304,
            headers: { etag: '"v1"' },
            body: chunksOf(''),
            finalUrl: url,
          });
        }
        return ok({
          status: 200,
          headers: { etag: '"v1"' },
          body: chunksOf(m3u),
          finalUrl: url,
        });
      },
    };

    const svc = createCatalogService({
      db,
      secrets,
      scheduler: noopScheduler(),
      http,
      clock: () => 1_700_000_000_000,
      newId: () => 'src304',
    });

    await svc.addSource({
      kind: 'm3u',
      name: 'Cached M3U',
      playlistUrl: 'http://s.example.test/list.m3u',
    });

    await svc.updateSourceSettings?.('src304', {
      categorySelection: { live: ['Sports'] },
    });

    // First import caches ETag "v1" and imports only Sports
    expect((await svc.importSource('src304')).ok).toBe(true);
    expect((await svc.categories('src304', 'live')).map((c) => c.name)).toEqual(['Sports']);

    // Second import with unchanged settings sends If-None-Match and hits 304
    expect((await svc.importSource('src304')).ok).toBe(true);
    expect(sentIfNoneMatch).toEqual([undefined, '"v1"']);

    // Updating categorySelection must clear httpCache.playlist so the next import fetches fresh
    await svc.updateSourceSettings?.('src304', {
      categorySelection: { live: ['Sports', 'News'] },
    });
    const rawAfterPatch = await db.all<{ settings_json: string }>(
      'SELECT settings_json FROM sources WHERE id = ?',
      ['src304'],
    );
    const parsedAfterPatch = JSON.parse(rawAfterPatch[0]?.settings_json ?? '{}');
    expect(parsedAfterPatch.httpCache).toBeUndefined();

    expect((await svc.importSource('src304')).ok).toBe(true);
    expect(sentIfNoneMatch).toEqual([undefined, '"v1"', undefined]);
    expect((await svc.categories('src304', 'live')).map((c) => c.name).sort()).toEqual([
      'News',
      'Sports',
    ]);
  });
});
