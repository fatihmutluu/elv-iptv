import { describe, expect, it } from 'vitest';
import { fingerprintXtreamCredentials, isCredentialFingerprint } from './credential-fingerprint';
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
    expectErr(r, 'network', 'http-500');
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
      error_code: 'http-500',
    });
    const firstRun = (await rows(e, 'SELECT id FROM import_runs ORDER BY id'))[0]?.id;
    const liveRuns = await rows(e, 'SELECT DISTINCT run_id FROM live');
    expect(liveRuns).toEqual([{ run_id: firstRun }]);
    for (const next of [
      'categories_next',
      'live_next',
      'movies_next',
      'series_next',
      'episodes_next',
      'placements_next',
    ]) {
      expect(await count(e.db, next)).toBe(0);
    }
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
    expect(live.at(-1)).toMatchObject({ phase: 'live', done: 1000, total: 1000 });
    expect(live.at(-1)?.fraction).toBeGreaterThan(0);
    expect(live.at(-1)?.fraction).toBeLessThanOrEqual(1);
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
    expectErr(r, 'network', 'http-500');
    expect(e.panel.state.urls.some((u) => u.includes('get_live_streams&category_id='))).toBe(true);
    expect(await rows(e, 'SELECT key, id FROM live ORDER BY key')).toEqual(liveBefore);
    expect(await count(e.db, 'placements')).toBe(placementsBefore);
    expect(await count(e.db, 'movies')).toBe(3);
    const runs = await rows(e, 'SELECT status, error_code FROM import_runs ORDER BY id');
    expect(runs[1]).toEqual({ status: 'failed', error_code: 'http-500' });
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

  it('reports unknown sources, unsupported kinds and missing secrets', async () => {
    const e = await setup(sampleCatalog());
    expectErr(await importCatalog('nope', e.deps), 'storage', 'source-not-found');
    await e.secrets.delete('source.s1.xtream');
    expectErr(await run(e), 'storage', 'secret-missing');
    await e.db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('m', 'm3u', 'M', 1, '{}')",
    );
    expectErr(await importCatalog('m', e.deps), 'storage', 'secret-missing');
    await e.db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('o', 'other', 'O', 1, '{}')",
    );
    expectErr(await importCatalog('o', e.deps), 'source-format', 'unsupported-source');
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

  it('refuses an empty panel and keeps the previous catalog', async () => {
    const e = await setup(sampleCatalog());
    await run(e);
    e.panel.state.data = emptyPanel();
    expectErr(await run(e), 'source-format', 'empty-source');
    expect(await count(e.db, 'live')).toBe(3);
    expect(await count(e.db, 'movies')).toBe(3);
    const runs = await rows(e, 'SELECT status, error_code FROM import_runs ORDER BY id');
    expect(runs.at(-1)).toEqual({ status: 'failed', error_code: 'empty-source' });
  });

  it('persists non-secret accountMeta (isTrial and expiresAt) without storing credentials (#170)', async () => {
    const data = sampleCatalog();
    const expSec = 1_900_000_000;
    data.user = {
      auth: 1,
      status: 'Active',
      is_trial: '1',
      exp_date: String(expSec),
      allowed_output_formats: ['ts', 'm3u8'],
    };
    const e = await setup(data);
    const r = await run(e);
    expect(r.ok).toBe(true);

    const srcRows = await rows(e, 'SELECT settings_json FROM sources WHERE id = ?', [e.sourceId]);
    const parsed = JSON.parse(String(srcRows[0]?.settings_json ?? '{}')) as {
      outputFormats?: string[];
      accountMeta?: { isTrial?: boolean; expiresAt?: number };
    };
    expect(parsed.outputFormats).toEqual(['ts', 'm3u8']);
    expect(parsed.accountMeta).toEqual({ isTrial: true, expiresAt: expSec * 1_000 });
    const rawSettings = String(srcRows[0]?.settings_json ?? '');
    expect(rawSettings).not.toContain('demo-user');
    expect(rawSettings).not.toContain(['pw', 'Xyz', '19'].join(''));

    // Re-importing with non-trial and no expiry clears expiresAt cleanly
    e.panel.state.data.user = { auth: 1, status: 'Active', is_trial: '0', exp_date: null };
    expect((await run(e)).ok).toBe(true);
    const updatedRows = await rows(e, 'SELECT settings_json FROM sources WHERE id = ?', [
      e.sourceId,
    ]);
    const updated = JSON.parse(String(updatedRows[0]?.settings_json ?? '{}')) as {
      accountMeta?: { isTrial?: boolean; expiresAt?: number };
    };
    expect(updated.accountMeta).toEqual({ isTrial: false });
    expect('expiresAt' in (updated.accountMeta ?? {})).toBe(false);
  });

  it('persists non-reversible credentialFingerprint in SourceSettings during import (#265)', async () => {
    const e = await setup(sampleCatalog());
    const r = await run(e);
    expect(r.ok).toBe(true);

    const srcRows = await rows(e, 'SELECT settings_json FROM sources WHERE id = ?', [e.sourceId]);
    const rawSettings = String(srcRows[0]?.settings_json ?? '{}');
    const parsed = JSON.parse(rawSettings) as { credentialFingerprint?: string };
    const expectedFp = fingerprintXtreamCredentials(
      'http://panel.example:8080',
      'demo-user',
      ['pw', 'Xyz', '19'].join(''),
    );
    expect(isCredentialFingerprint(parsed.credentialFingerprint)).toBe(true);
    expect(parsed.credentialFingerprint).toBe(expectedFp);
    expect(rawSettings).not.toContain('panel.example');
    expect(rawSettings).not.toContain('demo-user');
    expect(rawSettings).not.toContain(['pw', 'Xyz', '19'].join(''));
  });

  it('preserves is_hidden across Xtream re-imports and leaves live/FTS5 untouched on mid-run abort (#418)', async () => {
    const e = await setup(sampleCatalog());
    expect((await run(e)).ok).toBe(true);
    await e.db.run("UPDATE live SET is_hidden = 1 WHERE key = 'x:s1:live:100'");
    await e.db.run("UPDATE movies SET is_hidden = 1 WHERE key = 'x:s1:movie:200'");
    await e.db.run("UPDATE categories SET is_hidden = 1 WHERE provider_id = '1' AND kind = 'live'");
    await e.db.run("UPDATE placements SET is_hidden = 1 WHERE item_key = 'x:s1:live:100'");

    expect((await run(e)).ok).toBe(true);
    expect(await rows(e, "SELECT is_hidden FROM live WHERE key = 'x:s1:live:100'")).toEqual([
      { is_hidden: 1 },
    ]);
    expect(await rows(e, "SELECT is_hidden FROM movies WHERE key = 'x:s1:movie:200'")).toEqual([
      { is_hidden: 1 },
    ]);
    expect(
      await rows(e, "SELECT is_hidden FROM categories WHERE provider_id = '1' AND kind = 'live'"),
    ).toEqual([{ is_hidden: 1 }]);
    expect(
      await rows(e, "SELECT is_hidden FROM placements WHERE item_key = 'x:s1:live:100'"),
    ).toEqual([{ is_hidden: 1 }]);

    const liveSnap = await rows(e, 'SELECT * FROM live ORDER BY id');
    e.panel.state.data = {
      ...sampleCatalog(),
      live: [{ num: 1, name: 'ShouldNotLeak', stream_id: 999, category_id: '1' }],
    };
    const ctl = new AbortController();
    const aborted = await run(e, {
      signal: ctl.signal,
      onProgress: (p: ImportProgress) => {
        if (p.phase === 'live') ctl.abort();
      },
    });
    expectErr(aborted, 'network', 'aborted');
    expect(await rows(e, 'SELECT * FROM live ORDER BY id')).toEqual(liveSnap);
    expect(
      await rows(e, "SELECT rowid FROM live_fts WHERE live_fts MATCH 'shouldnotleak'"),
    ).toEqual([]);
    expect(await count(e.db, 'live_next')).toBe(0);
    expect(await count(e.db, 'categories_next')).toBe(0);
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
      provider_id: '9001',
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

  it('stores the playback inputs of an episode in their own columns', async () => {
    const e = await setup(sampleCatalog());
    await run(e);
    await loadSeriesEpisodes(e.sourceId, 'x:s1:series:300', e.deps);
    const play = await rows(
      e,
      'SELECT provider_id, extension FROM episodes WHERE series_key = ? ORDER BY season, episode',
      ['x:s1:series:300'],
    );
    expect(play).toEqual([
      { provider_id: '9001', extension: 'mp4' },
      { provider_id: '9002', extension: 'mkv' },
    ]);
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
      'http-500',
    );
    expect(await count(e.db, 'episodes')).toBe(0);
    await e.secrets.delete('source.s1.xtream');
    expectErr(
      await loadSeriesEpisodes(e.sourceId, 'x:s1:series:300', e.deps),
      'storage',
      'secret-missing',
    );
  });

  it('chunks episode batches atomically without yielding inside the write transaction, then yields after commit', async () => {
    const data = sampleCatalog();
    data.seriesInfo['300'] = {
      seasons: [{ season_number: 1 }],
      episodes: {
        '1': Array.from({ length: 25 }, (_, i) => ({
          id: String(9000 + i),
          episode_num: i + 1,
          title: `Ep ${i + 1}`,
          container_extension: 'mp4',
        })),
      },
    };
    const e = await setup(data);
    await run(e);

    const events: string[] = [];
    const wrappedDb = {
      ...e.db,
      transaction: <T>(fn: (tx: typeof e.db) => Promise<T>) =>
        e.db.transaction(async (tx) => {
          events.push('tx-start');
          try {
            return await fn({
              ...tx,
              batch: async (sql, batchRows) => {
                if (sql.includes('INSERT INTO episodes')) events.push('batch');
                return tx.batch(sql, batchRows);
              },
            });
          } finally {
            events.push('tx-end');
          }
        }),
    };
    const scheduler = {
      yieldNow: async () => {
        events.push('yield');
      },
    };
    const r = await loadSeriesEpisodes(
      e.sourceId,
      'x:s1:series:300',
      { ...e.deps, db: wrappedDb, scheduler },
      { batchSize: 10 },
    );
    expect(r).toEqual({ ok: true, value: 25 });
    expect(events).toEqual(['tx-start', 'batch', 'batch', 'batch', 'tx-end', 'yield']);
    expect(await count(e.db, 'episodes')).toBe(25);
  });
});
