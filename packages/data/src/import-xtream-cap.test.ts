import { describe, expect, it } from 'vitest';
import { count, sampleCatalog, setup } from './import-test-helpers';
import { importCatalog, loadSeriesEpisodes } from './import-xtream';

type Env = Awaited<ReturnType<typeof setup>>;
type Rows = Record<string, unknown>[];

const rows = (e: Env, sql: string) => e.db.all<Record<string, unknown>>(sql);
const calls = (e: Env, part: string) => e.panel.state.urls.filter((u) => u.includes(part)).length;
const strip = (x: Rows) => x.map(({ id: _i, run_id: _r, ...rest }) => rest);

describe('Xtream bodies over the device cap', () => {
  it('retries a category over the cap once without it and stores the same rows', async () => {
    const reference = await setup(sampleCatalog());
    await importCatalog(reference.sourceId, reference.deps);
    const e = await setup(sampleCatalog());
    e.panel.state.bloat.add('get_vod_streams');
    e.panel.state.bloatCategory.add('get_vod_streams');
    e.deps.maxBodyBytes = 600;
    const r = await importCatalog(e.sourceId, e.deps);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(calls(e, 'get_vod_streams&category_id=10')).toBe(2);
    expect(calls(e, 'get_vod_streams&category_id=11')).toBe(2);
    expect(calls(e, 'get_live_streams&category_id=')).toBe(0);
    for (const table of ['movies', 'placements']) {
      const sql = `SELECT * FROM ${table} ORDER BY 1, 2, 3, 4`;
      expect(strip(await rows(e, sql))).toEqual(strip(await rows(reference, sql)));
    }
  });

  it('keeps per-category calls under the cap on the first try', async () => {
    const e = await setup(sampleCatalog());
    e.panel.state.bloat.add('get_vod_streams');
    e.deps.maxBodyBytes = 1500;
    const r = await importCatalog(e.sourceId, e.deps);
    expect(r.ok).toBe(true);
    expect(calls(e, 'get_vod_streams&category_id=10')).toBe(1);
  });

  it('fails the run when the retried category fails for another reason', async () => {
    const e = await setup(sampleCatalog());
    e.panel.state.bloat.add('get_vod_streams');
    e.panel.state.bloatCategory.add('get_vod_streams');
    e.deps.maxBodyBytes = 600;
    let vodCalls = 0;
    e.panel.state.onRequest = (action) => {
      if (action === 'get_vod_streams' && ++vodCalls === 3) {
        e.panel.state.failWithCategory.set('get_vod_streams', 503);
      }
    };
    const r = await importCatalog(e.sourceId, e.deps);
    expect(r).toMatchObject({ ok: false, error: { category: 'network', code: 'http-503' } });
    expect(await count(e.db, 'movies')).toBe(0);
  });

  it('loads the episodes of a series whose info is over the cap', async () => {
    const e = await setup(sampleCatalog());
    await importCatalog(e.sourceId, e.deps);
    e.panel.state.bloat.add('get_series_info');
    e.deps.maxBodyBytes = 1000;
    const r = await loadSeriesEpisodes(e.sourceId, 'x:s1:series:300', e.deps);
    expect(r).toEqual({ ok: true, value: 2 });
    expect(calls(e, 'get_series_info')).toBe(2);
    expect(await count(e.db, 'episodes')).toBe(2);
  });

  it('asks once for series info under the cap', async () => {
    const e = await setup(sampleCatalog());
    await importCatalog(e.sourceId, e.deps);
    e.deps.maxBodyBytes = 1_000_000;
    expect(await loadSeriesEpisodes(e.sourceId, 'x:s1:series:300', e.deps)).toEqual({
      ok: true,
      value: 2,
    });
    expect(calls(e, 'get_series_info')).toBe(1);
  });
});
