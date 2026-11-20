import { describe, expect, it } from 'vitest';
import { createWorkbenchCatalog } from './mock-catalog.ts';

describe('createWorkbenchCatalog', () => {
  it('provides synthetic live, movie, and series categories, items, seasons, episodes, and stream URLs', async () => {
    const catalog = createWorkbenchCatalog();
    const sources = await catalog.listSources();
    expect(sources).toHaveLength(1);
    const srcId = sources[0]?.id ?? '';

    const liveCats = await catalog.categories(srcId, 'live');
    expect(liveCats.length).toBeGreaterThanOrEqual(3);
    const liveItems = await catalog.items(liveCats[0]?.id ?? '', 0, 50);
    expect(liveItems.length).toBeGreaterThan(0);

    const movieCats = await catalog.categories(srcId, 'movie');
    const movies = await catalog.items(movieCats[0]?.id ?? '', 0, 50);
    expect(movies[0]?.year).toBeGreaterThan(2020);

    const seriesCats = await catalog.categories(srcId, 'series');
    const series = await catalog.items(seriesCats[0]?.id ?? '', 0, 50);
    const seriesId = series[0]?.id ?? 0;
    const seasons = await catalog.seasons(seriesId);
    expect(seasons.ok && seasons.value.length).toBe(2);
    const eps = await catalog.episodes(seriesId, 1);
    expect(eps).toHaveLength(3);

    const resolved = await catalog.resolveStream(liveItems[0]?.key ?? '');
    expect(resolved.ok).toBe(true);
  });

  it('supports in-memory add, import, and remove source operations', async () => {
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

    const removed = await catalog.removeSource(added.value.id);
    expect(removed.ok).toBe(true);
    expect(await catalog.listSources()).toHaveLength(1);
  });
});
