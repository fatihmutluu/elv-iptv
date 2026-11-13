import { describe, expect, it } from 'vitest';
import { count, emptyPanel, type PanelData, sampleCatalog, setup } from './import-test-helpers';
import type { ImportProgress } from './import-types';
import { importCatalog, loadSeriesEpisodes } from './import-xtream';

type Env = Awaited<ReturnType<typeof setup>>;
type Rows = Record<string, unknown>[];

const rows = (e: Env, sql: string, p: (string | number)[] = []) =>
  e.db.all<Record<string, unknown>>(sql, p);

async function run(e: Env, opts = {}) {
  return importCatalog(e.sourceId, e.deps, opts);
}

function expectErr(
  r: { ok: boolean; error?: { category: string; code: string } },
  category: string,
  code: string,
) {
  if (r.ok || r.error === undefined) throw new Error('expected error');
  expect(r.error.category).toBe(category);
  expect(r.error.code).toBe(code);
}

describe('xtream import', () => {
  it('stores categories, items and placements', async () => {
    const e = await setup(sampleCatalog());
    const r = await run(e);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.counts).toMatchObject({ categories: 5, live: 3, movies: 3, series: 2 });
    expect(r.value.warnings).toBe(0);
    expect(await count(e.db, 'categories')).toBe(5);
    expect(await count(e.db, 'live')).toBe(3);
    expect(await count(e.db, 'movies')).toBe(3);
    expect(await count(e.db, 'series')).toBe(2);
    const live = await rows(e, 'SELECT * FROM live ORDER BY num');
    expect(live[0]).toMatchObject({
      key: 'x:s1:live:100',
      provider_id: '100',
      guide_id: 'haber1.tr',
      catchup_days: 3,
      name_fold: 'haber bir',
      url_template: null,
      headers_json: null,
      logo: 'http://img.example/1.png',
    });
    expect(live[1]).toMatchObject({ guide_id: null, catchup_days: 0 });
    const film = await rows(e, "SELECT * FROM movies WHERE provider_id = '200'");
    expect(film).toHaveLength(1);
    expect(film[0]).toMatchObject({ extension: 'mkv', rating: 7.5, url_template: null });
    const place = await rows(
      e,
      "SELECT category_id, position FROM placements WHERE kind = 'movie' AND item_key = 'x:s1:movie:200' ORDER BY category_id",
    );
    expect(place.map((p) => p.category_id)).toEqual(['10', '11']);
    const both = await rows(
      e,
      "SELECT category_id FROM placements WHERE item_key = 'x:s1:live:102' ORDER BY category_id",
    );
    expect(both.map((p) => p.category_id)).toEqual(['1', '2']);
    const order = await rows(
      e,
      "SELECT item_key FROM placements WHERE kind = 'movie' AND category_id = '10' ORDER BY position",
    );
    expect(order.map((p) => p.item_key)).toEqual(['x:s1:movie:200', 'x:s1:movie:201']);
    const run1 = await rows(e, 'SELECT status, counts_json FROM import_runs');
    expect(run1).toHaveLength(1);
    expect(run1[0]?.status).toBe('ok');
  });

  it('removes stale rows everywhere and keeps ids of kept items', async () => {
    const data = sampleCatalog();
    const e = await setup(data);
    await run(e);
    const ids = await rows(e, 'SELECT key, id FROM live');
    const keptId = ids.find((r) => r.key === 'x:s1:live:100')?.id;
    await loadSeriesEpisodes(e.sourceId, 'x:s1:series:300', e.deps);
    expect(await count(e.db, 'episodes')).toBe(2);
    e.panel.state.data = {
      ...data,
      liveCats: [data.liveCats[0] as Record<string, unknown>],
      live: [
        data.live[0] as Record<string, unknown>,
        { num: 9, name: 'New', stream_id: 150, category_id: '1' },
      ],
      vod: [data.vod[0] as Record<string, unknown>],
      vodCats: [data.vodCats[0] as Record<string, unknown>],
      series: [data.series[1] as Record<string, unknown>],
    };
    const r = await run(e);
    expect(r.ok).toBe(true);
    const live = await rows(e, 'SELECT key, id FROM live ORDER BY key');
    expect(live.map((l) => l.key)).toEqual(['x:s1:live:100', 'x:s1:live:150']);
    expect(live[0]?.id).toBe(keptId);
    expect(await count(e.db, 'categories')).toBe(3);
    expect(await count(e.db, 'movies')).toBe(1);
    expect(await count(e.db, 'series')).toBe(1);
    expect(await count(e.db, 'episodes')).toBe(0);
    const pl = await rows(e, 'SELECT item_key FROM placements ORDER BY item_key');
    expect(pl.map((p) => p.item_key)).not.toContain('x:s1:live:101');
    expect(pl.map((p) => p.item_key)).not.toContain('x:s1:movie:201');
    const runs = await rows(e, 'SELECT status FROM import_runs');
    expect(runs.map((x) => x.status)).toEqual(['ok', 'ok']);
  });

  it('keeps loaded episodes of series that stay', async () => {
    const e = await setup(sampleCatalog());
    await run(e);
    await loadSeriesEpisodes(e.sourceId, 'x:s1:series:300', e.deps);
    await run(e);
    expect(await count(e.db, 'episodes')).toBe(2);
  });

  it('keeps the previous catalog when a call fails', async () => {
    const e = await setup(sampleCatalog());
    await run(e);
    const before = await rows(e, 'SELECT key FROM movies ORDER BY key');
    const placementsBefore = await count(e.db, 'placements');
    e.panel.state.fail.set('get_vod_streams', 500);
    const r = await run(e);
    expectErr(r, 'network', 'server-error');
    expect(await rows(e, 'SELECT key FROM movies ORDER BY key')).toEqual(before);
    expect(await count(e.db, 'placements')).toBe(placementsBefore);
    expect(await count(e.db, 'live')).toBe(3);
    const runs = await rows(
      e,
      'SELECT status, error_category, error_code FROM import_runs ORDER BY id',
    );
    expect(runs[1]).toEqual({
      status: 'failed',
      error_category: 'network',
      error_code: 'server-error',
    });
    const newRun = (await rows(e, 'SELECT id FROM import_runs ORDER BY id'))[1]?.id;
    const liveRuns = await rows(e, 'SELECT DISTINCT run_id FROM live');
    expect(liveRuns).toEqual([{ run_id: newRun }]);
  });

  it('keeps the previous catalog when cancelled', async () => {
    const e = await setup(sampleCatalog());
    await run(e);
    const ctl = new AbortController();
    const before = await count(e.db, 'movies');
    const r = await run(e, {
      signal: ctl.signal,
      onProgress: (p: ImportProgress) => {
        if (p.phase === 'live') ctl.abort();
      },
    });
    expectErr(r, 'network', 'aborted');
    expect(await count(e.db, 'movies')).toBe(before);
    expect(await count(e.db, 'live')).toBe(3);
    const runs = await rows(e, 'SELECT status FROM import_runs ORDER BY id');
    expect(runs[1]?.status).toBe('cancelled');
  });

  it('cancels when the signal is already aborted', async () => {
    const e = await setup(sampleCatalog());
    const ctl = new AbortController();
    ctl.abort();
    const r = await run(e, { signal: ctl.signal });
    expectErr(r, 'network', 'aborted');
    expect(await count(e.db, 'live')).toBe(0);
  });

  it('yields between batches and reports monotonic progress', async () => {
    const data = emptyPanel();
    data.liveCats = [{ category_id: '1', category_name: 'All' }];
    data.live = Array.from({ length: 1000 }, (_, i) => ({
      num: i,
      name: `Channel ${i}`,
      stream_id: i + 1,
      category_id: '1',
    }));
    const e = await setup(data);
    const events: ImportProgress[] = [];
    const r = await run(e, { batchSize: 100, onProgress: (p: ImportProgress) => events.push(p) });
    expect(r.ok).toBe(true);
    expect(e.scheduler.count).toBeGreaterThanOrEqual(10);
    const live = events.filter((p) => p.phase === 'live');
    expect(live.length).toBeGreaterThanOrEqual(10);
    expect(live.at(-1)).toEqual({ phase: 'live', done: 1000, total: 1000 });
    const phases = new Set(events.map((p) => p.phase));
    for (const phase of phases) {
      const dones = events.filter((p) => p.phase === phase).map((p) => p.done);
      expect(dones).toEqual([...dones].sort((a, b) => a - b));
    }
    expect(events.at(-1)?.phase).toBe('cleanup');
  });

  it('falls back to per-category calls on too-large bodies', async () => {
    const reference = await setup(sampleCatalog());
    await run(reference);
    const e = await setup(sampleCatalog());
    e.panel.state.bloat.add('get_vod_streams');
    e.deps.maxBodyBytes = 1500;
    const r = await run(e);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(e.panel.state.urls.some((u) => u.includes('get_vod_streams&category_id='))).toBe(true);
    for (const table of ['movies', 'placements']) {
      const sql = `SELECT * FROM ${table} ORDER BY 1, 2, 3, 4`;
      const strip = (x: Rows) => x.map(({ id: _i, run_id: _r, ...rest }) => rest);
      expect(strip(await rows(e, sql))).toEqual(strip(await rows(reference, sql)));
    }
    expect(r.value.counts.movies).toBe(3);
  });

  it('fails the run and keeps the catalog when a per-category call fails', async () => {
    const e = await setup(sampleCatalog());
    await run(e);
    const liveBefore = await rows(e, 'SELECT key, id FROM live ORDER BY key');
    const placementsBefore = await count(e.db, 'placements');
    e.panel.state.bloat.add('get_live_streams');
    e.deps.maxBodyBytes = 800;
    e.panel.state.failWithCategory.set('get_live_streams', 500);
    const r = await run(e);
    expectErr(r, 'network', 'server-error');
    expect(e.panel.state.urls.some((u) => u.includes('get_live_streams&category_id='))).toBe(true);
    expect(await rows(e, 'SELECT key, id FROM live ORDER BY key')).toEqual(liveBefore);
    expect(await count(e.db, 'placements')).toBe(placementsBefore);
    expect(await count(e.db, 'movies')).toBe(3);
    const runs = await rows(e, 'SELECT status, error_code FROM import_runs ORDER BY id');
    expect(runs[1]).toEqual({ status: 'failed', error_code: 'server-error' });
  });

  it('fails before any catalog write on account errors', async () => {
    const data = sampleCatalog();
    data.user = { auth: 0 };
    const e = await setup(data);
    expectErr(await run(e), 'auth', 'invalid-credentials');
    expect(await count(e.db, 'categories')).toBe(0);
    expect((await rows(e, 'SELECT status FROM import_runs'))[0]?.status).toBe('failed');
    e.panel.state.data.user = { auth: 1, status: 'Expired' };
    expectErr(await run(e), 'auth', 'account-expired');
    expect(await count(e.db, 'categories')).toBe(0);
  });

  it('reports unknown sources, m3u sources and missing secrets', async () => {
    const e = await setup(sampleCatalog());
    expectErr(await importCatalog('nope', e.deps), 'storage', 'source-not-found');
    await e.secrets.delete('source:s1:xtream');
    expectErr(await run(e), 'storage', 'secret-missing');
    await e.db.run("INSERT INTO sources VALUES ('m', 'm3u', 'M', 1, '{}')");
    expectErr(await importCatalog('m', e.deps), 'source-format', 'unsupported-source');
  });

  it('turns a storage failure into a failed run', async () => {
    const e = await setup(sampleCatalog());
    await e.db.exec('DROP TABLE placements');
    expectErr(await run(e), 'storage', 'import-failed');
    expect((await rows(e, 'SELECT status FROM import_runs'))[0]?.status).toBe('failed');
  });

  it('puts nothing secret into the database, progress or errors', async () => {
    const e = await setup(sampleCatalog());
    const events: ImportProgress[] = [];
    await run(e, { onProgress: (p: ImportProgress) => events.push(p) });
    e.panel.state.fail.set('get_series', 500);
    const failed = await run(e);
    const secrets = ['demo-user', ['pw', 'Xyz', '19'].join('')];
    const dump = JSON.stringify(events) + JSON.stringify(failed);
    for (const table of [
      'sources',
      'import_runs',
      'categories',
      'live',
      'movies',
      'series',
      'placements',
    ]) {
      const text = JSON.stringify(await rows(e, `SELECT * FROM ${table}`));
      for (const s of secrets) expect(text).not.toContain(s);
    }
    for (const s of secrets) expect(dump).not.toContain(s);
  });

  it('survives an empty panel', async () => {
    const e = await setup(emptyPanel());
    const r = await run(e);
    expect(r.ok).toBe(true);
    expect(await count(e.db, 'live')).toBe(0);
  });
});

describe('loadSeriesEpisodes', () => {
  it('stores episodes and replaces them on a second call', async () => {
    const data: PanelData = sampleCatalog();
    const e = await setup(data);
    await run(e);
    const r = await loadSeriesEpisodes(e.sourceId, 'x:s1:series:300', e.deps);
    expect(r).toEqual({ ok: true, value: 2 });
    const eps = await rows(e, 'SELECT * FROM episodes ORDER BY episode');
    expect(eps[0]).toMatchObject({
      key: 'x:s1:episode:9001',
      series_key: 'x:s1:series:300',
      season: 1,
      episode: 1,
      title: 'Pilot',
      extension: 'mp4',
      duration_sec: 1500,
      url_template: null,
    });
    expect(eps[1]).toMatchObject({ duration_sec: null, extension: 'mkv' });
    const firstId = eps[0]?.id;
    data.seriesInfo['300'] = {
      episodes: {
        '1': [{ id: '9001', episode_num: 1, title: 'Pilot v2', container_extension: 'mp4' }],
      },
    };
    const again = await loadSeriesEpisodes(e.sourceId, 'x:s1:series:300', e.deps);
    expect(again).toEqual({ ok: true, value: 1 });
    const after = await rows(e, 'SELECT * FROM episodes');
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ title: 'Pilot v2', id: firstId });
  });

  it('reports unknown series and failures', async () => {
    const e = await setup(sampleCatalog());
    await run(e);
    const unknown = await loadSeriesEpisodes(e.sourceId, 'x:s1:series:999', e.deps);
    expectErr(unknown, 'source-format', 'unknown-series');
    expectErr(await loadSeriesEpisodes('nope', 'x', e.deps), 'storage', 'source-not-found');
    e.panel.state.fail.set('get_series_info', 500);
    expectErr(
      await loadSeriesEpisodes(e.sourceId, 'x:s1:series:300', e.deps),
      'network',
      'server-error',
    );
    expect(await count(e.db, 'episodes')).toBe(0);
    await e.secrets.delete('source:s1:xtream');
    expectErr(
      await loadSeriesEpisodes(e.sourceId, 'x:s1:series:300', e.deps),
      'storage',
      'secret-missing',
    );
  });
});
