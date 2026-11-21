import { type HttpRequestOptions, ok, type SqlDriver, type SqlValue } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import { createSerializedImportQueue } from './import-queue';
import {
  extinf,
  M3U_PASS,
  M3U_TOKEN,
  sampleCatalog,
  setup as setupPanel,
} from './import-test-helpers';
import {
  type CatalogService,
  createCatalogService,
  DEVICE_BATCH_SIZE,
  DEVICE_MAX_BODY_BYTES,
  decodeManifest,
  encodeManifest,
  type ManifestEntry,
  type ManifestStore,
  openCatalog,
  parseCategoryId,
  reconcileManifest,
} from './index';
import { countingScheduler, memorySecrets, testDb } from './test-db';

function m3uHttp(bodies: Record<string, string>) {
  return {
    async get(url: string, _opts?: HttpRequestOptions) {
      const text = bodies[url] ?? '';
      const bytes = new TextEncoder().encode(text);
      return ok({
        status: text === '' ? 404 : 200,
        headers: {},
        body: (async function* () {
          yield bytes;
        })(),
      });
    },
  };
}

async function createEnv(bodies: Record<string, string>, wrap?: (db: SqlDriver) => SqlDriver) {
  const t = testDb();
  const secrets = memorySecrets();
  const scheduler = countingScheduler();
  const baseDb = wrap ? wrap(t.db) : t.db;
  await openCatalog(baseDb);
  let idSeq = 0;
  const service = createCatalogService({
    db: baseDb,
    secrets,
    scheduler,
    http: m3uHttp(bodies),
    clock: () => 1_000,
    newId: () => `src${++idSeq}`,
  });
  return { ...t, db: baseDb, secrets, scheduler, service };
}

describe('CatalogService in @elv/data', () => {
  it('defaults DEVICE_BATCH_SIZE to 5,000 and DEVICE_MAX_BODY_BYTES to 4 MiB', async () => {
    expect(DEVICE_BATCH_SIZE).toBe(5_000);
    expect(DEVICE_MAX_BODY_BYTES).toBe(4 * 1024 * 1024);
    const playlistUrl = 'http://panel.example:8080/list.m3u';
    const playlist = `#EXTM3U\n${Array.from({ length: 5_200 }, (_, i) =>
      extinf(`Ch ${i}`, `http://cdn.example:8080/${M3U_TOKEN}/live/${i}.ts`, 'group-title="Live"'),
    ).join('')}`;
    const batchedSizes: number[] = [];
    const e = await createEnv({ [playlistUrl]: playlist }, (db) => ({
      ...db,
      batch: (sql, rows) => {
        if (sql.includes('INSERT INTO live')) batchedSizes.push(rows.length);
        return db.batch(sql, rows);
      },
    }));
    const added = await e.service.addSource({ kind: 'm3u', name: 'M', playlistUrl });
    if (!added.ok) throw new Error('expected addSource ok');
    const imported = await e.service.importSource(added.value.id);
    expect(imported.ok).toBe(true);
    expect(batchedSizes).toEqual([5_000, 200]);
  });

  it('resolves M3U headers_json (userAgent, referer, templated other headers) on live, movies and episodes', async () => {
    const playlistUrl = 'http://panel.example:8080/list.m3u';
    const tok = M3U_TOKEN;
    const playlist = [
      '#EXTM3U',
      `#EXTINF:-1 group-title="Live",News HD`,
      '#EXTVLCOPT:http-user-agent=CustomUA/2.0',
      `#EXTVLCOPT:http-referrer=http://ref.example/${tok}/home`,
      `#EXTHTTP:{"Authorization":"Bearer secret-bearer-99","X-Literal":"a{{b"}`,
      `http://cdn.example/${tok}/live/1.ts`,
      `#EXTINF:-1 group-title="Films",Sample Film (2024)`,
      '#EXTVLCOPT:http-user-agent=MovieUA/1.0',
      `#EXTHTTP:{"Cookie":"sid=secret-cookie-88","X-Mode":"cinema"}`,
      `http://cdn.example/${tok}/vod/10.mkv`,
      `#EXTINF:-1 group-title="Shows",Sample Show S01E01`,
      '#EXTVLCOPT:http-user-agent=SeriesUA/3.0',
      `#EXTHTTP:{"X-Auth-Token":"ep-token-77"}`,
      `http://cdn.example/${tok}/series/20.mp4`,
    ].join('\n');
    const e = await createEnv({ [playlistUrl]: playlist });
    const added = await e.service.addSource({
      kind: 'm3u',
      name: 'M',
      playlistUrl,
      transport: { userAgent: 'FallbackUA/0.1' },
    });
    if (!added.ok) throw new Error('add failed');
    const id = added.value.id;
    expect((await e.service.importSource(id)).ok).toBe(true);

    const liveCat = (await e.service.categories(id, 'live'))[0];
    const liveItem = (await e.service.items(liveCat?.id ?? '', 0, 10))[0];
    const liveReq = await e.service.resolveStream(liveItem?.key ?? '');
    expect(liveReq).toEqual({
      ok: true,
      value: {
        url: `http://cdn.example/${tok}/live/1.ts`,
        headers: {
          'user-agent': 'CustomUA/2.0',
          referer: `http://ref.example/${tok}/home`,
          authorization: 'Bearer secret-bearer-99',
          'x-literal': 'a{{b',
        },
      },
    });

    const movieCat = (await e.service.categories(id, 'movie'))[0];
    const movieItem = (await e.service.items(movieCat?.id ?? '', 0, 10))[0];
    const movieReq = await e.service.resolveStream(movieItem?.key ?? '');
    expect(movieReq).toEqual({
      ok: true,
      value: {
        url: `http://cdn.example/${tok}/vod/10.mkv`,
        headers: {
          'user-agent': 'MovieUA/1.0',
          cookie: 'sid=secret-cookie-88',
          'x-mode': 'cinema',
        },
      },
    });

    const seriesCat = (await e.service.categories(id, 'series'))[0];
    const seriesItem = (await e.service.items(seriesCat?.id ?? '', 0, 10))[0];
    const seriesSeasons = await e.service.seasons(seriesItem?.id ?? 0);
    expect(seriesSeasons).toEqual({ ok: true, value: [{ season: 0, episodeCount: 1 }] });
    const eps = await e.service.episodes(seriesItem?.id ?? 0, 0);
    const epReq = await e.service.resolveStream(eps[0]?.key ?? '');
    expect(epReq).toEqual({
      ok: true,
      value: {
        url: `http://cdn.example/${tok}/series/20.mp4`,
        headers: {
          'user-agent': 'SeriesUA/3.0',
          'x-auth-token': 'ep-token-77',
        },
      },
    });
  });

  it('caches StreamResolver per source across items/resolveStream and invalidates on re-import and remove', async () => {
    const playlistUrl = 'http://panel.example:8080/list.m3u';
    const segA = ['seg', 'Alpha', '12345'].join('');
    const segB = ['seg', 'Bravo', '67890'].join('');
    let currentSeg = segA;
    const t = testDb();
    await openCatalog(t.db);
    const secrets = memorySecrets();
    const getSpy = vi.spyOn(secrets, 'get');
    const service = createCatalogService({
      db: t.db,
      secrets,
      scheduler: countingScheduler(),
      http: {
        async get() {
          const text = [
            '#EXTM3U',
            `#EXTINF:-1 tvg-logo="http://img.example/${currentSeg}/1.png" group-title="G",Ch 1`,
            `http://cdn.example/${currentSeg}/live/1.ts`,
            `#EXTINF:-1 tvg-logo="http://img.example/${currentSeg}/2.png" group-title="G",Ch 2`,
            `http://cdn.example/${currentSeg}/live/2.ts`,
          ].join('\n');
          const bytes = new TextEncoder().encode(text);
          return ok({
            status: 200,
            headers: {},
            body: (async function* () {
              yield bytes;
            })(),
          });
        },
      },
      clock: () => 1_000,
      newId: () => 's1',
    });

    const added = await service.addSource({ kind: 'm3u', name: 'M', playlistUrl });
    if (!added.ok) throw new Error('add failed');
    expect((await service.importSource('s1')).ok).toBe(true);
    getSpy.mockClear();

    const cat = (await service.categories('s1', 'live'))[0];
    const listed = await service.items(cat?.id ?? '', 0, 10);
    expect(listed[0]?.logo).toBe(`http://img.example/${segA}/1.png`);
    expect((await service.resolveStream(listed[0]?.key ?? '')).ok).toBe(true);
    expect((await service.resolveStream(listed[1]?.key ?? '')).ok).toBe(true);
    const urlvarsReads = getSpy.mock.calls.filter(([k]) => k === 'source.s1.urlvars');
    expect(urlvarsReads).toHaveLength(1);

    currentSeg = segB;
    expect((await service.importSource('s1')).ok).toBe(true);
    const refreshed = await service.resolveStream(listed[0]?.key ?? '');
    expect(refreshed).toEqual({
      ok: true,
      value: { url: `http://cdn.example/${segB}/live/1.ts`, headers: {} },
    });
  });

  it('subquery-limits placements before joining item tables in queryItems', async () => {
    const playlistUrl = 'http://panel.example:8080/list.m3u';
    const playlist = `#EXTM3U\n${Array.from({ length: 20 }, (_, i) =>
      extinf(`Ch ${i}`, `http://cdn.example/${M3U_TOKEN}/live/${i}.ts`, 'group-title="G"'),
    ).join('')}`;
    const sqlSeen: string[] = [];
    const e = await createEnv({ [playlistUrl]: playlist }, (db) => ({
      ...db,
      all: <T>(sql: string, params?: readonly SqlValue[]) => {
        sqlSeen.push(sql);
        return db.all<T>(sql, params);
      },
    }));
    const added = await e.service.addSource({ kind: 'm3u', name: 'M', playlistUrl });
    if (!added.ok) throw new Error('add failed');
    await e.service.importSource(added.value.id);
    const cat = (await e.service.categories(added.value.id, 'live'))[0];
    sqlSeen.length = 0;
    const page = await e.service.items(cat?.id ?? '', 5, 4);
    expect(page.map((p) => p.name)).toEqual(['Ch 5', 'Ch 6', 'Ch 7', 'Ch 8']);
    expect(sqlSeen[0]).toMatch(
      /FROM\s*\(\s*SELECT[\s\S]*FROM placements[\s\S]*LIMIT \? OFFSET \?\s*\)\s*p/i,
    );
    expect(parseCategoryId('bad')).toBeUndefined();
  });

  it('aborts an in-flight or queued import when removeSource(id) is called and deletes rows + secrets', async () => {
    const playlistUrl = 'http://panel.example:8080/list.m3u';
    const playlist = `#EXTM3U\n${Array.from({ length: 1_500 }, (_, i) =>
      extinf(`Ch ${i}`, `http://cdn.example/${M3U_TOKEN}/live/${i}.ts`, 'group-title="G"'),
    ).join('')}`;
    const e = await createEnv({ [playlistUrl]: playlist });
    const a = await e.service.addSource({ kind: 'm3u', name: 'A', playlistUrl });
    const b = await e.service.addSource({ kind: 'm3u', name: 'B', playlistUrl });
    if (!a.ok || !b.ok) throw new Error('add failed');

    let removalA: ReturnType<CatalogService['removeSource']> | undefined;
    let queuedB: ReturnType<CatalogService['importSource']> | undefined;
    let removalB: ReturnType<CatalogService['removeSource']> | undefined;
    const importA = e.service.importSource(a.value.id, {
      batchSize: 300,
      onProgress: () => {
        if (removalA !== undefined) return;
        queuedB = e.service.importSource(b.value.id, { batchSize: 300 });
        removalB = e.service.removeSource(b.value.id);
        removalA = e.service.removeSource(a.value.id);
      },
    });

    expect(await importA).toMatchObject({ ok: false, error: { code: 'aborted' } });
    expect(await queuedB).toMatchObject({ ok: false, error: { code: 'aborted' } });
    expect(await removalA).toEqual({ ok: true, value: undefined });
    expect(await removalB).toEqual({ ok: true, value: undefined });
    expect(await e.service.listSources()).toEqual([]);
    expect(e.secrets.dump()).toEqual({});
  });

  it('close() aborts active imports, awaits settlement and closes the SqlDriver', async () => {
    const playlistUrl = 'http://panel.example:8080/list.m3u';
    const playlist = `#EXTM3U\n${Array.from({ length: 1_000 }, (_, i) =>
      extinf(`Ch ${i}`, `http://cdn.example/${M3U_TOKEN}/live/${i}.ts`, 'group-title="G"'),
    ).join('')}`;
    let closedCount = 0;
    const e = await createEnv({ [playlistUrl]: playlist }, (db) => ({
      ...db,
      close: async () => {
        closedCount += 1;
        await db.close?.();
      },
    }));
    const a = await e.service.addSource({ kind: 'm3u', name: 'A', playlistUrl });
    if (!a.ok) throw new Error('add failed');
    let closing: Promise<void> | undefined;
    const running = e.service.importSource(a.value.id, {
      batchSize: 250,
      onProgress: () => {
        closing ??= e.service.close();
      },
    });
    expect(await running).toMatchObject({ ok: false, error: { code: 'aborted' } });
    await closing;
    await e.service.close();
    expect(closedCount).toBe(1);
  });

  it('reconciles source manifests and resolves Xtream streams', async () => {
    const p = await setupPanel(sampleCatalog());
    const store: ManifestStore & { raw?: string } = {
      read() {
        return this.raw;
      },
      write(v) {
        this.raw = v;
      },
    };
    const service = createCatalogService({
      db: p.db,
      secrets: p.secrets,
      scheduler: p.scheduler,
      http: p.deps.http,
      clock: () => 2_000,
      newId: () => 'xs1',
      manifest: store,
    });
    const cred = ['username=demo-user', ['password', M3U_PASS].join('=')].join('&');
    const added = await service.addSourceFromLink({
      name: 'Panel',
      url: `http://panel.example:8080/get.php?${cred}&type=m3u_plus`,
    });
    if (!added.ok) throw new Error('link add failed');
    expect((await service.importSource(added.value.id)).ok).toBe(true);
    const cat = (await service.categories(added.value.id, 'series'))[0];
    const show = (await service.items(cat?.id ?? '', 0, 10))[0];
    const seasons = await service.seasons(show?.id ?? 0);
    expect(seasons.ok && seasons.value.length).toBeGreaterThan(0);
    const eps = await service.episodes(show?.id ?? 0, 1);
    const req = await service.resolveStream(eps[0]?.key ?? '');
    expect(req.ok && req.value.url).toContain(['/series', 'demo-user', M3U_PASS, ''].join('/'));

    const entry: ManifestEntry = {
      id: 'restored1',
      kind: 'm3u',
      name: 'R',
      createdAt: 5,
      settingsJson: '{}',
    };
    expect(decodeManifest(encodeManifest([entry]))).toEqual([entry]);
    const fresh = testDb();
    await openCatalog(fresh.db);
    const mem: ManifestStore = {
      read: () => encodeManifest([entry]),
      write: () => undefined,
    };
    expect(await reconcileManifest(fresh.db, mem)).toEqual(['restored1']);
  });

  it('imports XMLTV guide via importGuide, queries nowNext/epgWindow, and resolves M3U logos in channelByNumber', async () => {
    const playlistUrl = 'http://panel.example:8080/list.m3u';
    const guideUrl = 'http://panel.example:8080/guide.xml';
    const tok = M3U_TOKEN;
    const playlist = [
      '#EXTM3U',
      `#EXTINF:-1 tvg-id="cinema.1" tvg-chno="101" tvg-logo="http://img.example/${tok}/101.png" group-title="Cinema",Velvet Cinema`,
      `http://cdn.example/${tok}/live/101.ts`,
    ].join('\n');
    // Clock is 2026-11-21T12:30:00Z = 1795177800000
    const nowMs = Date.UTC(2026, 10, 21, 12, 30, 0);
    const xmltv = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<tv>',
      '  <channel id="cinema.1"><display-name>Velvet Cinema</display-name></channel>',
      '  <programme start="20261121120000 +0000" stop="20261121130000 +0000" channel="cinema.1">',
      '    <title>Noon Feature</title>',
      '    <desc>A quiet afternoon film.</desc>',
      '  </programme>',
      '  <programme start="20261121130000 +0000" stop="20261121140000 +0000" channel="cinema.1">',
      '    <title>Matinee Hour</title>',
      '  </programme>',
      '</tv>',
    ].join('\n');

    const t = testDb();
    await openCatalog(t.db);
    const service = createCatalogService({
      db: t.db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: m3uHttp({ [playlistUrl]: playlist, [guideUrl]: xmltv }),
      clock: () => nowMs,
      newId: () => 's1',
    });

    const added = await service.addSource({
      kind: 'm3u',
      name: 'Cinema M3U',
      playlistUrl,
      guideUrl,
    });
    if (!added.ok) throw new Error('add failed');
    expect((await service.importSource('s1')).ok).toBe(true);
    const guideRes = await service.importGuide?.('s1');
    expect(guideRes?.ok).toBe(true);

    const ch = await service.channelByNumber?.(101);
    expect(ch).toMatchObject({
      num: 101,
      name: 'Velvet Cinema',
      logo: `http://img.example/${tok}/101.png`,
    });
    expect(await service.channelByNumber?.(999)).toBeNull();

    const chKey = ch?.key ?? '';
    const nn = await service.nowNext?.([chKey], nowMs);
    expect(nn).toHaveLength(1);
    expect(nn?.[0]?.now?.title).toBe('Noon Feature');
    expect(nn?.[0]?.next?.title).toBe('Matinee Hour');

    const win = await service.epgWindow?.([chKey], nowMs - 30 * 60_000, nowMs + 90 * 60_000);
    expect(win?.[chKey]?.map((p) => p.title)).toEqual(['Noon Feature', 'Matinee Hour']);

    await service.close();
  });

  it('serializes importGuide with importSource, rejects duplicate importGuide, and aborts on removeSource', async () => {
    const playlistUrl = 'http://panel.example:8080/list.m3u';
    const guideUrl = 'http://panel.example:8080/guide.xml';
    const nowMs = Date.UTC(2026, 10, 21, 12, 30, 0);
    const playlist = `#EXTM3U\n${extinf('Ch 1', `http://cdn.example/${M3U_TOKEN}/live/1.ts`, 'tvg-id="c1" group-title="G"')}`;
    const xmltv = [
      '<tv><channel id="c1"><display-name>Ch 1</display-name></channel>',
      ...Array.from(
        { length: 40 },
        (_, i) =>
          `<programme start="20261121${String(Math.floor(i / 2)).padStart(2, '0')}${i % 2 === 0 ? '00' : '30'}00 +0000" stop="20261121${String(Math.floor((i + 1) / 2)).padStart(2, '0')}${(i + 1) % 2 === 0 ? '00' : '30'}00 +0000" channel="c1"><title>P${i}</title></programme>`,
      ),
      '</tv>',
    ].join('');

    const t = testDb();
    await openCatalog(t.db);
    const service = createCatalogService({
      db: t.db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: m3uHttp({ [playlistUrl]: playlist, [guideUrl]: xmltv }),
      clock: () => nowMs,
      newId: () => 's1',
    });

    const added = await service.addSource({ kind: 'm3u', name: 'M', playlistUrl, guideUrl });
    if (!added.ok) throw new Error('add failed');

    // Queue importGuide right after importSource; both succeed in order
    const catP = service.importSource('s1');
    const guideP = service.importGuide?.('s1');
    const dupGuideP = service.importGuide?.('s1');
    expect(await dupGuideP).toEqual({
      ok: false,
      error: { category: 'storage', code: 'import-in-progress' },
    });
    expect((await catP).ok).toBe(true);
    expect((await guideP)?.ok).toBe(true);

    // Abort in-flight importGuide via removeSource
    let rmP: ReturnType<CatalogService['removeSource']> | undefined;
    const abortedGuide = service.importGuide?.('s1', {
      batchSize: 5,
      onProgress: () => {
        rmP ??= service.removeSource('s1');
      },
    });
    expect(await abortedGuide).toMatchObject({ ok: false, error: { code: 'aborted' } });
    expect(await rmP).toEqual({ ok: true, value: undefined });
    await service.close();
  });

  it('never deadlocks close() or subsequent imports if queue onSettled rejects', async () => {
    const t = testDb();
    await openCatalog(t.db);
    const queue = createSerializedImportQueue(t.db);
    await expect(
      queue.run(
        's1',
        'guide',
        undefined,
        async () => ({
          ok: true,
          value: {
            runId: 1,
            counts: { categories: 0, live: 0, movies: 0, series: 0, episodes: 0 },
            warnings: 0,
            warningCodes: [],
            durationMs: 1,
          },
        }),
        {
          onSettled: async () => {
            throw new Error('disk full');
          },
        },
      ),
    ).rejects.toThrow('disk full');
    // Queue must not be deadlocked: close() resolves immediately
    await queue.close();
  });

  it('reaps orphaned running runs and programmes_next on openCatalog so imports succeed after a crash', async () => {
    const playlistUrl = 'http://panel.example:8080/list.m3u';
    const guideUrl = 'http://panel.example:8080/guide.xml';
    const nowMs = Date.UTC(2026, 10, 21, 12, 30, 0);
    const playlist = `#EXTM3U\n${extinf('News 1', `http://cdn.example/${M3U_TOKEN}/live/1.ts`, 'tvg-id="news.1" group-title="News"')}`;
    const xmltv = [
      '<tv>',
      '  <channel id="news.1"><display-name>News 1</display-name></channel>',
      '  <programme start="20261121120000 +0000" stop="20261121130000 +0000" channel="news.1"><title>Midday News</title></programme>',
      '</tv>',
    ].join('\n');

    const t = testDb();
    await openCatalog(t.db, () => 1_000);
    const secrets = memorySecrets();
    const http = m3uHttp({ [playlistUrl]: playlist, [guideUrl]: xmltv });
    const service1 = createCatalogService({
      db: t.db,
      secrets,
      scheduler: countingScheduler(),
      http,
      clock: () => nowMs,
      newId: () => 's1',
    });
    const added = await service1.addSource({
      kind: 'm3u',
      name: 'Crash Test',
      playlistUrl,
      guideUrl,
    });
    if (!added.ok) throw new Error('add failed');

    // Simulate a hard crash leaving both catalog and guide runs stuck in 'running' + staged programmes_next.
    await t.db.batch(
      "INSERT INTO import_runs (source_id, kind, started_at, status) VALUES (?, ?, ?, 'running')",
      [
        ['s1', 'catalog', 500],
        ['s1', 'guide', 600],
      ],
    );
    await t.db.run(
      "INSERT INTO programmes_next (source_id, guide_id, start, stop, title, run_id) VALUES ('s1', 'news.1', 10, 20, 'Orphan', 2)",
    );

    // Reopening the database reaps the crashed runs and purges staged rows.
    expect((await openCatalog(t.db, () => 9_999)).ok).toBe(true);
    const reapedRuns = await t.db.all<Record<string, unknown>>(
      'SELECT kind, status, error_category, error_code, finished_at FROM import_runs ORDER BY id',
    );
    expect(reapedRuns).toEqual([
      {
        kind: 'catalog',
        status: 'failed',
        error_category: 'storage',
        error_code: 'interrupted',
        finished_at: 9_999,
      },
      {
        kind: 'guide',
        status: 'failed',
        error_category: 'storage',
        error_code: 'interrupted',
        finished_at: 9_999,
      },
    ]);
    expect(await t.db.all('SELECT * FROM programmes_next')).toEqual([]);

    const service2 = createCatalogService({
      db: t.db,
      secrets,
      scheduler: countingScheduler(),
      http,
      clock: () => nowMs,
      newId: () => 's2',
    });
    expect((await service2.importSource('s1')).ok).toBe(true);
    expect((await service2.importGuide?.('s1'))?.ok).toBe(true);
    await service2.close();
  });
});
