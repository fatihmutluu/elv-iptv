import { type HttpRequestOptions, ok } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { importGuide } from './import-guide';
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
  titles,
  tv,
  xt,
} from './import-guide-test-helpers';
import { emptyPanel, M3U_PASS, M3U_USER, setup } from './import-test-helpers';
import type { ImportProgress } from './import-types';
import { importCatalog } from './import-xtream';
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

  it('accepts a guide whose mapped channels have no programmes', async () => {
    const e = await ready();
    await run(e);
    e.server.body = tv(channelXml('nobody', 'Nobody'));
    expect((await run(e)).ok).toBe(true);
    expect(await titles(e)).toEqual([]);
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
    expectErr(await run(e), 'auth', 'unauthorized');
    e.server.status = 503;
    expectErr(await run(e), 'network', 'server-error');
    e.server.status = 404;
    expectErr(await run(e), 'network', 'http-status');
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
