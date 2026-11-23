import { ok, type Scheduler, type SecretStore, type SqlDriver } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import {
  createCatalogService,
  openCatalog,
  queryAllSourcesItems,
  queryAlphabetIndex,
  querySearch,
} from './index';
import { backfillProgrammesFtsIfEmpty } from './schema-v12';
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

describe('Wave C4A Data Regressions (#397, #407)', () => {
  it('weights programmes_fts bm25(0, 0, 0, 0, 4.0, 1.0) so an infix title match outranks a shorter description-only match', async () => {
    const { db, close } = testDb();
    try {
      await openCatalog(db);
      await db.run(
        "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'm3u', 'Main', 100, '{}')",
      );
      await db.run(
        "INSERT INTO live (source_id, key, name, name_fold, sort_title, guide_id, run_id) VALUES ('s1', 'm:s1:live:1', 'Alpha TV', 'alpha tv', 'alpha tv', 'g.1', 1)",
      );
      await db.run(
        "INSERT INTO channel_guide (source_id, channel_key, guide_id) VALUES ('s1', 'm:s1:live:1', 'g.1')",
      );

      const nowMs = 1_000_000;
      // Description-only hit: earlier start, shorter 1-token description (would win under tied 1.0/1.0 weights).
      await db.run(
        `INSERT INTO programmes (source_id, guide_id, start, stop, title, description, run_id)
         VALUES ('s1', 'g.1', ?, ?, 'Evening News', 'Galaksi', 1)`,
        [nowMs + 1_000, nowMs + 60_000],
      );
      await db.run(
        `INSERT INTO programmes_fts (source_id, guide_id, start, stop, title_fold, description_fold)
         VALUES ('s1', 'g.1', ?, ?, 'evening news', 'galaksi')`,
        [nowMs + 1_000, nowMs + 60_000],
      );

      // Infix title hit: later start, longer 4-token title (neither exact nor prefix, so CASE ties at 2).
      await db.run(
        `INSERT INTO programmes (source_id, guide_id, start, stop, title, description, run_id)
         VALUES ('s1', 'g.1', ?, ?, 'Grand Cosmic Galaksi Special', 'Regular broadcast schedule info', 1)`,
        [nowMs + 2_000, nowMs + 60_000],
      );
      await db.run(
        `INSERT INTO programmes_fts (source_id, guide_id, start, stop, title_fold, description_fold)
         VALUES ('s1', 'g.1', ?, ?, 'grand cosmic galaksi special', 'regular broadcast schedule info')`,
        [nowMs + 2_000, nowMs + 60_000],
      );

      const res = await querySearch(db, 'galaksi', { scope: 'epg', nowMs });
      expect(res.epg.map((hit) => hit.title)).toEqual([
        'Grand Cosmic Galaksi Special',
        'Evening News',
      ]);
    } finally {
      close();
    }
  });

  it('keeps leading # strictly for < a and buckets non-Latin (> z) after Z with exact 1:1 alignment against items(sortBy: alpha)', async () => {
    const { db, close } = testDb();
    try {
      await openCatalog(db);
      const m3u = `#EXTM3U
#EXTINF:-1 group-title="World",123 Countdown
http://s.example.test/m/123.mp4
#EXTINF:-1 group-title="World",Alpha Film
http://s.example.test/m/alpha.mp4
#EXTINF:-1 group-title="World",İstanbul Masalı
http://s.example.test/m/istanbul.mp4
#EXTINF:-1 group-title="World",Şafak Vakti
http://s.example.test/m/safak.mp4
#EXTINF:-1 group-title="World",Zebra Crossing
http://s.example.test/m/zebra.mp4
#EXTINF:-1 group-title="World",Брат
http://s.example.test/m/brat.mp4
#EXTINF:-1 group-title="World",Αθήνα
http://s.example.test/m/athena.mp4
#EXTINF:-1 group-title="World",القاهرة
http://s.example.test/m/cairo.mp4
`;
      const svc = createCatalogService({
        db,
        secrets: memorySecrets(),
        scheduler: noopScheduler(),
        http: {
          async get(url) {
            return ok({
              status: 200,
              headers: {},
              body: chunksOf(m3u),
              finalUrl: url,
            });
          },
        },
        clock: () => 1_700_000_000_000,
        newId: () => 'intl',
      });

      await svc.addSource({
        kind: 'm3u',
        name: 'Intl M3U',
        playlistUrl: 'http://s.example.test/list.m3u',
        vodPlaylist: true,
      });
      expect((await svc.importSource('intl')).ok).toBe(true);

      const cats = await svc.categories('intl', 'movie');
      const catId = cats[0]?.id ?? '';
      const alphaItems = await svc.items(catId, 0, 100, { sortBy: 'alpha' });
      const buckets = await svc.alphabetIndex?.({
        sourceId: 'intl',
        kind: 'movie',
        categoryId: catId,
      });

      expect(alphaItems.map((i) => i.name)).toEqual([
        '123 Countdown',
        'Alpha Film',
        'İstanbul Masalı',
        'Şafak Vakti',
        'Zebra Crossing',
        'Αθήνα',
        'Брат',
        'القاهرة',
      ]);

      expect(buckets).toEqual([
        { letter: '#', offset: 0, count: 1 },
        { letter: 'A', offset: 1, count: 1 },
        { letter: 'I', offset: 2, count: 1 },
        { letter: 'S', offset: 3, count: 1 },
        { letter: 'Z', offset: 4, count: 1 },
        { letter: '…', offset: 5, count: 3 },
      ]);

      for (const bucket of buckets ?? []) {
        const directPage = await svc.items(catId, bucket.offset, 1, { sortBy: 'alpha' });
        expect(directPage[0]?.key).toBe(alphaItems[bucket.offset]?.key);
      }
    } finally {
      close();
    }
  });

  it('aligns multi-source allSourcesItems(sortBy: alpha) 1:1 with queryAlphabetIndex across >= 2 active sources (including groupVersions, collapseVariants, excludeWatched)', async () => {
    const { db, close } = testDb();
    try {
      await openCatalog(db);
      const playlistA = `#EXTM3U
#EXTINF:-1 group-title="Movies",300 (2006)
http://a.example.test/m/300.mp4
#EXTINF:-1 group-title="Movies",Charlie
http://a.example.test/m/charlie.mp4
#EXTINF:-1 group-title="Movies",Dune (2021) [4K]
http://a.example.test/m/dune-4k.mp4
#EXTINF:-1 group-title="Movies",Dune (2021) [1080p]
http://a.example.test/m/dune-1080.mp4
#EXTINF:-1 group-title="Movies",Zulu
http://a.example.test/m/zulu.mp4
#EXTINF:-1 group-title="Live",Canal+ HD
http://a.example.test/l/canal-hd.ts
#EXTINF:-1 group-title="Live",Canal+ 4K
http://a.example.test/l/canal-4k.ts
#EXTINF:-1 group-title="Live",ZDF HD
http://a.example.test/l/zdf.ts
`;
      const playlistB = `#EXTM3U
#EXTINF:-1 group-title="Movies",1917 (2019)
http://b.example.test/m/1917.mp4
#EXTINF:-1 group-title="Movies",Alpha
http://b.example.test/m/alpha.mp4
#EXTINF:-1 group-title="Movies",Bravo
http://b.example.test/m/bravo.mp4
#EXTINF:-1 group-title="Movies",Москва
http://b.example.test/m/moskva.mp4
#EXTINF:-1 group-title="Live",ARD HD
http://b.example.test/l/ard.ts
#EXTINF:-1 group-title="Live",BBC One SD
http://b.example.test/l/bbc-sd.ts
#EXTINF:-1 group-title="Live",BBC One HD
http://b.example.test/l/bbc-hd.ts
`;
      let nextId = 0;
      const ids = ['srcA', 'srcB'];
      const svc = createCatalogService({
        db,
        secrets: memorySecrets(),
        scheduler: noopScheduler(),
        http: {
          async get(url) {
            const body = url.includes('b.example.test') ? playlistB : playlistA;
            return ok({
              status: 200,
              headers: {},
              body: chunksOf(body),
              finalUrl: url,
            });
          },
        },
        clock: () => 1_700_000_000_000,
        newId: () => ids[nextId++] ?? `src${nextId}`,
      });

      await svc.addSource({
        kind: 'm3u',
        name: 'Source A',
        playlistUrl: 'http://a.example.test/list.m3u',
      });
      await svc.addSource({
        kind: 'm3u',
        name: 'Source B',
        playlistUrl: 'http://b.example.test/list.m3u',
      });
      expect((await svc.importSource('srcA')).ok).toBe(true);
      expect((await svc.importSource('srcB')).ok).toBe(true);

      // Mark Bravo watched so excludeWatched aligns too
      const allMoviesRaw = await queryAllSourcesItems(db, 'movie', 0, 100, undefined, {
        sortBy: 'alpha',
      });
      const bravo = allMoviesRaw.find((m) => m.name === 'Bravo');
      expect(bravo).toBeDefined();
      if (bravo) {
        await svc.saveProgress?.({
          sourceId: bravo.sourceId,
          itemKey: bravo.key,
          kind: 'movie',
          title: bravo.name,
          positionMs: 100_000,
          durationMs: 100_000,
          watched: true,
        });
      }

      // 1. Multi-source Movies with groupVersions + excludeWatched
      const movieOpts = {
        sortBy: 'alpha' as const,
        groupVersions: true,
        excludeWatched: true,
      };
      const allMovies = await svc.allSourcesItems?.('movie', 0, 100, undefined, movieOpts);
      const movieBuckets = await queryAlphabetIndex(db, {
        kind: 'movie',
        groupVersions: true,
        excludeWatched: true,
      });

      expect(allMovies?.map((m) => m.name)).toEqual([
        '1917 (2019)',
        '300 (2006)',
        'Alpha',
        'Charlie',
        'Dune (2021) [1080p]',
        'Zulu',
        'Москва',
      ]);
      expect(allMovies?.find((m) => m.name.startsWith('Dune'))?.versionCount).toBe(2);
      expect(movieBuckets).toEqual([
        { letter: '#', offset: 0, count: 2 },
        { letter: 'A', offset: 2, count: 1 },
        { letter: 'C', offset: 3, count: 1 },
        { letter: 'D', offset: 4, count: 1 },
        { letter: 'Z', offset: 5, count: 1 },
        { letter: '…', offset: 6, count: 1 },
      ]);
      for (const bucket of movieBuckets) {
        const pageAtOffset = await svc.allSourcesItems?.(
          'movie',
          bucket.offset,
          1,
          undefined,
          movieOpts,
        );
        expect(pageAtOffset?.[0]?.key).toBe(allMovies?.[bucket.offset]?.key);
      }

      // 2. Multi-source Live with collapseVariants
      const liveOpts = { sortBy: 'alpha' as const, collapseVariants: true };
      const allLive = await svc.allSourcesItems?.('live', 0, 100, undefined, liveOpts);
      const liveBuckets = await queryAlphabetIndex(db, {
        kind: 'live',
        collapseVariants: true,
      });
      expect(allLive?.map((c) => c.name)).toEqual(['ARD HD', 'BBC One HD', 'Canal+ 4K', 'ZDF HD']);
      expect(liveBuckets).toEqual([
        { letter: 'A', offset: 0, count: 1 },
        { letter: 'B', offset: 1, count: 1 },
        { letter: 'C', offset: 2, count: 1 },
        { letter: 'Z', offset: 3, count: 1 },
      ]);
      for (const bucket of liveBuckets) {
        const pageAtOffset = await svc.allSourcesItems?.(
          'live',
          bucket.offset,
          1,
          undefined,
          liveOpts,
        );
        expect(pageAtOffset?.[0]?.key).toBe(allLive?.[bucket.offset]?.key);
      }
    } finally {
      close();
    }
  });

  it('does not double-query programmes_fts on 0-hit searches when populated and wraps standalone backfill in a transaction', async () => {
    const { db, close } = testDb();
    try {
      await openCatalog(db);
      await db.run(
        "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'm3u', 'Main', 100, '{}')",
      );
      await db.run(
        "INSERT INTO live (source_id, key, name, name_fold, sort_title, guide_id, run_id) VALUES ('s1', 'm:s1:live:1', 'News TV', 'news tv', 'news tv', 'g.news', 1)",
      );
      await db.run(
        "INSERT INTO channel_guide (source_id, channel_key, guide_id) VALUES ('s1', 'm:s1:live:1', 'g.news')",
      );
      await db.run(
        "INSERT INTO programmes (source_id, guide_id, start, stop, title, description, run_id) VALUES ('s1', 'g.news', 1000, 9000, 'Morning Bulletin', 'Daily headlines', 1)",
      );
      await db.run(
        "INSERT INTO programmes_fts (source_id, guide_id, start, stop, title_fold, description_fold) VALUES ('s1', 'g.news', 1000, 9000, 'morning bulletin', 'daily headlines')",
      );

      let ftsMatchCalls = 0;
      let txCalls = 0;
      const spy: SqlDriver = {
        ...db,
        all(sql, params) {
          if (sql.includes('programmes_fts MATCH ?')) ftsMatchCalls += 1;
          return db.all(sql, params);
        },
        transaction(fn) {
          txCalls += 1;
          return db.transaction(fn);
        },
      };

      // 1. Populated programmes_fts + 0-hit search -> exactly ONE FTS MATCH query and ZERO write transactions!
      expect(await backfillProgrammesFtsIfEmpty(spy)).toBe(false);
      expect(txCalls).toBe(0);

      const miss = await querySearch(spy, 'zzzznomatch', { scope: 'epg', nowMs: 2000 });
      expect(miss.epg).toEqual([]);
      expect(ftsMatchCalls).toBe(1);
      expect(txCalls).toBe(0);

      // 2. Emptied programmes_fts while programmes has rows -> backfills atomically inside transaction, returns true, and finds hit on re-query!
      await db.run('DELETE FROM programmes_fts');
      ftsMatchCalls = 0;
      txCalls = 0;

      const healed = await querySearch(spy, 'bulletin', { scope: 'epg', nowMs: 2000 });
      expect(healed.epg).toHaveLength(1);
      expect(healed.epg[0]?.title).toBe('Morning Bulletin');
      expect(txCalls).toBe(1);
      expect(ftsMatchCalls).toBe(2);
    } finally {
      close();
    }
  });
});
