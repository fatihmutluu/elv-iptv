import { type HttpClient, ok } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createCatalogService } from './catalog';
import { openCatalog } from './migrate';
import { queryAllSourcesItemsByCursor, queryItemsByCursor } from './queries';
import { countingScheduler, memorySecrets, testDb } from './test-db';

function bytesStream(text: string): AsyncIterable<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return (async function* () {
    yield bytes;
  })();
}

function makeMockHttp(routes: Record<string, string>): HttpClient {
  return {
    async get(url) {
      const matched = Object.entries(routes).find(([key]) => url.startsWith(key));
      const body = matched?.[1] ?? '';
      return ok({
        status: matched ? 200 : 404,
        headers: { 'content-type': 'text/plain' },
        finalUrl: url,
        body: bytesStream(body),
      });
    },
  };
}

async function setupService(routes: Record<string, string> = {}) {
  const handle = testDb();
  const opened = await openCatalog(handle.db);
  if (!opened.ok) throw new Error('openCatalog failed');
  const secrets = memorySecrets();
  const nowMs = 1_000_000;
  let idSeq = 0;
  const service = createCatalogService({
    db: handle.db,
    secrets,
    scheduler: countingScheduler(),
    http: makeMockHttp(routes),
    clock: () => nowMs,
    newId: () => `s${++idSeq}`,
  });
  return { ...handle, secrets, service };
}

describe('query-layer parental enforcement across all @elv/data queries (#31)', () => {
  async function seedRichCatalog() {
    const m3uUrl = 'http://provider.example/list.m3u';
    const playlist = [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="news.1" tvg-chno="10" group-title="News",Alpha News HD',
      'http://cdn.example/live/news1.ts',
      '#EXTINF:-1 tvg-id="news.2" tvg-chno="10" group-title="News",Beta News HD',
      'http://cdn.example/live/news2.ts',
      '#EXTINF:-1 tvg-id="adult.1" tvg-chno="18" group-title="VIP 18+",Midnight XXX Live',
      'http://cdn.example/live/adult1.ts',
      '#EXTINF:-1 tvg-id="locked.1" tvg-chno="19" group-title="Premium",Locked Channel Live',
      'http://cdn.example/live/locked1.ts',
      '#EXTINF:-1 tvg-id="mixed.1" tvg-chno="20" group-title="News",Late Night Adult Show',
      'http://cdn.example/live/mixed1.ts',
    ].join('\n');

    const env = await setupService({ [m3uUrl]: playlist });
    const src1 = await env.service.addSource({ kind: 'm3u', name: 'M3U One', playlistUrl: m3uUrl });
    if (!src1.ok) throw new Error('addSource failed');
    const imp1 = await env.service.importSource(src1.value.id);
    if (!imp1.ok) throw new Error('importSource failed');

    const { db } = env;
    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s2', 'xtream', 'Xtream Two', 200, '{}')",
    );
    await env.secrets.set(
      'source.s2.xtream',
      JSON.stringify({ server: 'http://xt.example', username: 'u', password: 'p' }),
    );
    await db.run(
      "INSERT INTO categories (source_id, kind, provider_id, name, name_fold, position, run_id) VALUES ('s2', 'movie', 'fam', 'Family', 'family', 0, 1)",
    );
    await db.run(
      "INSERT INTO categories (source_id, kind, provider_id, name, name_fold, position, run_id) VALUES ('s2', 'movie', 'hot', 'Adults Cinema', 'adults cinema', 1, 1)",
    );
    await db.run(
      "INSERT INTO categories (source_id, kind, provider_id, name, name_fold, position, run_id) VALUES ('s2', 'series', 'drama', 'Drama', 'drama', 0, 1)",
    );
    await db.run(
      "INSERT INTO categories (source_id, kind, provider_id, name, name_fold, position, run_id) VALUES ('s2', 'live', 'sports', 'Sports', 'sports', 0, 1)",
    );
    await db.run(
      "INSERT INTO live (source_id, key, provider_id, num, name, name_fold, sort_title, run_id) VALUES ('s2', 'x:s2:live:1', '1', 18, 'Sports 18 Open', 'sports 18 open', 'sports 18 open', 1)",
    );
    await db.run(
      "INSERT INTO placements (source_id, kind, item_key, category_id, position, run_id) VALUES ('s2', 'live', 'x:s2:live:1', 'sports', 0, 1)",
    );

    await db.run(
      "INSERT INTO movies (source_id, key, provider_id, name, name_fold, sort_title, extension, run_id) VALUES ('s2', 'x:s2:movie:safe', '10', 'Adultery History', 'adultery history', 'adultery history', 'mp4', 1)",
    );
    await db.run(
      "INSERT INTO movies (source_id, key, provider_id, name, name_fold, sort_title, extension, run_id) VALUES ('s2', 'x:s2:movie:catadult', '11', 'Secret Moonlight', 'secret moonlight', 'secret moonlight', 'mp4', 1)",
    );
    await db.run(
      "INSERT INTO movies (source_id, key, provider_id, name, name_fold, sort_title, extension, run_id) VALUES ('s2', 'x:s2:movie:itemlock', '12', 'Dark Thriller', 'dark thriller', 'dark thriller', 'mp4', 1)",
    );
    await db.run(
      "INSERT INTO movies (source_id, key, provider_id, name, name_fold, sort_title, extension, run_id) VALUES ('s2', 'x:s2:movie:kw', '13', 'Erotica Nights', 'erotica nights', 'erotica nights', 'mp4', 1)",
    );
    await db.run(
      "INSERT INTO placements (source_id, kind, item_key, category_id, position, run_id) VALUES ('s2', 'movie', 'x:s2:movie:safe', 'fam', 0, 1)",
    );
    await db.run(
      "INSERT INTO placements (source_id, kind, item_key, category_id, position, run_id) VALUES ('s2', 'movie', 'x:s2:movie:catadult', 'fam', 1, 1)",
    );
    await db.run(
      "INSERT INTO placements (source_id, kind, item_key, category_id, position, run_id) VALUES ('s2', 'movie', 'x:s2:movie:catadult', 'hot', 0, 1)",
    );
    await db.run(
      "INSERT INTO placements (source_id, kind, item_key, category_id, position, run_id) VALUES ('s2', 'movie', 'x:s2:movie:itemlock', 'fam', 2, 1)",
    );
    await db.run(
      "INSERT INTO placements (source_id, kind, item_key, category_id, position, run_id) VALUES ('s2', 'movie', 'x:s2:movie:kw', 'fam', 3, 1)",
    );

    await db.run(
      "INSERT INTO series (source_id, key, provider_id, name, name_fold, sort_title, run_id) VALUES ('s2', 'x:s2:series:safe', '20', 'Galaxy Quest', 'galaxy quest', 'galaxy quest', 1)",
    );
    await db.run(
      "INSERT INTO series (source_id, key, provider_id, name, name_fold, sort_title, run_id) VALUES ('s2', 'x:s2:series:locked', '21', 'Midnight Shadows', 'midnight shadows', 'midnight shadows', 1)",
    );
    await db.run(
      "INSERT INTO placements (source_id, kind, item_key, category_id, position, run_id) VALUES ('s2', 'series', 'x:s2:series:safe', 'drama', 0, 1)",
    );
    await db.run(
      "INSERT INTO placements (source_id, kind, item_key, category_id, position, run_id) VALUES ('s2', 'series', 'x:s2:series:locked', 'drama', 1, 1)",
    );
    await db.run(
      "INSERT INTO episodes (source_id, key, provider_id, series_key, season, episode, title, title_fold, extension, run_id) VALUES ('s2', 'x:s2:ep:safe1', '30', 'x:s2:series:safe', 1, 1, 'Pilot Orbit', 'pilot orbit', 'mp4', 1)",
    );
    await db.run(
      "INSERT INTO episodes (source_id, key, provider_id, series_key, season, episode, title, title_fold, extension, run_id) VALUES ('s2', 'x:s2:ep:locked1', '31', 'x:s2:series:locked', 1, 1, 'Pilot Secret', 'pilot secret', 'mp4', 1)",
    );

    const s1Live = await db.all<{ key: string; name: string }>(
      "SELECT key, name FROM live WHERE source_id = 's1'",
    );
    const keyByName = new Map(s1Live.map((r) => [r.name, r.key]));
    const newsKey = keyByName.get('Alpha News HD') as string;
    const betaKey = keyByName.get('Beta News HD') as string;
    const adultKey = keyByName.get('Midnight XXX Live') as string;
    const lockedKey = keyByName.get('Locked Channel Live') as string;

    await db.run(
      "INSERT INTO channel_guide (source_id, channel_key, guide_id) VALUES ('s1', ?, 'g.news')",
      [newsKey],
    );
    await db.run(
      "INSERT INTO channel_guide (source_id, channel_key, guide_id) VALUES ('s1', ?, 'g.adult')",
      [adultKey],
    );
    await db.run(
      "INSERT INTO channel_guide (source_id, channel_key, guide_id) VALUES ('s1', ?, 'g.locked')",
      [lockedKey],
    );
    const t0 = 1_000_000;
    const hour = 3_600_000;
    await db.run(
      `INSERT INTO programmes (source_id, guide_id, start, stop, title, description, rating_value, title_fold, description_fold, run_id)
       VALUES ('s1', 'g.news', ?, ?, 'Morning Report', 'Daily headlines', 'TV-G', 'morning report', 'daily headlines', 1)`,
      [t0 - 1_000, t0 + hour],
    );
    await db.run(
      `INSERT INTO programmes (source_id, guide_id, start, stop, title, description, rating_value, title_fold, description_fold, run_id)
       VALUES ('s1', 'g.news', ?, ?, 'Late Crime Special', 'Mature thriller', 'TV-MA', 'late crime special', 'mature thriller', 1)`,
      [t0 + hour, t0 + 2 * hour],
    );
    await db.run(
      `INSERT INTO programmes (source_id, guide_id, start, stop, title, description, rating_value, title_fold, description_fold, run_id)
       VALUES ('s1', 'g.adult', ?, ?, 'After Dark Club', 'Special broadcast', 'TV-PG', 'after dark club', 'special broadcast', 1)`,
      [t0 - 1_000, t0 + hour],
    );
    await db.run(
      `INSERT INTO programmes (source_id, guide_id, start, stop, title, description, rating_value, title_fold, description_fold, run_id)
       VALUES ('s1', 'g.locked', ?, ?, 'Premium Show', 'Exclusive event', 'G', 'premium show', 'exclusive event', 1)`,
      [t0 - 1_000, t0 + hour],
    );
    await db.exec(
      `INSERT INTO programmes_fts (source_id, guide_id, start, stop, title_fold, description_fold)
       SELECT source_id, guide_id, start, stop, title_fold, description_fold FROM programmes`,
    );

    return { ...env, newsKey, betaKey, adultKey, lockedKey, t0, hour };
  }

  it('enforces parental controls across categories, items, cursors, allSources, alphabet, search, EPG, user-state, detail, and resolveStream, and unlocks with parentalUnlocked: true', async () => {
    const env = await seedRichCatalog();
    const { db, service, newsKey, betaKey, adultKey, lockedKey, t0, hour, close } = env;
    try {
      await service.updateParentalSettings?.({
        enabled: true,
        blockAdultKeywords: true,
        maxRatingAge: 12,
      });
      const s1AllCats = await service.categories('s1', 'live', { parentalUnlocked: true });
      const premiumCat = s1AllCats.find((c) => c.name === 'Premium');
      const newsCat = s1AllCats.find((c) => c.name === 'News');
      expect(premiumCat).toBeDefined();
      expect(newsCat).toBeDefined();
      const premiumCatId = premiumCat?.id ?? '';
      await service.setParentalLock?.(
        {
          sourceId: 's1',
          targetKind: 'category',
          itemKind: 'live',
          targetKey: premiumCatId,
        },
        true,
      );
      await service.setParentalLock?.(
        {
          sourceId: 's2',
          targetKind: 'item',
          itemKind: 'movie',
          targetKey: 'x:s2:movie:itemlock',
        },
        true,
      );
      await service.setParentalLock?.(
        {
          sourceId: 's2',
          targetKind: 'item',
          itemKind: 'series',
          targetKey: 'x:s2:series:locked',
        },
        true,
      );

      // 1. categories()
      const s1LockedCats = await service.categories('s1', 'live');
      expect(s1LockedCats.map((c) => ({ name: c.name, itemCount: c.itemCount }))).toEqual([
        { name: 'News', itemCount: 2 },
      ]);
      expect(
        (await service.categories('s1', 'live', { parentalUnlocked: true })).map((c) => c.name),
      ).toEqual(['News', 'VIP 18+', 'Premium']);

      const s2LockedMovieCats = await service.categories('s2', 'movie');
      expect(s2LockedMovieCats.map((c) => ({ name: c.name, itemCount: c.itemCount }))).toEqual([
        { name: 'Family', itemCount: 1 },
      ]);

      // 2. items() & queryItemsByCursor()
      expect(await service.items(premiumCatId, 0, 20)).toEqual([]);
      expect((await service.items('s2|movie|fam', 0, 20)).map((i) => i.key)).toEqual([
        'x:s2:movie:safe',
      ]);
      expect(
        (await service.items('s2|movie|fam', 0, 20, { sortBy: 'alpha' })).map((i) => i.key),
      ).toEqual(['x:s2:movie:safe']);
      expect(
        (await service.items('s2|movie|fam', 0, 20, { groupVersions: true })).map((i) => i.key),
      ).toEqual(['x:s2:movie:safe']);
      expect(await service.items('s2|movie|fam', 0, 20, { parentalUnlocked: true })).toHaveLength(
        4,
      );

      expect(await queryItemsByCursor(db, premiumCatId, undefined, 10)).toEqual({
        items: [],
        nextCursor: null,
        hasMore: false,
      });
      expect(
        (await queryItemsByCursor(db, 's2|movie|fam', undefined, 10)).items.map((i) => i.key),
      ).toEqual(['x:s2:movie:safe']);

      // 3. allSourcesItems() & queryAllSourcesItemsByCursor()
      expect((await service.allSourcesItems?.('live', 0, 20))?.map((i) => i.name).sort()).toEqual([
        'Alpha News HD',
        'Beta News HD',
        'Sports 18 Open',
      ]);
      expect(
        (await service.allSourcesItems?.('live', 0, 20, undefined, { sortBy: 'alpha' }))?.map(
          (i) => i.name,
        ),
      ).toEqual(['Alpha News HD', 'Beta News HD', 'Sports 18 Open']);
      expect(
        (await queryAllSourcesItemsByCursor(db, 'live', {}, 20)).items.map((i) => i.name).sort(),
      ).toEqual(['Alpha News HD', 'Beta News HD', 'Sports 18 Open']);
      expect((await service.allSourcesItems?.('movie', 0, 20))?.map((i) => i.key)).toEqual([
        'x:s2:movie:safe',
      ]);

      // 4. alphabetIndex()
      expect(await service.alphabetIndex?.({ kind: 'movie', sourceId: 's2' })).toEqual([
        { letter: 'A', offset: 0, count: 1 },
      ]);
      expect(await service.alphabetIndex?.({ kind: 'live', categoryId: premiumCatId })).toEqual([]);
      const alphaMoviesUnlocked = await service.alphabetIndex?.({
        kind: 'movie',
        sourceId: 's2',
        parentalUnlocked: true,
      });
      expect(alphaMoviesUnlocked?.reduce((s, b) => s + b.count, 0)).toBe(4);

      // 5. search()
      expect((await service.search?.('Midnight'))?.live).toEqual([]);
      expect((await service.search?.('Midnight'))?.series).toEqual([]);
      expect((await service.search?.('Secret', { scope: 'movie' }))?.movies).toEqual([]);
      expect((await service.search?.('Dark Thriller', { scope: 'movie' }))?.movies).toEqual([]);
      expect((await service.search?.('Erotica', { scope: 'movie' }))?.movies).toEqual([]);
      expect(
        (await service.search?.('Adultery', { scope: 'movie' }))?.movies.map((m) => m.key),
      ).toEqual(['x:s2:movie:safe']);
      expect(
        (await service.search?.('Pilot', { scope: 'episode' }))?.episodes.map((e) => e.itemKey),
      ).toEqual(['x:s2:ep:safe1']);
      expect((await service.search?.('Late Crime', { scope: 'epg', nowMs: t0 }))?.epg).toEqual([]);
      expect((await service.search?.('After Dark', { scope: 'epg', nowMs: t0 }))?.epg).toEqual([]);
      expect((await service.search?.('Premium Show', { scope: 'epg', nowMs: t0 }))?.epg).toEqual(
        [],
      );
      expect(
        (await service.search?.('Morning Report', { scope: 'epg', nowMs: t0 }))?.epg.map(
          (p) => p.title,
        ),
      ).toEqual(['Morning Report']);
      expect(
        (await service.search?.('Late Crime', { scope: 'epg', nowMs: t0, parentalUnlocked: true }))
          ?.epg,
      ).toHaveLength(1);

      // 6. nowNext(), epgWindow(), epgSlice()
      const nowNext = await service.nowNext?.([newsKey, adultKey, lockedKey], t0);
      expect(nowNext?.map((e) => e.channelKey)).toEqual([newsKey]);
      expect(nowNext?.[0]?.now?.title).toBe('Morning Report');
      expect(nowNext?.[0]?.next).toBeNull();

      const nowNextUnlocked = await service.nowNext?.([newsKey, adultKey, lockedKey], t0, {
        parentalUnlocked: true,
      });
      expect(nowNextUnlocked).toHaveLength(3);
      expect(nowNextUnlocked?.[0]?.next?.title).toBe('Late Crime Special');

      const win = await service.epgWindow?.([newsKey, adultKey, lockedKey], t0, t0 + 3 * hour);
      expect(Object.keys(win ?? {})).toEqual([newsKey]);
      expect(win?.[newsKey]?.map((p) => p.title)).toEqual(['Morning Report']);

      const slice = await service.epgSlice?.('s1', t0, t0 + 3 * hour);
      expect(slice?.map((p) => p.title)).toEqual(['Morning Report']);

      // 7. channelByNumber() + profile-specific favorites tie-breaking
      expect((await service.channelByNumber?.(18))?.key).toBe('x:s2:live:1');
      expect(await service.channelByNumber?.(19)).toBeNull();
      expect((await service.channelByNumber?.(19, 's1', { parentalUnlocked: true }))?.key).toBe(
        lockedKey,
      );

      await service.createProfile?.({ name: 'Viewer B' });
      const profiles = await service.listProfiles?.();
      const viewerB = profiles?.find((p) => p.name === 'Viewer B')?.id as string;
      await service.toggleFavorite?.({
        profileId: viewerB,
        sourceId: 's1',
        itemKey: betaKey,
        kind: 'live',
        title: 'Beta News HD',
      });
      expect((await service.channelByNumber?.(10, 's1', { profileId: 'default' }))?.key).toBe(
        newsKey,
      );
      expect((await service.channelByNumber?.(10, 's1', { profileId: viewerB }))?.key).toBe(
        betaKey,
      );

      // 8. User-state lists & searchSuggestions
      await service.saveProgress?.({
        sourceId: 's2',
        itemKey: 'x:s2:movie:safe',
        kind: 'movie',
        title: 'Adultery History',
        positionMs: 20_000,
        durationMs: 120_000,
      });
      await service.saveProgress?.({
        sourceId: 's2',
        itemKey: 'x:s2:ep:locked1',
        kind: 'episode',
        title: 'Pilot Secret',
        seriesKey: 'x:s2:series:locked',
        positionMs: 20_000,
        durationMs: 120_000,
      });
      await service.toggleFavorite?.({
        sourceId: 's2',
        itemKey: 'x:s2:movie:safe',
        kind: 'movie',
        title: 'Adultery History',
      });
      await service.toggleFavorite?.({
        sourceId: 's2',
        itemKey: 'x:s2:movie:itemlock',
        kind: 'movie',
        title: 'Dark Thriller',
      });
      await service.recordRecentChannel?.(newsKey, 's1');
      await service.recordRecentChannel?.(adultKey, 's1');

      expect((await service.listContinueWatching?.(10))?.map((r) => r.itemKey)).toEqual([
        'x:s2:movie:safe',
      ]);
      expect(
        (await service.listContinueWatching?.(10, 'default', { parentalUnlocked: true }))?.map(
          (r) => r.itemKey,
        ),
      ).toHaveLength(2);
      expect((await service.listFavorites?.(10))?.map((r) => r.itemKey)).toEqual([
        'x:s2:movie:safe',
      ]);
      expect((await service.listRecentChannels?.(10))?.map((r) => r.key)).toEqual([newsKey]);

      const suggestions = await service.searchSuggestions?.({ limit: 16 });
      const labels = suggestions?.map((s) => s.label) ?? [];
      expect(labels).not.toContain('Dark Thriller');
      expect(labels).not.toContain('Pilot Secret');
      expect(labels).not.toContain('Midnight XXX Live');
      expect(labels).not.toContain('VIP 18+');
      expect(labels).not.toContain('Premium');
      expect(labels).not.toContain('Adults Cinema');

      // 9. itemDetail() and resolveStream()
      expect(await service.itemDetail?.('x:s2:movie:itemlock')).toBeNull();
      expect(await service.itemDetail?.('x:s2:movie:catadult')).toBeNull();
      expect((await service.itemDetail?.('x:s2:movie:safe'))?.key).toBe('x:s2:movie:safe');
      expect(
        (await service.itemDetail?.('x:s2:movie:itemlock', { parentalUnlocked: true }))?.key,
      ).toBe('x:s2:movie:itemlock');

      expect(await service.resolveStream(adultKey)).toEqual({
        ok: false,
        error: { category: 'auth', code: 'parental-locked' },
      });
      expect(await service.resolveStream('x:s2:movie:itemlock')).toEqual({
        ok: false,
        error: { category: 'auth', code: 'parental-locked' },
      });
      expect(await service.resolveStream('x:s2:ep:locked1')).toEqual({
        ok: false,
        error: { category: 'auth', code: 'parental-locked' },
      });
      expect((await service.resolveStream(newsKey)).ok).toBe(true);
      expect((await service.resolveStream(adultKey, { parentalUnlocked: true })).ok).toBe(true);
      expect((await service.resolveStream('x:s2:ep:locked1', { parentalUnlocked: true })).ok).toBe(
        true,
      );
    } finally {
      close();
    }
  });
});
