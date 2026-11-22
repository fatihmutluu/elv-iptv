import type { HttpClient, HttpResponse, Scheduler, SecretStore } from '@elv/domain';
import { ok } from '@elv/domain';
import { EPG_FLAG_LIVE, EPG_FLAG_NEW, EPG_FLAG_PREMIERE, EPG_FLAG_REPEAT } from '@elv/sources';
import { describe, expect, it } from 'vitest';
import {
  createCatalogService,
  listRecentChannels,
  MIGRATIONS,
  openCatalog,
  reconcileUserData,
  recordRecentChannel,
  saveUserDataSnapshot,
  type UserDataStore,
} from './index';
import { testDb } from './test-db';

function createMemorySecrets(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: async (k) => map.get(k),
    set: async (k, v) => {
      map.set(k, v);
    },
    delete: async (k) => {
      map.delete(k);
    },
  };
}

const syncScheduler: Scheduler = {
  yieldNow: async () => undefined,
};

function makeHttpResponse(
  body: string,
  opts?: { status?: number; url?: string; headers?: Record<string, string> },
): HttpResponse {
  const bytes = new TextEncoder().encode(body);
  return {
    status: opts?.status ?? 200,
    headers: opts?.headers ?? {},
    finalUrl: opts?.url ?? 'https://provider.example/res',
    body: (async function* () {
      if (bytes.length > 0) yield bytes;
    })(),
  };
}

describe('Wave C2 data layer: MIGRATION_V10, EPG genre/flags, recent channels, sync timestamps (#396, #53, #68)', () => {
  it('upgrades a v9 database to v10 with genre/flags columns, recent_channels table, and import_runs index', async () => {
    const { db } = testDb();
    // Apply migrations v1..v9 manually to simulate an existing v9 database
    for (let i = 0; i < 9; i += 1) {
      await db.exec(MIGRATIONS[i] as string);
      await db.exec(`PRAGMA user_version = ${i + 1}`);
    }

    const opened = await openCatalog(db);
    expect(opened.ok).toBe(true);
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(10);

    const progCols = await db.all<{ name: string }>('PRAGMA table_info(programmes)');
    expect(progCols.map((c) => c.name)).toEqual(expect.arrayContaining(['genre', 'flags']));

    const nextCols = await db.all<{ name: string }>('PRAGMA table_info(programmes_next)');
    expect(nextCols.map((c) => c.name)).toEqual(expect.arrayContaining(['genre', 'flags']));

    const recentCols = await db.all<{ name: string }>('PRAGMA table_info(recent_channels)');
    expect(recentCols.map((c) => c.name)).toEqual([
      'profile_id',
      'source_id',
      'item_key',
      'watched_at',
    ]);

    const indexes = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index'",
    );
    expect(indexes.map((i) => i.name)).toEqual(
      expect.arrayContaining([
        'idx_recent_channels_order',
        'idx_recent_channels_source',
        'idx_import_runs_source_kind_status',
      ]),
    );

    await db.close?.();
  });

  it('persists genre and broadcast flags during XMLTV guide import and returns them on EPG queries', async () => {
    const { db } = testDb();
    const opened = await openCatalog(db);
    expect(opened.ok).toBe(true);

    const m3u = `#EXTM3U
#EXTINF:-1 tvg-id="spor1" tvg-name="Spor 1",Spor 1
http://stream.example/live/spor1.ts
`;
    const xmltv = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="spor1"><display-name>Spor 1</display-name></channel>
  <programme start="20261122120000 +0000" stop="20261122130000 +0000" channel="spor1">
    <title>Derbi Maçı</title>
    <category>Spor</category>
    <category>Futbol</category>
    <live/>
    <premiere/>
  </programme>
  <programme start="20261122130000 +0000" stop="20261122140000 +0000" channel="spor1">
    <title>Ana Haber</title>
    <category>Haberler</category>
    <new/>
    <previously-shown/>
  </programme>
</tv>`;

    const http: HttpClient = {
      get: async (url) => {
        if (url.includes('guide.xml')) return ok(makeHttpResponse(xmltv, { url }));
        return ok(makeHttpResponse(m3u, { url }));
      },
    };

    const now = 1_795_348_800_000; // 2026-11-22T12:00:00Z
    const catalog = createCatalogService({
      db,
      secrets: createMemorySecrets(),
      scheduler: syncScheduler,
      http,
      clock: () => now,
      newId: () => 'src1',
    });

    const added = await catalog.addSource({
      kind: 'm3u',
      name: 'Test M3U',
      playlistUrl: 'https://provider.example/playlist.m3u',
      guideUrl: 'https://provider.example/guide.xml',
    });
    expect(added.ok).toBe(true);
    expect(await catalog.importSource('src1')).toMatchObject({ ok: true });
    expect(await catalog.importGuide?.('src1')).toMatchObject({ ok: true });

    const cats = await catalog.categories('src1', 'live');
    const items = await catalog.items(cats[0]?.id ?? '', 0, 10);
    expect(items).toHaveLength(1);
    const chKey = items[0]?.key ?? '';

    const nowMs = Date.UTC(2026, 10, 22, 12, 30, 0);
    const nn = await catalog.nowNext?.([chKey], nowMs);
    expect(nn).toHaveLength(1);
    expect(nn?.[0]?.now?.genre).toBe('sports');
    expect(nn?.[0]?.now?.flags).toBe(EPG_FLAG_LIVE | EPG_FLAG_PREMIERE);
    expect(nn?.[0]?.next?.genre).toBe('news');
    expect(nn?.[0]?.next?.flags).toBe(EPG_FLAG_NEW | EPG_FLAG_REPEAT);

    const win = await catalog.epgWindow?.(
      [chKey],
      Date.UTC(2026, 10, 22, 12, 0, 0),
      Date.UTC(2026, 10, 22, 14, 0, 0),
    );
    expect(win?.[chKey]).toHaveLength(2);
    expect(win?.[chKey]?.[0]?.genre).toBe('sports');
    expect(win?.[chKey]?.[0]?.flags).toBe(EPG_FLAG_LIVE | EPG_FLAG_PREMIERE);
    expect(win?.[chKey]?.[1]?.genre).toBe('news');
    expect(win?.[chKey]?.[1]?.flags).toBe(EPG_FLAG_NEW | EPG_FLAG_REPEAT);

    const slice = await catalog.epgSlice?.(
      'src1',
      Date.UTC(2026, 10, 22, 12, 0, 0),
      Date.UTC(2026, 10, 22, 14, 0, 0),
    );
    expect(slice).toHaveLength(2);
    expect(slice?.[0]?.genre).toBe('sports');
    expect(slice?.[0]?.flags).toBe(EPG_FLAG_LIVE | EPG_FLAG_PREMIERE);
    expect(slice?.[1]?.genre).toBe('news');
    expect(slice?.[1]?.flags).toBe(EPG_FLAG_NEW | EPG_FLAG_REPEAT);

    await catalog.close();
  });

  it('records, deduplicates, prunes >50, filters hidden/deleted, survives re-import, backs up, and purges recent channels on source delete', async () => {
    const { db } = testDb();
    await openCatalog(db);

    let playlistChannels = 55;
    const buildM3u = (count: number) => {
      const lines = ['#EXTM3U'];
      for (let i = 1; i <= count; i += 1) {
        lines.push(`#EXTINF:-1 tvg-id="c${i}" tvg-chno="${i}",Channel ${i}`);
        lines.push(`http://stream.example/live/c${i}.ts`);
      }
      return lines.join('\n');
    };

    const http: HttpClient = {
      get: async (url) => ok(makeHttpResponse(buildM3u(playlistChannels), { url })),
    };

    let now = 1_000_000;
    let backupRaw: string | undefined;
    const userData: UserDataStore = {
      read: () => backupRaw,
      write: (v) => {
        backupRaw = v;
      },
    };

    const catalog = createCatalogService({
      db,
      secrets: createMemorySecrets(),
      scheduler: syncScheduler,
      http,
      clock: () => now,
      newId: () => 'src1',
      userData,
    });

    await catalog.addSource({
      kind: 'm3u',
      name: 'M3U',
      playlistUrl: 'https://provider.example/list.m3u',
    });
    await catalog.importSource('src1');

    const cats = await catalog.categories('src1', 'live');
    const allLive = await catalog.items(cats[0]?.id ?? '', 0, 100);
    expect(allLive).toHaveLength(55);
    const keyAt = (idx: number): string => allLive[idx]?.key ?? '';

    // Rejects URLs / credentials / invalid sourceId
    await recordRecentChannel(db, 'http://user:pass@host/live/1.ts', 'src1', 'default', now);
    await recordRecentChannel(db, 'src1:live:1?token=secret', 'src1', 'default', now);
    await recordRecentChannel(db, '{{h:0}}/live', 'src1', 'default', now);
    await recordRecentChannel(db, keyAt(0), 'bad source id!', 'default', now);
    expect(await listRecentChannels(db)).toEqual([]);

    // Record 55 channels so pruning >50 kicks in
    for (let i = 0; i < 55; i += 1) {
      now += 1_000;
      await catalog.recordRecentChannel?.(keyAt(i), 'src1');
    }
    const rawCount = await db.all<{ c: number }>('SELECT COUNT(*) AS c FROM recent_channels');
    expect(rawCount[0]?.c).toBe(50);

    // Default listRecentChannels returns top 20 in MRU order
    const top20 = await catalog.listRecentChannels?.();
    expect(top20).toHaveLength(20);
    expect(top20?.[0]?.key).toBe(keyAt(54));
    expect(top20?.[19]?.key).toBe(keyAt(35));

    // Re-recording an older channel bumps it to #1 without duplicating
    now += 5_000;
    await catalog.recordRecentChannel?.(keyAt(40), 'src1');
    const afterBump = await catalog.listRecentChannels?.(5);
    expect(afterBump?.map((c) => c.key)).toEqual([
      keyAt(40),
      keyAt(54),
      keyAt(53),
      keyAt(52),
      keyAt(51),
    ]);

    // Hidden channel is excluded from listRecentChannels
    await db.run('UPDATE live SET is_hidden = 1 WHERE key = ?', [keyAt(54)]);
    const afterHide = await catalog.listRecentChannels?.(3);
    expect(afterHide?.map((c) => c.key)).toEqual([keyAt(40), keyAt(53), keyAt(52)]);
    await db.run('UPDATE live SET is_hidden = 0 WHERE key = ?', [keyAt(54)]);

    // Re-importing with fewer channels keeps surviving channels and drops deleted ones from result
    playlistChannels = 52;
    await catalog.importSource('src1');
    const afterReimport = await catalog.listRecentChannels?.(5);
    expect(afterReimport?.map((c) => c.key)).toEqual([
      keyAt(40),
      keyAt(51),
      keyAt(50),
      keyAt(49),
      keyAt(48),
    ]);

    // User-data backup & restore round-trip
    await saveUserDataSnapshot(db, userData);
    await db.run('DELETE FROM recent_channels');
    const restored = await reconcileUserData(db, userData);
    expect(restored.recentChannelsRestored).toBeGreaterThan(0);
    const afterRestore = await catalog.listRecentChannels?.(2);
    expect(afterRestore?.[0]?.key).toBe(keyAt(40));

    // Removing source purges recent_channels
    const removed = await catalog.removeSource('src1');
    expect(removed.ok).toBe(true);
    const remaining = await db.all<{ c: number }>('SELECT COUNT(*) AS c FROM recent_channels');
    expect(remaining[0]?.c).toBe(0);

    await catalog.close();
  });

  it('exposes lastCatalogSyncAt and lastGuideSyncAt on SourceRow (including 304 guide runs)', async () => {
    const { db } = testDb();
    await openCatalog(db);

    const m3u = `#EXTM3U
#EXTINF:-1 tvg-id="c1",Channel 1
http://stream.example/live/c1.ts
`;
    const xmltv = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="c1"><display-name>Channel 1</display-name></channel>
  <programme start="20261122120000 +0000" stop="20261122130000 +0000" channel="c1">
    <title>Show 1</title>
  </programme>
</tv>`;

    let guideCalls = 0;
    let failGuide = false;
    const http: HttpClient = {
      get: async (url) => {
        if (url.includes('guide.xml')) {
          guideCalls += 1;
          if (failGuide) return ok(makeHttpResponse('', { status: 500, url }));
          if (guideCalls === 1) {
            return ok(makeHttpResponse(xmltv, { url, headers: { etag: '"v1"' } }));
          }
          return ok(makeHttpResponse('', { status: 304, url, headers: { etag: '"v1"' } }));
        }
        return ok(makeHttpResponse(m3u, { url }));
      },
    };

    const baseTime = Date.UTC(2026, 10, 22, 12, 0, 0);
    let now = baseTime;
    const catalog = createCatalogService({
      db,
      secrets: createMemorySecrets(),
      scheduler: syncScheduler,
      http,
      clock: () => now,
      newId: () => 'src1',
    });

    const added = await catalog.addSource({
      kind: 'm3u',
      name: 'Sync Test',
      playlistUrl: 'https://provider.example/list.m3u',
      guideUrl: 'https://provider.example/guide.xml',
    });
    expect(added.ok).toBe(true);
    if (added.ok) {
      expect(added.value.lastCatalogSyncAt).toBeNull();
      expect(added.value.lastGuideSyncAt).toBeNull();
    }

    const before = await catalog.listSources();
    expect(before[0]?.lastCatalogSyncAt).toBeNull();
    expect(before[0]?.lastGuideSyncAt).toBeNull();

    now = baseTime + 10_000;
    expect((await catalog.importSource('src1')).ok).toBe(true);
    const afterCat = await catalog.listSources();
    expect(afterCat[0]?.lastCatalogSyncAt).toBe(baseTime + 10_000);
    expect(afterCat[0]?.lastGuideSyncAt).toBeNull();

    now = baseTime + 20_000;
    expect((await catalog.importGuide?.('src1'))?.ok).toBe(true);
    const afterGuide1 = await catalog.listSources();
    expect(afterGuide1[0]?.lastGuideSyncAt).toBe(baseTime + 20_000);

    // Conditional 304 guide run still advances lastGuideSyncAt
    now = baseTime + 30_000;
    const guide304 = await catalog.importGuide?.('src1');
    expect(guide304?.ok).toBe(true);
    if (guide304?.ok) expect(guide304.value.unchanged).toBe(true);
    const afterGuide304 = await catalog.listSources();
    expect(afterGuide304[0]?.lastGuideSyncAt).toBe(baseTime + 30_000);

    // Failed guide run does not overwrite lastGuideSyncAt
    now = baseTime + 40_000;
    failGuide = true;
    const failed = await catalog.importGuide?.('src1');
    expect(failed?.ok).toBe(false);
    const afterFail = await catalog.listSources();
    expect(afterFail[0]?.lastGuideSyncAt).toBe(baseTime + 30_000);

    await catalog.close();
  });
});
