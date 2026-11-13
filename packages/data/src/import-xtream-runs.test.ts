import { describe, expect, it } from 'vitest';
import { count, sampleCatalog, setup } from './import-test-helpers';
import type { ImportProgress } from './import-types';
import { importCatalog, loadSeriesEpisodes } from './import-xtream';
import { openCatalog } from './migrate';

type Env = Awaited<ReturnType<typeof setup>>;

const rows = (e: Env, sql: string) => e.db.all<Record<string, unknown>>(sql);
const run = (e: Env, opts = {}) => importCatalog(e.sourceId, e.deps, opts);

function expectErr(
  r: { ok: boolean; error?: { category: string; code: string } },
  category: string,
  code: string,
) {
  if (r.ok || r.error === undefined) throw new Error('expected error');
  expect(r.error.category).toBe(category);
  expect(r.error.code).toBe(code);
}

describe('import run safety', () => {
  it('refuses a concurrent import of the same source and leaves the first intact', async () => {
    const e = await setup(sampleCatalog());
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: () => void = () => undefined;
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    e.panel.state.onRequest = async (a) => {
      if (a === 'get_vod_streams') {
        reached();
        await gate;
      }
    };
    const first = run(e);
    await paused;
    const liveDuring = await count(e.db, 'live');
    expectErr(await run(e), 'storage', 'import-in-progress');
    expect(await count(e.db, 'live')).toBe(liveDuring);
    release();
    const done = await first;
    expect(done.ok).toBe(true);
    expect(await count(e.db, 'live')).toBe(3);
    const runs = await rows(e, 'SELECT status FROM import_runs ORDER BY id');
    expect(runs.map((x) => x.status)).toEqual(['ok']);
  });

  it('recovers after a crash left a running row', async () => {
    const e = await setup(sampleCatalog());
    await e.db.run(
      "INSERT INTO import_runs (source_id, kind, started_at, status) VALUES ('s1', 'catalog', 1, 'running')",
    );
    expectErr(await run(e), 'storage', 'import-in-progress');
    await openCatalog(e.db);
    expect((await run(e)).ok).toBe(true);
    const runs = await rows(e, 'SELECT status, error_code FROM import_runs ORDER BY id');
    expect(runs).toEqual([
      { status: 'failed', error_code: 'interrupted' },
      { status: 'ok', error_code: null },
    ]);
  });

  it('ignores a throwing progress callback', async () => {
    const e = await setup(sampleCatalog());
    const r = await run(e, {
      onProgress: () => {
        throw new Error('ui exploded');
      },
    });
    expect(r.ok).toBe(true);
    expect((await rows(e, 'SELECT status FROM import_runs'))[0]?.status).toBe('ok');
    const eps = await loadSeriesEpisodes(e.sourceId, 'x:s1:series:300', e.deps, {
      onProgress: () => {
        throw new Error('ui exploded');
      },
    });
    expect(eps).toEqual({ ok: true, value: 2 });
    const last = await run(e, {
      onProgress: (p: ImportProgress) => {
        if (p.phase === 'cleanup') throw new Error('late');
      },
    });
    expect(last.ok).toBe(true);
    const runs = await rows(e, 'SELECT status FROM import_runs ORDER BY id');
    expect(runs.map((x) => x.status)).toEqual(['ok', 'ok']);
  });
});
