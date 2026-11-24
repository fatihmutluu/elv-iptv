import { type HttpClient, ok, type Scheduler, type SecretStore } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import {
  createCatalogService,
  MIGRATIONS,
  openCatalog,
  queryAlphabetIndex,
  queryItemDetail,
  querySearch,
  querySearchSuggestions,
  SCHEMA_VERSION,
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

describe('Wave C4A Data Layer (#397 Expanded FTS5 Search + Suggestions, #407 A-Z Alphabet Index)', () => {
  it('MIGRATION_V12 upgrades v11 -> v12, backfills episodes.title_fold & programmes_fts with Turkish folding, and verifyAndHealSchema heals without rebuild crash on programmes_fts', async () => {
    const { db } = testDb();
    await db.transaction(async (tx) => {
      for (let i = 0; i < 11; i++) {
        await tx.exec(MIGRATIONS[i] ?? '');
      }
      await tx.exec('PRAGMA user_version = 11');
    });

    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Main', 100, '{}')",
    );
    await db.run(
      "INSERT INTO live (source_id, key, name, name_fold, sort_title, guide_id, run_id) VALUES ('s1', 'x:s1:live:1', 'TRT Spor HD', 'trt spor hd', 'trt spor hd', 'trt.spor', 1)",
    );
    await db.run(
      "INSERT INTO channel_guide (source_id, channel_key, guide_id) VALUES ('s1', 'x:s1:live:1', 'trt.spor')",
    );
    await db.run(
      "INSERT INTO series (source_id, key, name, name_fold, sort_title, run_id) VALUES ('s1', 'x:s1:series:10', 'Şahsiyet', 'sahsiyet', 'sahsiyet', 1)",
    );
    await db.run(
      "INSERT INTO episodes (source_id, key, series_key, season, episode, title, run_id) VALUES ('s1', 'x:s1:episode:100', 'x:s1:series:10', 1, 1, 'İstanbul Şafağı & Çiçek', 1)",
    );
    await db.run(
      "INSERT INTO programmes (source_id, guide_id, start, stop, title, description, run_id) VALUES ('s1', 'trt.spor', 1000, 5000, 'Şampiyonlar Ligi Özel', 'İstanbul Ğüzel Gece', 1)",
    );

    const opened = await openCatalog(db);
    expect(opened.ok).toBe(true);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(12);
    expect(await db.all('PRAGMA user_version')).toEqual([{ user_version: SCHEMA_VERSION }]);

    // Verify episodes.title_fold backfilled with Turkish-accurate foldText()
    const epFold = await db.all<{ title_fold: string }>(
      'SELECT title_fold FROM episodes WHERE key = ?',
      ['x:s1:episode:100'],
    );
    expect(epFold).toEqual([{ title_fold: 'istanbul safagi cicek' }]);

    // Verify episodes_fts finds the upgraded episode via Turkish query
    const epHits = await querySearch(db, 'ıstanbul çiç', { scope: 'episode' });
    expect(epHits.episodes).toHaveLength(1);
    expect(epHits.episodes[0]).toMatchObject({
      sourceId: 's1',
      itemKey: 'x:s1:episode:100',
      seriesKey: 'x:s1:series:10',
      seriesName: 'Şahsiyet',
      season: 1,
      episode: 1,
      title: 'İstanbul Şafağı & Çiçek',
    });

    // Verify programmes_fts backfilled from existing programmes and searchable
    const epgHits = await querySearch(db, 'şampiyonlar', { scope: 'epg', nowMs: 2000 });
    expect(epgHits.epg).toHaveLength(1);
    expect(epgHits.epg[0]).toMatchObject({
      sourceId: 's1',
      guideId: 'trt.spor',
      channelKey: 'x:s1:live:1',
      channelName: 'TRT Spor HD',
      title: 'Şampiyonlar Ligi Özel',
      isLiveNow: true,
    });

    // Simulate emptied programmes_fts while programmes has rows: verifyAndHealSchema repopulates without VALUES('rebuild') error
    await db.run('DELETE FROM programmes_fts');
    expect(await db.all('SELECT * FROM programmes_fts')).toHaveLength(0);
    const healed = await openCatalog(db);
    expect(healed.ok).toBe(true);
    const epgAfterHeal = await querySearch(db, 'ğüzel', { scope: 'epg', nowMs: 2000 });
    expect(epgAfterHeal.epg).toHaveLength(1);
    expect(epgAfterHeal.epg[0]?.title).toBe('Şampiyonlar Ligi Özel');
  });

  it('persists cast & director on Xtream import and loadSeriesEpisodes, hydrates ItemDetailRow, and ranks title hits ahead of cast/director hits via bm25(..., 4.0, 1.5, 1.5)', async () => {
    const { db } = testDb();
    await openCatalog(db);
    const secrets = memorySecrets();

    const http: HttpClient = {
      async get(url) {
        let json: unknown = [];
        if (url.includes('action=get_live_categories')) {
          json = [];
        } else if (url.includes('action=get_vod_categories')) {
          json = [{ category_id: '1', category_name: 'Drama' }];
        } else if (url.includes('action=get_series_categories')) {
          json = [{ category_id: '2', category_name: 'Turkish Series' }];
        } else if (url.includes('action=get_live_streams')) {
          json = [];
        } else if (url.includes('action=get_vod_streams')) {
          json = [
            {
              stream_id: 101,
              name: 'Kış Uykusu',
              category_id: '1',
              container_extension: 'mkv',
              cast: 'Haluk Bilginer, Melisa Sözen, Demet Akbağ',
              director: 'Nuri Bilge Ceylan',
            },
            {
              stream_id: 102,
              name: 'Haluk Belgeseli',
              category_id: '1',
              container_extension: 'mp4',
              cast: 'Cem Yılmaz',
              director: 'Çağan Irmak',
            },
          ];
        } else if (url.includes('action=get_series_info')) {
          json = {
            info: {
              cast: 'Haluk Bilginer, Cansu Dere, Metin Akdülger',
              director: 'Onur Saylak',
            },
            seasons: [{ season_number: 1 }],
            episodes: {
              '1': [
                {
                  id: '301',
                  episode_num: 1,
                  title: 'Kambura Dönüş',
                  container_extension: 'mp4',
                },
              ],
            },
          };
        } else if (url.includes('action=get_series')) {
          json = [
            {
              series_id: 201,
              name: 'Şahsiyet',
              category_id: '2',
              plot: 'Agah Beyoğlu hikayesi.',
              actors: ['Haluk Bilginer', 'Cansu Dere'],
            },
          ];
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
      newId: () => 'xt1',
    });

    await svc.addSource({
      kind: 'xtream',
      name: 'Xtream Credits',
      server: 'http://xt.example.test',
      username: 'u',
      password: 'p',
    });
    expect((await svc.importSource('xt1')).ok).toBe(true);

    // Hydrates cast & director on movie ItemDetailRow
    const movieDetail = await queryItemDetail(db, 'x:xt1:movie:101');
    expect(movieDetail?.cast).toBe('Haluk Bilginer, Melisa Sözen, Demet Akbağ');
    expect(movieDetail?.director).toBe('Nuri Bilge Ceylan');

    // Loading series episodes also enriches series director & cast from get_series_info
    const seriesRows = await db.all<{ id: number }>('SELECT id FROM series WHERE key = ?', [
      'x:xt1:series:201',
    ]);
    const seriesId = seriesRows[0]?.id ?? 0;
    expect((await svc.seasons(seriesId)).ok).toBe(true);

    const seriesDetail = await svc.itemDetail?.('x:xt1:series:201');
    expect(seriesDetail?.cast).toBe('Haluk Bilginer, Cansu Dere, Metin Akdülger');
    expect(seriesDetail?.director).toBe('Onur Saylak');

    // Search for 'Haluk': Movie 102 ('Haluk Belgeseli', title match) outranks Movie 101 ('Kış Uykusu', cast match)
    const halukRes = await svc.search?.('haluk', { scope: 'movie' });
    expect(halukRes?.movies.map((m) => m.name)).toEqual(['Haluk Belgeseli', 'Kış Uykusu']);
    expect(halukRes?.movies[0]?.matchedBy).toBe('title');
    expect(halukRes?.movies[1]?.matchedBy).toBe('cast');

    // Search for director with Turkish characters: 'Nuri Bilge' & 'Onur Saylak'
    const directorMovie = await svc.search?.('nuri bilge', { scope: 'movie' });
    expect(directorMovie?.movies).toHaveLength(1);
    expect(directorMovie?.movies[0]?.name).toBe('Kış Uykusu');
    expect(directorMovie?.movies[0]?.matchedBy).toBe('director');

    const directorSeries = await svc.search?.('onur saylak', { scope: 'series' });
    expect(directorSeries?.series).toHaveLength(1);
    expect(directorSeries?.series[0]?.name).toBe('Şahsiyet');
    expect(directorSeries?.series[0]?.matchedBy).toBe('director');

    // Substring LIKE fallback on cast/director when FTS5 prefix finds 0 hits
    const likeCast = await svc.search?.('ilginer', { scope: 'movie' });
    expect(likeCast?.movies.map((m) => m.name)).toEqual(['Kış Uykusu']);
    expect(likeCast?.movies[0]?.matchedBy).toBe('cast');

    // Episode search via loaded series episode
    const epRes = await svc.search?.('kambura dönüş', { scope: 'episode' });
    expect(epRes?.episodes).toHaveLength(1);
    expect(epRes?.episodes[0]?.title).toBe('Kambura Dönüş');
  });

  it('maintains programmes_fts atomically in commitGuide, ranks active/upcoming EPG hits ahead of past programmes, and purges programmes_fts on removeSource', async () => {
    const { db } = testDb();
    await openCatalog(db);
    const secrets = memorySecrets();

    const m3u = `#EXTM3U
#EXTINF:-1 tvg-id="ch.spor" group-title="Spor",Spor Kanalı HD
http://s.example.test/spor.ts
#EXTINF:-1 tvg-id="ch.hidden" group-title="Spor",Gizli Kanal
http://s.example.test/hidden.ts
`;
    const xmltv = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="ch.spor"><display-name>Spor Kanalı HD</display-name></channel>
  <channel id="ch.hidden"><display-name>Gizli Kanal</display-name></channel>
  <programme channel="ch.spor" start="20260715160000 +0000" stop="20260715170000 +0000">
    <title>İstanbul Derbisi Özeti (Geçmiş)</title>
    <desc>Dünkü karşılaşma</desc>
    <category>Sports</category>
  </programme>
  <programme channel="ch.spor" start="20260715180000 +0000" stop="20260715190000 +0000">
    <title>İstanbul Derbisi Canlı</title>
    <desc>Şampiyonluk mücadelesi</desc>
    <category>Sports</category>
  </programme>
  <programme channel="ch.spor" start="20260715200000 +0000" stop="20260715210000 +0000">
    <title>İstanbul Derbisi Analiz</title>
    <desc>Maç sonu yorumları</desc>
    <category>Sports</category>
  </programme>
  <programme channel="ch.hidden" start="20260715180000 +0000" stop="20260715190000 +0000">
    <title>İstanbul Derbisi Gizli</title>
  </programme>
</tv>`;

    const nowMs = Date.UTC(2026, 6, 15, 18, 30, 0);
    const svc = createCatalogService({
      db,
      secrets,
      scheduler: noopScheduler(),
      http: {
        async get(url) {
          const body = url.includes('guide.xml') ? xmltv : m3u;
          return ok({
            status: 200,
            headers: {},
            body: chunksOf(body),
            finalUrl: url,
          });
        },
      },
      clock: () => nowMs,
      newId: () => 'epgsrc',
    });

    await svc.addSource({
      kind: 'm3u',
      name: 'EPG Source',
      playlistUrl: 'http://s.example.test/list.m3u',
      guideUrl: 'http://s.example.test/guide.xml',
    });
    expect((await svc.importSource('epgsrc')).ok).toBe(true);
    expect((await svc.importGuide?.('epgsrc'))?.ok).toBe(true);

    // Hide ch.hidden so we verify hidden channels are excluded from EPG search hits
    await db.run(
      "UPDATE live SET is_hidden = 1 WHERE source_id = 'epgsrc' AND guide_id = 'ch.hidden'",
    );

    const res = await svc.search?.('ıstanbul derbisi', { scope: 'epg', nowMs });
    expect(res?.epg.map((p) => p.title)).toEqual([
      'İstanbul Derbisi Canlı',
      'İstanbul Derbisi Analiz',
      'İstanbul Derbisi Özeti (Geçmiş)',
    ]);
    expect(res?.epg[0]?.isLiveNow).toBe(true);
    expect(res?.epg[0]?.category).toBe('Sports');
    expect(res?.epg[1]?.isLiveNow).toBe(false);
    expect(res?.epg[2]?.isLiveNow).toBe(false);

    // Description search with Turkish characters ('şampiyonluk mücadelesi')
    const descRes = await svc.search?.('sampiyonluk mucadelesi', { scope: 'epg', nowMs });
    expect(descRes?.epg).toHaveLength(1);
    expect(descRes?.epg[0]?.title).toBe('İstanbul Derbisi Canlı');

    // removeSource purges programmes_fts leaving 0 orphan rows
    expect((await svc.removeSource('epgsrc')).ok).toBe(true);
    expect(await db.all('SELECT * FROM programmes_fts')).toHaveLength(0);
  });

  it('returns deduplicated on-device searchSuggestions across favorites, recents, and top non-hidden categories', async () => {
    const { db } = testDb();
    await openCatalog(db);
    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Main', 100, '{}')",
    );
    await db.run(
      `INSERT INTO categories (source_id, kind, provider_id, name, name_fold, position, is_hidden, run_id) VALUES
         ('s1', 'movie', 'c1', 'Bilim Kurgu', 'bilim kurgu', 0, 0, 1),
         ('s1', 'live', 'c2', 'Ulusal Kanallar', 'ulusal kanallar', 1, 0, 1),
         ('s1', 'movie', 'c_hidden', 'Gizli Kategori', 'gizli kategori', 2, 1, 1)`,
    );
    await db.run(
      `INSERT INTO live (source_id, key, name, name_fold, sort_title, is_hidden, run_id) VALUES
         ('s1', 'x:s1:live:1', 'TRT 1 HD', 'trt 1 hd', 'trt 1 hd', 0, 1)`,
    );
    await db.run(
      `INSERT INTO movies (source_id, key, name, name_fold, sort_title, is_hidden, run_id) VALUES
         ('s1', 'x:s1:movie:1', 'G.O.R.A.', 'g o r a', 'g o r a', 0, 1),
         ('s1', 'x:s1:movie:2', 'A.R.O.G', 'a r o g', 'a r o g', 0, 1)`,
    );
    await db.run(
      `INSERT INTO placements (source_id, kind, item_key, category_id, position, is_hidden, run_id) VALUES
         ('s1', 'movie', 'x:s1:movie:1', 'c1', 0, 0, 1),
         ('s1', 'movie', 'x:s1:movie:2', 'c1', 1, 0, 1),
         ('s1', 'live', 'x:s1:live:1', 'c2', 0, 0, 1),
         ('s1', 'movie', 'x:s1:movie:1', 'c_hidden', 0, 0, 1)`,
    );
    await db.run(
      `INSERT INTO favorites (profile_id, source_id, item_key, kind, title, added_at) VALUES
         ('default', 's1', 'x:s1:movie:1', 'movie', 'G.O.R.A.', 500)`,
    );
    await db.run(
      `INSERT INTO watch_progress (profile_id, source_id, item_key, kind, title, position_ms, duration_ms, watched, updated_at) VALUES
         ('default', 's1', 'x:s1:movie:1', 'movie', 'G.O.R.A.', 10000, 90000, 0, 600),
         ('default', 's1', 'x:s1:movie:2', 'movie', 'A.R.O.G', 20000, 90000, 0, 700)`,
    );
    await db.run(
      `INSERT INTO recent_channels (profile_id, source_id, item_key, watched_at) VALUES
         ('default', 's1', 'x:s1:live:1', 800)`,
    );

    const suggestions = await querySearchSuggestions(db, { limit: 8 });
    expect(suggestions).toEqual([
      {
        kind: 'favorite',
        label: 'G.O.R.A.',
        query: 'G.O.R.A.',
        itemKind: 'movie',
        sourceId: 's1',
        itemKey: 'x:s1:movie:1',
      },
      {
        kind: 'recent',
        label: 'TRT 1 HD',
        query: 'TRT 1 HD',
        itemKind: 'live',
        sourceId: 's1',
        itemKey: 'x:s1:live:1',
      },
      {
        kind: 'recent',
        label: 'A.R.O.G',
        query: 'A.R.O.G',
        itemKind: 'movie',
        sourceId: 's1',
        itemKey: 'x:s1:movie:2',
      },
      {
        kind: 'category',
        label: 'Bilim Kurgu',
        query: 'Bilim Kurgu',
        itemKind: 'movie',
        sourceId: 's1',
        categoryId: 's1|movie|c1',
      },
      {
        kind: 'category',
        label: 'Ulusal Kanallar',
        query: 'Ulusal Kanallar',
        itemKind: 'live',
        sourceId: 's1',
        categoryId: 's1|live|c2',
      },
    ]);
    expect(await querySearchSuggestions(db, { limit: 0 })).toEqual([]);
  });

  it('computes A-Z alphabetIndex with exact 0-based offset alignment against items() and allSourcesItems() including Turkish diacritics, collapseVariants, and groupVersions (#407)', async () => {
    const { db } = testDb();
    await openCatalog(db);
    const secrets = memorySecrets();

    const m3u = `#EXTM3U
#EXTINF:-1 group-title="Movies",1917 (2019)
http://s.example.test/movie/1917.mp4
#EXTINF:-1 group-title="Movies",300 (2006)
http://s.example.test/movie/300.mp4
#EXTINF:-1 group-title="Movies",Çiçek Abbas (1982)
http://s.example.test/movie/cicek.mp4
#EXTINF:-1 group-title="Movies",Dune (2021) [4K HDR]
http://s.example.test/movie/dune-4k.mp4
#EXTINF:-1 group-title="Movies",Dune (2021) [1080p]
http://s.example.test/movie/dune-1080.mp4
#EXTINF:-1 group-title="Movies",Ğ
http://s.example.test/movie/g.mp4
#EXTINF:-1 group-title="Movies",İstanbul Kanatlarımın Altında
http://s.example.test/movie/istanbul.mp4
#EXTINF:-1 group-title="Movies",ıssız Adam
http://s.example.test/movie/issiz.mp4
#EXTINF:-1 group-title="Movies",Şampiyon
http://s.example.test/movie/sampiyon.mp4
#EXTINF:-1 group-title="Movies",Bir Zamanlar Anadolu'da
http://s.example.test/movie/anadolu.mp4
#EXTINF:-1 group-title="UK",BBC One SD
http://s.example.test/live/bbc-sd.ts
#EXTINF:-1 group-title="UK",BBC One 4K
http://s.example.test/live/bbc-4k.ts
#EXTINF:-1 group-title="UK",BBC One HD
http://s.example.test/live/bbc-hd.ts
#EXTINF:-1 group-title="UK",ITV 1 HD
http://s.example.test/live/itv-hd.ts
#EXTINF:-1 group-title="UK",ITV 1 FHD
http://s.example.test/live/itv-fhd.ts
#EXTINF:-1 group-title="UK",Sky News HD
http://s.example.test/live/sky.ts
`;

    const svc = createCatalogService({
      db,
      secrets,
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
      newId: () => 'azsrc',
    });

    await svc.addSource({
      kind: 'm3u',
      name: 'AZ Source',
      playlistUrl: 'http://s.example.test/list.m3u',
    });
    expect((await svc.importSource('azsrc')).ok).toBe(true);

    const movieCats = await svc.categories('azsrc', 'movie');
    const movieCatId = movieCats[0]?.id ?? '';

    // 1. Ungrouped Movies category alphabetIndex vs items(..., { sortBy: 'alpha' })
    const ungroupedAlphaItems = await svc.items(movieCatId, 0, 100, { sortBy: 'alpha' });
    const ungroupedBuckets = await svc.alphabetIndex?.({
      sourceId: 'azsrc',
      kind: 'movie',
      categoryId: movieCatId,
    });
    expect(ungroupedBuckets).toEqual([
      { letter: '#', offset: 0, count: 2 },
      { letter: 'C', offset: 2, count: 1 },
      { letter: 'D', offset: 3, count: 2 },
      { letter: 'G', offset: 5, count: 1 },
      { letter: 'I', offset: 6, count: 2 },
      { letter: 'S', offset: 8, count: 1 },
      { letter: 'Z', offset: 9, count: 1 },
    ]);
    for (const bucket of ungroupedBuckets ?? []) {
      const itemAtOffset = ungroupedAlphaItems[bucket.offset];
      expect(itemAtOffset).toBeDefined();
      const pageAtOffset = await svc.items(movieCatId, bucket.offset, 1, { sortBy: 'alpha' });
      expect(pageAtOffset[0]?.key).toBe(itemAtOffset?.key);
    }

    // 2. Grouped Movies (groupVersions: true) category alphabetIndex vs items(..., { sortBy: 'alpha', groupVersions: true })
    const groupedAlphaItems = await svc.items(movieCatId, 0, 100, {
      sortBy: 'alpha',
      groupVersions: true,
    });
    const groupedBuckets = await svc.alphabetIndex?.({
      sourceId: 'azsrc',
      kind: 'movie',
      categoryId: movieCatId,
      groupVersions: true,
    });
    expect(groupedBuckets).toEqual([
      { letter: '#', offset: 0, count: 2 },
      { letter: 'C', offset: 2, count: 1 },
      { letter: 'D', offset: 3, count: 1 }, // Dune collapsed from 2 -> 1!
      { letter: 'G', offset: 4, count: 1 },
      { letter: 'I', offset: 5, count: 2 },
      { letter: 'S', offset: 7, count: 1 },
      { letter: 'Z', offset: 8, count: 1 },
    ]);
    for (const bucket of groupedBuckets ?? []) {
      const pageAtOffset = await svc.items(movieCatId, bucket.offset, 1, {
        sortBy: 'alpha',
        groupVersions: true,
      });
      expect(pageAtOffset[0]?.key).toBe(groupedAlphaItems[bucket.offset]?.key);
    }

    // 3. All-sources alphabetIndex (no categoryId, no sourceId) with groupVersions: true vs allSourcesItems
    const allSourcesGroupedItems = await svc.allSourcesItems?.('movie', 0, 100, undefined, {
      sortBy: 'alpha',
      groupVersions: true,
    });
    const allSourcesGroupedBuckets = await queryAlphabetIndex(db, {
      kind: 'movie',
      groupVersions: true,
    });
    expect(allSourcesGroupedBuckets).toEqual(groupedBuckets);
    for (const bucket of allSourcesGroupedBuckets) {
      const pageAtOffset = await svc.allSourcesItems?.('movie', bucket.offset, 1, undefined, {
        sortBy: 'alpha',
        groupVersions: true,
      });
      expect(pageAtOffset?.[0]?.key).toBe(allSourcesGroupedItems?.[bucket.offset]?.key);
    }

    // 4. Live Channels with collapseVariants: true vs items(..., { sortBy: 'alpha', collapseVariants: true })
    const liveCats = await svc.categories('azsrc', 'live', { collapseVariants: true });
    const liveCatId = liveCats[0]?.id ?? '';
    const collapsedLiveItems = await svc.items(liveCatId, 0, 100, {
      sortBy: 'alpha',
      collapseVariants: true,
    });
    const collapsedLiveBuckets = await svc.alphabetIndex?.({
      sourceId: 'azsrc',
      kind: 'live',
      categoryId: liveCatId,
      collapseVariants: true,
    });
    expect(collapsedLiveBuckets).toEqual([
      { letter: 'B', offset: 0, count: 1 }, // BBC One (3 variants -> 1)
      { letter: 'I', offset: 1, count: 1 }, // ITV 1 (2 variants -> 1)
      { letter: 'S', offset: 2, count: 1 }, // Sky News (1)
    ]);
    for (const bucket of collapsedLiveBuckets ?? []) {
      const pageAtOffset = await svc.items(liveCatId, bucket.offset, 1, {
        sortBy: 'alpha',
        collapseVariants: true,
      });
      expect(pageAtOffset[0]?.key).toBe(collapsedLiveItems[bucket.offset]?.key);
    }

    // 5. Source-wide alphabetIndex (sourceId without categoryId) and all-sources live with collapseVariants
    const sourceLiveBuckets = await svc.alphabetIndex?.({
      sourceId: 'azsrc',
      kind: 'live',
      collapseVariants: true,
    });
    expect(sourceLiveBuckets).toEqual(collapsedLiveBuckets);
    const allSourcesCollapsedLive = await svc.allSourcesItems?.('live', 0, 100, ['azsrc'], {
      sortBy: 'alpha',
      collapseVariants: true,
    });
    expect(allSourcesCollapsedLive).toHaveLength(3);

    // 6. Raw provider categoryId with sourceId + invalid categoryId edge cases
    const rawCatBuckets = await svc.alphabetIndex?.({
      sourceId: 'azsrc',
      kind: 'live',
      categoryId: 'UK',
      collapseVariants: true,
    });
    expect(rawCatBuckets).toEqual(collapsedLiveBuckets);
    expect(await svc.alphabetIndex?.({ kind: 'live', categoryId: 'azsrc|movie|Movies' })).toEqual(
      [],
    );
    expect(
      await svc.alphabetIndex?.({
        sourceId: 'other',
        kind: 'live',
        categoryId: 'azsrc|live|UK',
      }),
    ).toEqual([]);
    expect(await svc.alphabetIndex?.({ kind: 'live', categoryId: 'unqualified-raw-cat' })).toEqual(
      [],
    );

    // 7. EPG and Episode LIKE fallback when FTS5 prefix finds 0 hits, plus CatalogService.searchSuggestions
    await db.run(
      "INSERT INTO series (source_id, key, name, name_fold, sort_title, run_id) VALUES ('azsrc', 'm:azsrc:series:1', 'SuperShow', 'supershow', 'supershow', 1)",
    );
    await db.run(
      "INSERT INTO episodes (source_id, key, series_key, season, episode, title, title_fold, run_id) VALUES ('azsrc', 'm:azsrc:ep:1', 'm:azsrc:series:1', 1, 2, 'Megaepisode', 'megaepisode', 1)",
    );
    await db.run(
      "INSERT INTO programmes (source_id, guide_id, start, stop, title, description, run_id) VALUES ('azsrc', 'g.bbc', 1000, 9000, 'Megaprogramme', 'Subdesc', 1)",
    );
    await db.run(
      "INSERT INTO channel_guide (source_id, channel_key, guide_id) VALUES ('azsrc', ?, 'g.bbc')",
      [collapsedLiveItems[0]?.key ?? ''],
    );
    await db.run(
      "INSERT INTO programmes_fts (source_id, guide_id, start, stop, title_fold, description_fold) VALUES ('azsrc', 'g.bbc', 1000, 9000, 'megaprogramme', 'subdesc')",
    );

    const epLike = await svc.search?.('gaepis', { scope: 'episode' });
    expect(epLike?.episodes.map((e) => e.title)).toEqual(['Megaepisode']);

    const epgLike = await svc.search?.('gaprog', { scope: 'epg' });
    expect(epgLike?.epg.map((p) => p.title)).toEqual(['Megaprogramme']);

    const svcSuggestions = await svc.searchSuggestions?.({ limit: 4 });
    expect(svcSuggestions?.length).toBeGreaterThan(0);
  });
});
