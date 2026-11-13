import { ok } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { importGuide } from './import-guide';
import {
  channelXml,
  defaultGuide,
  type Env,
  expectErr,
  HOUR,
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
  tv,
  xt,
} from './import-guide-test-helpers';
import { extinf, M3U_PASS, M3U_USER } from './import-test-helpers';
import type { ImportProgress } from './import-types';
import { importCatalog } from './import-xtream';
import { updateSourceSettings } from './sources';
import { fileBytes } from './test-db';

describe('guide staging and surfaced failures', () => {
  const bigGuide = (shiftMin: number, n = 30) =>
    tv(
      channelXml('haber1.tr', 'Haber Bir'),
      ...Array.from({ length: n }, (_, i) =>
        programmeXml('haber1.tr', i * HOUR + shiftMin * 60_000, 0.5, `P${i}`),
      ),
    );
  const snapshot = async (e: Env) =>
    JSON.stringify([
      await rows(e, 'SELECT * FROM programmes ORDER BY guide_id, start'),
      await rows(e, 'SELECT * FROM guide_channels ORDER BY guide_id'),
      await rows(e, 'SELECT * FROM channel_guide ORDER BY channel_key'),
    ]);
  const staged = async (e: Env) =>
    (await rows(e, 'SELECT COUNT(*) AS n FROM programmes_next'))[0]?.n;

  it('leaves the previous guide byte for byte after a failure past several batches', async () => {
    const e = await ready(bigGuide(0));
    expect((await run(e, { batchSize: 5 })).ok).toBe(true);
    const before = await snapshot(e);
    e.server.body = bigGuide(15);
    e.server.failAfter = 3000;
    e.server.chunk = 200;
    const r = await run(e, { batchSize: 5 });
    expect(r.ok).toBe(false);
    expect(await snapshot(e)).toBe(before);
    expect(await staged(e)).toBe(0);
  });

  it('leaves the previous guide byte for byte after an abort past several batches', async () => {
    const e = await ready(bigGuide(0));
    await run(e, { batchSize: 5 });
    const before = await snapshot(e);
    e.server.body = bigGuide(15);
    const controller = new AbortController();
    let batches = 0;
    const r = await run(e, {
      batchSize: 5,
      signal: controller.signal,
      onProgress: (p: ImportProgress) => {
        if (p.phase === 'programmes' && ++batches === 3) controller.abort();
      },
    });
    expectErr(r, 'network', 'aborted');
    expect(await snapshot(e)).toBe(before);
    expect(await staged(e)).toBe(0);
  });

  it('replaces everything on success and leaves no staging rows', async () => {
    const e = await ready(bigGuide(0));
    await run(e, { batchSize: 5 });
    e.server.body = bigGuide(15);
    expect((await run(e, { batchSize: 5 })).ok).toBe(true);
    const starts = (await rows(e, 'SELECT start FROM programmes ORDER BY start')).map(
      (p) => p.start as number,
    );
    expect(starts).toHaveLength(30);
    expect(starts.every((s) => (s - NOW) % HOUR === 15 * 60_000)).toBe(true);
    expect(await staged(e)).toBe(0);
  });

  it('clears staging rows left by a crashed run before starting', async () => {
    const e = await ready(bigGuide(0));
    await e.db.run(
      "INSERT INTO programmes_next (source_id, guide_id, start, stop, title, run_id) VALUES ('s1', 'x', 1, 2, 'Ghost', 99)",
    );
    expect((await run(e)).ok).toBe(true);
    expect(await staged(e)).toBe(0);
    expect((await rows(e, "SELECT * FROM programmes WHERE title = 'Ghost'")).length).toBe(0);
  });

  it('surfaces a failing override as a code-only warning and counts the fallback', async () => {
    const guide = `http://epg.example/guide.xml?username=${M3U_USER}&password=${M3U_PASS}`;
    const e = await setupGuide(PLAYLIST, { guideUrl: guide });
    await importCatalog(e.sourceId, e.deps);
    await updateSourceSettings(e.db, e.sourceId, {
      ...(await settings(e)),
      discoveredGuideUrls: [SECOND_URL],
    });
    e.server.body = defaultGuide();
    e.server.statuses.set(guide, 404);
    const r = await run(e);
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.counts.guideUrlFallbacks).toBe(1);
    expect(r.value.warnings).toBe(1);
    expect(r.value.warningCodes).toEqual(['network/http-404']);
    const dump = JSON.stringify([r.value, await rows(e, 'SELECT * FROM import_runs')]);
    expect(dump).not.toContain(M3U_PASS);
    expect(dump).not.toContain('epg.example');
  });

  it('counts no fallback when the first url answers', async () => {
    const e = await ready();
    const r = await run(e);
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.counts.guideUrlFallbacks).toBe(0);
    expect(r.value.warningCodes).toEqual([]);
  });

  it('reports a raw non-2xx guide response with the fetch client codes', async () => {
    const e = await ready();
    const http = {
      get: async () =>
        ok({
          status: 401,
          headers: {},
          body: (async function* () {
            yield new Uint8Array(0);
          })(),
        }),
    };
    const r = await importGuide(e.sourceId, { ...e.deps, http }, { now: NOW });
    expectErr(r, 'auth', 'http-401');
  });
});

describe('write-ahead log', () => {
  it('bounds the journal and truncates the WAL after a guide swap', async () => {
    const e = await setupGuide(PLAYLIST, undefined, true);
    try {
      expect(await e.db.all('PRAGMA journal_size_limit')).toEqual([
        { journal_size_limit: 67_108_864 },
      ]);
      expect((await importCatalog(e.sourceId, e.deps)).ok).toBe(true);
      const about = 'A description of the programme that is about this long. '.repeat(8);
      const shows = Array.from(
        { length: 3000 },
        (_, i) =>
          `<programme start="${xt(i * 60_000)}" stop="${xt((i + 1) * 60_000)}" channel="haber1.tr"><title>P${i}</title><desc>${about}</desc></programme>`,
      );
      e.server.body = tv(channelXml('haber1.tr', 'Haber Bir'), ...shows);
      e.server.chunk = 64 * 1024;
      expect((await run(e, { batchSize: 500 })).ok).toBe(true);
      expect(await rows(e, 'SELECT COUNT(*) AS n FROM programmes')).toEqual([{ n: 3000 }]);
      expect(fileBytes(`${e.raw.name}-wal`)).toBe(0);
    } finally {
      e.close();
    }
  });
});

describe('channel_guide follows the catalog', () => {
  it('drops the mapping of a live channel that a catalog import removed', async () => {
    const e = await setupGuide(PLAYLIST);
    await importCatalog(e.sourceId, e.deps);
    e.server.body = defaultGuide();
    expect((await run(e)).ok).toBe(true);
    const mapped = async () =>
      (await rows(e, 'SELECT channel_key FROM channel_guide')).map((r) => r.channel_key);
    expect(await mapped()).toHaveLength(3);
    e.state.body = PLAYLIST.replace(extinf('Haber Bir HD', stream(2), 'tvg-id="haber1.tr"'), '');
    expect((await importCatalog(e.sourceId, e.deps)).ok).toBe(true);
    const after = await rows(
      e,
      'SELECT l.name FROM channel_guide g JOIN live l ON l.key = g.channel_key ORDER BY l.name',
    );
    expect(after.map((r) => r.name)).toEqual(['Haber Bir', 'Çağrı TV']);
    expect(await mapped()).toHaveLength(2);
  });
});
