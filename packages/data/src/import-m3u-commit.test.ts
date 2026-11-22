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

  it('fails closed with secret-write-failed before SQLite commit when SecretStore.set throws', async () => {
    const first = await setupM3u(big(M3U_TOKEN, 5));
    first.secrets.set = async () => {
      throw new Error('keychain');
    };
    const r1 = await run(first);
    expect(!r1.ok && r1.error).toMatchObject({ category: 'storage', code: 'secret-write-failed' });
    expect(await count(first.db, 'live')).toBe(0);
    expect(await rows(first, 'SELECT status, error_code FROM import_runs')).toEqual([
      { status: 'failed', error_code: 'secret-write-failed' },
    ]);

    const { e, snap } = await imported(10);
    const oddHost = `http://late.example/${rotated}/99.ts`;
    e.state.body = `${big(rotated, 10)}${extinf('New Host Ch', oddHost, 'group-title="All"')}`;
    const realSet = e.secrets.set.bind(e.secrets);
    e.secrets.set = async () => {
      throw new Error('keychain');
    };
    const r2 = await run(e, { batchSize: 3 });
    expect(!r2.ok && r2.error).toMatchObject({ category: 'storage', code: 'secret-write-failed' });
    expect(await snapshot(e)).toEqual(snap);
    expect(await count(e.db, 'live')).toBe(10);
    await resolvesOld(e, snap);
    const runs = await rows(e, 'SELECT status FROM import_runs ORDER BY id');
    expect(runs).toEqual([{ status: 'ok' }, { status: 'failed' }]);
    e.secrets.set = realSet;
  });

  it('stages merged urlvars before cleanup commit and prunes stale keys after commit', async () => {
    const extra = ['tok', 'Extra11111'].join('');
    const e = await setupM3u(
      `${big(M3U_TOKEN, 50)}${extinf('Extra', `http://cdn.example:8080/${extra}/hb/s/999.ts`, 'group-title="All"')}`,
    );
    expect((await run(e)).ok).toBe(true);
    const beforeRefresh = JSON.parse((await e.secrets.get('source.s1.urlvars')) ?? '{}') as UrlVars;
    expect(beforeRefresh['v0~1']).toBe(extra);

    const writes: UrlVars[] = [];
    const realSet = e.secrets.set.bind(e.secrets);
    e.secrets.set = async (k, v) => {
      if (k === 'source.s1.urlvars') writes.push(JSON.parse(v) as UrlVars);
      await realSet(k, v);
    };
    e.state.body = big(rotated, 50);
    expect((await run(e)).ok).toBe(true);
    expect(writes.length).toBeGreaterThanOrEqual(2);
    expect(writes[0]?.['v0~1']).toBe(extra);
    expect(writes[0]?.v0).toBe(rotated);
    expect(writes.at(-1)?.['v0~1']).toBeUndefined();
    expect(writes.at(-1)?.v0).toBe(rotated);
  });

  it('shards urlvars above 64 KiB for 10,000+ unique per-channel tokens and resolves streams cleanly (#430)', async () => {
    let huge = '#EXTM3U\n';
    const total = 10_050;
    for (let i = 0; i < total; i += 1) {
      const perStreamToken = `tok_${i.toString().padStart(6, '0')}_${'x'.repeat(28)}`;
      huge += extinf(`Ch ${i}`, `http://perstream.example/play/${i}.m3u8?token=${perStreamToken}`);
    }
    const e = await setupM3u(huge);
    const r = await run(e, { batchSize: 1000 });
    expect(r.ok).toBe(true);
    expect(await count(e.db, 'live')).toBe(total);

    const dump = e.secrets.dump();
    const manifest = JSON.parse(dump['source.s1.urlvars'] ?? '{}') as { __chunks?: number };
    expect(manifest.__chunks).toBeGreaterThan(5);
    for (let i = 0; i < (manifest.__chunks ?? 0); i += 1) {
      expect(dump[`source.s1.urlvars.${i}`]).toBeDefined();
    }

    // Verify stream resolution across shards (first and last channel)
    const { createPlaytimeResolverCache } = await import('./stream-resolver');
    const cache = createPlaytimeResolverCache({ db: e.db, secrets: e.secrets, http: e.deps.http });
    const sampleLive = await rows(
      e,
      "SELECT key, name FROM live WHERE name IN ('Ch 0', 'Ch 10049') ORDER BY name",
    );
    const r0 = await cache.resolveStream(String(sampleLive[0]?.key));
    const rLast = await cache.resolveStream(String(sampleLive[1]?.key));
    expect(r0.ok && r0.value.url).toBe(
      `http://perstream.example/play/0.m3u8?token=tok_000000_${'x'.repeat(28)}`,
    );
    expect(rLast.ok && rLast.value.url).toBe(
      `http://perstream.example/play/10049.m3u8?token=tok_010049_${'x'.repeat(28)}`,
    );

    // Re-importing a small playlist shrinks shards back to single-key storage cleanly.
    e.state.body = big(rotated, 10);
    expect((await run(e)).ok).toBe(true);
    expect(Object.keys(e.secrets.dump()).filter((k) => k.startsWith('source.s1.urlvars'))).toEqual([
      'source.s1.urlvars',
    ]);
  });

  it('fails closed with urlvars-too-large above the sharded ceiling and preserves prior catalog and urlvars (#430)', async () => {
    const { e, snap } = await imported(20);
    // An entry whose extracted secret exceeds URLVARS_CHUNK_BYTES (60,000 B) cannot fit in any shard and fails closed
    const oversizedToken = `tok_${'z'.repeat(60_050)}`;
    e.state.body =
      '#EXTM3U\n' +
      extinf('Huge 0', `http://perstream.example/play/0.m3u8?token=${oversizedToken}`);
    const r = await run(e, { batchSize: 50 });
    expect(!r.ok && r.error).toMatchObject({
      category: 'source-format',
      code: 'urlvars-too-large',
    });
    expect(await snapshot(e)).toEqual(snap);
    expect(await count(e.db, 'live')).toBe(20);
    await resolvesOld(e, snap);
    const runs = await rows(e, 'SELECT status, error_code FROM import_runs ORDER BY id');
    expect(runs.at(-1)).toEqual({ status: 'failed', error_code: 'urlvars-too-large' });
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
