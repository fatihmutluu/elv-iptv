import {
  err,
  type HttpClient,
  type HttpRequestOptions,
  type HttpResponse,
  httpStatusError,
  ok,
  type Result,
} from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { replaceGuideValidator, withGuideValidator } from './http-cache';
import { closeOpenProgrammes, importGuide } from './import-guide';
import {
  channelXml,
  defaultGuide,
  GUIDE_URL,
  HOUR,
  NOW,
  PLAYLIST,
  programmeXml,
  rows,
  SECOND_URL,
  settings,
  setupGuide,
  titles,
  tv,
  xt,
} from './import-guide-test-helpers';
import type { RunCtx } from './import-run';
import {
  count,
  extinf,
  M3U_PASS,
  M3U_TOKEN,
  M3U_USER,
  setup,
  setupM3u,
} from './import-test-helpers';
import { importCatalog } from './import-xtream';
import { getSource, updateSourceSettings } from './sources';

const enc = (s: string) => new TextEncoder().encode(s);

function bodyOf(text: string): AsyncIterable<Uint8Array> {
  const bytes = enc(text);
  return (async function* () {
    if (bytes.length > 0) yield bytes;
  })();
}

interface ConditionalMock {
  body: string;
  etag?: string;
  lastModified?: string;
  /** Optional override headers returned on 304 responses. */
  headers304?: Record<string, string>;
  /** When true, always respond 304 if any conditional header matches. */
  requests: { url: string; headers: Readonly<Record<string, string>> }[];
  statuses: number[];
  bodiesRead: number;
  http: HttpClient;
}

function createConditionalMock(
  initial: { body: string; etag?: string; lastModified?: string },
  fallback?: HttpClient,
  matchUrl: (url: string) => boolean = () => true,
): ConditionalMock {
  const mock: ConditionalMock = {
    body: initial.body,
    ...(initial.etag === undefined ? {} : { etag: initial.etag }),
    ...(initial.lastModified === undefined ? {} : { lastModified: initial.lastModified }),
    requests: [],
    statuses: [],
    bodiesRead: 0,
    http: {
      async get(url: string, options?: HttpRequestOptions): Promise<Result<HttpResponse>> {
        if (!matchUrl(url) && fallback !== undefined) return fallback.get(url, options);
        const reqHeaders = options?.headers ?? {};
        mock.requests.push({ url, headers: { ...reqHeaders } });
        const inm = reqHeaders['if-none-match'];
        const ims = reqHeaders['if-modified-since'];
        const matched =
          (inm !== undefined && mock.etag !== undefined && inm === mock.etag) ||
          (inm === undefined &&
            ims !== undefined &&
            mock.lastModified !== undefined &&
            ims === mock.lastModified);
        if (matched) {
          mock.statuses.push(304);
          const headers: Record<string, string> =
            mock.headers304 !== undefined
              ? mock.headers304
              : {
                  ...(mock.etag === undefined ? {} : { etag: mock.etag }),
                  ...(mock.lastModified === undefined
                    ? {}
                    : { 'last-modified': mock.lastModified }),
                };
          return ok({ status: 304, headers, body: bodyOf('') });
        }
        mock.statuses.push(200);
        const headers: Record<string, string> = {
          ...(mock.etag === undefined ? {} : { etag: mock.etag }),
          ...(mock.lastModified === undefined ? {} : { 'last-modified': mock.lastModified }),
        };
        const bytes = enc(mock.body);
        const body: AsyncIterable<Uint8Array> = (async function* () {
          mock.bodiesRead += 1;
          yield bytes;
        })();
        return ok({ status: 200, headers, body });
      },
    },
  };
  return mock;
}

describe('conditional HTTP 304 guide downloads (#66)', () => {
  it('persists validators under opaque slot keys, sends conditional headers on refresh #2, and keeps stored guide on 304', async () => {
    const secretGuideUrl = `http://epg.example/guide.xml?username=${M3U_USER}&password=${M3U_PASS}`;
    const e = await setupGuide(PLAYLIST, { guideUrl: secretGuideUrl });
    const catRes = await importCatalog(e.sourceId, e.deps);
    expect(catRes.ok).toBe(true);

    const mock = createConditionalMock(
      {
        body: defaultGuide(),
        etag: '"guide-v1"',
        lastModified: 'Fri, 13 Nov 2026 00:00:00 GMT',
      },
      e.deps.http,
      (u) => u.includes('epg.example'),
    );
    const deps = { ...e.deps, http: mock.http };

    const r1 = await importGuide(e.sourceId, deps, { now: NOW });
    if (!r1.ok) throw new Error(JSON.stringify(r1.error));
    expect(r1.value.unchanged).toBeUndefined();
    const titlesBefore = await titles(e);
    expect(titlesBefore).toHaveLength(5);
    expect(mock.statuses).toEqual([200]);
    expect(mock.bodiesRead).toBe(1);

    const s1 = await settings(e);
    expect(s1.httpCache?.guide).toEqual({
      override: { etag: '"guide-v1"', lastModified: 'Fri, 13 Nov 2026 00:00:00 GMT' },
    });
    const rawSettings = JSON.stringify(await rows(e, 'SELECT settings_json FROM sources'));
    expect(rawSettings).not.toContain('epg.example');
    expect(rawSettings).not.toContain(M3U_PASS);

    const r2 = await importGuide(e.sourceId, deps, { now: NOW });
    if (!r2.ok) throw new Error(JSON.stringify(r2.error));
    expect(r2.value.unchanged).toBe(true);
    expect(r2.value.counts).toEqual({ unchanged: 1 });
    expect(mock.statuses).toEqual([200, 304]);
    expect(mock.bodiesRead).toBe(1);
    expect(mock.requests[1]?.headers['if-none-match']).toBe('"guide-v1"');
    expect(mock.requests[1]?.headers['if-modified-since']).toBe('Fri, 13 Nov 2026 00:00:00 GMT');

    expect(await titles(e)).toEqual(titlesBefore);
    expect(await rows(e, 'SELECT guide_id FROM guide_channels ORDER BY guide_id')).toHaveLength(4);
    expect(await rows(e, 'SELECT channel_key FROM channel_guide')).toHaveLength(3);

    const runs = await rows(
      e,
      "SELECT status, counts_json FROM import_runs WHERE kind = 'guide' ORDER BY id",
    );
    expect(runs).toHaveLength(2);
    expect(runs[1]).toEqual({ status: 'ok', counts_json: JSON.stringify({ unchanged: 1 }) });
    expect(JSON.stringify(runs)).not.toContain(M3U_PASS);
  });

  it('updates cached validator when 304 carries a newer ETag and keeps previous when 304 omits headers', async () => {
    const e = await setupGuide(PLAYLIST, { guideUrl: GUIDE_URL });
    expect((await importCatalog(e.sourceId, e.deps)).ok).toBe(true);

    const mock = createConditionalMock(
      { body: defaultGuide(), etag: '"g1"', lastModified: 'Fri, 13 Nov 2026 00:00:00 GMT' },
      e.deps.http,
      (u) => u.includes('epg.example'),
    );
    const deps = { ...e.deps, http: mock.http };
    expect((await importGuide(e.sourceId, deps, { now: NOW })).ok).toBe(true);

    mock.headers304 = {};
    const r2 = await importGuide(e.sourceId, deps, { now: NOW });
    expect(r2.ok && r2.value.unchanged).toBe(true);
    expect((await settings(e)).httpCache?.guide?.override).toEqual({
      etag: '"g1"',
      lastModified: 'Fri, 13 Nov 2026 00:00:00 GMT',
    });

    mock.headers304 = { etag: 'W/"g1-weak"' };
    const r3 = await importGuide(e.sourceId, deps, { now: NOW });
    expect(r3.ok && r3.value.unchanged).toBe(true);
    expect((await settings(e)).httpCache?.guide?.override).toEqual({
      etag: 'W/"g1-weak"',
      lastModified: 'Fri, 13 Nov 2026 00:00:00 GMT',
    });
  });

  it('performs full downloads when server omits validators and clears stale validators', async () => {
    const e = await setupGuide(PLAYLIST, { guideUrl: GUIDE_URL });
    expect((await importCatalog(e.sourceId, e.deps)).ok).toBe(true);

    const mock = createConditionalMock({ body: defaultGuide(), etag: '"g1"' }, e.deps.http, (u) =>
      u.includes('epg.example'),
    );
    const deps = { ...e.deps, http: mock.http };
    expect((await importGuide(e.sourceId, deps, { now: NOW })).ok).toBe(true);
    expect((await settings(e)).httpCache?.guide?.override?.etag).toBe('"g1"');

    // Server stops sending validators
    delete mock.etag;
    const r2 = await importGuide(e.sourceId, deps, { now: NOW });
    if (!r2.ok) throw new Error(JSON.stringify(r2.error));
    expect(r2.value.unchanged).toBeUndefined();
    expect(mock.statuses).toEqual([200, 200]);
    expect((await settings(e)).httpCache).toBeUndefined();

    // Refresh #3 sends no conditional headers
    const r3 = await importGuide(e.sourceId, deps, { now: NOW });
    expect(r3.ok && r3.value.unchanged).toBeUndefined();
    expect(mock.requests[2]?.headers['if-none-match']).toBeUndefined();
    expect(mock.requests[2]?.headers['if-modified-since']).toBeUndefined();
  });

  it('does not send conditional headers when programmes table is empty despite cached validator', async () => {
    const e = await setupGuide(PLAYLIST, { guideUrl: GUIDE_URL });
    expect((await importCatalog(e.sourceId, e.deps)).ok).toBe(true);

    const mock = createConditionalMock(
      { body: defaultGuide(), etag: '"g1"', lastModified: 'Fri, 13 Nov 2026 00:00:00 GMT' },
      e.deps.http,
      (u) => u.includes('epg.example'),
    );
    const deps = { ...e.deps, http: mock.http };
    expect((await importGuide(e.sourceId, deps, { now: NOW })).ok).toBe(true);

    await e.db.run('DELETE FROM programmes WHERE source_id = ?', [e.sourceId]);
    expect(await titles(e)).toEqual([]);

    const r2 = await importGuide(e.sourceId, deps, { now: NOW });
    if (!r2.ok) throw new Error(JSON.stringify(r2.error));
    expect(r2.value.unchanged).toBeUndefined();
    expect(mock.requests[1]?.headers['if-none-match']).toBeUndefined();
    expect(mock.requests[1]?.headers['if-modified-since']).toBeUndefined();
    expect(await titles(e)).toHaveLength(5);
  });

  it('does not persist validators when guide/empty drops the incoming guide', async () => {
    const e = await setupGuide(PLAYLIST, { guideUrl: GUIDE_URL });
    expect((await importCatalog(e.sourceId, e.deps)).ok).toBe(true);

    const mock = createConditionalMock(
      { body: defaultGuide(), etag: '"good-guide"' },
      e.deps.http,
      (u) => u.includes('epg.example'),
    );
    const deps = { ...e.deps, http: mock.http };
    expect((await importGuide(e.sourceId, deps, { now: NOW })).ok).toBe(true);

    mock.body = tv(channelXml('nobody', 'Nobody'));
    mock.etag = '"empty-guide"';
    const r2 = await importGuide(e.sourceId, deps, { now: NOW });
    expect(r2.ok && r2.value.warningCodes).toEqual(['guide/empty']);
    expect((await settings(e)).httpCache?.guide?.override?.etag).toBe('"good-guide"');
  });

  it('uses opaque slot keys for xtream and discovered guide URLs', async () => {
    const xt = await setup({
      liveCats: [{ category_id: '1', category_name: 'News' }],
      vodCats: [],
      seriesCats: [],
      live: [{ stream_id: 7, name: 'Haber Bir', category_id: '1', epg_channel_id: 'haber1.tr' }],
      vod: [],
      series: [],
      seriesInfo: {},
      user: { auth: 1, status: 'Active' },
    });
    const xtGuideMock = createConditionalMock(
      {
        body: tv(channelXml('haber1.tr', 'Haber Bir'), programmeXml('haber1.tr', HOUR, 1, 'News')),
        etag: '"xt-1"',
      },
      xt.deps.http,
      (u) => u.includes('xmltv.php'),
    );
    const xtDeps = { ...xt.deps, http: xtGuideMock.http };
    expect((await importCatalog(xt.sourceId, xtDeps)).ok).toBe(true);
    expect((await importGuide(xt.sourceId, xtDeps, { now: NOW })).ok).toBe(true);
    expect((await getSource(xt.db, xt.sourceId))?.settings.httpCache?.guide).toEqual({
      xtream: { etag: '"xt-1"' },
    });
    const xt2 = await importGuide(xt.sourceId, xtDeps, { now: NOW });
    expect(xt2.ok && xt2.value.unchanged).toBe(true);

    const m3u = await setupGuide(PLAYLIST, {});
    expect((await importCatalog(m3u.sourceId, m3u.deps)).ok).toBe(true);
    await updateSourceSettings(m3u.db, m3u.sourceId, {
      ...(await settings(m3u)),
      discoveredGuideUrls: [GUIDE_URL, SECOND_URL],
    });
    const discMock = createConditionalMock(
      { body: defaultGuide(), etag: '"disc-1"' },
      {
        async get(url) {
          if (url === GUIDE_URL) return err(httpStatusError(404));
          return m3u.deps.http.get(url);
        },
      },
      (u) => u === SECOND_URL,
    );
    expect(
      (await importGuide(m3u.sourceId, { ...m3u.deps, http: discMock.http }, { now: NOW })).ok,
    ).toBe(true);
    expect((await settings(m3u)).httpCache?.guide).toEqual({
      'discovered:1': { etag: '"disc-1"' },
    });
  });

  it('replaces stale fallback slot validators when another slot commits (#1)', async () => {
    const e = await setup({
      liveCats: [{ category_id: '1', category_name: 'News' }],
      vodCats: [],
      seriesCats: [],
      live: [{ stream_id: 7, name: 'Haber Bir', category_id: '1', epg_channel_id: 'haber1.tr' }],
      vod: [],
      series: [],
      seriesInfo: {},
      user: { auth: 1, status: 'Active' },
    });
    const overrideUrl = 'http://override.example/epg.xml';
    await updateSourceSettings(e.db, e.sourceId, {
      ...(await getSource(e.db, e.sourceId))?.settings,
      guideUrl: '{{g:url}}',
    });
    await e.secrets.set('source.s1.urlvars', JSON.stringify({ 'g:url': overrideUrl }));

    let overrideStatus = 200;
    const overrideReqs: Readonly<Record<string, string>>[] = [];
    const baseHttp = e.deps.http;
    const http: HttpClient = {
      async get(url, options) {
        if (url === overrideUrl) {
          overrideReqs.push({ ...(options?.headers ?? {}) });
          if (overrideStatus !== 200) return err(httpStatusError(overrideStatus));
          if (options?.headers?.['if-none-match'] === '"ov-1"') {
            return ok({ status: 304, headers: { etag: '"ov-1"' }, body: bodyOf('') });
          }
          return ok({
            status: 200,
            headers: { etag: '"ov-1"' },
            body: bodyOf(
              tv(
                channelXml('haber1.tr', 'Haber Bir'),
                programmeXml('haber1.tr', HOUR, 1, 'FromOverride'),
              ),
            ),
          });
        }
        if (url.includes('xmltv.php')) {
          return ok({
            status: 200,
            headers: {},
            body: bodyOf(
              tv(
                channelXml('haber1.tr', 'Haber Bir'),
                programmeXml('haber1.tr', HOUR, 1, 'FromXtream'),
              ),
            ),
          });
        }
        return baseHttp.get(url, options);
      },
    };
    const deps = { ...e.deps, http };
    expect((await importCatalog(e.sourceId, deps)).ok).toBe(true);

    // Run 1: override commits with ETag "ov-1"
    expect((await importGuide(e.sourceId, deps, { now: NOW })).ok).toBe(true);
    expect((await getSource(e.db, e.sourceId))?.settings.httpCache?.guide).toEqual({
      override: { etag: '"ov-1"' },
    });

    // Run 2: override fails (503), xtream fallback commits with NO validator -> stale override validator MUST be cleared
    overrideStatus = 503;
    expect((await importGuide(e.sourceId, deps, { now: NOW })).ok).toBe(true);
    expect((await getSource(e.db, e.sourceId))?.settings.httpCache?.guide).toBeUndefined();
    expect(
      (await e.db.all<{ title: string }>('SELECT title FROM programmes')).map((r) => r.title),
    ).toEqual(['FromXtream']);

    // Run 3: override recovers -> must NOT send stale If-None-Match and must replace FromXtream with FromOverride
    overrideStatus = 200;
    const r3 = await importGuide(e.sourceId, deps, { now: NOW });
    if (!r3.ok) throw new Error(JSON.stringify(r3.error));
    expect(r3.value.unchanged).toBeUndefined();
    expect(overrideReqs[2]?.['if-none-match']).toBeUndefined();
    expect(
      (await e.db.all<{ title: string }>('SELECT title FROM programmes')).map((r) => r.title),
    ).toEqual(['FromOverride']);
  });
});

describe('conditional HTTP 304 M3U playlist downloads (#66)', () => {
  const samplePlaylist = () =>
    '#EXTM3U\n' +
    extinf('Haber Bir', `http://cdn.example:8080/${M3U_TOKEN}/hb/s/1.ts`, 'group-title="News"') +
    extinf(
      'Film A',
      `http://panel.example:8080/movie/${M3U_USER}/${M3U_PASS}/201.mkv`,
      'group-title="Films"',
    ) +
    extinf(
      'Show S01E01',
      `http://panel.example:8080/series/${M3U_USER}/${M3U_PASS}/301.mkv`,
      'group-title="Drama"',
    );

  it('persists playlist validator on 200 and keeps all catalog rows untouched on 304', async () => {
    const e = await setupM3u(samplePlaylist());
    const mock = createConditionalMock({
      body: samplePlaylist(),
      etag: '"m3u-v1"',
      lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT',
    });
    const deps = { ...e.deps, http: mock.http };

    const r1 = await importCatalog(e.sourceId, deps);
    if (!r1.ok) throw new Error(JSON.stringify(r1.error));
    expect(r1.value.unchanged).toBeUndefined();
    expect(await count(e.db, 'live')).toBe(1);
    expect(await count(e.db, 'movies')).toBe(1);
    expect(await count(e.db, 'series')).toBe(1);
    expect(await count(e.db, 'episodes')).toBe(1);
    expect((await getSource(e.db, e.sourceId))?.settings.httpCache?.playlist).toEqual({
      etag: '"m3u-v1"',
      lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT',
    });

    const r2 = await importCatalog(e.sourceId, deps);
    if (!r2.ok) throw new Error(JSON.stringify(r2.error));
    expect(r2.value.unchanged).toBe(true);
    expect(r2.value.counts).toEqual({ unchanged: 1 });
    expect(r2.value.warningCodes).toEqual([]);
    expect(mock.statuses).toEqual([200, 304]);
    expect(mock.bodiesRead).toBe(1);
    expect(mock.requests[1]?.headers['if-none-match']).toBe('"m3u-v1"');
    expect(mock.requests[1]?.headers['if-modified-since']).toBe('Wed, 01 Jan 2025 00:00:00 GMT');

    expect(await count(e.db, 'live')).toBe(1);
    expect(await count(e.db, 'movies')).toBe(1);
    expect(await count(e.db, 'series')).toBe(1);
    expect(await count(e.db, 'episodes')).toBe(1);
    expect(await count(e.db, 'categories')).toBe(3);
    expect(await count(e.db, 'placements')).toBe(3);
  });

  it('does not send conditional headers for M3U when catalog tables are empty despite cached validator', async () => {
    const e = await setupM3u(samplePlaylist());
    const mock = createConditionalMock({ body: samplePlaylist(), etag: '"m3u-v1"' });
    const deps = { ...e.deps, http: mock.http };
    expect((await importCatalog(e.sourceId, deps)).ok).toBe(true);

    for (const table of ['live', 'movies', 'series', 'episodes']) {
      await e.db.run(`DELETE FROM ${table} WHERE source_id = ?`, [e.sourceId]);
    }

    const r2 = await importCatalog(e.sourceId, deps);
    if (!r2.ok) throw new Error(JSON.stringify(r2.error));
    expect(r2.value.unchanged).toBeUndefined();
    expect(mock.requests[1]?.headers['if-none-match']).toBeUndefined();
    expect(await count(e.db, 'live')).toBe(1);
  });

  it('drops discovered:* guide validators when M3U url-tvg changes while preserving override (#2)', async () => {
    const withHeader = (tvgUrl?: string) =>
      `${tvgUrl === undefined ? '#EXTM3U' : `#EXTM3U url-tvg="${tvgUrl}"`}\n` +
      extinf('Haber Bir', `http://cdn.example:8080/${M3U_TOKEN}/hb/s/1.ts`, 'group-title="News"');
    const e = await setupM3u(withHeader('http://epg1.example/a.xml'));
    expect((await importCatalog(e.sourceId, e.deps)).ok).toBe(true);

    // Seed both override and discovered:0 guide cache validators
    const baseSettings = (await getSource(e.db, e.sourceId))?.settings ?? {};
    await updateSourceSettings(e.db, e.sourceId, {
      ...baseSettings,
      httpCache: {
        guide: {
          override: { etag: '"ov-keep"' },
          'discovered:0': { etag: '"disc-old"' },
        },
      },
    });

    // Re-import with unchanged url-tvg -> discovered:0 stays intact
    expect((await importCatalog(e.sourceId, e.deps)).ok).toBe(true);
    expect((await getSource(e.db, e.sourceId))?.settings.httpCache?.guide).toEqual({
      override: { etag: '"ov-keep"' },
      'discovered:0': { etag: '"disc-old"' },
    });

    // Re-import with changed url-tvg -> discovered:0 dropped, override preserved
    e.state.body = withHeader('http://epg2.example/b.xml');
    expect((await importCatalog(e.sourceId, e.deps)).ok).toBe(true);
    expect((await getSource(e.db, e.sourceId))?.settings.httpCache?.guide).toEqual({
      override: { etag: '"ov-keep"' },
    });
  });
});

describe('HTTP cache validator sanitization', () => {
  it('drops CR/LF injection, non-ASCII ByteString chars, invalid slot keys, and oversized validators', async () => {
    const e = await setupGuide(PLAYLIST, { guideUrl: GUIDE_URL });
    expect((await importCatalog(e.sourceId, e.deps)).ok).toBe(true);

    const mock = createConditionalMock(
      {
        body: defaultGuide(),
        etag: '"bad"\r\nX-Injected: evil',
        lastModified: 'A'.repeat(300),
      },
      e.deps.http,
      (u) => u.includes('epg.example'),
    );
    const deps = { ...e.deps, http: mock.http };
    expect((await importGuide(e.sourceId, deps, { now: NOW })).ok).toBe(true);
    expect((await settings(e)).httpCache).toBeUndefined();

    // Non-ASCII (> 0xff) validator must be dropped so WHATWG fetch ByteString never throws
    mock.etag = '"etag-\u2603"';
    mock.lastModified = 'Çalışma-Date';
    expect((await importGuide(e.sourceId, deps, { now: NOW })).ok).toBe(true);
    expect((await settings(e)).httpCache).toBeUndefined();

    // Slot vocabulary rejects prototype-pollution keys and raw URLs
    const s0 = {};
    expect(withGuideValidator(s0, '__proto__', { etag: '"x"' })).toEqual({});
    expect(withGuideValidator(s0, 'constructor', { etag: '"x"' })).toEqual({});
    expect(replaceGuideValidator(s0, 'http://epg.example/a.xml', { etag: '"x"' })).toEqual({});
    expect(replaceGuideValidator(s0, 'discovered:abc', { etag: '"x"' })).toEqual({});

    // Tamper settings_json directly to verify outgoing request defense-in-depth
    await updateSourceSettings(e.db, e.sourceId, {
      ...(await settings(e)),
      httpCache: {
        guide: {
          override: {
            etag: '"tampered-\u2603"',
            lastModified: 'B'.repeat(257),
          },
        },
      },
    });
    expect((await importGuide(e.sourceId, deps, { now: NOW })).ok).toBe(true);
    expect(mock.requests[2]?.headers['if-none-match']).toBeUndefined();
    expect(mock.requests[2]?.headers['if-modified-since']).toBeUndefined();
  });
});

describe('guide interval safety (#288)', () => {
  it('never stages stop <= start for open-ended programmes followed by duplicate or earlier starts', async () => {
    const open = (h: number, title: string, channel = 'cagri') =>
      `<programme start="${xt(h * HOUR)}" channel="${channel}"><title>${title}</title></programme>`;
    const e = await setupGuide(PLAYLIST, { guideUrl: GUIDE_URL });
    expect((await importCatalog(e.sourceId, e.deps)).ok).toBe(true);
    e.server.body = tv(
      channelXml('cagri', 'Çağrı TV'),
      open(4, 'OpenAt4'),
      open(4, 'DupOpenAt4'),
      open(2, 'EarlierOpenAt2'),
      programmeXml('cagri', 1 * HOUR, 1, 'EarlierClosedAt1'),
      programmeXml('cagri', 6 * HOUR, 1, 'ClosedAt6'),
      open(8, 'OpenAt8'),
      programmeXml('cagri', 8 * HOUR, 1, 'DupClosedAt8'),
    );
    const r = await importGuide(e.sourceId, e.deps, { now: NOW });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const bad = await rows(e, 'SELECT title, start, stop FROM programmes WHERE stop <= start');
    expect(bad).toEqual([]);
    const stored = await rows(e, 'SELECT title, start, stop FROM programmes ORDER BY start');
    expect(stored.length).toBeGreaterThanOrEqual(4);
    for (const p of stored) {
      expect(Number(p.stop)).toBeGreaterThan(Number(p.start));
    }
  });

  it('skips malformed stop <= start and non-finite timestamps in closeOpenProgrammes with programme-bad-time', async () => {
    const e = await setupGuide(PLAYLIST, { guideUrl: GUIDE_URL });
    const c = {
      sourceId: e.sourceId,
      runId: 1,
      warnings: 0,
      warningCodes: [] as string[],
    } as RunCtx;
    const open = new Map();
    const out = closeOpenProgrammes(c, open, [
      { channel: 'cagri', start: 1000, title: 'Open1', categories: [] },
      { channel: 'cagri', start: 2000, stop: 2000, title: 'ZeroLen', categories: [] },
      { channel: 'cagri', start: 2000, stop: 1500, title: 'NegativeLen', categories: [] },
      { channel: 'cagri', start: Number.NaN, title: 'NaNStart', categories: [] },
      {
        channel: 'cagri',
        start: Number.POSITIVE_INFINITY,
        stop: 5000,
        title: 'InfStart',
        categories: [],
      },
      { channel: 'cagri', start: 2500, stop: Number.NaN, title: 'NaNStop', categories: [] },
      { channel: 'cagri', start: 3000, stop: 4000, title: 'Valid', categories: [] },
    ]);
    expect(c.warningCodes).toEqual([
      'programme-bad-time',
      'programme-bad-time',
      'programme-bad-time',
      'programme-bad-time',
      'programme-bad-time',
    ]);
    expect(c.warnings).toBe(5);
    expect(out).toHaveLength(2);
    for (const row of out) {
      expect(Number(row[3])).toBeGreaterThan(Number(row[2]));
    }
    expect(out[0]?.[3]).toBe(3000);
  });
});
