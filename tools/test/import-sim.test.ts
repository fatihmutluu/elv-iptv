import {
  addSourceFromLink,
  type ImportDeps,
  importCatalog,
  importGuide,
  loadSeriesEpisodes,
  resolveTemplate,
  secretKey,
} from '@elv/data';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/sim/catalog.ts';
import { startSim } from '../src/sim/server.ts';
import {
  count,
  type Env,
  m3uSource,
  openEnv,
  playlistLink,
  redirectingClient,
  rewritingClient,
  scanForSecrets,
  xtreamSource,
} from './import-sim-helpers.ts';
import { http, SIM_CLOCK, type Sim, startTestSim } from './sources-sim-helpers.ts';

const NOW = SIM_CLOCK.getTime();
const small = buildCatalog('small', 1);
const compat = buildCatalog('compat', 1);

let sim: Sim;
const envs: Env[] = [];
beforeAll(async () => {
  sim = await startTestSim();
});
afterAll(async () => {
  await sim.close();
});

async function env(): Promise<Env> {
  const e = await openEnv();
  envs.push(e);
  return e;
}

afterEach(() => {
  const hits: unknown[] = [];
  for (const e of envs.splice(0)) {
    try {
      hits.push(...scanForSecrets(e.raw, e.forbidden));
    } finally {
      e.close();
    }
  }
  expect(hits).toEqual([]);
});

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`unexpected failure: ${JSON.stringify(r.error)}`);
  return r.value;
};

const rows = <T>(e: Env, sql: string, ...params: unknown[]): T[] =>
  e.raw.prepare(sql).all(...params) as T[];

const urlVars = (e: Env, id: string): Record<string, string> =>
  JSON.parse(e.secrets.dump()[secretKey(id, 'urlvars')] ?? '{}');

describe('demo as an Xtream source', () => {
  it('imports exactly the simulator catalog and keeps credentials out of the database', async () => {
    const e = await env();
    const id = await xtreamSource(e, sim, 'demo');
    const summary = must(await importCatalog(id, e.deps));
    expect(summary.counts).toMatchObject({
      live: small.live.length,
      movies: small.movies.length,
      series: small.series.length,
      categories: small.categories.length,
    });
    expect(await count(e.db, 'live')).toBe(small.live.length);
    expect(await count(e.db, 'movies')).toBe(small.movies.length);
    expect(await count(e.db, 'series')).toBe(small.series.length);
    expect(await count(e.db, 'categories')).toBe(small.categories.length);
    expect(await count(e.db, 'live WHERE url_template IS NOT NULL')).toBe(0);
    expect(e.secrets.dump()[secretKey(id, 'xtream')]).toContain(sim.url);
  });

  it('loads the episodes of one series on demand and keeps them across a re-import', async () => {
    const e = await env();
    const id = await xtreamSource(e, sim, 'demo');
    must(await importCatalog(id, e.deps));
    expect(await count(e.db, 'episodes')).toBe(0);
    const first = small.series[0];
    if (first === undefined) throw new Error('catalog has no series');
    const key = rows<{ key: string }>(
      e,
      'SELECT key FROM series WHERE provider_id = ?',
      String(first.id),
    )[0]?.key;
    if (key === undefined) throw new Error('series not imported');
    expect(must(await loadSeriesEpisodes(id, key, e.deps))).toBe(first.episodes.length);
    expect(await count(e.db, 'episodes')).toBe(first.episodes.length);
    must(await importCatalog(id, e.deps));
    expect(await count(e.db, 'episodes')).toBe(first.episodes.length);
  });

  it('imports the guide by id and maps every channel that has a guide id', async () => {
    const e = await env();
    const id = await xtreamSource(e, sim, 'demo');
    must(await importCatalog(id, e.deps));
    const guide = must(await importGuide(id, e.deps, { now: NOW }));
    const withGuide = small.live.filter((c) => c.epgId !== null).length;
    expect(guide.counts).toMatchObject({ guideChannels: withGuide, mapped: withGuide });
    expect(await count(e.db, 'channel_guide')).toBe(withGuide);
    expect(await count(e.db, 'programmes')).toBeGreaterThan(withGuide);
    expect(await count(e.db, 'programmes_next')).toBe(0);
    expect(await count(e.db, 'programmes WHERE stop <= start')).toBe(0);
  });
});

describe('demo as an M3U source', () => {
  it('imports the playlist with credentials as template placeholders', async () => {
    const e = await env();
    const id = await m3uSource(e, sim, 'demo');
    const summary = must(await importCatalog(id, e.deps));
    expect(summary.counts).toMatchObject({
      live: small.live.length,
      movies: small.movies.length,
      episodes: small.series.reduce((n, s) => n + s.episodes.length, 0),
    });
    const [row] = rows<{ url_template: string }>(
      e,
      'SELECT url_template FROM live ORDER BY num LIMIT 1',
    );
    expect(row?.url_template).toBe(`${sim.url}/live/{{user}}/{{pass}}/1001.ts`);
    expect(resolveTemplate(row?.url_template ?? '', urlVars(e, id))).toBe(
      `${sim.url}/live/demo/demo/1001.ts`,
    );
    expect(e.secrets.dump()[secretKey(id, 'playlist')]).toBe(playlistLink(sim, 'demo'));
  });

  it('discovers the guide from the playlist header and imports it', async () => {
    const e = await env();
    const id = await m3uSource(e, sim, 'demo');
    must(await importCatalog(id, e.deps));
    const guide = must(await importGuide(id, e.deps, { now: NOW }));
    expect(guide.counts.mapped).toBeGreaterThan(0);
    expect(await count(e.db, 'programmes')).toBeGreaterThan(0);
  });
});

describe('pasted playlist links', () => {
  const addDeps = (e: Env) => ({
    db: e.db,
    secrets: e.secrets,
    clock: () => 1,
    newId: () => 'link',
  });

  it('becomes an Xtream source unless asked to stay M3U, and both import', async () => {
    const e = await env();
    e.forbidden.push(playlistLink(sim, 'demo'), 'username=demo', 'password=demo');
    const asXtream = must(
      await addSourceFromLink({ name: 'Link', url: playlistLink(sim, 'demo') }, addDeps(e)),
    );
    expect(asXtream.kind).toBe('xtream');
    expect(must(await importCatalog(asXtream.id, e.deps)).counts.live).toBe(small.live.length);
    await e.db.run('DELETE FROM sources WHERE id = ?', [asXtream.id]);
    const asM3u = must(
      await addSourceFromLink(
        { name: 'Link', url: playlistLink(sim, 'demo'), keepAsM3u: true },
        addDeps(e),
      ),
    );
    expect(asM3u.kind).toBe('m3u');
    expect(must(await importCatalog(asM3u.id, e.deps)).counts.live).toBe(small.live.length);
  });
});

describe('quirks account', () => {
  it('dedupes the repeated stream id, decodes entities and keeps orphan categories', async () => {
    const e = await env();
    const id = await xtreamSource(e, sim, 'quirks');
    const summary = must(await importCatalog(id, e.deps));
    expect(summary.counts.live).toBe(small.live.length - 1);
    expect(rows(e, "SELECT 1 FROM live WHERE name = 'Channel 0002 & Co'")).toHaveLength(1);
    expect(await count(e.db, "placements WHERE kind = 'live' AND category_id = '999'")).toBe(1);
    expect(await count(e.db, "placements WHERE kind = 'movie'")).toBeGreaterThan(
      small.movies.length,
    );
    expect(await count(e.db, 'live WHERE guide_id IS NOT NULL')).toBe(5);
    expect(await count(e.db, 'live WHERE catchup_days = 3')).toBeGreaterThan(0);
  });

  it('maps guide channels without a guide id by their folded names', async () => {
    const e = await env();
    const id = await xtreamSource(e, sim, 'quirks');
    must(await importCatalog(id, e.deps));
    must(await importGuide(id, e.deps, { now: NOW }));
    expect(await count(e.db, 'channel_guide')).toBeGreaterThan(5);
    const [row] = rows<{ guide_id: string }>(
      e,
      "SELECT guide_id FROM channel_guide WHERE channel_key LIKE '%:1003'",
    );
    expect(row?.guide_id).toBe('ch1003');
  });

  it('has no constant token segment, so the playlist yields no segment rules', async () => {
    const e = await env();
    const id = await m3uSource(e, sim, 'quirks');
    must(await importCatalog(id, e.deps));
    const settings = JSON.parse(
      rows<{ settings_json: string }>(e, 'SELECT settings_json FROM sources')[0]?.settings_json ??
        '{}',
    );
    expect(settings.segmentRules ?? []).toEqual([]);
  });
});

describe('compat account', () => {
  it('lands every case: catch-up days, headers and non-HTTP URLs', async () => {
    const e = await env();
    const id = await m3uSource(e, sim, 'compat');
    const summary = must(await importCatalog(id, e.deps));
    expect(summary.counts.live).toBe(compat.live.length);
    const byNum = (n: number) =>
      rows<{ catchup_days: number | null; headers_json: string | null; url_template: string }>(
        e,
        'SELECT catchup_days, headers_json, url_template FROM live WHERE num = ?',
        n,
      )[0];
    expect(byNum(13)?.catchup_days).toBe(3);
    expect(byNum(20)?.headers_json).toContain('ELV-Compat-UA/1.0');
    expect(byNum(21)?.headers_json).toContain('referrer-check');
    expect(byNum(27)?.url_template).toMatch(/^udp:\/\//);
    expect(byNum(28)?.url_template).toMatch(/^rtp:\/\//);
    expect(byNum(29)?.url_template).toMatch(/^rtmp:\/\//);
  });

  it('templates credentials embedded in the URL authority', async () => {
    const e = await env();
    const id = await m3uSource(e, sim, 'compat');
    must(await importCatalog(id, e.deps));
    const [row] = rows<{ url_template: string }>(e, 'SELECT url_template FROM live WHERE num = 26');
    expect(row?.url_template).toBe(
      `http://{{userinfo}}@${new URL(sim.url).host}/live/{{user}}/{{pass}}/1026.ts`,
    );
    expect(urlVars(e, id).userinfo).toBe('compat:compat');
  });

  it('imports the same cases from the Xtream API', async () => {
    const e = await env();
    const id = await xtreamSource(e, sim, 'compat');
    expect(must(await importCatalog(id, e.deps)).counts.live).toBe(compat.live.length);
    must(await importGuide(id, e.deps, { now: NOW }));
    expect(await count(e.db, 'channel_guide')).toBeGreaterThan(0);
  });
});

describe('failing sources', () => {
  it('rejects an expired account before writing any row', async () => {
    const e = await env();
    const id = await xtreamSource(e, sim, 'expired');
    const result = await importCatalog(id, e.deps);
    expect(result).toEqual({ ok: false, error: { category: 'auth', code: 'account-expired' } });
    for (const table of ['live', 'movies', 'series', 'categories', 'placements']) {
      expect(await count(e.db, table)).toBe(0);
    }
    const [run] = rows<{ status: string }>(e, 'SELECT status FROM import_runs');
    expect(run?.status).toBe('failed');
  });

  it('rejects a wrong password', async () => {
    const e = await env();
    const id = await xtreamSource(e, sim, 'demo', ['not', 'the', 'password'].join('-'));
    const result = await importCatalog(id, e.deps);
    expect(result).toEqual({ ok: false, error: { category: 'auth', code: 'invalid-credentials' } });
    expect(await count(e.db, 'live')).toBe(0);
  });

  it('reports a catalog without items as empty-source and keeps the previous one', async () => {
    const e = await env();
    const id = await xtreamSource(e, sim, 'demo');
    must(await importCatalog(id, e.deps));
    let emptied = http;
    for (const action of ['get_live_streams', 'get_vod_streams', 'get_series']) {
      emptied = rewritingClient(emptied, action, () => []);
    }
    const result = await importCatalog(id, { ...e.deps, http: emptied });
    expect(result).toEqual({
      ok: false,
      error: { category: 'source-format', code: 'empty-source' },
    });
    expect(await count(e.db, 'live')).toBe(small.live.length);
  });

  it('refuses a second running import of the same source', async () => {
    const e = await env();
    const id = await xtreamSource(e, sim, 'demo');
    const results = await Promise.all([importCatalog(id, e.deps), importCatalog(id, e.deps)]);
    expect(results.filter((r) => !r.ok)).toEqual([
      { ok: false, error: { category: 'storage', code: 'import-in-progress' } },
    ]);
    expect(await count(e.db, 'live')).toBe(small.live.length);
  });
});

describe('re-imports', () => {
  it('removes rows the provider dropped and keeps the ids of the others', async () => {
    const e = await env();
    const id = await xtreamSource(e, sim, 'demo');
    must(await importCatalog(id, e.deps));
    const idOf = (n: number) =>
      rows<{ id: number }>(e, 'SELECT id FROM live WHERE num = ?', n)[0]?.id;
    const keptId = idOf(11);
    const trimmed = rewritingClient(
      rewritingClient(http, 'get_live_streams', (r) => r.slice(10)),
      'get_vod_streams',
      (r) => r.slice(5),
    );
    must(await importCatalog(id, { ...e.deps, http: trimmed }));
    expect(await count(e.db, 'live')).toBe(small.live.length - 10);
    expect(await count(e.db, 'movies')).toBe(small.movies.length - 5);
    expect(await count(e.db, "placements WHERE kind = 'live'")).toBe(small.live.length - 10);
    expect(idOf(11)).toBe(keptId);
    expect(await count(e.db, 'live WHERE run_id < 2')).toBe(0);
  });

  it('applies the changes of another simulator seed and keeps row ids', async () => {
    const other = await startSim({ port: 0, ffmpegPath: null, clock: SIM_CLOCK, seed: 2 });
    try {
      const e = await env();
      const id = await xtreamSource(e, sim, 'demo');
      must(await importCatalog(id, e.deps));
      const movie = () =>
        rows<{ id: number; added: number }>(
          e,
          'SELECT id, added FROM movies ORDER BY id LIMIT 1',
        )[0];
      const before = movie();
      const moved: ImportDeps = { ...e.deps, http: redirectingClient(http, sim.url, other.url) };
      must(await importCatalog(id, moved));
      const after = movie();
      expect(after?.id).toBe(before?.id);
      expect(after?.added).not.toBe(before?.added);
      expect(await count(e.db, 'movies')).toBe(small.movies.length);
    } finally {
      await other.close();
    }
  });

  it('keeps the old guide when a guide run fails and swaps in the new one on success', async () => {
    const e = await env();
    const id = await xtreamSource(e, sim, 'demo');
    must(await importCatalog(id, e.deps));
    must(await importGuide(id, e.deps, { now: NOW }));
    const programmes = await count(e.db, 'programmes');
    const broken = redirectingClient(http, '/xmltv.php', '/no-such-guide');
    const result = await importGuide(id, { ...e.deps, http: broken }, { now: NOW });
    expect(result.ok).toBe(false);
    expect(await count(e.db, 'programmes')).toBe(programmes);
    must(await importGuide(id, e.deps, { now: NOW }));
    expect(await count(e.db, 'programmes')).toBe(programmes);
    expect(await count(e.db, 'programmes_next')).toBe(0);
  });
});

describe('cancellation', () => {
  it('leaves the previous catalog intact', async () => {
    const e = await env();
    const id = await xtreamSource(e, sim, 'demo');
    must(await importCatalog(id, e.deps));
    const controller = new AbortController();
    const trimmed = rewritingClient(http, 'get_live_streams', (r) => r.slice(10));
    const result = await importCatalog(
      id,
      { ...e.deps, http: trimmed },
      {
        signal: controller.signal,
        batchSize: 5,
        onProgress: (p) => {
          if (p.phase === 'live' && p.done >= 10) controller.abort();
        },
      },
    );
    expect(result).toEqual({ ok: false, error: { category: 'network', code: 'aborted' } });
    expect(await count(e.db, 'live')).toBe(small.live.length);
    expect(await count(e.db, 'live WHERE run_id = 1')).toBeGreaterThanOrEqual(10);
    const statuses = rows<{ status: string }>(e, 'SELECT status FROM import_runs ORDER BY id');
    expect(statuses.map((r) => r.status)).toEqual(['ok', 'cancelled']);
  });
});

describe('secret scan', () => {
  it('finds a planted credential in any column', async () => {
    const e = await env();
    await xtreamSource(e, sim, 'demo');
    expect(scanForSecrets(e.raw, ['username=demo'])).toEqual([]);
    e.raw.prepare('UPDATE sources SET name = ?').run('see username=demo here');
    expect(scanForSecrets(e.raw, ['username=demo'])).toEqual([
      { table: 'sources', column: 'name', needle: 'username=demo' },
    ]);
    e.raw.prepare('UPDATE sources SET name = ?').run('Panel');
  });
});
