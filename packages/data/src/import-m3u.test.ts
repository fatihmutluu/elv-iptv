import { ok } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import {
  fingerprintM3uCredentials,
  fingerprintXtreamCredentials,
  isCredentialFingerprint,
} from './credential-fingerprint';
import { fakeGunzip, gzipped } from './import-guide-test-helpers';
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
  JSON.parse((await e.secrets.get('source.s1.urlvars')) ?? '{}') as UrlVars;

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
    const eps = await rows(e, 'SELECT series_key, title FROM episodes ORDER BY title');
    expect(eps.map((x) => x.series_key)).toEqual([
      'm:s1:series:misc',
      'm:s1:series:drama shows',
      'm:s1:series:drama shows',
    ]);
    const live = await rows(e, "SELECT name, num, guide_id FROM live WHERE name = 'Haber Bir'");
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
      "SELECT category_id FROM placements WHERE kind = 'live' AND item_key = 'm:s1:live:n:spor iki|sports' ORDER BY category_id",
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
    const live = await rows(e, "SELECT url_template FROM live WHERE name = 'Haber Bir'");
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
    await e.secrets.set('source.s1.playlist', playlistUrlFor(M3U_USER, newPass));
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

  it('templates a second token on a judged host and keys it like the first', async () => {
    const odd = ['tok', 'Other0000'].join('');
    let more = '';
    for (let i = 0; i < 200; i += 1) more += extinf(`Ch ${i}`, cdn(M3U_TOKEN, 400 + i));
    const e = await setupM3u(
      `${playlist()}${more}${extinf('Odd One', cdn(odd, 110))}${extinf('Same', cdn(odd, 401))}`,
    );
    expect((await run(e)).ok).toBe(true);
    const odds = await rows(e, "SELECT key, url_template FROM live WHERE name = 'Odd One'");
    expect(String(odds[0]?.url_template)).toBe(
      'http://cdn.example:8080/{{v0~1}}/hb/s/110.ts?username={{q:username}}&password={{q:password}}',
    );
    expect(JSON.stringify(await rows(e, 'SELECT * FROM live'))).not.toContain(odd);
    expect((await vars(e))['v0~1']).toBe(odd);
    const same = await rows(
      e,
      "SELECT key, name FROM live WHERE name IN ('Ch 1', 'Same') ORDER BY name",
    );
    expect(same).toEqual([
      { key: 'm:s1:live:n:ch 1|', name: 'Ch 1' },
      { key: 'm:s1:live:n:same|', name: 'Same' },
    ]);
  });

  it('discovers guide URLs for the guide import unless the user set one', async () => {
    const guide = 'http://guide.example/epg.xml';
    const e = await setupM3u(playlist(M3U_TOKEN, M3U_USER, M3U_PASS, `#EXTM3U url-tvg="${guide}"`));
    await run(e);
    const settings = (await getSource(e.db, 's1'))?.settings;
    expect(settings?.discoveredGuideUrls).toEqual(['{{g:d0}}']);
    expect(resolveTemplate(settings?.discoveredGuideUrls?.[0] ?? '', await vars(e))).toBe(guide);

    const own = `http://list.example:8080/xmltv.php?username=${M3U_USER}&password=${M3U_PASS}`;
    const other = `http://list.example:8080/${['tok', 'Other0000'].join('')}/epg.xml`;
    const header = `#EXTM3U url-tvg="${own},${other}"`;
    const e2 = await setupM3u(playlist(M3U_TOKEN, M3U_USER, M3U_PASS, header));
    await run(e2);
    const s2 = (await getSource(e2.db, 's1'))?.settings;
    expect(s2?.discoveredGuideUrls).toEqual(['{{g:d0}}', '{{g:d1}}']);
    const v2 = await vars(e2);
    expect(resolveTemplate(s2?.discoveredGuideUrls?.[0] ?? '', v2)).toBe(own);
    expect(resolveTemplate(s2?.discoveredGuideUrls?.[1] ?? '', v2)).toBe(other);

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
      [401, 'auth', 'http-401'],
      [503, 'network', 'http-503'],
      [404, 'network', 'http-404'],
    ] as const) {
      e.state.status = status;
      expectErr(await run(e), category, code);
    }
    expect(await count(e.db, 'live')).toBe(2);
  });

  it('reports a raw non-2xx response with the fetch client codes', async () => {
    const e = await setupM3u(playlist());
    const raw = (status: number) => ({
      get: async () =>
        ok({
          status,
          headers: {},
          body: (async function* () {
            yield new Uint8Array(0);
          })(),
        }),
    });
    for (const [status, category, code] of [
      [403, 'auth', 'http-403'],
      [502, 'network', 'http-502'],
    ] as const) {
      expectErr(await importCatalog(e.sourceId, { ...e.deps, http: raw(status) }), category, code);
    }
  });

  it('fails without a stored playlist URL', async () => {
    const e = await setupM3u(playlist());
    await e.secrets.delete('source.s1.playlist');
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
    const live = await rows(e, 'SELECT url_template FROM live ORDER BY name');
    const v = await vars(e);
    expect(resolveTemplate(String(live[0]?.url_template), v)).toContain('token=first');
    expect(resolveTemplate(String(live[1]?.url_template), v)).toContain('token=second');
    expect(JSON.stringify(live)).not.toContain('second');
  });

  it('stores user agent, templated referer, EXTHTTP other headers on live/movies/episodes, and timeshift fallback', async () => {
    const referer = `http://ref.example/${M3U_TOKEN}/player`;
    const body = [
      '#EXTM3U',
      '#EXTINF:-1 timeshift="7",Live H',
      '#EXTVLCOPT:http-user-agent=Probe/1',
      `#EXTVLCOPT:http-referrer=${referer}`,
      '#EXTHTTP:{"X-Custom":"val1","Authorization":"Bearer s3cret-jwt"}',
      'http://cdn.example/live/ch1.m3u8',
      '#EXTINF:-1 group-title="Films",Movie H',
      '#EXTHTTP:{"User-Agent":"MovieUA/2","Referer":"http://ref.example/' +
        M3U_TOKEN +
        '/vod","X-Vod":"ok"}',
      'http://cdn.example/movie/m1.mp4',
      '#EXTINF:-1 group-title="Show S",Ep H',
      '#EXTHTTP:{"User-Agent":"EpUA/3","X-Ep":"yes"}',
      'http://cdn.example/series/e1.mkv',
      '',
    ].join('\n');
    const e = await setupM3u(body);
    expect((await run(e)).ok).toBe(true);
    const v = await vars(e);

    const live = await rows(e, 'SELECT key, catchup_days, headers_json FROM live');
    expect(live[0]?.catchup_days).toBe(7);
    const liveH = JSON.parse(String(live[0]?.headers_json)) as {
      userAgent?: string;
      referer?: string;
      other?: Record<string, string>;
    };
    expect(liveH.userAgent).not.toContain('Probe/1');
    expect(resolveTemplate(liveH.userAgent ?? '', v)).toBe('Probe/1');
    expect(liveH.referer).not.toContain(M3U_TOKEN);
    expect(resolveTemplate(liveH.referer ?? '', v)).toBe(referer);
    expect(liveH.other?.['x-custom']).toBe('val1');
    expect(liveH.other?.authorization).not.toContain('s3cret-jwt');
    expect(resolveTemplate(liveH.other?.authorization ?? '', v)).toBe('Bearer s3cret-jwt');

    const movies = await rows(e, 'SELECT key, headers_json FROM movies');
    const movieH = JSON.parse(String(movies[0]?.headers_json)) as typeof liveH;
    expect(movieH.userAgent).not.toContain('MovieUA/2');
    expect(resolveTemplate(movieH.userAgent ?? '', v)).toBe('MovieUA/2');
    expect(movieH.referer).not.toContain(M3U_TOKEN);
    expect(resolveTemplate(movieH.referer ?? '', v)).toBe(`http://ref.example/${M3U_TOKEN}/vod`);
    expect(movieH.other).toEqual({ 'x-vod': 'ok' });

    const eps = await rows(e, 'SELECT key, headers_json FROM episodes');
    const epH = JSON.parse(String(eps[0]?.headers_json)) as typeof liveH;
    expect(epH.userAgent).not.toContain('EpUA/3');
    expect(resolveTemplate(epH.userAgent ?? '', v)).toBe('EpUA/3');
    expect(epH.other).toEqual({ 'x-ep': 'yes' });

    const { createPlaytimeResolverCache } = await import('./stream-resolver');
    const cache = createPlaytimeResolverCache({
      db: e.db,
      secrets: e.secrets,
      http: e.deps.http,
    });
    const rLive = await cache.resolveStream(String(live[0]?.key));
    const rMovie = await cache.resolveStream(String(movies[0]?.key));
    const rEp = await cache.resolveStream(String(eps[0]?.key));
    expect(rLive.ok && rLive.value.headers['user-agent']).toBe('Probe/1');
    expect(rMovie.ok && rMovie.value.headers['user-agent']).toBe('MovieUA/2');
    expect(rEp.ok && rEp.value.headers['user-agent']).toBe('EpUA/3');
  });

  it('persists templated backup_urls_json on live/movies/episodes and epg_shift_ms on live without leaking tokens (#430, #121)', async () => {
    const backupToken = ['bk', 'Tok', '99887766'].join('');
    const body = [
      '#EXTM3U',
      '#EXTINF:-1 tvg-shift="+2.5" group-title="News",Live Shifted',
      `http://cdn.example:8080/${M3U_TOKEN}/live/1.ts#http://backup.example/${backupToken}/live/1.ts#http://backup2.example/plain/1.ts`,
      '#EXTINF:-1 group-title="Films",Movie With Backup',
      `http://cdn.example:8080/${M3U_TOKEN}/movie/1.mp4#http://backup.example/${backupToken}/movie/1.mp4`,
      '#EXTINF:-1 group-title="Show S",Episode With Backup',
      `http://cdn.example:8080/${M3U_TOKEN}/series/1.mkv#http://backup.example/${backupToken}/series/1.mkv`,
      '',
    ].join('\n');
    const e = await setupM3u(body);
    expect((await run(e)).ok).toBe(true);

    const live = await rows(e, 'SELECT key, backup_urls_json, epg_shift_ms FROM live');
    expect(live[0]?.epg_shift_ms).toBe(9_000_000);
    expect(String(live[0]?.backup_urls_json)).not.toContain(backupToken);
    const movies = await rows(e, 'SELECT key, backup_urls_json FROM movies');
    expect(String(movies[0]?.backup_urls_json)).not.toContain(backupToken);
    const eps = await rows(e, 'SELECT key, backup_urls_json FROM episodes');
    expect(String(eps[0]?.backup_urls_json)).not.toContain(backupToken);

    const { createPlaytimeResolverCache } = await import('./stream-resolver');
    const cache = createPlaytimeResolverCache({
      db: e.db,
      secrets: e.secrets,
      http: e.deps.http,
    });
    const rLive = await cache.resolveStream(String(live[0]?.key));
    expect(rLive.ok && rLive.value.alternates?.map((a) => a.url)).toEqual([
      `http://backup.example/${backupToken}/live/1.ts`,
      'http://backup2.example/plain/1.ts',
    ]);
    const rMovie = await cache.resolveStream(String(movies[0]?.key));
    expect(rMovie.ok && rMovie.value.alternates?.map((a) => a.url)).toEqual([
      `http://backup.example/${backupToken}/movie/1.mp4`,
    ]);
    const rEp = await cache.resolveStream(String(eps[0]?.key));
    expect(rEp.ok && rEp.value.alternates?.map((a) => a.url)).toEqual([
      `http://backup.example/${backupToken}/series/1.mkv`,
    ]);
  });

  it('redacts a single tokenized logo URL on a multi-stream host so the token never enters live.logo (#430)', async () => {
    const logoTok = ['logo', 'Secret', '77665544'].join('');
    let body = '#EXTM3U\n';
    for (let i = 0; i < 60; i += 1) {
      const attrs = i === 0 ? `tvg-logo="http://shared.example/${logoTok}/only-logo.png"` : '';
      body += extinf(`Ch ${i}`, `http://shared.example/live/s${i}.ts`, attrs);
    }
    const e = await setupM3u(body);
    expect((await run(e)).ok).toBe(true);
    const storedLogos = await rows(e, 'SELECT logo FROM live WHERE logo IS NOT NULL');
    expect(storedLogos).toHaveLength(1);
    expect(String(storedLogos[0]?.logo)).not.toContain(logoTok);
    const v = await vars(e);
    expect(resolveTemplate(String(storedLogos[0]?.logo), v)).toBe(
      `http://shared.example/${logoTok}/only-logo.png`,
    );
  });

  it('reports exact deduplicated SQL counts when duplicate entries appear across batches', async () => {
    const dup = extinf('Dup Live', cdn(M3U_TOKEN, 777), 'group-title="News"');
    const e = await setupM3u(`#EXTM3U\n${dup}${dup}${dup}`);
    const r = await run(e, { batchSize: 1 });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.counts.live).toBe(1);
    expect(await count(e.db, 'live')).toBe(1);
  });

  it('uses a 180s response-header timeout for full M3U playlist imports (#169)', async () => {
    const e = await setupM3u(playlist());
    const timeouts: (number | undefined)[] = [];
    const origGet = e.deps.http.get.bind(e.deps.http);
    const r = await importCatalog(e.sourceId, {
      ...e.deps,
      http: {
        get: (url, opts) => {
          timeouts.push(opts?.timeoutMs);
          return origGet(url, opts);
        },
      },
    });
    expect(r.ok).toBe(true);
    expect(timeouts).toEqual([180_000]);
  });

  it('decompresses gzipped M3U playlists via deps.decompressor without Content-Encoding (#169)', async () => {
    const e = await setupM3u();
    const rawGz = gzipped(playlist());
    const gzHttp = {
      get: async () =>
        ok({
          status: 200,
          headers: {},
          body: (async function* () {
            yield rawGz.subarray(0, 1);
            yield rawGz.subarray(1);
          })(),
        }),
    };

    const noDecomp = await importCatalog(e.sourceId, { ...e.deps, http: gzHttp });
    expectErr(noDecomp, 'source-format', 'gzip-unsupported');

    const withDecomp = await importCatalog(e.sourceId, {
      ...e.deps,
      http: gzHttp,
      decompressor: fakeGunzip,
    });
    if (!withDecomp.ok) throw new Error(JSON.stringify(withDecomp.error));
    expect(withDecomp.value.counts).toMatchObject({ live: 2, movies: 1, episodes: 3, series: 2 });
    expect(await count(e.db, 'live')).toBe(2);
  });

  it('persists credentialFingerprint from playlistUrl or falls back to sample stream URLs (#265)', async () => {
    const e1 = await setupM3u(playlist());
    expect((await run(e1)).ok).toBe(true);
    const s1 = await getSource(e1.db, e1.sourceId);
    const expectedFromPlaylist = fingerprintM3uCredentials(playlistUrlFor());
    expect(isCredentialFingerprint(s1?.settings.credentialFingerprint)).toBe(true);
    expect(s1?.settings.credentialFingerprint).toBe(expectedFromPlaylist);

    const opaquePlaylistUrl = 'http://cdn.example/opaque/list.m3u';
    const e2 = await setupM3u(
      `#EXTM3U\n${extinf('Plain', 'http://cdn.example/hls/ch1/index.m3u8')}${extinf(
        'Film A',
        panel('movie', 201),
      )}`,
      { playlistUrl: opaquePlaylistUrl },
    );
    expect((await run(e2)).ok).toBe(true);
    const s2 = await getSource(e2.db, e2.sourceId);
    expect(s2?.settings.credentialFingerprint).toBe(
      fingerprintXtreamCredentials('http://panel.example:8080', M3U_USER, M3U_PASS),
    );

    const e3 = await setupM3u(
      `#EXTM3U\n${extinf('Plain', 'http://cdn.example/hls/ch1/index.m3u8')}`,
      {
        playlistUrl: opaquePlaylistUrl,
      },
    );
    expect((await run(e3)).ok).toBe(true);
    const s3 = await getSource(e3.db, e3.sourceId);
    expect(s3?.settings.credentialFingerprint).toBeUndefined();
  });

  it('resolves relative stream URLs against response.finalUrl after redirects (#417)', async () => {
    const e = await setupM3u();
    const redirectedHttp = {
      get: async () =>
        ok({
          status: 200,
          headers: {},
          finalUrl: 'https://cdn.redirected.example/playlists/v2/index.m3u',
          body: (async function* () {
            yield new TextEncoder().encode(`#EXTM3U\n${extinf('Rel Ch', 'streams/ch7.m3u8')}`);
          })(),
        }),
    };
    const r = await importCatalog(e.sourceId, { ...e.deps, http: redirectedHttp });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const live = await rows(e, 'SELECT url_template FROM live');
    expect(resolveTemplate(String(live[0]?.url_template), await vars(e))).toBe(
      'https://cdn.redirected.example/playlists/v2/streams/ch7.m3u8',
    );
  });

  it('assigns deterministic #2/#3 suffixes to distinct duplicate M3U entries and preserves legacy user state across URL/token rotation (#201, #418)', async () => {
    const body =
      '#EXTM3U\n' +
      extinf('CNN HD', cdn(M3U_TOKEN, 101), 'tvg-id="cnn.us" group-title="News"') +
      extinf('CNN Backup', cdn(M3U_TOKEN, 102), 'tvg-id="cnn.us" group-title="News"') +
      extinf('Local', cdn(M3U_TOKEN, 103), 'group-title="City"') +
      extinf('Local', cdn(M3U_TOKEN, 104), 'group-title="City"');
    const e = await setupM3u(body);

    // Pre-seed legacy m3uKey rows for CNN HD in live, favorites, watch_progress, and channel_guide.
    const legacyCnnKey = 'm:s1:http://cdn.example:8080/{{*}}/hb/s/101.ts|CNN HD';
    await e.db.run(
      'INSERT INTO live (source_id, key, name, name_fold, run_id, is_hidden) VALUES (?, ?, ?, ?, 0, 1)',
      ['s1', legacyCnnKey, 'CNN HD', 'cnn hd'],
    );
    await e.db.run(
      "INSERT INTO favorites (profile_id, source_id, item_key, kind, title, added_at) VALUES ('default', 's1', ?, 'live', 'CNN HD', 50)",
      [legacyCnnKey],
    );
    await e.db.run(
      "INSERT INTO watch_progress (profile_id, source_id, item_key, kind, title, position_ms, duration_ms, watched, updated_at) VALUES ('default', 's1', ?, 'live', 'CNN HD', 1000, 5000, 0, 50)",
      [legacyCnnKey],
    );
    await e.db.run(
      "INSERT INTO channel_guide (source_id, channel_key, guide_id) VALUES ('s1', ?, 'cnn.us')",
      [legacyCnnKey],
    );

    const r1 = await run(e);
    if (!r1.ok) throw new Error(JSON.stringify(r1.error));
    const keys = (await rows(e, 'SELECT key, is_hidden FROM live ORDER BY key')).map((x) => ({
      key: x.key,
      is_hidden: x.is_hidden,
    }));
    expect(keys).toEqual([
      { key: 'm:s1:live:n:local|city', is_hidden: 0 },
      { key: 'm:s1:live:n:local|city#2', is_hidden: 0 },
      { key: 'm:s1:live:t:cnn.us', is_hidden: 1 },
      { key: 'm:s1:live:t:cnn.us#2', is_hidden: 0 },
    ]);
    expect(await rows(e, 'SELECT item_key FROM favorites')).toEqual([
      { item_key: 'm:s1:live:t:cnn.us' },
    ]);
    expect(await rows(e, 'SELECT item_key FROM watch_progress')).toEqual([
      { item_key: 'm:s1:live:t:cnn.us' },
    ]);
    expect(await rows(e, 'SELECT channel_key FROM channel_guide')).toEqual([
      { channel_key: 'm:s1:live:t:cnn.us' },
    ]);

    // Rotate host + token completely and re-import: keys and is_hidden survive unchanged.
    const liveIdsBefore = await rows(e, 'SELECT id, key, is_hidden FROM live ORDER BY key');
    e.state.body =
      '#EXTM3U\n' +
      extinf(
        'CNN Renamed',
        'http://new-host.example/alt/901.m3u8?token=newtok',
        'tvg-id="cnn.us" group-title="World"',
      ) +
      extinf(
        'CNN Backup 2',
        'http://new-host.example/alt/902.m3u8?token=newtok',
        'tvg-id="cnn.us" group-title="World"',
      ) +
      extinf('Local', 'http://new-host.example/alt/903.m3u8', 'group-title="City"') +
      extinf('Local', 'http://new-host.example/alt/904.m3u8', 'group-title="City"');
    const r2 = await run(e);
    if (!r2.ok) throw new Error(JSON.stringify(r2.error));
    expect(await rows(e, 'SELECT id, key, is_hidden FROM live ORDER BY key')).toEqual(
      liveIdsBefore,
    );
  });

  it('leaves live tables and FTS5 100% untouched and purges *_next on mid-run abort, stream failure, urlvars-too-large, and secret-write-failed (#418)', async () => {
    const e = await setupM3u(playlist());
    const ok1 = await run(e);
    if (!ok1.ok) throw new Error(JSON.stringify(ok1.error));
    const liveSnap = await rows(e, 'SELECT * FROM live ORDER BY id');
    const ftsSnap = await rows(e, "SELECT rowid FROM live_fts WHERE live_fts MATCH 'haber'");

    // Abort mid-run with brand new channel names that would fire FTS5 if live were touched.
    e.state.body =
      '#EXTM3U\n' +
      Array.from({ length: 10 }, (_, i) =>
        extinf(`AbortedCh ${i}`, cdn(M3U_TOKEN, 500 + i), 'group-title="New"'),
      ).join('');
    const ctl = new AbortController();
    const aborted = await run(e, {
      signal: ctl.signal,
      batchSize: 2,
      onProgress: () => ctl.abort(),
    });
    expectErr(aborted, 'network', 'aborted');
    expect(await rows(e, 'SELECT * FROM live ORDER BY id')).toEqual(liveSnap);
    expect(await rows(e, "SELECT rowid FROM live_fts WHERE live_fts MATCH 'abortedch'")).toEqual(
      [],
    );
    expect(await rows(e, "SELECT rowid FROM live_fts WHERE live_fts MATCH 'haber'")).toEqual(
      ftsSnap,
    );
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

    // urlvars-too-large above the chunk/sharded ceiling leaves live, FTS5, and urlvars untouched and purges *_next.
    const urlvarsBefore = await e.secrets.get('source.s1.urlvars');
    const oversizedToken = `tok_${'p'.repeat(60_050)}`;
    e.state.body =
      '#EXTM3U\n' +
      extinf(
        'TooBigCh 0',
        `http://perstream.example/play/0.m3u8?token=${oversizedToken}`,
        'group-title="New"',
      );
    expectErr(await run(e, { batchSize: 50 }), 'source-format', 'urlvars-too-large');
    expect(await rows(e, 'SELECT * FROM live ORDER BY id')).toEqual(liveSnap);
    expect(await rows(e, "SELECT rowid FROM live_fts WHERE live_fts MATCH 'toobigch'")).toEqual([]);
    expect(await count(e.db, 'live_next')).toBe(0);
    expect(await e.secrets.get('source.s1.urlvars')).toBe(urlvarsBefore);

    // secret-write-failed also leaves live untouched and *_next empty.
    e.state.body =
      '#EXTM3U\n' +
      Array.from({ length: 10 }, (_, i) =>
        extinf(`SecretFailCh ${i}`, cdn(M3U_TOKEN, 700 + i), 'group-title="New"'),
      ).join('');
    e.secrets.set = async () => {
      throw new Error('keychain');
    };
    expectErr(await run(e, { batchSize: 2 }), 'storage', 'secret-write-failed');
    expect(await rows(e, 'SELECT * FROM live ORDER BY id')).toEqual(liveSnap);
    expect(await count(e.db, 'live_next')).toBe(0);
  });
});
