import { describe, expect, it } from 'vitest';
import {
  count,
  extinf,
  M3U_PASS,
  M3U_TOKEN,
  M3U_USER,
  playlistUrlFor,
  setupM3u,
} from './import-test-helpers';
import type { ImportProgress } from './import-types';
import { importCatalog } from './import-xtream';
import { getSource } from './sources';
import { resolveTemplate, type UrlVars } from './templates';

type Env = Awaited<ReturnType<typeof setupM3u>>;

const rows = (e: Env, sql: string, p: (string | number)[] = []) =>
  e.db.all<Record<string, unknown>>(sql, p);
const run = (e: Env, opts = {}) => importCatalog(e.sourceId, e.deps, opts);
const vars = async (e: Env): Promise<UrlVars> =>
  JSON.parse((await e.secrets.get('source:s1:urlvars')) ?? '{}') as UrlVars;

function expectErr(
  r: { ok: boolean; error?: { category: string; code: string } },
  category: string,
  code: string,
) {
  if (r.ok || r.error === undefined) throw new Error('expected error');
  expect(r.error.category).toBe(category);
  expect(r.error.code).toBe(code);
}

const cdn = (token: string, id: number, user = M3U_USER, pass = M3U_PASS) =>
  `http://cdn.example:8080/${token}/hb/s/${id}.ts?username=${user}&password=${pass}`;
const panel = (kind: string, id: number, user = M3U_USER, pass = M3U_PASS, ext = 'mkv') =>
  `http://panel.example:8080/${kind}/${user}/${pass}/${id}.${ext}`;

function playlist(token = M3U_TOKEN, user = M3U_USER, pass = M3U_PASS, header = '#EXTM3U'): string {
  const logo = 'tvg-logo="http://img.example/a.png"';
  return (
    `${header}\n` +
    extinf(
      'Haber Bir',
      cdn(token, 101, user, pass),
      'tvg-id="haber1.tr" tvg-chno="7" group-title="News"',
    ) +
    extinf('Spor Iki', cdn(token, 102, user, pass), 'group-title="Sports;News"') +
    extinf('Film A', panel('movie', 201, user, pass), `${logo} group-title="Films"`) +
    extinf('Show One S01E01', panel('series', 301, user, pass), 'group-title="Drama Shows"') +
    extinf('Show One S01E02', panel('series', 302, user, pass), 'group-title="Drama Shows"') +
    extinf('Other Ep', panel('series', 303, user, pass), 'group-title="Misc"')
  );
}

describe('m3u import', () => {
  it('routes entries by kind and builds synthetic series per group', async () => {
    const e = await setupM3u(playlist());
    const r = await run(e);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.counts).toMatchObject({ live: 2, movies: 1, episodes: 3, series: 2 });
    expect(await count(e.db, 'live')).toBe(2);
    expect(await count(e.db, 'movies')).toBe(1);
    expect(await count(e.db, 'episodes')).toBe(3);
    const series = await rows(e, 'SELECT key, name FROM series ORDER BY id');
    expect(series).toEqual([
      { key: 'm:s1:series:drama shows', name: 'Drama Shows' },
      { key: 'm:s1:series:misc', name: 'Misc' },
    ]);
    const eps = await rows(e, 'SELECT series_key, title FROM episodes ORDER BY id');
    expect(eps.map((x) => x.series_key)).toEqual([
      'm:s1:series:drama shows',
      'm:s1:series:drama shows',
      'm:s1:series:misc',
    ]);
    const live = await rows(e, 'SELECT name, num, guide_id FROM live ORDER BY id');
    expect(live[0]).toEqual({ name: 'Haber Bir', num: 7, guide_id: 'haber1.tr' });
  });

  it('treats every entry as a movie in a vod playlist', async () => {
    const e = await setupM3u(playlist(), { vodPlaylist: true });
    expect((await run(e)).ok).toBe(true);
    expect(await count(e.db, 'movies')).toBe(6);
    expect(await count(e.db, 'live')).toBe(0);
    expect(await count(e.db, 'episodes')).toBe(0);
  });

  it('creates categories per kind in first-seen order with several placements', async () => {
    const e = await setupM3u(playlist());
    await run(e);
    const cats = await rows(
      e,
      'SELECT kind, name, position FROM categories ORDER BY kind, position',
    );
    expect(cats.map((c) => `${c.kind}:${c.name}:${c.position}`)).toEqual([
      'live:News:0',
      'live:Sports:1',
      'movie:Films:0',
      'series:Drama Shows:0',
      'series:Misc:1',
    ]);
    const spor = await rows(
      e,
      "SELECT category_id FROM placements WHERE kind = 'live' AND item_key LIKE '%102.ts%' ORDER BY category_id",
    );
    expect(spor.map((p) => p.category_id)).toEqual(['News', 'Sports']);
    const news = await rows(
      e,
      "SELECT position FROM placements WHERE kind = 'live' AND category_id = 'News' ORDER BY position",
    );
    expect(news.map((p) => p.position)).toEqual([0, 1]);
    expect(await rows(e, "SELECT 1 FROM placements WHERE kind = 'series'")).toHaveLength(2);
  });

  it('stores templates, detects segment rules once and resolves back to the original URL', async () => {
    const e = await setupM3u(playlist());
    await run(e);
    const source = await getSource(e.db, 's1');
    expect(source?.settings.segmentRules).toEqual(
      expect.arrayContaining([expect.objectContaining({ host: 'cdn.example:8080', position: 0 })]),
    );
    const live = await rows(e, 'SELECT url_template FROM live ORDER BY id');
    expect(live[0]?.url_template).toBe(
      'http://cdn.example:8080/{{v0}}/hb/s/101.ts?username={{q:username}}&password={{q:password}}',
    );
    const v = await vars(e);
    expect(v.v0).toBe(M3U_TOKEN);
    expect(resolveTemplate(String(live[0]?.url_template), v)).toBe(cdn(M3U_TOKEN, 101));
    const movies = await rows(e, 'SELECT url_template, logo FROM movies');
    expect(resolveTemplate(String(movies[0]?.url_template), v)).toBe(panel('movie', 201));
    expect(movies[0]?.logo).toBe('http://img.example/a.png');
    const before = JSON.stringify(source?.settings.segmentRules);
    await run(e);
    expect(JSON.stringify((await getSource(e.db, 's1'))?.settings.segmentRules)).toBe(before);
  });

  it('puts no secret or playlist URL in any column', async () => {
    const e = await setupM3u(playlist());
    expect((await run(e)).ok).toBe(true);
    const tables = await rows(e, "SELECT name FROM sqlite_master WHERE type = 'table'");
    let dump = '';
    for (const t of tables) dump += JSON.stringify(await rows(e, `SELECT * FROM ${t.name}`));
    for (const secret of [M3U_TOKEN, M3U_PASS, M3U_USER, playlistUrlFor()]) {
      expect(dump).not.toContain(secret);
    }
    expect(dump).not.toContain('list.example');
  });

  it('keeps keys and row ids when the account token and password change', async () => {
    const e = await setupM3u(playlist());
    await run(e);
    const before = await rows(e, 'SELECT id, key FROM live ORDER BY id');
    const moviesBefore = await rows(e, 'SELECT id, key FROM movies ORDER BY id');
    const newToken = ['tok', 'Zz81p0q4m9'].join('');
    const newPass = ['pw', 'Abc', '77'].join('');
    e.state.body = playlist(newToken, M3U_USER, newPass);
    await e.secrets.set('source:s1:playlist', playlistUrlFor(M3U_USER, newPass));
    const r = await run(e);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(await rows(e, 'SELECT id, key FROM live ORDER BY id')).toEqual(before);
    expect(await rows(e, 'SELECT id, key FROM movies ORDER BY id')).toEqual(moviesBefore);
    expect(await count(e.db, 'episodes')).toBe(3);
    const v = await vars(e);
    expect(v.v0).toBe(newToken);
    expect(JSON.stringify(v)).not.toContain(M3U_TOKEN);
    const dump = JSON.stringify(await rows(e, 'SELECT * FROM live'));
    expect(dump).not.toContain(newToken);
    expect(dump).not.toContain(newPass);
  });

  it('keeps a minority URL with a different token literal under its own key', async () => {
    const odd = ['tok', 'Other0000'].join('');
    const e = await setupM3u(`${playlist()}${extinf('Odd One', cdn(odd, 110))}`);
    await run(e);
    const odds = await rows(e, "SELECT key, url_template FROM live WHERE name = 'Odd One'");
    expect(String(odds[0]?.url_template)).toContain(odd);
    const plain = await rows(e, "SELECT key FROM live WHERE name = 'Haber Bir'");
    expect(odds[0]?.key).not.toBe(plain[0]?.key);
  });

  it('discovers guide URLs for the guide import unless the user set one', async () => {
    const guide = 'http://guide.example/epg.xml';
    const e = await setupM3u(playlist(M3U_TOKEN, M3U_USER, M3U_PASS, `#EXTM3U url-tvg="${guide}"`));
    await run(e);
    const settings = (await getSource(e.db, 's1'))?.settings;
    expect(settings?.discoveredGuideUrls).toHaveLength(1);
    expect(resolveTemplate(settings?.discoveredGuideUrls?.[0] ?? '', await vars(e))).toBe(guide);

    const own = `http://list.example:8080/xmltv.php?username=${M3U_USER}&password=${M3U_PASS}`;
    const e2 = await setupM3u(playlist(M3U_TOKEN, M3U_USER, M3U_PASS, `#EXTM3U url-tvg="${own}"`));
    await run(e2);
    const s2 = (await getSource(e2.db, 's1'))?.settings;
    expect(JSON.stringify(s2)).not.toContain(M3U_PASS);
    expect(resolveTemplate(s2?.discoveredGuideUrls?.[0] ?? '', await vars(e2))).toBe(own);

    const e3 = await setupM3u(
      playlist(M3U_TOKEN, M3U_USER, M3U_PASS, `#EXTM3U url-tvg="${guide}"`),
      { guideUrl: own },
    );
    await run(e3);
    const s3 = (await getSource(e3.db, 's1'))?.settings;
    expect(s3?.discoveredGuideUrls).toBeUndefined();
    expect(resolveTemplate(s3?.guideUrl ?? '', await vars(e3))).toBe(own);
  });

  it('rejects a body that is not a playlist and keeps the previous catalog', async () => {
    const e = await setupM3u(playlist());
    await run(e);
    e.state.body = '<html><body>Login required</body></html>';
    expectErr(await run(e), 'source-format', 'not-a-playlist');
    expect(await count(e.db, 'live')).toBe(2);
    const runs = await rows(e, 'SELECT status, error_code FROM import_runs ORDER BY id');
    expect(runs[1]).toEqual({ status: 'failed', error_code: 'not-a-playlist' });
  });

  it('refuses a playlist with a header but no entries and keeps the catalog', async () => {
    const e = await setupM3u(playlist());
    await run(e);
    e.state.body = '#EXTM3U\n';
    expectErr(await run(e), 'source-format', 'empty-source');
    expect(await count(e.db, 'live')).toBe(2);
    expect(await count(e.db, 'episodes')).toBe(3);
    const runs = await rows(e, 'SELECT status, error_code FROM import_runs ORDER BY id');
    expect(runs.at(-1)).toEqual({ status: 'failed', error_code: 'empty-source' });
  });

  it('accepts a playlist without header when it has entries', async () => {
    const e = await setupM3u(extinf('Solo', 'http://cdn.example:8080/a/b/1.ts'));
    expect((await run(e)).ok).toBe(true);
    expect(await count(e.db, 'live')).toBe(1);
  });

  it('maps http failures and keeps the catalog', async () => {
    const e = await setupM3u(playlist());
    await run(e);
    for (const [status, category, code] of [
      [401, 'auth', 'unauthorized'],
      [503, 'network', 'server-error'],
      [404, 'network', 'http-status'],
    ] as const) {
      e.state.status = status;
      expectErr(await run(e), category, code);
    }
    expect(await count(e.db, 'live')).toBe(2);
  });

  it('fails without a stored playlist URL', async () => {
    const e = await setupM3u(playlist());
    await e.secrets.delete('source:s1:playlist');
    expectErr(await run(e), 'storage', 'secret-missing');
  });

  it('keeps the catalog when the stream breaks half way', async () => {
    const e = await setupM3u(playlist());
    await run(e);
    e.state.failAfter = 200;
    expectErr(await run(e, { batchSize: 1 }), 'network', 'timeout');
    expect(await count(e.db, 'live')).toBe(2);
    expect(await count(e.db, 'episodes')).toBe(3);
  });

  it('cancels with network/aborted and never deletes', async () => {
    const e = await setupM3u(playlist());
    await run(e);
    const ctl = new AbortController();
    const r = await run(e, { signal: ctl.signal, batchSize: 1, onProgress: () => ctl.abort() });
    expectErr(r, 'network', 'aborted');
    const runs = await rows(e, 'SELECT status FROM import_runs ORDER BY id');
    expect(runs.at(-1)?.status).toBe('cancelled');
    expect(await count(e.db, 'live')).toBe(2);
  });

  it('reports progress, yields per batch and survives a throwing callback', async () => {
    const e = await setupM3u(playlist());
    const events: ImportProgress[] = [];
    const r = await run(e, {
      batchSize: 2,
      onProgress: (p: ImportProgress) => {
        events.push(p);
        throw new Error('ui');
      },
    });
    expect(r.ok).toBe(true);
    expect(e.scheduler.count).toBeGreaterThanOrEqual(3);
    expect(events.at(-1)).toEqual({ phase: 'cleanup', done: 0 });
    expect(events.some((p) => p.phase === 'live')).toBe(true);
  });

  it('resolves relative entries against the playlist URL and counts warnings', async () => {
    const e = await setupM3u(`#EXTM3U\n${extinf('Rel', 'chan/5.ts')}not a url line\n`);
    const r = await run(e);
    if (!r.ok) throw new Error('failed');
    expect(r.value.warnings).toBeGreaterThan(0);
    const live = await rows(e, 'SELECT url_template FROM live');
    expect(String(live[0]?.url_template)).toContain('list.example');
    expect(JSON.stringify(live)).not.toContain(M3U_PASS);
  });

  it('imports playlists larger than the rule sample in several batches', async () => {
    let body = '#EXTM3U\n';
    for (let i = 0; i < 1100; i += 1)
      body += extinf(`Ch ${i}`, cdn(M3U_TOKEN, i), 'group-title="All"');
    const e = await setupM3u(body);
    const r = await run(e, { batchSize: 300 });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.counts.live).toBe(1100);
    expect(await count(e.db, 'live')).toBe(1100);
    expect(await count(e.db, 'placements')).toBe(1100);
    expect((await vars(e)).v0).toBe(M3U_TOKEN);
  });

  it('keeps clashing per-entry credential values apart', async () => {
    const one = extinf('A', 'http://cdn.example/a/b/c/1.ts?token=first');
    const two = extinf('B', 'http://cdn.example/a/b/c/2.ts?token=second');
    const e = await setupM3u(`#EXTM3U\n${one}${two}`);
    await run(e);
    const live = await rows(e, 'SELECT url_template FROM live ORDER BY id');
    const v = await vars(e);
    expect(resolveTemplate(String(live[0]?.url_template), v)).toContain('token=first');
    expect(resolveTemplate(String(live[1]?.url_template), v)).toContain('token=second');
    expect(JSON.stringify(live)).not.toContain('second');
  });

  it('stores the user agent and a templated referer of a live entry', async () => {
    const referer = `http://cdn.example/r?token=${M3U_TOKEN}`;
    const body = [
      '#EXTM3U',
      '#EXTINF:-1,H',
      '#EXTVLCOPT:http-user-agent=Probe/1',
      `#EXTVLCOPT:http-referrer=${referer}`,
      'http://cdn.example/a/b/c/1.ts',
      '',
    ].join('\n');
    const e = await setupM3u(body);
    await run(e);
    const live = await rows(e, 'SELECT headers_json FROM live');
    const headers = JSON.parse(String(live[0]?.headers_json)) as Record<string, string>;
    expect(headers.userAgent).toBe('Probe/1');
    expect(headers.referer).not.toContain(M3U_TOKEN);
    expect(resolveTemplate(headers.referer ?? '', await vars(e))).toBe(referer);
  });
});
