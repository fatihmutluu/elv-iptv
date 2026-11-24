import { type HttpRequestOptions, ok, type SqlDriver, type SqlValue } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import { M3U_TOKEN, sampleCatalog, setup as setupPanel } from './import-test-helpers';
import {
  createCatalogService,
  type ItemDetailRow,
  type ItemsCursor,
  openCatalog,
  queryCatalogByIdCursor,
  queryCategories,
  queryItemDetail,
  queryItems,
  queryItemsByCursor,
} from './index';
import { countingScheduler, memorySecrets, testDb } from './test-db';

describe('queryItemDetail & CatalogService.itemDetail', () => {
  it('returns live, movie, and series rows with plot via indexed UNIQUE(source_id, key) lookup and skips DB on malformed keys', async () => {
    const data = sampleCatalog();
    data.vod[0] = {
      ...data.vod[0],
      stream_icon: 'http://img.example/film-a.png',
      year: '2025',
    };
    data.series[0] = {
      ...data.series[0],
      cover: 'http://img.example/show-one.png',
      plot: 'A radio engineer decodes a repeating northern transmission.',
      rating: '8.7',
      releaseDate: '2026-01-15',
    };

    const p = await setupPanel(data);
    const service = createCatalogService({
      db: p.db,
      secrets: p.secrets,
      scheduler: p.scheduler,
      http: p.deps.http,
      clock: () => 2_000,
    });
    const imported = await service.importSource(p.sourceId);
    expect(imported.ok).toBe(true);

    // Live channel: plot is null, num and logo populated
    const liveCat = (await service.categories(p.sourceId, 'live'))[0];
    const liveItem = (await service.items(liveCat?.id ?? '', 0, 10))[0];
    expect(liveItem).toBeDefined();
    const liveDetail = await queryItemDetail(p.db, liveItem?.key ?? '');
    expect(liveDetail).toEqual<ItemDetailRow>({
      id: liveItem?.id ?? -1,
      key: liveItem?.key ?? '',
      kind: 'live',
      sourceId: p.sourceId,
      providerId: '100',
      name: 'Haber Bir',
      logo: 'http://img.example/1.png',
      rating: null,
      year: null,
      num: 1,
      catchupDays: 3,
      plot: null,
    });

    // Movie: plot is null, logo/rating/year populated
    const movieCat = (await service.categories(p.sourceId, 'movie'))[0];
    const movieItem = (await service.items(movieCat?.id ?? '', 0, 10))[0];
    const movieDetail = await queryItemDetail(p.db, movieItem?.key ?? '');
    expect(movieDetail).toMatchObject({
      id: movieItem?.id,
      key: movieItem?.key,
      kind: 'movie',
      sourceId: p.sourceId,
      providerId: '200',
      name: 'Film A',
      logo: 'http://img.example/film-a.png',
      rating: 7.5,
      num: null,
      plot: null,
    });

    // Series: plot populated from series.plot, logo from series.cover
    const seriesCat = (await service.categories(p.sourceId, 'series'))[0];
    const seriesItems = await service.items(seriesCat?.id ?? '', 0, 10);
    const showOne = seriesItems.find((s) => s.name === 'Show One');
    const showTwo = seriesItems.find((s) => s.name === 'Show Two');
    expect(showOne).toBeDefined();
    expect(showTwo).toBeDefined();

    const showOneDetail = await service.itemDetail?.(showOne?.key ?? '');
    expect(showOneDetail).toEqual<ItemDetailRow>({
      id: showOne?.id ?? -1,
      key: showOne?.key ?? '',
      kind: 'series',
      sourceId: p.sourceId,
      providerId: '300',
      name: 'Show One',
      logo: 'http://img.example/show-one.png',
      rating: 8.7,
      year: 2026,
      num: null,
      plot: 'A radio engineer decodes a repeating northern transmission.',
    });

    const showTwoDetail = await service.itemDetail?.(showTwo?.key ?? '');
    expect(showTwoDetail).toMatchObject({
      key: showTwo?.key,
      kind: 'series',
      name: 'Show Two',
      plot: null,
    });

    // Unknown valid-shaped key returns undefined/null
    expect(await queryItemDetail(p.db, `x:${p.sourceId}:movie:999999`)).toBeUndefined();
    expect(await service.itemDetail?.(`x:${p.sourceId}:movie:999999`)).toBeNull();

    // Malformed keys short-circuit with zero DB queries
    const allSpy = vi.fn();
    const spiedDb: SqlDriver = {
      ...p.db,
      all: <T>(sql: string, params?: readonly SqlValue[]) => {
        allSpy(sql, params);
        return p.db.all<T>(sql, params);
      },
    };
    for (const bad of ['', 'bad', 'z:s1:movie:1', 'x::movie:1', 'wb:movie:401']) {
      expect(await queryItemDetail(spiedDb, bad)).toBeUndefined();
    }
    expect(allSpy).not.toHaveBeenCalled();

    // Verify SQLite query plan uses indexed SEARCH on all three tables with zero full table SCAN
    const capturedSql: { sql: string; params: readonly SqlValue[] | undefined }[] = [];
    const captureDb: SqlDriver = {
      ...p.db,
      all: <T>(sql: string, params?: readonly SqlValue[]) => {
        capturedSql.push({ sql, params });
        return p.db.all<T>(sql, params);
      },
    };
    await queryItemDetail(captureDb, showOne?.key ?? '');
    expect(capturedSql).toHaveLength(1);
    const plan = await p.db.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN ${capturedSql[0]?.sql ?? ''}`,
      capturedSql[0]?.params,
    );
    const details = plan.map((r) => r.detail);
    expect(details.some((d) => /SCAN\b/i.test(d))).toBe(false);
    expect(
      details.filter((d) => /SEARCH\s+(live|movies|series)\s+USING\s+INDEX/i.test(d)),
    ).toHaveLength(3);
  });

  it('resolves M3U logo templates at read time in CatalogService.itemDetail without mutating DB', async () => {
    const playlistUrl = 'http://panel.example:8080/list.m3u';
    const playlist = [
      '#EXTM3U',
      `#EXTINF:-1 tvg-logo="http://img.example/${M3U_TOKEN}/live1.png" group-title="Live",Channel One`,
      `http://cdn.example/${M3U_TOKEN}/live/1.ts`,
      `#EXTINF:-1 tvg-logo="http://img.example/${M3U_TOKEN}/film1.png" group-title="Films",Sample Film (2025)`,
      `http://cdn.example/${M3U_TOKEN}/vod/10.mkv`,
    ].join('\n');

    const t = testDb();
    await openCatalog(t.db);
    const service = createCatalogService({
      db: t.db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: {
        async get(_url: string, _opts?: HttpRequestOptions) {
          const bytes = new TextEncoder().encode(playlist);
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
      newId: () => 'm1',
    });

    const added = await service.addSource({ kind: 'm3u', name: 'M3U', playlistUrl });
    if (!added.ok) throw new Error('addSource failed');
    expect((await service.importSource('m1')).ok).toBe(true);

    const movieCat = (await service.categories('m1', 'movie'))[0];
    const movie = (await service.items(movieCat?.id ?? '', 0, 10))[0];
    expect(movie).toBeDefined();

    // Raw DB query still holds templated logo (zero secret in SQLite)
    const rawDetail = await queryItemDetail(t.db, movie?.key ?? '');
    expect(rawDetail?.logo).toContain('{{');
    expect(rawDetail?.logo).not.toContain(M3U_TOKEN);

    // Service resolves logo template at read time
    const serviceDetail = await service.itemDetail?.(movie?.key ?? '');
    expect(serviceDetail).toMatchObject({
      key: movie?.key,
      kind: 'movie',
      sourceId: 'm1',
      logo: `http://img.example/${M3U_TOKEN}/film1.png`,
      plot: null,
    });

    // Malformed key returns null cleanly
    expect(await service.itemDetail?.('not-a-key')).toBeNull();
  });
});

describe('queryCategories grouped counts & scale', () => {
  it('uses a grouped LEFT JOIN (no correlated scalar subquery), preserves empty categories, and counts 50,000 placements in < 100ms', async () => {
    const { db, close } = testDb();
    try {
      await openCatalog(db);
      await db.run(
        "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Scale', 100, '{}'), ('s2', 'xtream', 'Other', 100, '{}')",
      );

      const categoryCount = 100;
      const populatedCategories = 95;
      const totalPlacements = 50_000;
      await db.transaction(async (tx) => {
        const catRows: [string, string, string, string, string, number, number][] = [];
        for (let c = 0; c < categoryCount; c += 1) {
          catRows.push(['s1', 'movie', `cat-${c}`, `Category ${c}`, `category ${c}`, c, 1]);
        }
        // Noise categories in another kind and another source
        catRows.push(['s1', 'live', 'cat-0', 'Live Noise', 'live noise', 0, 1]);
        catRows.push(['s2', 'movie', 'cat-0', 'Other Source', 'other source', 0, 1]);
        await tx.batch(
          'INSERT INTO categories (source_id, kind, provider_id, name, name_fold, position, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
          catRows,
        );

        const chunk: [string, string, string, string, number, number][] = [];
        const movieChunk: [string, string, string, string, number][] = [];
        for (let i = 0; i < totalPlacements; i += 1) {
          const catIdx = i % populatedCategories;
          const key = `x:s1:movie:${i}`;
          chunk.push(['s1', 'movie', key, `cat-${catIdx}`, i, 1]);
          movieChunk.push(['s1', key, `Movie ${i}`, `movie ${i}`, 1]);
          if (chunk.length === 5_000) {
            await tx.batch(
              'INSERT INTO movies (source_id, key, name, name_fold, run_id) VALUES (?, ?, ?, ?, ?)',
              movieChunk,
            );
            await tx.batch(
              'INSERT INTO placements (source_id, kind, item_key, category_id, position, run_id) VALUES (?, ?, ?, ?, ?, ?)',
              chunk,
            );
            chunk.length = 0;
            movieChunk.length = 0;
          }
        }
        // Noise placements in another kind and source that must NOT affect s1/movie counts
        await tx.batch(
          'INSERT INTO placements (source_id, kind, item_key, category_id, position, run_id) VALUES (?, ?, ?, ?, ?, ?)',
          [
            ['s1', 'live', 'x:s1:live:1', 'cat-0', 0, 1],
            ['s2', 'movie', 'x:s2:movie:1', 'cat-0', 0, 1],
          ],
        );
      });

      const capturedSql: { sql: string; params: readonly SqlValue[] | undefined }[] = [];
      const captureDb: SqlDriver = {
        ...db,
        all: <T>(sql: string, params?: readonly SqlValue[]) => {
          capturedSql.push({ sql, params });
          return db.all<T>(sql, params);
        },
      };

      const start = performance.now();
      const categories = await queryCategories(captureDb, 's1', 'movie');
      const elapsedMs = performance.now() - start;

      expect(categories).toHaveLength(categoryCount);
      expect(categories.reduce((sum, c) => sum + c.itemCount, 0)).toBe(totalPlacements);
      // Empty trailing categories (95..99) must still appear with itemCount: 0
      for (let c = populatedCategories; c < categoryCount; c += 1) {
        expect(categories[c]).toMatchObject({
          id: `s1|movie|cat-${c}`,
          position: c,
          itemCount: 0,
        });
      }
      // First category receives ceil(50_000 / 95) = 527 placements (unaffected by noise)
      expect(categories[0]?.itemCount).toBe(Math.ceil(totalPlacements / populatedCategories));

      expect(capturedSql).toHaveLength(1);
      const plan = await db.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${capturedSql[0]?.sql ?? ''}`,
        capturedSql[0]?.params,
      );
      const planText = plan.map((r) => r.detail).join('\n');
      expect(planText).not.toMatch(/CORRELATED SCALAR SUBQUERY/i);
      expect(elapsedMs).toBeLessThan(100);
    } finally {
      close();
    }
  });

  it('filters is_hidden=1 categories, placements, and items in SQL before LIMIT/OFFSET (#149)', async () => {
    const { db, close } = testDb();
    try {
      await openCatalog(db);
      await db.run(
        "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Src', 100, '{}')",
      );
      await db.run(
        `INSERT INTO categories (source_id, kind, provider_id, name, name_fold, position, is_hidden, run_id) VALUES
           ('s1', 'movie', 'c-vis', 'Visible Cat', 'visible cat', 0, 0, 1),
           ('s1', 'movie', 'c-hid', 'Hidden Cat', 'hidden cat', 1, 1, 1)`,
      );
      await db.run(
        `INSERT INTO movies (source_id, key, name, name_fold, is_hidden, run_id) VALUES
           ('s1', 'x:s1:movie:1', 'M1 Hidden Placement', 'm1 hidden placement', 0, 1),
           ('s1', 'x:s1:movie:2', 'M2 Hidden Item', 'm2 hidden item', 1, 1),
           ('s1', 'x:s1:movie:3', 'M3 Visible A', 'm3 visible a', 0, 1),
           ('s1', 'x:s1:movie:4', 'M4 Visible B', 'm4 visible b', 0, 1),
           ('s1', 'x:s1:movie:5', 'M5 Visible C', 'm5 visible c', 0, 1)`,
      );
      await db.run(
        `INSERT INTO placements (source_id, kind, item_key, category_id, position, is_hidden, run_id) VALUES
           ('s1', 'movie', 'x:s1:movie:1', 'c-vis', 0, 1, 1),
           ('s1', 'movie', 'x:s1:movie:2', 'c-vis', 1, 0, 1),
           ('s1', 'movie', 'x:s1:movie:3', 'c-vis', 2, 0, 1),
           ('s1', 'movie', 'x:s1:movie:4', 'c-vis', 3, 0, 1),
           ('s1', 'movie', 'x:s1:movie:5', 'c-vis', 4, 0, 1),
           ('s1', 'movie', 'x:s1:movie:3', 'c-hid', 0, 0, 1)`,
      );

      // Hidden category is omitted; visible category counts only non-hidden placements & non-hidden items (3)
      const cats = await queryCategories(db, 's1', 'movie');
      expect(cats).toEqual([
        {
          id: 's1|movie|c-vis',
          sourceId: 's1',
          kind: 'movie',
          name: 'Visible Cat',
          position: 0,
          itemCount: 3,
        },
      ]);

      // Hidden placement & hidden item at positions 0 and 1 must NOT consume LIMIT/OFFSET slots
      const page1 = await queryItems(
        db,
        { sourceId: 's1', kind: 'movie', providerId: 'c-vis' },
        0,
        2,
      );
      expect(page1.map((r) => r.key)).toEqual(['x:s1:movie:3', 'x:s1:movie:4']);

      const page2 = await queryItems(
        db,
        { sourceId: 's1', kind: 'movie', providerId: 'c-vis' },
        2,
        2,
      );
      expect(page2.map((r) => r.key)).toEqual(['x:s1:movie:5']);

      // Verify EXPLAIN QUERY PLAN uses idx_placements_visible
      const captured: { sql: string; params: readonly SqlValue[] | undefined }[] = [];
      const captureDb: SqlDriver = {
        ...db,
        all: <T>(sql: string, params?: readonly SqlValue[]) => {
          captured.push({ sql, params });
          return db.all<T>(sql, params);
        },
      };
      await queryItems(captureDb, { sourceId: 's1', kind: 'movie', providerId: 'c-vis' }, 0, 2);
      const plan = await db.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${captured[0]?.sql ?? ''}`,
        captured[0]?.params,
      );
      expect(plan.map((r) => r.detail).join('\n')).toContain('idx_placements_visible');

      // Marking source deleting=1 hides both categories and items during chunked deletion
      await db.run("UPDATE sources SET deleting = 1 WHERE id = 's1'");
      expect(await queryCategories(db, 's1', 'movie')).toEqual([]);
      expect(
        await queryItems(db, { sourceId: 's1', kind: 'movie', providerId: 'c-vis' }, 0, 10),
      ).toEqual([]);
    } finally {
      close();
    }
  });
});

describe('key-cursor pagination (#176)', () => {
  it('queryItemsByCursor paginates cleanly with tie-breaking, zero drift under concurrent inserts/deletes, and idx_placements_visible', async () => {
    const { db, close } = testDb();
    try {
      await openCatalog(db);
      await db.run(
        "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Src', 100, '{}')",
      );
      await db.run(
        "INSERT INTO categories (source_id, kind, provider_id, name, name_fold, position, run_id) VALUES ('s1', 'movie', 'c1', 'Films', 'films', 0, 1)",
      );
      await db.run(
        `INSERT INTO movies (source_id, key, name, name_fold, is_hidden, run_id) VALUES
           ('s1', 'x:s1:movie:1', 'M1', 'm1', 0, 1),
           ('s1', 'x:s1:movie:2', 'M2', 'm2', 0, 1),
           ('s1', 'x:s1:movie:3', 'M3 Hidden', 'm3 hidden', 1, 1),
           ('s1', 'x:s1:movie:4', 'M4', 'm4', 0, 1),
           ('s1', 'x:s1:movie:5', 'M5', 'm5', 0, 1),
           ('s1', 'x:s1:movie:6', 'M6', 'm6', 0, 1)`,
      );
      // Items 4 and 5 intentionally share position=3 to verify deterministic item_key tie-breaking.
      await db.run(
        `INSERT INTO placements (source_id, kind, item_key, category_id, position, is_hidden, run_id) VALUES
           ('s1', 'movie', 'x:s1:movie:1', 'c1', 1, 0, 1),
           ('s1', 'movie', 'x:s1:movie:2', 'c1', 2, 0, 1),
           ('s1', 'movie', 'x:s1:movie:3', 'c1', 2, 0, 1),
           ('s1', 'movie', 'x:s1:movie:4', 'c1', 3, 0, 1),
           ('s1', 'movie', 'x:s1:movie:5', 'c1', 3, 0, 1),
           ('s1', 'movie', 'x:s1:movie:6', 'c1', 4, 0, 1)`,
      );

      // Invalid categoryId and limit=0 short-circuit cleanly.
      expect(await queryItemsByCursor(db, 'bad-category-id', undefined, 10)).toEqual({
        items: [],
        nextCursor: null,
        hasMore: false,
      });
      expect(await queryItemsByCursor(db, 's1|movie|c1', undefined, 0)).toEqual({
        items: [],
        nextCursor: null,
        hasMore: false,
      });

      const page1 = await queryItemsByCursor(db, 's1|movie|c1', undefined, 2);
      expect(page1.items.map((r) => r.key)).toEqual(['x:s1:movie:1', 'x:s1:movie:2']);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toEqual<ItemsCursor>({ position: 2, itemKey: 'x:s1:movie:2' });

      // Concurrent mutation between pages: insert at position 0 AND delete position 1 before cursor!
      await db.run(
        "INSERT INTO movies (source_id, key, name, name_fold, is_hidden, run_id) VALUES ('s1', 'x:s1:movie:0', 'M0', 'm0', 0, 1)",
      );
      await db.run(
        "INSERT INTO placements (source_id, kind, item_key, category_id, position, is_hidden, run_id) VALUES ('s1', 'movie', 'x:s1:movie:0', 'c1', 0, 0, 1)",
      );
      await db.run("DELETE FROM placements WHERE item_key = 'x:s1:movie:1'");

      // Page 2 resumes strictly after (2, 'x:s1:movie:2') with zero skipped or duplicated items.
      const page2 = await queryItemsByCursor(db, 's1|movie|c1', page1.nextCursor ?? undefined, 2);
      expect(page2.items.map((r) => r.key)).toEqual(['x:s1:movie:4', 'x:s1:movie:5']);
      expect(page2.hasMore).toBe(true);
      expect(page2.nextCursor).toEqual<ItemsCursor>({ position: 3, itemKey: 'x:s1:movie:5' });

      // Page 3 gets the final item; exact-fit end reports hasMore=false & nextCursor=null.
      const page3 = await queryItemsByCursor(db, 's1|movie|c1', page2.nextCursor ?? undefined, 1);
      expect(page3.items.map((r) => r.key)).toEqual(['x:s1:movie:6']);
      expect(page3.hasMore).toBe(false);
      expect(page3.nextCursor).toBeNull();

      // Verify EXPLAIN QUERY PLAN uses idx_placements_visible with zero TEMP B-TREE.
      const captured: { sql: string; params: readonly SqlValue[] | undefined }[] = [];
      const captureDb: SqlDriver = {
        ...db,
        all: <T>(sql: string, params?: readonly SqlValue[]) => {
          captured.push({ sql, params });
          return db.all<T>(sql, params);
        },
      };
      await queryItemsByCursor(
        captureDb,
        's1|movie|c1',
        { position: 2, itemKey: 'x:s1:movie:2' },
        2,
      );
      const plan = await db.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${captured[0]?.sql ?? ''}`,
        captured[0]?.params,
      );
      const planText = plan.map((r) => r.detail).join('\n');
      expect(planText).toContain('idx_placements_visible');
      expect(planText).not.toMatch(/TEMP B-TREE/i);

      // Deleting source hides results immediately.
      await db.run("UPDATE sources SET deleting = 1 WHERE id = 's1'");
      expect(await queryItemsByCursor(db, 's1|movie|c1', undefined, 10)).toEqual({
        items: [],
        nextCursor: null,
        hasMore: false,
      });
    } finally {
      close();
    }
  });

  it('queryCatalogByIdCursor paginates by id > afterId without drift and uses INTEGER PRIMARY KEY', async () => {
    const { db, close } = testDb();
    try {
      await openCatalog(db);
      await db.run(
        "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Src', 100, '{}')",
      );
      await db.run(
        `INSERT INTO live (id, source_id, key, num, name, name_fold, is_hidden, run_id) VALUES
           (10, 's1', 'x:s1:live:10', 10, 'Ch 10', 'ch 10', 0, 1),
           (20, 's1', 'x:s1:live:20', 20, 'Ch 20 Hidden', 'ch 20 hidden', 1, 1),
           (30, 's1', 'x:s1:live:30', 30, 'Ch 30', 'ch 30', 0, 1),
           (40, 's1', 'x:s1:live:40', 40, 'Ch 40', 'ch 40', 0, 1),
           (50, 's1', 'x:s1:live:50', 50, 'Ch 50', 'ch 50', 0, 1)`,
      );

      expect(await queryCatalogByIdCursor(db, 's1', 'live', 0, 0)).toEqual([]);

      const p1 = await queryCatalogByIdCursor(db, 's1', 'live', 0, 2);
      expect(p1.map((r) => r.id)).toEqual([10, 30]);

      // Delete id=10 before cursor and insert id=15 before cursor -> neither shifts p2.
      await db.run('DELETE FROM live WHERE id = 10');
      await db.run(
        "INSERT INTO live (id, source_id, key, num, name, name_fold, is_hidden, run_id) VALUES (15, 's1', 'x:s1:live:15', 15, 'Ch 15', 'ch 15', 0, 1)",
      );

      const p2 = await queryCatalogByIdCursor(db, 's1', 'live', p1[p1.length - 1]?.id ?? 0, 2);
      expect(p2.map((r) => r.id)).toEqual([40, 50]);

      const p3 = await queryCatalogByIdCursor(db, 's1', 'live', p2[p2.length - 1]?.id ?? 0, 2);
      expect(p3).toEqual([]);

      const captured: { sql: string; params: readonly SqlValue[] | undefined }[] = [];
      const captureDb: SqlDriver = {
        ...db,
        all: <T>(sql: string, params?: readonly SqlValue[]) => {
          captured.push({ sql, params });
          return db.all<T>(sql, params);
        },
      };
      await queryCatalogByIdCursor(captureDb, 's1', 'live', 30, 2);
      const plan = await db.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${captured[0]?.sql ?? ''}`,
        captured[0]?.params,
      );
      const planText = plan.map((r) => r.detail).join('\n');
      expect(planText).toMatch(/INTEGER PRIMARY KEY/i);
      expect(planText).not.toMatch(/TEMP B-TREE/i);
    } finally {
      close();
    }
  });
});
