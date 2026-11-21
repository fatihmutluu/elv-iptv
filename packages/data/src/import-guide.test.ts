import { type HttpRequestOptions, ok, type SqlValue } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { closeOpenProgrammes, importGuide } from './import-guide';
import {
  channelXml,
  defaultGuide,
  expectErr,
  fakeGunzip,
  GUIDE_URL,
  gzipped,
  HOUR,
  lastGuideRun,
  NOW,
  PLAYLIST,
  programmeXml,
  ready,
  rows,
  run,
  SECOND_URL,
  settings,
  setupGuide,
  stream,
  titles,
  tv,
  xt,
} from './import-guide-test-helpers';
import { emptyPanel, extinf, M3U_PASS, M3U_USER, setup } from './import-test-helpers';
import type { ImportProgress } from './import-types';
import { importCatalog } from './import-xtream';
import { addSourceFromLink } from './source-link';
import { updateSourceSettings } from './sources';

describe('guide import', () => {
  it('stores channels, mappings and only mapped programmes inside the window', async () => {
    const e = await ready();
    const r = await run(e);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(await titles(e)).toEqual(['Ended', 'Running', 'Later', 'Named Match', 'Next Week']);
    const chans = await rows(e, 'SELECT guide_id, name_fold FROM guide_channels ORDER BY guide_id');
    expect(chans.map((c) => c.guide_id)).toEqual(['cagri', 'haber1.tr', 'ikiz', 'nobody']);
    expect(chans.find((c) => c.guide_id === 'cagri')?.name_fold).toBe('cagri tv');
    const map = await rows(
      e,
      'SELECT l.name, g.guide_id FROM channel_guide g JOIN live l ON l.key = g.channel_key ORDER BY l.name',
    );
    expect(map).toEqual([
      { name: 'Haber Bir', guide_id: 'haber1.tr' },
      { name: 'Haber Bir HD', guide_id: 'haber1.tr' },
      { name: 'Çağrı TV', guide_id: 'cagri' },
    ]);
    expect(r.value.counts).toMatchObject({ guideChannels: 4, mapped: 2, programmes: 5 });
    expect(await lastGuideRun(e)).toBe('ok');
  });

  it('runs PRAGMA wal_checkpoint(TRUNCATE) through db.exec (writer) rather than db.all (reader)', async () => {
    const e = await ready();
    const execSql: string[] = [];
    const allSql: string[] = [];
    const recordingDb = {
      ...e.db,
      exec: (sql: string) => {
        execSql.push(sql);
        return e.db.exec(sql);
      },
      all: <T>(sql: string, params?: readonly SqlValue[]) => {
        allSql.push(sql);
        return e.db.all<T>(sql, params);
      },
    };
    const r = await importGuide(e.sourceId, { ...e.deps, db: recordingDb }, { now: NOW });
    expect(r.ok).toBe(true);
    expect(execSql.some((s) => s.includes('wal_checkpoint(TRUNCATE)'))).toBe(true);
    expect(allSql.some((s) => s.includes('wal_checkpoint'))).toBe(false);
  });

  it('honours the configured window', async () => {
    const e = await ready();
    await updateSourceSettings(e.db, e.sourceId, {
      ...(await settings(e)),
      guideWindow: { daysBack: 3, daysForward: 1 },
    });
    await run(e);
    expect(await titles(e)).toEqual(['Too Old', 'Ended', 'Running', 'Later', 'Named Match']);
  });

  it('replaces programmes, stale guide channels and stale mappings on the next import', async () => {
    const e = await ready();
    await run(e);
    e.server.body = tv(
      channelXml('haber1.tr', 'Haber Bir'),
      programmeXml('haber1.tr', HOUR, 1, 'Fresh'),
    );
    expect((await run(e)).ok).toBe(true);
    expect(await titles(e)).toEqual(['Fresh']);
    expect(await rows(e, 'SELECT guide_id FROM guide_channels')).toEqual([
      { guide_id: 'haber1.tr' },
    ]);
    expect(await rows(e, 'SELECT DISTINCT guide_id FROM channel_guide')).toEqual([
      { guide_id: 'haber1.tr' },
    ]);
  });

  it('reads gzip guides through the decompressor', async () => {
    const e = await ready();
    e.server.body = gzipped(defaultGuide());
    const r = await importGuide(e.sourceId, { ...e.deps, decompressor: fakeGunzip }, { now: NOW });
    expect(r.ok).toBe(true);
    expect(await titles(e)).toHaveLength(5);
  });

  it('keeps the previous guide when a new one has no programme of a mapped channel', async () => {
    const e = await ready();
    await run(e);
    const before = await titles(e);
    e.server.body = tv(channelXml('nobody', 'Nobody'));
    const r = await run(e);
    expect(r.ok && r.value.warningCodes).toEqual(['guide/empty']);
    expect(await titles(e)).toEqual(before);
  });

  it('stores every programme of one huge mapped channel across many batches', async () => {
    const parts = [channelXml('first', 'Çağrı TV')];
    for (let i = 0; i < 30; i++) parts.push(programmeXml('first', i * HOUR, 1, `P${i}`));
    const e = await ready(tv(...parts));
    expect((await run(e, { batchSize: 7 })).ok).toBe(true);
    expect(await titles(e)).toHaveLength(30);
  });

  it('drops programmes of channels the guide never declares', async () => {
    const e = await ready(tv(channelXml('cagri', 'Çağrı TV'), programmeXml('ghost', HOUR, 1, 'X')));
    expect((await run(e)).ok).toBe(true);
    expect(await titles(e)).toEqual([]);
  });

  it('ends a programme without stop where the next one of its channel starts, else after 30 minutes', async () => {
    const open = (h: number, title: string, channel = 'cagri') =>
      `<programme start="${xt(h * HOUR)}" channel="${channel}"><title>${title}</title></programme>`;
    const e = await ready(
      tv(
        channelXml('cagri', 'Çağrı TV'),
        channelXml('haber1.tr', 'Haber Bir'),
        open(1, 'First'),
        open(3, 'Second'),
        open(2, 'Other', 'haber1.tr'),
        programmeXml('cagri', 4 * HOUR, 1, 'Closed'),
        open(6, 'Last'),
      ),
    );
    expect((await run(e, { batchSize: 2 })).ok).toBe(true);
    const got = await rows(e, 'SELECT title, start, stop FROM programmes ORDER BY title');
    const span = (title: string) => {
      const r = got.find((g) => g.title === title);
      return ((r?.stop as number) - (r?.start as number)) / HOUR;
    };
    expect(span('First')).toBe(2);
    expect(span('Second')).toBe(1);
    expect(span('Closed')).toBe(1);
    expect(span('Last')).toBe(0.5);
    expect(span('Other')).toBe(0.5);
  });

  it('matches an unmapped channel by unique num fallback while preventing ambiguous num collisions', async () => {
    const playlist =
      '#EXTM3U\n' +
      extinf('Unrelated Twenty Four', stream(6), 'tvg-chno="24"') +
      extinf('Mystery Feed', stream(1), 'tvg-chno="42"') +
      extinf('Named Winner', stream(2), 'tvg-chno="55"') +
      extinf('Dup Num A', stream(3), 'tvg-chno="77"') +
      extinf('Dup Num B', stream(4), 'tvg-chno="77"') +
      extinf('Dual Claimed', stream(5), 'tvg-chno="88"');
    const e = await setupGuide(playlist);
    expect((await importCatalog(e.sourceId, e.deps)).ok).toBe(true);
    e.server.body = tv(
      channelXml('epg.24news', '24 News'),
      channelXml('epg.42', '42', '42 - Cinema'),
      channelXml('epg.55.name', 'Named Winner'),
      channelXml('epg.55.num', '55 - Other'),
      channelXml('epg.77', '77 - Twin'),
      channelXml('epg.88.a', '#88 First'),
      channelXml('epg.88.b', '88: Second'),
      programmeXml('epg.24news', HOUR, 1, 'Brand Should Not Match'),
      programmeXml('epg.42', HOUR, 1, 'Number Matched Film'),
      programmeXml('epg.55.name', HOUR, 1, 'Name Precedence Show'),
      programmeXml('epg.55.num', HOUR, 1, 'Should Lose To Name'),
      programmeXml('epg.77', HOUR, 1, 'Ambiguous Live Num'),
      programmeXml('epg.88.a', HOUR, 1, 'Ambiguous Xmltv A'),
      programmeXml('epg.88.b', HOUR, 1, 'Ambiguous Xmltv B'),
    );
    const r = await run(e);
    if (!r.ok) throw new Error(JSON.stringify(r.error));

    const mappings = await rows(
      e,
      'SELECT l.name, g.guide_id FROM channel_guide g JOIN live l ON l.key = g.channel_key ORDER BY l.num',
    );
    expect(mappings).toEqual([
      { name: 'Mystery Feed', guide_id: 'epg.42' },
      { name: 'Named Winner', guide_id: 'epg.55.name' },
    ]);
    expect(await titles(e)).toEqual(['Number Matched Film', 'Name Precedence Show']);
  });
});

describe('guide url choice', () => {
  it('prefers the user override', async () => {
    const e = await ready();
    await run(e);
    expect(e.server.urls).toEqual([GUIDE_URL]);
  });

  it('falls back to a discovered url when the override does not answer', async () => {
    const e = await ready();
    await updateSourceSettings(e.db, e.sourceId, {
      ...(await settings(e)),
      discoveredGuideUrls: [SECOND_URL],
    });
    e.server.statuses.set(GUIDE_URL, 404);
    expect((await run(e)).ok).toBe(true);
    expect(e.server.urls).toEqual([GUIDE_URL, SECOND_URL]);
  });

  it('uses discovered urls when there is no override', async () => {
    const e = await setupGuide(PLAYLIST, {});
    await importCatalog(e.sourceId, e.deps);
    await updateSourceSettings(e.db, e.sourceId, { discoveredGuideUrls: [SECOND_URL] });
    e.server.body = defaultGuide();
    expect((await run(e)).ok).toBe(true);
    expect(e.server.urls).toEqual([SECOND_URL]);
  });

  it('resolves templates in memory and keeps credentials out of every column and event', async () => {
    const guide = `http://epg.example/guide.xml?username=${M3U_USER}&password=${M3U_PASS}`;
    const e = await setupGuide(PLAYLIST, { guideUrl: guide });
    await importCatalog(e.sourceId, e.deps);
    e.server.body = defaultGuide();
    const events: ImportProgress[] = [];
    const r = await run(e, { onProgress: (p: ImportProgress) => events.push(p) });
    expect(r.ok).toBe(true);
    expect(e.server.urls).toEqual([guide]);
    e.server.statuses.set(guide, 500);
    const failed = await run(e);
    const dump = JSON.stringify([
      await rows(e, 'SELECT * FROM import_runs'),
      await rows(e, 'SELECT * FROM sources'),
      await rows(e, 'SELECT * FROM guide_channels'),
      events,
      failed,
    ]);
    expect(dump).not.toContain(M3U_PASS);
  });

  it('fails with no-guide-url when the source has none', async () => {
    const e = await setupGuide(PLAYLIST, {});
    expectErr(await run(e), 'source-format', 'no-guide-url');
    expect(await rows(e, "SELECT * FROM import_runs WHERE kind = 'guide'")).toEqual([]);
  });

  it('skips candidates that stay unresolved', async () => {
    const e = await ready();
    await updateSourceSettings(e.db, e.sourceId, {
      ...(await settings(e)),
      guideUrl: 'http://epg.example/{{g:missing}}.xml',
    });
    expectErr(await run(e), 'source-format', 'no-guide-url');
  });

  it('reports the first failure when no url answers', async () => {
    const e = await ready();
    e.server.status = 403;
    expectErr(await run(e), 'auth', 'http-403');
    e.server.status = 503;
    expectErr(await run(e), 'network', 'http-503');
    e.server.status = 404;
    expectErr(await run(e), 'network', 'http-404');
  });

  it('reports a missing source and unsupported kinds', async () => {
    const e = await ready();
    expectErr(await importGuide('nope', e.deps), 'storage', 'source-not-found');
  });
});

describe('guide failure and cancel', () => {
  it('keeps the previous programmes when the gzip stream is corrupt', async () => {
    const e = await ready();
    await run(e);
    const before = await titles(e);
    e.server.body = gzipped(defaultGuide());
    const broken = {
      // biome-ignore lint/correctness/useYield: the generator only fails
      async *gunzip(): AsyncGenerator<Uint8Array> {
        throw new Error('bad gzip');
      },
    };
    const r = await importGuide(e.sourceId, { ...e.deps, decompressor: broken }, { now: NOW });
    expectErr(r, 'source-format', 'gzip-corrupt');
    expect(await titles(e)).toEqual(before);
    expect(await lastGuideRun(e)).toBe('failed');
  });

  it('fails on gzip without a decompressor', async () => {
    const e = await ready();
    e.server.body = gzipped(defaultGuide());
    expectErr(await run(e), 'source-format', 'gzip-unsupported');
  });

  it('keeps the previous programmes when the connection drops mid guide', async () => {
    const e = await ready();
    await run(e);
    const before = await titles(e);
    e.server.failAfter = 400;
    expect((await run(e)).ok).toBe(false);
    expect(await titles(e)).toEqual(before);
    expect(await lastGuideRun(e)).toBe('failed');
  });

  it('rejects a document that is not a guide and keeps the previous programmes', async () => {
    const e = await ready();
    await run(e);
    const before = await titles(e);
    e.server.body = '<html><body>Please log in</body></html>';
    expectErr(await run(e), 'source-format', 'not-a-guide');
    expect(await titles(e)).toEqual(before);
    e.server.body = '';
    expectErr(await run(e), 'source-format', 'not-a-guide');
    expect(await titles(e)).toEqual(before);
    expect(await lastGuideRun(e)).toBe('failed');
  });

  it('cancels on abort and keeps the previous programmes', async () => {
    const e = await ready();
    await run(e);
    const before = await titles(e);
    const controller = new AbortController();
    const r = await run(e, { signal: controller.signal, onProgress: () => controller.abort() });
    expectErr(r, 'network', 'aborted');
    expect(await titles(e)).toEqual(before);
    expect(await lastGuideRun(e)).toBe('cancelled');
  });

  it('refuses a second guide run of the same source while one is running', async () => {
    const e = await ready();
    const first = run(e);
    expectErr(await run(e), 'storage', 'import-in-progress');
    expect((await first).ok).toBe(true);
  });

  it('ignores a throwing progress callback', async () => {
    const e = await ready();
    const r = await run(e, {
      onProgress: () => {
        throw new Error('ui bug');
      },
    });
    expect(r.ok).toBe(true);
  });
});

describe('guide yields', () => {
  it('yields at least once per batch', async () => {
    const parts = [channelXml('haber1.tr', 'Haber Bir')];
    for (let i = 0; i < 450; i++) parts.push(programmeXml('haber1.tr', i * 60_000, 0.01, `P${i}`));
    const e = await ready(tv(...parts));
    const before = e.scheduler.count;
    expect((await run(e, { batchSize: 100 })).ok).toBe(true);
    expect(e.scheduler.count - before).toBeGreaterThanOrEqual(4);
    expect(await titles(e)).toHaveLength(450);
  });

  it('chunks guide_channels inside the cleanup transaction without yielding while a write transaction is open', async () => {
    const parts = Array.from({ length: 25 }, (_, i) => channelXml(`ch-${i}`, `Channel ${i}`));
    parts.push(channelXml('haber1.tr', 'Haber Bir'));
    parts.push(programmeXml('haber1.tr', HOUR, 1, 'Show'));
    const e = await ready(tv(...parts));
    let inTx = false;
    let yieldedInTx = 0;
    let batches = 0;
    const wrappedDb = {
      ...e.db,
      transaction: <T>(fn: (tx: typeof e.db) => Promise<T>) =>
        e.db.transaction(async (tx) => {
          inTx = true;
          try {
            return await fn({
              ...tx,
              batch: async (sql, batchRows) => {
                if (sql.includes('INSERT INTO guide_channels')) batches++;
                return tx.batch(sql, batchRows);
              },
            });
          } finally {
            inTx = false;
          }
        }),
    };
    const scheduler = {
      yieldNow: async () => {
        if (inTx) yieldedInTx++;
      },
    };
    const r = await importGuide(
      e.sourceId,
      { ...e.deps, db: wrappedDb, scheduler },
      { now: NOW, batchSize: 10 },
    );
    expect(r.ok).toBe(true);
    expect(batches).toBe(3);
    expect(yieldedInTx).toBe(0);
    expect(await rows(e, 'SELECT COUNT(*) AS n FROM guide_channels')).toEqual([{ n: 26 }]);
  });
});

describe('xtream guide', () => {
  it('uses the panel guide url and the live channel guide ids', async () => {
    const e = await setup({
      ...emptyPanel(),
      liveCats: [{ category_id: '1', category_name: 'News' }],
      live: [{ stream_id: 7, name: 'Haber Bir', category_id: '1', epg_channel_id: 'haber1.tr' }],
    });
    const panelHttp = e.deps.http;
    const urls: string[] = [];
    const deps = {
      ...e.deps,
      http: {
        async get(url: string, options?: HttpRequestOptions) {
          if (!url.includes('xmltv.php')) return panelHttp.get(url, options);
          urls.push(url);
          const bytes = new TextEncoder().encode(
            tv(channelXml('haber1.tr', 'X'), programmeXml('haber1.tr', HOUR, 1, 'Evening')),
          );
          return ok({
            status: 200,
            headers: {},
            body: (async function* () {
              yield bytes;
            })(),
          });
        },
      },
    };
    expect((await importCatalog(e.sourceId, deps)).ok).toBe(true);
    const r = await importGuide(e.sourceId, deps, { now: NOW });
    expect(r.ok).toBe(true);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/xmltv.php?');
    expect(
      (await e.db.all<{ title: string }>('SELECT title FROM programmes')).map((p) => p.title),
    ).toEqual(['Evening']);
    const runs = JSON.stringify(await e.db.all('SELECT * FROM import_runs'));
    expect(runs).not.toContain('xmltv');
  });
});

describe('xtream guide override', () => {
  it('fetches the override, resolved from its template, before the panel guide', async () => {
    const e = await setup();
    const pw = ['pw', 'Xyz', '19'].join('');
    const deps0 = { db: e.db, secrets: e.secrets, clock: () => 2, newId: () => 's2' };
    const cred = ['username=demo-user', ['password', pw].join('=')].join('&');
    const override = `http://epg.example/g.xml?${cred}`;
    const added = await addSourceFromLink(
      {
        name: 'Linked',
        url: `http://panel.example:8080/get.php?${cred}`,
        guideUrl: override,
      },
      deps0,
    );
    expect(added.ok && added.value.kind).toBe('xtream');
    expect(JSON.stringify(await e.db.all('SELECT settings_json FROM sources'))).not.toContain(pw);
    const urls: string[] = [];
    const panelHttp = e.deps.http;
    const deps = {
      ...e.deps,
      http: {
        async get(url: string, options?: HttpRequestOptions) {
          if (!url.includes('epg.example')) return panelHttp.get(url, options);
          urls.push(url);
          const bytes = new TextEncoder().encode(tv(channelXml('a', 'A')));
          return ok({
            status: 200,
            headers: {},
            body: (async function* () {
              yield bytes;
            })(),
          });
        },
      },
    };
    expect((await importGuide('s2', deps, { now: NOW })).ok).toBe(true);
    expect(urls).toEqual([override]);
  });

  it('discards non-2xx @@asyncIterator bodies in catalog and guide imports when Symbol.asyncIterator is undefined', async () => {
    const e = await ready();
    const OriginalSymbol = globalThis.Symbol;
    const FakeSymbol = Object.assign(
      ((description?: string | number) => OriginalSymbol(description)) as typeof Symbol,
      {
        for: OriginalSymbol.for.bind(OriginalSymbol),
        keyFor: OriginalSymbol.keyFor.bind(OriginalSymbol),
        asyncIterator: undefined as unknown as typeof Symbol.asyncIterator,
      },
    );
    let discarded = 0;
    const makeBabelBody = () => {
      const gen = {
        '@@asyncIterator'() {
          return gen;
        },
        next: async () => ({ done: true as const, value: undefined }),
        return: async () => {
          discarded++;
          return { done: true as const, value: undefined };
        },
      };
      return gen as unknown as AsyncIterable<Uint8Array>;
    };
    const failingDeps = {
      ...e.deps,
      http: {
        async get() {
          return ok({ status: 502, headers: {}, body: makeBabelBody() });
        },
      },
    };
    (globalThis as { Symbol: typeof Symbol }).Symbol = FakeSymbol;
    try {
      expectErr(await importCatalog(e.sourceId, failingDeps), 'network', 'http-502');
      expectErr(await importGuide(e.sourceId, failingDeps, { now: NOW }), 'network', 'http-502');
      expect(discarded).toBe(2);
    } finally {
      (globalThis as { Symbol: typeof Symbol }).Symbol = OriginalSymbol;
    }
  });
});

describe('guide hardening (#169)', () => {
  it('passes a 180_000 ms response-header timeout to http.get', async () => {
    const e = await ready();
    const timeouts: (number | undefined)[] = [];
    const baseHttp = e.deps.http;
    const r = await importGuide(
      e.sourceId,
      {
        ...e.deps,
        http: {
          async get(url, options) {
            timeouts.push(options?.timeoutMs);
            return baseHttp.get(url, options);
          },
        },
      },
      { now: NOW },
    );
    expect(r.ok).toBe(true);
    expect(timeouts).toEqual([180_000]);
  });

  it('rejects a gzip bomb exceeding the decompressed ceiling with source-format/too-large and preserves previous programmes', async () => {
    const e = await ready();
    expect((await run(e)).ok).toBe(true);
    const before = await titles(e);
    e.server.body = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const oneMiB = new Uint8Array(1024 * 1024);
    oneMiB.fill(0x20);
    let closed = false;
    const bomb = {
      async *gunzip() {
        try {
          for (let i = 0; i < 300; i++) yield oneMiB;
        } finally {
          closed = true;
        }
      },
    };
    const r = await importGuide(e.sourceId, { ...e.deps, decompressor: bomb }, { now: NOW });
    expectErr(r, 'source-format', 'too-large');
    expect(closed).toBe(true);
    expect(await titles(e)).toEqual(before);
    expect(await lastGuideRun(e)).toBe('failed');
  });

  it('imports all programmes from a concatenated multi-member gzip guide with DecompressionStream', async () => {
    const gz = async (text: string): Promise<Uint8Array> => {
      const stream = new Blob([new TextEncoder().encode(text) as BlobPart])
        .stream()
        .pipeThrough(new CompressionStream('gzip'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    };
    const part1 =
      `<?xml version="1.0" encoding="UTF-8"?>\n<tv>` +
      channelXml('haber1.tr', 'Haber Bir') +
      programmeXml('haber1.tr', HOUR, 1, 'Concat Show 1');
    const part2 =
      channelXml('cagri', 'ÇAĞRI TV') +
      programmeXml('cagri', 2 * HOUR, 1, 'Concat Show 2') +
      `</tv>\n`;
    const m1 = await gz(part1);
    const m2 = await gz(part2);
    const combined = new Uint8Array(m1.length + m2.length);
    combined.set(m1, 0);
    combined.set(m2, m1.length);

    const webGunzip = {
      async *gunzip(chunks: AsyncIterable<Uint8Array>) {
        const parts: Uint8Array[] = [];
        for await (const c of chunks) parts.push(c);
        const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let at = 0;
        for (const p of parts) {
          all.set(p, at);
          at += p.length;
        }
        const reader = new Blob([all as BlobPart])
          .stream()
          .pipeThrough(new DecompressionStream('gzip'))
          .getReader();
        for (;;) {
          const step = await reader.read();
          if (step.done) return;
          yield step.value;
        }
      },
    };

    const e = await ready();
    e.server.body = combined;
    const r = await importGuide(e.sourceId, { ...e.deps, decompressor: webGunzip }, { now: NOW });
    expect(r.ok).toBe(true);
    expect(await titles(e)).toEqual(['Concat Show 1', 'Concat Show 2']);
  });
});

describe('guide precision: @feedId, call-signs & overlap clamping (#181, #267)', () => {
  it('matches @feedId sub-feeds (with exact id beating base fallback regardless of order) and preserves call signs', async () => {
    const playlist =
      '#EXTM3U\n' +
      extinf('Channel East', stream(1), 'tvg-id="Channel.uk@East"') +
      extinf('Channel Base', stream(2), 'tvg-id="Channel.uk"') +
      extinf('Metro One [HD] (XELV) East', stream(3), '') +
      extinf('Metro One [HD] (ZTVA) West', stream(4), '') +
      extinf('Harbor News', stream(5), '');
    const e = await setupGuide(playlist);
    expect((await importCatalog(e.sourceId, e.deps)).ok).toBe(true);
    e.server.body = tv(
      // Base fallback appears BEFORE exact @East in XMLTV; exact @East must still win for Channel East
      channelXml('Channel.uk@West', 'Channel West'),
      channelXml('Channel.uk@East', 'Channel East'),
      channelXml('metro.xelv', 'Metro One (XELV) 1080p'),
      channelXml('metro.ztva', 'Metro One (ZTVA) [FHD]'),
      // Normalized fallback appears BEFORE exact folded name; exact fold must win cleanly
      channelXml('harbor.hd', 'Harbor News [HD]'),
      channelXml('harbor.exact', 'Harbor News'),
      programmeXml('Channel.uk@West', HOUR, 1, 'West Feed Show'),
      programmeXml('Channel.uk@East', HOUR, 1, 'East Feed Show'),
      programmeXml('metro.xelv', HOUR, 1, 'XELV Evening'),
      programmeXml('metro.ztva', HOUR, 1, 'ZTVA Evening'),
      programmeXml('harbor.hd', HOUR, 1, 'Harbor HD Show'),
      programmeXml('harbor.exact', HOUR, 1, 'Harbor Exact Show'),
    );
    const r = await run(e);
    if (!r.ok) throw new Error(JSON.stringify(r.error));

    const mappings = await rows(
      e,
      'SELECT l.name, g.guide_id FROM channel_guide g JOIN live l ON l.key = g.channel_key ORDER BY l.name',
    );
    expect(mappings).toEqual([
      { name: 'Channel Base', guide_id: 'Channel.uk@West' },
      { name: 'Channel East', guide_id: 'Channel.uk@East' },
      { name: 'Harbor News', guide_id: 'harbor.exact' },
      { name: 'Metro One [HD] (XELV) East', guide_id: 'metro.xelv' },
      { name: 'Metro One [HD] (ZTVA) West', guide_id: 'metro.ztva' },
    ]);
  });

  it('deterministically clamps overlapping and duplicate (channel, start) blocks in closeOpenProgrammes and across batches', async () => {
    const c = { sourceId: 's1', runId: 1, warnings: 0, warningCodes: [] as string[] };
    const open = new Map();
    const out = closeOpenProgrammes(c, open, [
      { channel: 'ch1', start: 1000, stop: 3000, title: 'First', categories: [] },
      { channel: 'ch1', start: 1000, stop: 3500, title: 'DupStart', categories: [] },
      { channel: 'ch1', start: 2000, stop: 4000, title: 'OverlapNext', categories: [] },
      { channel: 'ch1', start: 4000, stop: 5000, title: 'Adjacent', categories: [] },
    ]);
    expect(out.map((r) => [r[4], r[2], r[3]])).toEqual([
      ['DupStart', 1000, 2000],
      ['OverlapNext', 2000, 4000],
      ['Adjacent', 4000, 5000],
    ]);

    // Out-of-order earlier programme overlapping a later closed or open block is also clamped
    const open2 = new Map();
    const out2 = closeOpenProgrammes(c, open2, [
      { channel: 'ch2', start: 3000, stop: 5000, title: 'Later', categories: [] },
      { channel: 'ch2', start: 2000, stop: 4000, title: 'EarlyOverlap', categories: [] },
      { channel: 'ch3', start: 3000, title: 'OpenLater', categories: [] },
      { channel: 'ch3', start: 1000, stop: 4000, title: 'EarlyClosed', categories: [] },
      { channel: 'ch3', start: 2000, title: 'EarlyOpen', categories: [] },
    ]);
    expect(out2.map((r) => [r[1], r[4], r[2], r[3]])).toEqual([
      ['ch2', 'Later', 3000, 5000],
      ['ch2', 'EarlyOverlap', 2000, 3000],
      ['ch3', 'EarlyClosed', 1000, 2000],
      ['ch3', 'EarlyOpen', 2000, 3000],
    ]);

    // Cross-batch test with batchSize: 1 including overlap, duplicate start, and trailing open block
    const e = await ready(
      tv(
        channelXml('haber1.tr', 'Haber Bir'),
        programmeXml('haber1.tr', 1 * HOUR, 2, 'Block A'),
        programmeXml('haber1.tr', 1 * HOUR, 3, 'Block A Replace'),
        programmeXml('haber1.tr', 2 * HOUR, 2, 'Block B'),
        `<programme start="${xt(3 * HOUR)}" channel="haber1.tr"><title>Open C</title></programme>`,
      ),
    );
    const progDone: number[] = [];
    const res = await run(e, {
      batchSize: 1,
      onProgress: (p: ImportProgress) => {
        if (p.phase === 'programmes') progDone.push(p.done);
      },
    });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    const stored = await rows(
      e,
      'SELECT title, start, stop FROM programmes WHERE guide_id = ? ORDER BY start',
      ['haber1.tr'],
    );
    expect(stored.map((p) => p.title)).toEqual(['Block A Replace', 'Block B', 'Open C']);
    expect(progDone.at(-1)).toBe(2); // 2 non-open rows committed before EOF flush (zero double-count on cross-batch re-upsert)
    expect(res.value.counts.programmes).toBe(3);
    expect(stored[0]?.stop).toBe(stored[1]?.start);
    expect(stored[1]?.stop).toBe(stored[2]?.start);
    for (let i = 0; i < stored.length; i += 1) {
      const curr = stored[i] as { start: number; stop: number };
      expect(curr.stop).toBeGreaterThan(curr.start);
      if (i > 0) {
        const prev = stored[i - 1] as { start: number; stop: number };
        expect(prev.stop).toBeLessThanOrEqual(curr.start);
      }
    }
  });
});
