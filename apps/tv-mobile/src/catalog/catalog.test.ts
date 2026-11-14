import { describe, expect, it } from 'vitest';
import { buildCatalog } from '../../../../tools/src/sim/catalog.ts';
import type { CatalogService } from './catalog';
import { addAccount, type Env, env, must, useSim } from './catalog-test-env';

const small = buildCatalog('small', 1);
const sim = useSim();

async function demo(e: Env): Promise<string> {
  const id = await addAccount(e, sim.url());
  must(await e.service.importSource(id));
  return id;
}

describe('sources', () => {
  it('adds an Xtream source, imports it and lists it', async () => {
    const e = await env();
    const id = await demo(e);
    expect(await e.service.listSources()).toEqual([
      { id, kind: 'xtream', name: 'Main', createdAt: 1_000, needsImport: false },
    ]);
    const live = await e.service.categories(id, 'live');
    expect(live.length).toBeGreaterThan(0);
  });

  it('marks a source for import until an import succeeded', async () => {
    const e = await env();
    const id = await addAccount(e, sim.url());
    expect((await e.service.listSources())[0]?.needsImport).toBe(true);
    const controller = new AbortController();
    controller.abort();
    await e.service.importSource(id, { signal: controller.signal });
    expect((await e.service.listSources())[0]?.needsImport).toBe(true);
    must(await e.service.importSource(id));
    expect((await e.service.listSources())[0]?.needsImport).toBe(false);
  });

  it('adds a source from a pasted link', async () => {
    const e = await env();
    const link = `${sim.url()}/get.php?username=demo&password=demo&type=m3u_plus&output=ts`;
    const added = must(await e.service.addSourceFromLink({ name: 'Linked', url: link }));
    expect(added.kind).toBe('xtream');
    expect(must(await e.service.importSource(added.id)).counts.live).toBe(small.live.length);
  });

  it('binds the abort signal around an import and detaches it afterwards', async () => {
    const e = await env();
    const controller = new AbortController();
    const id = await addAccount(e, sim.url());
    must(await e.service.importSource(id, { signal: controller.signal }));
    expect(e.setAbortSignal.mock.calls).toEqual([[controller.signal], [undefined]]);
  });

  it('detaches the abort signal when the import fails', async () => {
    const e = await env();
    await e.service.importSource('missing');
    expect(e.setAbortSignal.mock.calls.at(-1)).toEqual([undefined]);
  });
});

describe('paged reads', () => {
  it('pages items in provider order without gaps or overlap', async () => {
    const e = await env();
    const id = await demo(e);
    const cats = await e.service.categories(id, 'live');
    const big = [...cats].sort((a, b) => b.itemCount - a.itemCount)[0];
    if (big === undefined) throw new Error('no category');
    const all = await e.service.items(big.id, 0, 500);
    expect(all).toHaveLength(big.itemCount);
    const paged = [];
    for (let offset = 0; offset < all.length; offset += 2) {
      paged.push(...(await e.service.items(big.id, offset, 2)));
    }
    expect(paged.map((i) => i.key)).toEqual(all.map((i) => i.key));
    expect(all[0]).toMatchObject({ kind: 'live', name: expect.any(String) });
    const nums = all.map((i) => i.num ?? 0);
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
  });

  it('orders categories by provider position and caps the page size at 500', async () => {
    const e = await env();
    const id = await demo(e);
    const cats = await e.service.categories(id, 'movie');
    expect(cats.map((c) => c.position)).toEqual(
      [...cats.map((c) => c.position)].sort((a, b) => a - b),
    );
    const first = cats[0];
    if (first === undefined) throw new Error('no category');
    expect(await e.service.items(first.id, 0, 100_000)).toHaveLength(first.itemCount);
    expect(await e.service.items(first.id, 0, 0)).toEqual([]);
    expect(await e.service.items('nope|live|x', 0, 10)).toEqual([]);
  });

  it('lists seasons and episodes of a series, loading them on first use', async () => {
    const e = await env();
    const id = await demo(e);
    const cat = (await e.service.categories(id, 'series'))[0];
    if (cat === undefined) throw new Error('no series category');
    const series = (await e.service.items(cat.id, 0, 500))[0];
    if (series === undefined) throw new Error('no series');
    expect(e.raw.prepare('SELECT COUNT(*) AS n FROM episodes').get()).toEqual({ n: 0 });
    const seasons = must(await e.service.seasons(series.id));
    const expected = small.series.find((s) => String(s.id) === series.providerId);
    expect(seasons.reduce((n, s) => n + s.episodeCount, 0)).toBe(expected?.episodes.length);
    const first = seasons[0];
    if (first === undefined) throw new Error('no season');
    const eps = await e.service.episodes(series.id, first.season);
    expect(eps).toHaveLength(first.episodeCount);
    const numbers = eps.map((x) => x.episode ?? 0);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  });

  it('reports an unknown series', async () => {
    const e = await env();
    await demo(e);
    const r = await e.service.seasons(999_999);
    expect(r).toMatchObject({ ok: false, error: { code: 'item-not-found' } });
  });
});

describe('re-import', () => {
  it('keeps content keys and row ids', async () => {
    const e = await env();
    const id = await demo(e);
    const before = e.raw.prepare('SELECT id, key FROM movies ORDER BY id').all();
    expect(before.length).toBe(small.movies.length);
    must(await e.service.importSource(id));
    expect(e.raw.prepare('SELECT id, key FROM movies ORDER BY id').all()).toEqual(before);
  });

  it('cancelling an import keeps the previous catalog', async () => {
    const e = await env();
    const id = await demo(e);
    const before = e.raw.prepare('SELECT id, key FROM live ORDER BY id').all();
    const controller = new AbortController();
    const r = await e.service.importSource(id, {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    expect(r.ok).toBe(false);
    expect(e.raw.prepare('SELECT id, key FROM live ORDER BY id').all()).toEqual(before);
    expect(e.raw.prepare('SELECT COUNT(*) AS n FROM movies').get()).toEqual({
      n: small.movies.length,
    });
  });
});

describe('remove', () => {
  it('refuses to remove a source during an import', async () => {
    const e = await env();
    const id = await demo(e);
    let removal: ReturnType<CatalogService['removeSource']> | undefined;
    const r = await e.service.importSource(id, {
      onProgress: () => {
        removal ??= e.service.removeSource(id);
      },
    });
    expect(r.ok).toBe(true);
    expect(await removal).toMatchObject({ ok: false, error: { code: 'import-in-progress' } });
    expect(await e.service.listSources()).toHaveLength(1);
  });

  it('deletes rows and secrets', async () => {
    const e = await env();
    const id = await demo(e);
    must(await e.service.removeSource(id));
    expect(await e.service.listSources()).toEqual([]);
    for (const table of ['live', 'movies', 'series', 'categories', 'placements', 'import_runs']) {
      expect(e.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    expect(e.secrets.dump()).toEqual({});
  });
});

describe('resolveStream', () => {
  it('rebuilds an Xtream URL with credentials from the secrets', async () => {
    const e = await env();
    const id = await demo(e);
    const row = e.raw.prepare('SELECT key, provider_id FROM live ORDER BY id LIMIT 1').get() as {
      key: string;
      provider_id: string;
    };
    const request = must(await e.service.resolveStream(row.key));
    expect(request.url).toBe(`${sim.url()}/live/demo/demo/${row.provider_id}.ts`);
    expect(request.headers).toEqual({});
    const movie = e.raw
      .prepare('SELECT key, provider_id, extension FROM movies ORDER BY id LIMIT 1')
      .get() as { key: string; provider_id: string; extension: string };
    expect(must(await e.service.resolveStream(movie.key)).url).toBe(
      `${sim.url()}/movie/demo/demo/${movie.provider_id}.${movie.extension}`,
    );
    expect(id).toBeTruthy();
  });

  it('resolves a loaded episode and applies transport headers', async () => {
    const e = await env();
    const added = must(
      await e.service.addSource({
        kind: 'xtream',
        name: 'Main',
        server: sim.url(),
        username: 'demo',
        password: 'demo',
        transport: { userAgent: 'UA/1', referer: 'https://ref.example/' },
      }),
    );
    must(await e.service.importSource(added.id));
    const cat = (await e.service.categories(added.id, 'series'))[0];
    const series = (await e.service.items(cat?.id ?? '', 0, 1))[0];
    must(await e.service.seasons(series?.id ?? 0));
    const ep = e.raw.prepare('SELECT key, provider_id, extension FROM episodes LIMIT 1').get() as {
      key: string;
      provider_id: string;
      extension: string;
    };
    const request = must(await e.service.resolveStream(ep.key));
    expect(request.url).toBe(`${sim.url()}/series/demo/demo/${ep.provider_id}.${ep.extension}`);
    expect(request.headers).toEqual({ 'user-agent': 'UA/1', referer: 'https://ref.example/' });
  });

  it('resolves an M3U entry from its template', async () => {
    const e = await env();
    const added = must(
      await e.service.addSource({
        kind: 'm3u',
        name: 'List',
        playlistUrl: `${sim.url()}/get.php?username=demo&password=demo&type=m3u_plus&output=ts`,
      }),
    );
    must(await e.service.importSource(added.id));
    const row = e.raw.prepare('SELECT key FROM live ORDER BY num LIMIT 1').get() as { key: string };
    expect(must(await e.service.resolveStream(row.key)).url).toBe(
      `${sim.url()}/live/demo/demo/1001.ts`,
    );
  });

  it('reports an unknown key and a missing secret', async () => {
    const e = await env();
    const id = await demo(e);
    expect(await e.service.resolveStream('x:nope:live:1')).toMatchObject({
      ok: false,
      error: { code: 'item-not-found' },
    });
    const key = (e.raw.prepare('SELECT key FROM live LIMIT 1').get() as { key: string }).key;
    await e.secrets.delete(`source.${id}.xtream`);
    expect(await e.service.resolveStream(key)).toMatchObject({
      ok: false,
      error: { code: 'secret-missing' },
    });
  });
});

describe('credentials', () => {
  it('stores no credential in any table', async () => {
    const e = await env();
    const id = await demo(e);
    const cat = (await e.service.categories(id, 'series'))[0];
    const series = (await e.service.items(cat?.id ?? '', 0, 1))[0];
    must(await e.service.seasons(series?.id ?? 0));
    const m3u = must(
      await e.service.addSource({
        kind: 'm3u',
        name: 'List',
        playlistUrl: `${sim.url()}/get.php?username=demo&password=demo&type=m3u_plus&output=ts`,
      }),
    );
    must(await e.service.importSource(m3u.id));
    const needles = ['password=demo', 'username=demo', '/demo/demo/', 'demo:demo', 'demo@'];
    const tables = e.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    const hits: string[] = [];
    for (const { name } of tables) {
      const cols = e.raw.prepare('SELECT name FROM pragma_table_info(?)').all(name) as {
        name: string;
      }[];
      for (const { name: col } of cols) {
        for (const needle of needles) {
          const sql = `SELECT 1 FROM "${name}" WHERE instr(CAST("${col}" AS TEXT), ?) > 0 LIMIT 1`;
          if (e.raw.prepare(sql).get(needle) !== undefined) hits.push(`${name}.${col}:${needle}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
