import {
  type HttpClient,
  type HttpRequestOptions,
  ok,
  type Scheduler,
  type SecretStore,
} from '@elv/domain';
import { describe, expect, it } from 'vitest';
import {
  createCatalogService,
  type LocalPlaylistStore,
  MIGRATIONS,
  openCatalog,
  queryItemsByCursor,
  SCHEMA_VERSION,
  updateSourceSettings,
} from './index';
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

function createMemoryPlaylistStore(): LocalPlaylistStore & {
  readonly files: Map<string, Uint8Array>;
  readonly removed: string[];
} {
  const files = new Map<string, Uint8Array>();
  const removed: string[] = [];
  return {
    files,
    removed,
    async write(sourceId, bytes) {
      files.set(sourceId, new Uint8Array(bytes));
    },
    async openRead(sourceId) {
      const data = files.get(sourceId);
      if (data === undefined) return undefined;
      return (async function* () {
        yield data;
      })();
    },
    async remove(sourceId) {
      files.delete(sourceId);
      removed.push(sourceId);
    },
  };
}

function makeMockHttp(
  routes: Readonly<Record<string, string>>,
  seenOpts?: Array<{ url: string; opts?: HttpRequestOptions }>,
): HttpClient {
  return {
    async get(url, opts) {
      seenOpts?.push({ url, ...(opts === undefined ? {} : { opts }) });
      for (const [pattern, body] of Object.entries(routes)) {
        if (url.includes(pattern)) {
          return ok({
            status: 200,
            headers: { 'content-type': 'text/plain' },
            body: chunksOf(body),
            finalUrl: url,
          });
        }
      }
      return ok({
        status: 404,
        headers: {},
        body: chunksOf('not found'),
        finalUrl: url,
      });
    },
  };
}

describe('Wave C3 Data Layer (#51, #39, #182, #218, #404)', () => {
  it('MIGRATION_V11 upgrades v10 -> v11 and backfills live, movies, and watch_progress idempotently', async () => {
    const { db } = testDb();
    // Apply migrations v1..v10 manually
    await db.transaction(async (tx) => {
      for (let i = 0; i < 10; i++) {
        await tx.exec(MIGRATIONS[i] ?? '');
      }
      await tx.exec('PRAGMA user_version = 10');
    });

    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'm3u', 'Test', 1, '{}')",
    );
    await db.run(
      "INSERT INTO live (source_id, key, name, name_fold, sort_title, run_id) VALUES ('s1', 'm:s1:live:1', 'BBC One 4K', 'bbc one 4k', 'bbc one 4k', 1)",
    );
    await db.run(
      "INSERT INTO movies (source_id, key, name, name_fold, sort_title, year, run_id) VALUES ('s1', 'm:s1:movie:1', 'Dune (2021) [4K HDR]', 'dune 2021 4k hdr', 'dune 2021 4k hdr', 2021, 1)",
    );
    await db.run(
      "INSERT INTO watch_progress (profile_id, source_id, item_key, kind, title, position_ms, duration_ms, watched, updated_at) VALUES ('default', 's1', 'm:s1:movie:1', 'movie', 'Dune', 60000, 120000, 0, 100)",
    );

    const res = await openCatalog(db);
    expect(res.ok).toBe(true);
    expect(SCHEMA_VERSION).toBe(15);

    const liveRows = await db.all<{ variant_base_fold: string; quality_rank: number }>(
      'SELECT variant_base_fold, quality_rank FROM live WHERE key = ?',
      ['m:s1:live:1'],
    );
    expect(liveRows).toEqual([{ variant_base_fold: 'bbc one', quality_rank: 40 }]);

    const movieRows = await db.all<{ version_group_key: string; version_label: string | null }>(
      'SELECT version_group_key, version_label FROM movies WHERE key = ?',
      ['m:s1:movie:1'],
    );
    expect(movieRows).toEqual([{ version_group_key: 'dune::2021', version_label: '4K HDR' }]);

    const wpRows = await db.all<{
      version_group_key: string | null;
      preferred_item_key: string | null;
    }>('SELECT version_group_key, preferred_item_key FROM watch_progress WHERE item_key = ?', [
      'm:s1:movie:1',
    ]);
    expect(wpRows).toEqual([
      { version_group_key: 'dune::2021', preferred_item_key: 'm:s1:movie:1' },
    ]);
  });

  it('#51 adds, imports, resolves, and deletes a local M3U source via LocalPlaylistStore without storing paths', async () => {
    const { db } = testDb();
    await openCatalog(db);
    const secrets = memorySecrets();
    const localStore = createMemoryPlaylistStore();
    const svc = createCatalogService({
      db,
      secrets,
      scheduler: noopScheduler(),
      http: makeMockHttp({}),
      clock: () => 1_700_000_000_000,
      newId: () => 'local1',
      localPlaylistStore: localStore,
    });

    const m3u = `#EXTM3U
#EXTINF:-1 tvg-id="bbc1" group-title="UK",BBC One HD
http://streams.example.test/bbc1.ts
`;
    const added = await svc.addLocalM3uSource?.({
      name: 'My Local List',
      bytes: new TextEncoder().encode(m3u),
    });
    expect(added?.ok).toBe(true);
    expect(localStore.files.has('local1')).toBe(true);

    // Ensure no playlist secret URL was stored
    expect(await secrets.get('source.local1.playlist')).toBeUndefined();

    const imported = await svc.importSource('local1');
    expect(imported.ok).toBe(true);
    if (imported.ok) {
      expect(imported.value.counts.live).toBe(1);
    }

    const cats = await svc.categories('local1', 'live');
    expect(cats).toHaveLength(1);
    expect(cats[0]?.name).toBe('UK');

    const removed = await svc.removeSource('local1');
    expect(removed.ok).toBe(true);
    expect(localStore.removed).toContain('local1');
    expect(localStore.files.has('local1')).toBe(false);
  });

  it('#182 forwards allowLegacyTls, applies xmltvTimezone, persists <lcn> & <rating>, and matches via LCN fallback', async () => {
    const { db } = testDb();
    await openCatalog(db);
    const secrets = memorySecrets();
    const seenOpts: Array<{ url: string; opts?: HttpRequestOptions }> = [];

    const m3u = `#EXTM3U
#EXTINF:-1 tvg-chno="101" group-title="News",Mystery Feed
https://legacy.example.test/ch101.ts
`;
    const xmltv = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="unknown-id">
    <display-name>Totally Different Name</display-name>
    <lcn>101</lcn>
  </channel>
  <programme channel="unknown-id" start="20260715200000" stop="20260715210000">
    <title>Berlin Prime Time</title>
    <rating system="FSK"><value>12</value></rating>
  </programme>
</tv>`;

    const http = makeMockHttp(
      {
        'playlist.m3u': m3u,
        'guide.xml': xmltv,
      },
      seenOpts,
    );

    const svc = createCatalogService({
      db,
      secrets,
      scheduler: noopScheduler(),
      http,
      clock: () => Date.UTC(2026, 6, 15, 18, 30, 0),
      newId: () => 'src182',
    });

    const added = await svc.addSource({
      kind: 'm3u',
      name: 'Legacy Source',
      playlistUrl: 'https://legacy.example.test/playlist.m3u',
      guideUrl: 'https://legacy.example.test/guide.xml',
      transport: { allowLegacyTls: true },
    });
    expect(added.ok).toBe(true);

    await updateSourceSettings(db, 'src182', {
      transport: { allowLegacyTls: true },
      guideUrl: '{{g:url}}',
      xmltvTimezone: 'Europe/Berlin',
    });

    const catRes = await svc.importSource('src182');
    expect(catRes.ok).toBe(true);

    const guideRes = await svc.importGuide?.('src182');
    expect(guideRes?.ok).toBe(true);

    // Both playlist and guide HTTP fetches received allowLegacyTls: true
    expect(seenOpts.length).toBeGreaterThanOrEqual(2);
    for (const call of seenOpts) {
      expect(call.opts?.allowLegacyTls).toBe(true);
    }

    // Channel matched via <lcn> 101 -> programme persisted with DST-adjusted time (20:00 CEST = 18:00 UTC) and rating
    const cats = await svc.categories('src182', 'live');
    const items = await svc.items(cats[0]?.id ?? '', 0, 10);
    expect(items).toHaveLength(1);
    const key = items[0]?.key ?? '';

    const streamRes = await svc.resolveStream(key);
    expect(streamRes.ok).toBe(true);
    if (streamRes.ok) {
      expect(streamRes.value.allowLegacyTls).toBe(true);
    }

    const nowNext = await svc.nowNext?.([key], Date.UTC(2026, 6, 15, 18, 30, 0));
    expect(nowNext).toHaveLength(1);
    expect(nowNext?.[0]?.now?.title).toBe('Berlin Prime Time');
    expect(nowNext?.[0]?.now?.start).toBe(Date.UTC(2026, 6, 15, 18, 0, 0));
    expect(nowNext?.[0]?.now?.ratingSystem).toBe('FSK');
    expect(nowNext?.[0]?.now?.ratingValue).toBe('12');

    const gcRows = await db.all<{ lcn: string | null }>(
      'SELECT lcn FROM guide_channels WHERE source_id = ?',
      ['src182'],
    );
    expect(gcRows).toEqual([{ lcn: '101' }]);
  });

  it('#39 discovers categories without SQLite writes, filters M3U & Xtream imports, clears intentionally empty kinds, and records pending new categories', async () => {
    const { db } = testDb();
    await openCatalog(db);
    const secrets = memorySecrets();

    let playlistVersion = 1;
    const m3uV1 = `#EXTM3U
#EXTINF:-1 group-title="Sports",ESPN HD
http://s.example.test/espn.ts
#EXTINF:-1 group-title="News",CNN HD
http://s.example.test/cnn.ts
#EXTINF:-1 group-title="Movies",Dune (2021)
http://s.example.test/movie/dune.mp4
`;
    const m3uV2 = `#EXTM3U
#EXTINF:-1 group-title="Sports",ESPN HD
http://s.example.test/espn.ts
#EXTINF:-1 group-title="News",CNN HD
http://s.example.test/cnn.ts
#EXTINF:-1 group-title="Kids",Cartoon Network
http://s.example.test/cn.ts
`;

    const http: HttpClient = {
      async get(url) {
        return ok({
          status: 200,
          headers: {},
          body: chunksOf(playlistVersion === 1 ? m3uV1 : m3uV2),
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
      newId: () => 'src39',
    });

    await svc.addSource({
      kind: 'm3u',
      name: 'Filtered M3U',
      playlistUrl: 'http://s.example.test/list.m3u',
    });

    // Discover without writing to SQLite
    const discovered = await svc.discoverSourceCategories?.('src39');
    expect(discovered?.ok).toBe(true);
    if (discovered?.ok) {
      expect(discovered.value).toEqual(
        expect.arrayContaining([
          { id: 'Sports', name: 'Sports', kind: 'live', itemCount: 1 },
          { id: 'News', name: 'News', kind: 'live', itemCount: 1 },
          { id: 'Movies', name: 'Movies', kind: 'movie', itemCount: 1 },
        ]),
      );
    }
    expect(await db.all('SELECT * FROM categories WHERE source_id = ?', ['src39'])).toHaveLength(0);

    // Select only Sports for live and Movies for movie
    await updateSourceSettings(db, 'src39', {
      categorySelection: {
        live: ['Sports'],
        movie: ['Movies'],
      },
    });

    const firstImport = await svc.importSource('src39');
    expect(firstImport.ok).toBe(true);
    const liveCats = await svc.categories('src39', 'live');
    expect(liveCats.map((c) => c.name)).toEqual(['Sports']);
    const movieCats = await svc.categories('src39', 'movie');
    expect(movieCats.map((c) => c.name)).toEqual(['Movies']);

    // Refresh with a newly added 'Kids' category and intentionally empty movie: []
    playlistVersion = 2;
    const rawSettings = await db.all<{ settings_json: string }>(
      'SELECT settings_json FROM sources WHERE id = ?',
      ['src39'],
    );
    const currentSettings = JSON.parse(rawSettings[0]?.settings_json ?? '{}');
    await updateSourceSettings(db, 'src39', {
      ...currentSettings,
      categorySelection: {
        ...currentSettings.categorySelection,
        movie: [],
      },
    });

    const secondImport = await svc.importSource('src39');
    expect(secondImport.ok).toBe(true);
    if (secondImport.ok) {
      // Intentionally deselected movie kind must NOT trigger kind-empty preservation warning
      expect(secondImport.value.warningCodes).not.toContain('catalog/kind-empty-movie');
    }
    expect(await svc.categories('src39', 'movie')).toHaveLength(0);
    // 'Kids' must NOT be imported silently, and must appear in pendingLive
    expect((await svc.categories('src39', 'live')).map((c) => c.name)).toEqual(['Sports']);
    const afterSettings = JSON.parse(
      (
        await db.all<{ settings_json: string }>('SELECT settings_json FROM sources WHERE id = ?', [
          'src39',
        ])
      )[0]?.settings_json ?? '{}',
    );
    expect(afterSettings.categorySelection?.pendingLive).toEqual(['Kids']);
  });

  it('#218 collapses live quality variants within (source_id, category_id) and exposes liveVariants()', async () => {
    const { db } = testDb();
    await openCatalog(db);
    const secrets = memorySecrets();
    const m3u = `#EXTM3U
#EXTINF:-1 group-title="UK",BBC One SD
http://s.example.test/bbc-sd.ts
#EXTINF:-1 group-title="UK",BBC One 4K
http://s.example.test/bbc-4k.ts
#EXTINF:-1 group-title="UK",BBC One HD
http://s.example.test/bbc-hd.ts
#EXTINF:-1 group-title="UK",BBC One +1 HD
http://s.example.test/bbc-plus1.ts
#EXTINF:-1 group-title="Backup",BBC One FHD
http://s.example.test/bbc-fhd-other.ts
`;
    const svc = createCatalogService({
      db,
      secrets,
      scheduler: noopScheduler(),
      http: makeMockHttp({ 'list.m3u': m3u }),
      clock: () => 1_700_000_000_000,
      newId: () => 'src218',
    });

    await svc.addSource({
      kind: 'm3u',
      name: 'Live Variants',
      playlistUrl: 'http://s.example.test/list.m3u',
    });
    expect((await svc.importSource('src218')).ok).toBe(true);

    const rawCats = await svc.categories('src218', 'live');
    expect(rawCats.find((c) => c.name === 'UK')?.itemCount).toBe(4);

    const collapsedCats = await svc.categories('src218', 'live', { collapseVariants: true });
    const ukCat = collapsedCats.find((c) => c.name === 'UK');
    expect(ukCat?.itemCount).toBe(2); // BBC One (3 variants) + BBC One +1 HD (1)

    const collapsedItems = await svc.items(ukCat?.id ?? '', 0, 10, { collapseVariants: true });
    expect(collapsedItems).toHaveLength(2);
    // Representative must be highest quality (4K) with variantCount = 3
    expect(collapsedItems[0]?.name).toBe('BBC One 4K');
    expect(collapsedItems[0]?.variantCount).toBe(3);
    expect(collapsedItems[1]?.name).toBe('BBC One +1 HD');
    expect(collapsedItems[1]?.variantCount).toBeUndefined();

    // Cursor pagination also supports collapseVariants
    const page1 = await queryItemsByCursor(db, ukCat?.id ?? '', undefined, 1, {
      collapseVariants: true,
    });
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0]?.name).toBe('BBC One 4K');
    expect(page1.hasMore).toBe(true);
    const page2 = await queryItemsByCursor(db, ukCat?.id ?? '', page1.nextCursor ?? undefined, 1, {
      collapseVariants: true,
    });
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]?.name).toBe('BBC One +1 HD');
    expect(page2.hasMore).toBe(false);

    // liveVariants restricted to UK category returns only the 3 UK variants ordered 4K -> HD -> SD
    const ukVariants = await svc.liveVariants?.(collapsedItems[0]?.key ?? '', ukCat?.id);
    expect(ukVariants?.map((v) => v.qualityLabel)).toEqual(['4K', 'HD', 'SD']);
  });

  it('#404 groups multi-version movies, exposes itemVersions(), and syncs watch_progress across versions', async () => {
    const { db } = testDb();
    await openCatalog(db);
    const secrets = memorySecrets();
    const m3u = `#EXTM3U
#EXTINF:-1 group-title="Sci-Fi",Dune (2021) [1080p]
http://s.example.test/movie/dune-1080.mp4
#EXTINF:-1 group-title="Sci-Fi",Dune (2021) [4K HDR]
http://s.example.test/movie/dune-4k.mp4
#EXTINF:-1 group-title="Sci-Fi",Dune (1984) [1080p]
http://s.example.test/movie/dune-1984.mp4
`;
    const svc = createCatalogService({
      db,
      secrets,
      scheduler: noopScheduler(),
      http: makeMockHttp({ 'list.m3u': m3u }),
      clock: () => 1_700_000_000_000,
      newId: () => 'src404',
    });

    await svc.addSource({
      kind: 'm3u',
      name: 'VOD Versions',
      playlistUrl: 'http://s.example.test/list.m3u',
    });
    expect((await svc.importSource('src404')).ok).toBe(true);

    const groupedCats = await svc.categories('src404', 'movie', { groupVersions: true });
    expect(groupedCats[0]?.itemCount).toBe(2); // Dune 2021 (2 versions) + Dune 1984 (1 version)

    const groupedItems = await svc.items(groupedCats[0]?.id ?? '', 0, 10, { groupVersions: true });
    expect(groupedItems).toHaveLength(2);
    expect(groupedItems[0]?.versionCount).toBe(2);
    expect(groupedItems[1]?.versionCount).toBeUndefined();

    const versions = await svc.itemVersions?.(groupedItems[0]?.key ?? '');
    expect(versions).toHaveLength(2);
    expect(versions?.[0]?.versionLabel).toBe('4K HDR');
    expect(versions?.[1]?.versionLabel).toBe('1080p');

    const key4k = versions?.[0]?.key ?? '';
    const key1080 = versions?.[1]?.key ?? '';

    // Save progress on 4K version -> visible on 1080p version, with preferredItemKey = key4k
    const saved = await svc.saveProgress?.({
      sourceId: 'src404',
      itemKey: key4k,
      kind: 'movie',
      title: 'Dune (2021) [4K HDR]',
      positionMs: 120_000,
      durationMs: 7_200_000,
    });
    expect(saved?.ok).toBe(true);

    const progressOn1080 = await svc.getProgress?.(key1080);
    expect(progressOn1080?.positionMs).toBe(120_000);
    expect(progressOn1080?.preferredItemKey).toBe(key4k);

    const byKeys = await svc.listProgressByKeys?.([key1080]);
    expect(byKeys).toHaveLength(1);
    expect(byKeys?.[0]?.itemKey).toBe(key1080);
    expect(byKeys?.[0]?.positionMs).toBe(120_000);

    // Save progress on 1080p version too -> listContinueWatching deduplicates to 1 row
    await svc.saveProgress?.({
      sourceId: 'src404',
      itemKey: key1080,
      kind: 'movie',
      title: 'Dune (2021) [1080p]',
      positionMs: 240_000,
      durationMs: 7_200_000,
    });
    const cw = await svc.listContinueWatching?.(10);
    expect(cw).toHaveLength(1);
    expect(cw?.[0]?.positionMs).toBe(240_000);
    expect(cw?.[0]?.preferredItemKey).toBe(key1080);

    // setWatched propagates across all versions
    await svc.setWatched?.(key4k, true);
    expect((await svc.getProgress?.(key1080))?.watched).toBe(true);

    // clearProgress clears all sibling versions
    await svc.clearProgress?.(key4k);
    expect(await svc.getProgress?.(key1080)).toBeNull();
    expect(await svc.getProgress?.(key4k)).toBeNull();
  });

  it('#39 discovers Xtream categories (including Uncategorized), filters multi-category items, and tracks pending categories', async () => {
    const { db } = testDb();
    await openCatalog(db);
    const secrets = memorySecrets();

    let extraCat = false;
    const http: HttpClient = {
      async get(url) {
        let json: unknown = [];
        if (url.includes('action=get_live_categories')) {
          json = extraCat
            ? [
                { category_id: '1', category_name: 'Sports' },
                { category_id: '2', category_name: 'News' },
                { category_id: '3', category_name: 'Docs' },
              ]
            : [
                { category_id: '1', category_name: 'Sports' },
                { category_id: '2', category_name: 'News' },
              ];
        } else if (url.includes('action=get_vod_categories')) {
          json = [{ category_id: '10', category_name: 'Action' }];
        } else if (url.includes('action=get_series_categories')) {
          json = [];
        } else if (url.includes('action=get_live_streams')) {
          json = [
            { stream_id: 101, name: 'ESPN HD', category_id: '1', category_ids: ['1', '2'] },
            { stream_id: 102, name: 'CNN HD', category_id: '2', category_ids: ['2'] },
            { stream_id: 103, name: 'Orphan Channel', category_id: '', category_ids: [] },
          ];
        } else if (url.includes('action=get_vod_streams')) {
          json = [
            {
              stream_id: 201,
              name: 'Die Hard (1988)',
              category_id: '10',
              container_extension: 'mp4',
            },
          ];
        } else if (url.includes('action=get_series')) {
          json = [];
        } else {
          json = {
            user_info: { status: 'Active', auth: 1, allowed_output_formats: ['ts'] },
            server_info: { url: 'xt.example.test', port: '80', server_protocol: 'http' },
          };
        }
        return ok({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: chunksOf(JSON.stringify(json)),
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
      newId: () => 'xt39',
    });

    await svc.addSource({
      kind: 'xtream',
      name: 'Filtered Xtream',
      server: 'http://xt.example.test',
      username: 'u',
      password: 'p',
    });

    const discovered = await svc.discoverSourceCategories?.('xt39');
    expect(discovered?.ok).toBe(true);
    if (discovered?.ok) {
      expect(discovered.value).toEqual(
        expect.arrayContaining([
          { id: '1', name: 'Sports', kind: 'live', itemCount: 1 },
          { id: '2', name: 'News', kind: 'live', itemCount: 2 },
          { id: 'Uncategorized', name: 'Uncategorized', kind: 'live', itemCount: 1 },
          { id: '10', name: 'Action', kind: 'movie', itemCount: 1 },
        ]),
      );
    }

    await updateSourceSettings(db, 'xt39', {
      categorySelection: {
        live: ['1'],
        movie: [],
      },
    });
    const first = await svc.importSource('xt39');
    expect(first.ok).toBe(true);

    // Multi-category item 101 is kept ONLY in selected category '1' (Sports), not '2' (News)
    const liveCats = await svc.categories('xt39', 'live');
    expect(liveCats.map((c) => c.name)).toEqual(['Sports']);
    expect(liveCats[0]?.itemCount).toBe(1);
    expect(await svc.categories('xt39', 'movie')).toHaveLength(0);

    // Refresh with newly appeared category '3' (Docs) -> recorded in pendingLive, not imported
    extraCat = true;
    const second = await svc.importSource('xt39');
    expect(second.ok).toBe(true);
    const afterSettings = JSON.parse(
      (
        await db.all<{ settings_json: string }>('SELECT settings_json FROM sources WHERE id = ?', [
          'xt39',
        ])
      )[0]?.settings_json ?? '{}',
    );
    expect(afterSettings.categorySelection?.pendingLive).toEqual(['3']);
  });

  it('SourceRow exposes settings_json metadata and CatalogService.updateSourceSettings merges patches cleanly', async () => {
    const { db } = testDb();
    await openCatalog(db);
    const localPlaylistStore = createMemoryPlaylistStore();
    let idSeq = 0;
    const svc = createCatalogService({
      db,
      secrets: memorySecrets(),
      scheduler: noopScheduler(),
      http: makeMockHttp({}),
      clock: () => 2000,
      newId: () => `src_${++idSeq}`,
      localPlaylistStore,
    });

    const addedXt = await svc.addSource({
      kind: 'xtream',
      name: 'XT',
      server: 'https://xt.example',
      username: 'u',
      password: 'p',
      xmltvTimezone: '  Europe/Berlin  ',
      transport: { allowLegacyTls: true },
    });
    expect(addedXt.ok).toBe(true);
    if (addedXt.ok) {
      expect(addedXt.value.xmltvTimezone).toBe('Europe/Berlin');
      expect(addedXt.value.allowLegacyTls).toBe(true);
    }

    const addedLocal = await svc.addLocalM3uSource?.({
      name: 'Local',
      bytes: new TextEncoder().encode('#EXTM3U\n#EXTINF:-1,Ch1\nhttps://a.example/1.ts\n'),
      xmltvTimezone: '   ',
    });
    expect(addedLocal?.ok).toBe(true);
    if (addedLocal?.ok) {
      expect(addedLocal.value.isLocalPlaylist).toBe(true);
      expect(addedLocal.value.xmltvTimezone).toBeUndefined();
    }

    // Merge patch via CatalogService.updateSourceSettings while preserving isLocalPlaylist
    await svc.updateSourceSettings?.('src_2', {
      xmltvTimezone: 'America/New_York',
      categorySelection: { live: ['1'], pendingLive: ['2'] },
      transport: { allowLegacyTls: true },
    });

    const listed = await svc.listSources();
    const localRow = listed.find((s) => s.id === 'src_2');
    expect(localRow?.isLocalPlaylist).toBe(true);
    expect(localRow?.xmltvTimezone).toBe('America/New_York');
    expect(localRow?.allowLegacyTls).toBe(true);
    expect(localRow?.categorySelection).toEqual({ live: ['1'], pendingLive: ['2'] });

    // Clearing xmltvTimezone with empty string removes it while preserving other fields
    await svc.updateSourceSettings?.('src_2', { xmltvTimezone: '  ' });
    const afterClear = (await svc.listSources()).find((s) => s.id === 'src_2');
    expect(afterClear?.xmltvTimezone).toBeUndefined();
    expect(afterClear?.isLocalPlaylist).toBe(true);
    expect(afterClear?.allowLegacyTls).toBe(true);
    expect(afterClear?.categorySelection).toEqual({ live: ['1'], pendingLive: ['2'] });

    // Attempting to mutate isLocalPlaylist via updateSourceSettings is ignored
    await svc.updateSourceSettings?.('src_2', { isLocalPlaylist: false });
    const afterAttempt = (await svc.listSources()).find((s) => s.id === 'src_2');
    expect(afterAttempt?.isLocalPlaylist).toBe(true);
  });
});
