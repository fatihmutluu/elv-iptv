import { type HttpClient, type HttpResponse, ok } from '@elv/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { createCatalogService } from './catalog';
import { openCatalog } from './migrate';
import { countingScheduler, memorySecrets, testDb } from './test-db';

function jsonResponse(body: unknown): HttpResponse {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}

describe('CatalogService Wave 1B hardening (#138, #432, #193, #113)', () => {
  const closers: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (closers.length > 0) {
      await closers.pop()?.();
    }
  });

  it('excludes sources marked deleting = 1 from listSources (#138)', async () => {
    const { db, close } = testDb();
    closers.push(close);
    expect((await openCatalog(db)).ok).toBe(true);
    const catalog = createCatalogService({
      db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: { get: async () => ok(jsonResponse([])) },
      clock: () => 1_700_000_000_000,
      newId: (() => {
        let i = 0;
        return () => `s${++i}`;
      })(),
    });
    closers.push(() => catalog.close());

    await catalog.addSource({
      kind: 'm3u',
      name: 'Active',
      playlistUrl: 'https://a.example/a.m3u',
    });
    await catalog.addSource({
      kind: 'm3u',
      name: 'Deleting',
      playlistUrl: 'https://b.example/b.m3u',
    });
    await db.run("UPDATE sources SET deleting = 1 WHERE id = 's2'");

    const listed = await catalog.listSources();
    expect(listed.map((s) => s.id)).toEqual(['s1']);
  });

  it('serializes loadSeriesEpisodes via SerializedImportQueue and aborts on removeSource (#432, #138)', async () => {
    const { db, close } = testDb();
    closers.push(close);
    expect((await openCatalog(db)).ok).toBe(true);

    let seriesInfoStarted!: () => void;
    const seriesInfoStartedPromise = new Promise<void>((r) => {
      seriesInfoStarted = r;
    });
    let capturedAbort = false;

    const http: HttpClient = {
      async get(url, opts) {
        if (url.includes('get_series_info')) {
          seriesInfoStarted();
          await new Promise<void>((_resolve, reject) => {
            opts?.signal?.addEventListener('abort', () => {
              capturedAbort = true;
              reject(new DOMException('aborted', 'AbortError'));
            });
          });
        }
        return ok(jsonResponse([]));
      },
    };

    const catalog = createCatalogService({
      db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http,
      clock: () => 1_700_000_000_000,
      newId: () => 'src-xt',
    });
    closers.push(() => catalog.close());

    const added = await catalog.addSource({
      kind: 'xtream',
      name: 'XT',
      server: 'https://xt.example',
      username: 'u',
      password: 'p',
    });
    expect(added.ok).toBe(true);

    await db.run(
      `INSERT INTO series (source_id, key, provider_id, name, name_fold, run_id)
       VALUES ('src-xt', 'x:src-xt:series:42', '42', 'Show', 'show', 1)`,
    );
    const seriesId = (await db.all<{ id: number }>('SELECT id FROM series'))[0]?.id ?? 0;

    const seasonsPromise = catalog.seasons(seriesId);
    await seriesInfoStartedPromise;

    const removed = await catalog.removeSource('src-xt');
    expect(removed.ok).toBe(true);
    expect(capturedAbort).toBe(true);

    const seasonsRes = await seasonsPromise;
    expect(seasonsRes.ok).toBe(false);
  });

  it('exposes fair-quota allSourcesItems and indexed epgSlice through CatalogService (#193, #113)', async () => {
    const { db, close } = testDb();
    closers.push(close);
    expect((await openCatalog(db)).ok).toBe(true);
    const catalog = createCatalogService({
      db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: { get: async () => ok(jsonResponse([])) },
      clock: () => 1_700_000_000_000,
      newId: (() => {
        let i = 0;
        return () => `s${++i}`;
      })(),
    });
    closers.push(() => catalog.close());

    await catalog.addSource({ kind: 'm3u', name: 'S1', playlistUrl: 'https://s1.example/a.m3u' });
    await catalog.addSource({ kind: 'm3u', name: 'S2', playlistUrl: 'https://s2.example/b.m3u' });

    await db.run(
      `INSERT INTO live (source_id, key, name, name_fold, run_id) VALUES
       ('s1', 'm:s1:live:n:a1|', 'A1', 'a1', 1),
       ('s1', 'm:s1:live:n:a2|', 'A2', 'a2', 1),
       ('s2', 'm:s2:live:n:b1|', 'B1', 'b1', 1),
       ('s2', 'm:s2:live:n:b2|', 'B2', 'b2', 1)`,
    );
    await db.run(
      `INSERT INTO programmes (source_id, guide_id, start, stop, title, run_id) VALUES
       ('s1', 'ch1', 1000, 2000, 'News', 1),
       ('s1', 'ch2', 1500, 2500, 'Sports', 1),
       ('s1', 'ch3', 3000, 4000, 'Late', 1)`,
    );

    const allItems = await catalog.allSourcesItems?.('live', 0, 4);
    expect(allItems?.map((x) => x.sourceId).sort()).toEqual(['s1', 's1', 's2', 's2']);

    const slice = await catalog.epgSlice?.('s1', 1200, 2200, 10);
    expect(slice?.map((p) => p.title)).toEqual(['News', 'Sports']);
  });
});
