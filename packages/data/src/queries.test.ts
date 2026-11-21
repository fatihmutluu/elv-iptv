import { type HttpRequestOptions, ok, type SqlDriver, type SqlValue } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import { M3U_TOKEN, sampleCatalog, setup as setupPanel } from './import-test-helpers';
import { createCatalogService, type ItemDetailRow, openCatalog, queryItemDetail } from './index';
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
