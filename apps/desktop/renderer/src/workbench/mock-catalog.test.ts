import { describe, expect, it } from 'vitest';
import { createWorkbenchCatalog } from './mock-catalog.ts';

describe('createWorkbenchCatalog', () => {
  it('provides synthetic live, movie, and series categories with deterministic SVG artwork and clean channel names', async () => {
    const catalog = createWorkbenchCatalog();
    const sources = await catalog.listSources();
    expect(sources).toHaveLength(1);
    const srcId = sources[0]?.id ?? '';

    const liveCats = await catalog.categories(srcId, 'live');
    expect(liveCats.length).toBeGreaterThanOrEqual(3);
    const cinemaLive = await catalog.items(liveCats[0]?.id ?? '', 0, 50);
    const sportsLive = await catalog.items(liveCats[1]?.id ?? '', 0, 50);
    expect(cinemaLive[0]?.name).toBe('Velvet Cinema 4K');
    expect(sportsLive[0]?.name).toBe('Pitch Sports 1 UHD');
    expect(cinemaLive.every((c) => c.logo?.startsWith('data:image/svg+xml;utf8,'))).toBe(true);
    expect(sportsLive.every((c) => c.logo?.startsWith('data:image/svg+xml;utf8,'))).toBe(true);

    const movieCats = await catalog.categories(srcId, 'movie');
    const movies = await catalog.items(movieCats[0]?.id ?? '', 0, 50);
    expect(movies[0]?.year).toBeGreaterThan(2020);
    expect(movies.every((m) => m.logo?.startsWith('data:image/svg+xml;utf8,'))).toBe(true);

    const seriesCats = await catalog.categories(srcId, 'series');
    const series = await catalog.items(seriesCats[0]?.id ?? '', 0, 50);
    expect(series.every((s) => s.logo?.startsWith('data:image/svg+xml;utf8,'))).toBe(true);
    const seriesId = series[0]?.id ?? 0;
    const seasons = await catalog.seasons(seriesId);
    expect(seasons.ok && seasons.value.length).toBe(2);
    const eps = await catalog.episodes(seriesId, 1);
    expect(eps).toHaveLength(3);

    const resolved = await catalog.resolveStream(cinemaLive[0]?.key ?? '');
    expect(resolved.ok).toBe(true);
  });

  it('returns ItemDetailRow with synthetic English synopses for all workbench movies and series, null plot for live, and null for unknown keys', async () => {
    const catalog = createWorkbenchCatalog();
    const sources = await catalog.listSources();
    const srcId = sources[0]?.id ?? '';

    const movieCats = await catalog.categories(srcId, 'movie');
    const allMovies = (await Promise.all(movieCats.map((c) => catalog.items(c.id, 0, 50)))).flat();
    expect(allMovies.length).toBe(7);
    for (const movie of allMovies) {
      const detail = await catalog.itemDetail?.(movie.key);
      expect(detail).toMatchObject({ ...movie });
      expect(typeof detail?.plot).toBe('string');
      expect((detail?.plot ?? '').trim().length).toBeGreaterThan(40);
      expect(typeof detail?.cast).toBe('string');
      expect(typeof detail?.director).toBe('string');
    }

    const seriesCats = await catalog.categories(srcId, 'series');
    const allSeries = (await Promise.all(seriesCats.map((c) => catalog.items(c.id, 0, 50)))).flat();
    expect(allSeries.length).toBe(3);
    for (const show of allSeries) {
      const detail = await catalog.itemDetail?.(show.key);
      expect(detail).toMatchObject({ ...show });
      expect(typeof detail?.plot).toBe('string');
      expect((detail?.plot ?? '').trim().length).toBeGreaterThan(40);
      expect(typeof detail?.cast).toBe('string');
      expect(typeof detail?.director).toBe('string');
    }

    const liveCats = await catalog.categories(srcId, 'live');
    const firstLive = (await catalog.items(liveCats[0]?.id ?? '', 0, 10))[0];
    expect(firstLive).toBeDefined();
    expect(await catalog.itemDetail?.(firstLive?.key ?? '')).toEqual({
      ...firstLive,
      plot: null,
    });

    expect(await catalog.itemDetail?.('wb:movie:9999')).toBeNull();
    expect(await catalog.itemDetail?.('unknown')).toBeNull();
  });

  it('pre-seeds Continue Watching and My List and supports stateful user-state mutations', async () => {
    const catalog = createWorkbenchCatalog();

    const cw = await catalog.listContinueWatching?.(10);
    expect(cw).toHaveLength(2);
    expect(cw?.map((r) => r.title)).toEqual(['Silent Horizon', 'Northern Signal']);
    const silent = cw?.[0];
    const northern = cw?.[1];
    expect(silent && Math.round((silent.positionMs / silent.durationMs) * 100)).toBe(42);
    expect(northern && Math.round((northern.positionMs / northern.durationMs) * 100)).toBe(64);
    expect(northern).toMatchObject({ kind: 'episode', season: 1, episode: 2 });

    const favs = await catalog.listFavorites?.(10);
    expect(favs).toHaveLength(2);
    expect(favs?.map((f) => f.title)).toEqual(['Orbital Nine', 'Paper Lanterns']);
    expect(await catalog.listFavoriteKeys?.()).toEqual(['wb:movie:402', 'wb:movie:503']);

    // Save progress & query by keys
    const saved = await catalog.saveProgress?.({
      sourceId: 'workbench-demo',
      itemKey: 'wb:movie:403',
      kind: 'movie',
      title: 'Glass Meridian',
      positionMs: 120_000,
      durationMs: 600_000,
    });
    expect(saved?.ok).toBe(true);
    expect((await catalog.getProgress?.('wb:movie:403'))?.positionMs).toBe(120_000);
    expect((await catalog.listProgressByKeys?.(['wb:movie:403', 'wb:movie:401']))?.length).toBe(2);

    // Mark watched removes from Continue Watching
    await catalog.setWatched?.('wb:movie:403', true);
    expect((await catalog.getProgress?.('wb:movie:403'))?.watched).toBe(true);
    expect(
      (await catalog.listContinueWatching?.(10))?.some((r) => r.itemKey === 'wb:movie:403'),
    ).toBe(false);

    // Clear progress removes row
    await catalog.clearProgress?.('wb:movie:403');
    expect(await catalog.getProgress?.('wb:movie:403')).toBeNull();

    // Toggle favorite off and back on
    const off = await catalog.toggleFavorite?.({
      sourceId: 'workbench-demo',
      itemKey: 'wb:movie:402',
      kind: 'movie',
      title: 'Orbital Nine',
    });
    expect(off).toEqual({ ok: true, value: false });
    expect(await catalog.listFavoriteKeys?.()).toEqual(['wb:movie:503']);
  });

  it('supports in-memory add, import, and remove source operations including user-state cleanup', async () => {
    const catalog = createWorkbenchCatalog();
    const added = await catalog.addSource({
      kind: 'm3u',
      name: 'Temp List',
      playlistUrl: 'http://example.invalid/list.m3u',
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const imported = await catalog.importSource(added.value.id);
    expect(imported.ok).toBe(true);

    await catalog.saveProgress?.({
      sourceId: added.value.id,
      itemKey: `wb:temp:1`,
      kind: 'movie',
      title: 'Temp Film',
      positionMs: 25_000,
      durationMs: 100_000,
    });
    await catalog.toggleFavorite?.({
      sourceId: added.value.id,
      itemKey: `wb:temp:1`,
      kind: 'movie',
      title: 'Temp Film',
    });

    const removed = await catalog.removeSource(added.value.id);
    expect(removed.ok).toBe(true);
    expect(await catalog.listSources()).toHaveLength(1);
    expect(await catalog.getProgress?.('wb:temp:1')).toBeNull();
    expect((await catalog.listFavoriteKeys?.())?.includes('wb:temp:1')).toBe(false);
  });

  it('supports folded prefix search across live, epg, movies, series, and episodes with credits attribution, scope, sourceId, and limit filtering', async () => {
    const catalog = createWorkbenchCatalog();
    const nowMs = Date.UTC(2026, 10, 21, 14, 20, 0);

    // Empty / punctuation-only returns empty sets
    expect(await catalog.search?.('   ')).toEqual({
      live: [],
      epg: [],
      movies: [],
      series: [],
      episodes: [],
    });
    expect(await catalog.search?.('meridian', { limit: 0 })).toEqual({
      live: [],
      epg: [],
      movies: [],
      series: [],
      episodes: [],
    });

    // Cross-kind search ("Meridian" appears in live 'Meridian Business', EPG 'Glass Meridian', and movie 'Glass Meridian')
    const cross = await catalog.search?.('MERİDİAN', { nowMs });
    expect(cross?.live.map((i) => i.name)).toEqual(['Meridian Business']);
    expect(cross?.epg.length).toBeGreaterThan(0);
    expect(cross?.movies.map((i) => i.name)).toEqual(['Glass Meridian']);
    expect(cross?.movies[0]?.matchedBy).toBe('title');
    expect(cross?.series).toEqual([]);

    // Cast & director credit matching (#397)
    const castHit = await catalog.search?.('Defne Yıldız', { scope: 'movie' });
    expect(castHit?.movies.map((m) => ({ name: m.name, matchedBy: m.matchedBy }))).toEqual([
      { name: 'Orbital Nine', matchedBy: 'cast' },
    ]);
    const directorHit = await catalog.search?.('Aylin Şahin', { scope: 'movie' });
    expect(directorHit?.movies.map((m) => ({ name: m.name, matchedBy: m.matchedBy }))).toEqual([
      { name: 'Orbital Nine', matchedBy: 'director' },
    ]);

    // Scope filtering
    const movieOnly = await catalog.search?.('merid', { scope: 'movie' });
    expect(movieOnly?.live).toEqual([]);
    expect(movieOnly?.epg).toEqual([]);
    expect(movieOnly?.movies.map((i) => i.name)).toEqual(['Glass Meridian']);
    expect(movieOnly?.series).toEqual([]);
    expect(movieOnly?.episodes).toEqual([]);

    const epgOnly = await catalog.search?.('Radar', { scope: 'epg', nowMs });
    expect(epgOnly?.epg.length).toBeGreaterThan(0);
    expect(epgOnly?.epg[0]?.title).toContain('Radar');
    expect(epgOnly?.live).toEqual([]);

    const episodeOnly = await catalog.search?.('Night Crossing', { scope: 'episode' });
    expect(episodeOnly?.episodes.length).toBeGreaterThan(0);
    expect(episodeOnly?.episodes[0]?.title).toBe('Night Crossing');
    expect(episodeOnly?.movies).toEqual([]);

    const seriesOnly = await catalog.search?.('north sig', { scope: 'series' });
    expect(seriesOnly?.series.map((i) => i.name)).toEqual(['Northern Signal']);

    // Limit & sourceId filtering
    const limited = await catalog.search?.('a', { scope: 'live', limit: 1 });
    expect(limited?.live.length).toBeLessThanOrEqual(1);
    expect(await catalog.search?.('meridian', { sourceId: 'nonexistent-source' })).toEqual({
      live: [],
      epg: [],
      movies: [],
      series: [],
      episodes: [],
    });
  });

  it('provides searchSuggestions and alphabetIndex buckets aligned with alphabetical sorting (#397, #407)', async () => {
    const catalog = createWorkbenchCatalog();
    const suggestions = await catalog.searchSuggestions?.({ limit: 8 });
    expect(suggestions?.length).toBe(8);
    expect(suggestions?.some((s) => s.kind === 'favorite' && s.label === 'Orbital Nine')).toBe(
      true,
    );
    expect(suggestions?.some((s) => s.kind === 'recent')).toBe(true);
    expect(suggestions?.some((s) => s.kind === 'category')).toBe(true);
    expect(await catalog.searchSuggestions?.({ limit: 0 })).toEqual([]);

    const movieBuckets = await catalog.alphabetIndex?.({ kind: 'movie' });
    expect(movieBuckets).toEqual([
      { letter: 'E', offset: 0, count: 1 },
      { letter: 'G', offset: 1, count: 1 },
      { letter: 'H', offset: 2, count: 1 },
      { letter: 'O', offset: 3, count: 1 },
      { letter: 'P', offset: 4, count: 1 },
      { letter: 'S', offset: 5, count: 1 },
      { letter: 'W', offset: 6, count: 1 },
    ]);
    const sortedMovies = await catalog.allSourcesItems?.('movie', 0, 50, undefined, {
      sortBy: 'alpha',
    });
    expect(sortedMovies?.map((m) => m.name.charAt(0))).toEqual(['E', 'G', 'H', 'O', 'P', 'S', 'W']);
  });

  it('provides synthetic multi-hour EPG schedules for all 10 workbench live channels, channelByNumber, and importGuide', async () => {
    const catalog = createWorkbenchCatalog();
    const sources = await catalog.listSources();
    const srcId = sources[0]?.id ?? '';
    const liveCats = await catalog.categories(srcId, 'live');
    const allLive = (await Promise.all(liveCats.map((c) => catalog.items(c.id, 0, 50)))).flat();
    expect(allLive).toHaveLength(10);

    const nowMs = Date.UTC(2026, 10, 21, 14, 20, 0);
    const keys = allLive.map((c) => c.key);

    // nowNext returns active now + upcoming next for every workbench live channel
    const nn = await catalog.nowNext?.(keys, nowMs);
    expect(nn).toHaveLength(10);
    for (const entry of nn ?? []) {
      const { now, next } = entry;
      expect(now).not.toBeNull();
      expect(next).not.toBeNull();
      if (!now || !next) continue;
      expect(now.start).toBeLessThanOrEqual(nowMs);
      expect(now.stop).toBeGreaterThan(nowMs);
      expect(next.start).toBe(now.stop);
      const durMin = (now.stop - now.start) / 60_000;
      expect(durMin).toBeGreaterThanOrEqual(45);
      expect(durMin).toBeLessThanOrEqual(60);
      expect(now.description?.length).toBeGreaterThan(15);
    }

    // epgWindow returns overlapping multi-hour schedule consistent with nowNext
    const fromMs = nowMs - 30 * 60_000;
    const toMs = nowMs + 3 * 3_600_000;
    const win = await catalog.epgWindow?.(keys, fromMs, toMs);
    expect(Object.keys(win ?? {})).toHaveLength(10);
    for (const entry of nn ?? []) {
      const { now, next } = entry;
      if (!now || !next) continue;
      const list = win?.[entry.channelKey] ?? [];
      expect(list.length).toBeGreaterThanOrEqual(4);
      expect(list.some((p) => p.start === now.start && p.title === now.title)).toBe(true);
      expect(list.some((p) => p.start === next.start && p.title === next.title)).toBe(true);
      for (let i = 1; i < list.length; i += 1) {
        const cur = list[i];
        const prev = list[i - 1];
        expect(cur && prev && cur.start >= prev.stop).toBe(true);
      }
    }

    // channelByNumber finds workbench live channels and rejects missing/negative numbers
    expect(await catalog.channelByNumber?.(101)).toMatchObject({
      key: 'wb:live:101',
      name: 'Velvet Cinema 4K',
      num: 101,
    });
    expect(await catalog.channelByNumber?.(303, srcId)).toMatchObject({
      key: 'wb:live:303',
      name: 'Weather Pulse',
      num: 303,
    });
    expect(await catalog.channelByNumber?.(303, 'missing-source')).toBeNull();
    expect(await catalog.channelByNumber?.(999)).toBeNull();
    expect(await catalog.channelByNumber?.(-1)).toBeNull();

    // importGuide succeeds for existing sources and fails for unknown sources
    const guideOk = await catalog.importGuide?.(srcId);
    expect(guideOk?.ok).toBe(true);
    expect(await catalog.importGuide?.('unknown-source')).toMatchObject({
      ok: false,
      error: { category: 'storage' },
    });
  });
});
