import { describe, expect, it } from 'vitest';
import {
  channelXml,
  HOUR,
  programmeXml,
  ready,
  run as runGuide,
  titles,
  tv,
} from './import-guide-test-helpers';
import { count, extinf, sampleCatalog, setup, setupM3u } from './import-test-helpers';
import { importCatalog } from './import-xtream';

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

describe('uncategorized Xtream items', () => {
  it('places items without a category in an Uncategorized category', async () => {
    const data = sampleCatalog();
    data.live.push({ num: 9, name: 'Loose', stream_id: 109 });
    const e = await setup(data);
    const summary = ok(await importCatalog(e.sourceId, e.deps));
    expect(summary.counts.categories).toBe(6);
    expect(
      await e.db.all("SELECT category_id FROM placements WHERE item_key = 'x:s1:live:109'"),
    ).toEqual([{ category_id: 'Uncategorized' }]);
    expect(
      await e.db.all("SELECT name, position FROM categories WHERE provider_id = 'Uncategorized'"),
    ).toEqual([{ name: 'Uncategorized', position: 2 }]);
  });
});

describe('a kind that comes back empty keeps its previous rows', () => {
  it('keeps the movies of an Xtream source when the movie list is empty', async () => {
    const data = sampleCatalog();
    const e = await setup(data);
    ok(await importCatalog(e.sourceId, e.deps));
    e.panel.state.data = { ...data, vod: [] };
    const summary = ok(await importCatalog(e.sourceId, e.deps));
    expect(summary.warningCodes).toEqual(['catalog/kind-empty-movie']);
    expect(await count(e.db, 'movies')).toBe(3);
    expect(await count(e.db, "placements WHERE kind = 'movie'")).toBe(4);
    expect(await count(e.db, "categories WHERE kind = 'movie'")).toBe(2);
    expect(await count(e.db, 'live')).toBe(3);
    e.panel.state.data = { ...data, vod: [data.vod[1] as Record<string, unknown>] };
    const later = ok(await importCatalog(e.sourceId, e.deps));
    expect(later.warningCodes).toEqual([]);
    expect(await count(e.db, 'movies')).toBe(1);
  });

  it('keeps the movies and series of an M3U source whose playlist lost them', async () => {
    const full =
      '#EXTM3U\n' +
      extinf('Live', 'http://cdn.example/live/a/b/1.ts', 'group-title="L"') +
      extinf('Film', 'http://cdn.example/movie/a/b/2.mkv', 'group-title="F"') +
      extinf('Show S01E01', 'http://cdn.example/series/a/b/3.mkv', 'group-title="S"');
    const e = await setupM3u(full);
    ok(await importCatalog(e.sourceId, e.deps));
    e.state.body = `#EXTM3U\n${extinf('Live', 'http://cdn.example/live/a/b/1.ts', 'group-title="L"')}`;
    const summary = ok(await importCatalog(e.sourceId, e.deps));
    expect(summary.warningCodes).toEqual(['catalog/kind-empty-movie', 'catalog/kind-empty-series']);
    expect(summary.warnings).toBe(2);
    for (const table of ['live', 'movies', 'series', 'episodes']) {
      expect(await count(e.db, table)).toBe(1);
    }
  });

  it('warns about nothing when a kind was empty before too', async () => {
    const e = await setupM3u(
      `#EXTM3U\n${extinf('Live', 'http://cdn.example/live/a/b/1.ts', 'group-title="L"')}`,
    );
    expect(ok(await importCatalog(e.sourceId, e.deps)).warningCodes).toEqual([]);
    expect(ok(await importCatalog(e.sourceId, e.deps)).warningCodes).toEqual([]);
  });
});

describe('an empty guide keeps the previous one', () => {
  it('keeps the previous programmes when a guide maps no programme', async () => {
    const e = await ready(
      tv(channelXml('haber1.tr', 'Haber Bir'), programmeXml('haber1.tr', HOUR, 1, 'Evening')),
    );
    ok(await runGuide(e));
    e.server.body = tv(channelXml('haber1.tr', 'Haber Bir'), channelXml('other', 'Other'));
    const summary = ok(await runGuide(e));
    expect(summary.warningCodes).toEqual(['guide/empty']);
    expect(await titles(e)).toEqual(['Evening']);
    expect(await count(e.db, 'channel_guide')).toBe(2);
    expect(await count(e.db, 'guide_channels')).toBe(1);
    expect(await count(e.db, 'programmes_next')).toBe(0);
  });

  it('accepts an empty first guide without a warning', async () => {
    const e = await ready(tv(channelXml('haber1.tr', 'Haber Bir')));
    const summary = ok(await runGuide(e));
    expect(summary.warningCodes).toEqual([]);
    expect(await titles(e)).toEqual([]);
  });
});
