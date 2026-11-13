import { describe, expect, it } from 'vitest';
import { count, extinf, M3U_PASS, M3U_TOKEN, M3U_USER, setupM3u } from './import-test-helpers';
import { importCatalog } from './import-xtream';
import { getSource, updateSourceSettings } from './sources';
import { resolveTemplate, type UrlVars } from './templates';

type Env = Awaited<ReturnType<typeof setupM3u>>;

const rows = (e: Env, sql: string) => e.db.all<Record<string, unknown>>(sql);
const run = (e: Env, opts = {}) => importCatalog(e.sourceId, e.deps, opts);
const GUIDE = 'http://guide.example/epg.xml';

function big(token: string, n: number, header = `#EXTM3U url-tvg="${GUIDE}"`): string {
  let body = `${header}\n`;
  for (let i = 0; i < n; i += 1) {
    const url = `http://cdn.example:8080/${token}/hb/s/${i}.ts?username=${M3U_USER}&password=${M3U_PASS}`;
    body += extinf(`Ch ${i}`, url, 'group-title="All"');
  }
  return body;
}

async function snapshot(e: Env) {
  const source = await e.db.all<{ settings_json: string }>(
    'SELECT settings_json FROM sources WHERE id = ?',
    ['s1'],
  );
  return { settings: source[0]?.settings_json, vars: await e.secrets.get('source.s1.urlvars') };
}

async function resolvesOld(e: Env, snap: Awaited<ReturnType<typeof snapshot>>) {
  const live = await rows(e, 'SELECT url_template FROM live ORDER BY id LIMIT 1');
  const vars = JSON.parse(snap.vars ?? '{}') as UrlVars;
  expect(resolveTemplate(String(live[0]?.url_template), vars)).toContain(`${M3U_TOKEN}/hb/s/0.ts`);
}

async function imported(n = 1100) {
  const e = await setupM3u(big(M3U_TOKEN, n));
  expect((await run(e, { batchSize: 300 })).ok).toBe(true);
  const snap = await snapshot(e);
  expect(JSON.parse(snap.settings ?? '{}').discoveredGuideUrls).toHaveLength(1);
  return { e, snap };
}

const rotated = ['tok', 'Zz81p0q4m9'].join('');

describe('m3u settings and secrets commit with the run', () => {
  it('leaves settings and urlvars untouched on empty-source', async () => {
    const { e, snap } = await imported();
    e.state.body = '#EXTM3U\n';
    const r = await run(e);
    expect(!r.ok && r.error.code).toBe('empty-source');
    expect(await snapshot(e)).toEqual(snap);
    await resolvesOld(e, snap);
    expect(await count(e.db, 'live')).toBe(1100);
  });

  it('leaves them untouched on not-a-playlist', async () => {
    const { e, snap } = await imported();
    e.state.body = '<html></html>';
    expect((await run(e)).ok).toBe(false);
    expect(await snapshot(e)).toEqual(snap);
    await resolvesOld(e, snap);
  });

  it('leaves them untouched when the stream breaks after rows were written', async () => {
    const { e, snap } = await imported(2000);
    e.state.body = big(rotated, 2000);
    e.state.failAfter = 150_000;
    const r = await run(e, { batchSize: 300 });
    expect(!r.ok && r.error.code).toBe('timeout');
    expect(await snapshot(e)).toEqual(snap);
    await resolvesOld(e, snap);
  });

  it('leaves them untouched on abort and updates the token only after a later success', async () => {
    const { e, snap } = await imported();
    e.state.body = big(rotated, 1100);
    const ctl = new AbortController();
    const r = await run(e, { signal: ctl.signal, batchSize: 300, onProgress: () => ctl.abort() });
    expect(!r.ok && r.error.code).toBe('aborted');
    expect(await snapshot(e)).toEqual(snap);
    await resolvesOld(e, snap);
    expect((await run(e, { batchSize: 300 })).ok).toBe(true);
    const after = JSON.parse((await snapshot(e)).vars ?? '{}') as UrlVars;
    expect(after.v0).toBe(rotated);
  });

  it('stores no rules after a failed first run and detects them on a later success', async () => {
    const e = await setupM3u(big(M3U_TOKEN, 1100));
    const ctl = new AbortController();
    await run(e, { signal: ctl.signal, batchSize: 300, onProgress: () => ctl.abort() });
    let settings = (await getSource(e.db, 's1'))?.settings;
    expect(settings?.segmentRules).toBeUndefined();
    expect(await e.secrets.get('source.s1.urlvars')).toBe('{}');
    expect((await run(e, { batchSize: 300 })).ok).toBe(true);
    settings = (await getSource(e.db, 's1'))?.settings;
    expect(settings?.segmentRules?.length).toBeGreaterThan(0);
    for (const t of ['live', 'sources']) {
      expect(JSON.stringify(await rows(e, `SELECT * FROM ${t}`))).not.toContain(M3U_TOKEN);
    }
  });

  it('never stores an empty rule list and re-detects over a stored one', async () => {
    const tiny = await setupM3u('#EXTM3U\n');
    expect((await run(tiny)).ok).toBe(false);
    expect((await getSource(tiny.db, 's1'))?.settings.segmentRules).toBeUndefined();

    const e = await setupM3u(big(M3U_TOKEN, 5));
    const settings = (await getSource(e.db, 's1'))?.settings ?? {};
    await updateSourceSettings(e.db, 's1', { ...settings, segmentRules: [] });
    expect((await run(e)).ok).toBe(true);
    expect((await getSource(e.db, 's1'))?.settings.segmentRules?.length).toBeGreaterThan(0);
    expect(JSON.stringify(await rows(e, 'SELECT url_template FROM live'))).not.toContain(M3U_TOKEN);
  });

  it('reports secret-write-failed after an otherwise successful run', async () => {
    const e = await setupM3u(big(M3U_TOKEN, 5));
    e.secrets.set = async () => {
      throw new Error('keychain');
    };
    const r = await run(e);
    expect(!r.ok && r.error).toMatchObject({ category: 'storage', code: 'secret-write-failed' });
    expect(await count(e.db, 'live')).toBe(5);
    const runs = await rows(e, 'SELECT status FROM import_runs');
    expect(runs).toEqual([{ status: 'ok' }]);
  });

  it('puts live and movie entries without a group into the fallback category', async () => {
    const body = [
      '#EXTM3U',
      extinf('Plain Live', 'http://cdn.example:8080/a/b/c/1.ts'),
      extinf('Plain Film', 'http://cdn.example:8080/movie/x/y/2.mkv'),
      '',
    ].join('\n');
    const e = await setupM3u(body);
    expect((await run(e)).ok).toBe(true);
    const placed = await rows(e, 'SELECT kind, category_id FROM placements ORDER BY kind');
    expect(placed).toEqual([
      { kind: 'live', category_id: 'Ungrouped' },
      { kind: 'movie', category_id: 'Ungrouped' },
    ]);
    const cats = await rows(e, 'SELECT kind, name FROM categories ORDER BY kind');
    expect(cats.map((c) => c.kind)).toEqual(['live', 'movie']);
  });
});
