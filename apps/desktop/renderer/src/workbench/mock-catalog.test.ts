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
    }

    const seriesCats = await catalog.categories(srcId, 'series');
    const allSeries = (await Promise.all(seriesCats.map((c) => catalog.items(c.id, 0, 50)))).flat();
    expect(allSeries.length).toBe(3);
    for (const show of allSeries) {
      const detail = await catalog.itemDetail?.(show.key);
      expect(detail).toMatchObject({ ...show });
      expect(typeof detail?.plot).toBe('string');
      expect((detail?.plot ?? '').trim().length).toBeGreaterThan(40);
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
});
