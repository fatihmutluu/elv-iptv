import { elvError, err, ok } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import { type CatalogService, createCatalogService } from './catalog';
import { openCatalog } from './migrate';
import { queryNextEpisode } from './next-episode';
import { countingScheduler, memorySecrets, testDb } from './test-db';
import {
  getWatchProgress,
  listContinueWatching,
  listProgressByKeys,
  listSeriesUnplayedCounts,
  listWatched,
  saveWatchProgress,
  setItemWatched,
  type WatchProgressRow,
} from './user-state';
import type { UserDataStore } from './user-state-backup';
import { setSeasonWatchedInDb, setSeriesWatchedInDb } from './user-state-series';
import { createCoalescedCatalog } from './write-coalescer';

async function setupDb() {
  const handle = testDb();
  await openCatalog(handle.db);
  return handle;
}

async function seedSeriesWithEpisodes(
  db: ReturnType<typeof testDb>['db'],
  opts: {
    sourceId: string;
    sourceKind?: 'xtream' | 'm3u';
    seriesKey: string;
    seriesName: string;
    cover?: string | null;
    providerId?: string;
    episodes: Array<{
      key: string;
      season: number | null;
      episode: number | null;
      title: string | null;
      durationSec: number | null;
    }>;
  },
) {
  const { sourceId, seriesKey, seriesName, cover = 'https://img.example/show.jpg' } = opts;
  await db.run(
    `INSERT OR IGNORE INTO sources (id, kind, name, created_at, settings_json, deleting)
     VALUES (?, ?, 'Demo', 1000, '{}', 0)`,
    [sourceId, opts.sourceKind ?? 'xtream'],
  );
  await db.run(
    `INSERT INTO series (source_id, key, provider_id, name, name_fold, cover, run_id)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [sourceId, seriesKey, opts.providerId ?? '42', seriesName, seriesName.toLowerCase(), cover],
  );
  for (const ep of opts.episodes) {
    await db.run(
      `INSERT INTO episodes (source_id, key, series_key, season, episode, title, duration_sec, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [sourceId, ep.key, seriesKey, ep.season, ep.episode, ep.title, ep.durationSec],
    );
  }
}

function makeMemoryUserDataStore(): { store: UserDataStore; writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    store: {
      read: () => writes.at(-1),
      write: (value: string) => {
        writes.push(value);
      },
    },
  };
}

function createFakeTimers() {
  let nextId = 1;
  const active = new Map<number, { fn: () => void; ms: number }>();
  return {
    active,
    setTimeoutFn: (fn: () => void, ms: number) => {
      const id = nextId++;
      active.set(id, { fn, ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => {
      active.delete(handle as unknown as number);
    },
    runAll: () => {
      const callbacks = [...active.values()];
      active.clear();
      for (const cb of callbacks) cb.fn();
    },
  };
}

describe('setSeasonWatchedInDb & setSeriesWatchedInDb', () => {
  it('marks one season watched transactionally with duration/position preservation and leaves other seasons intact', async () => {
    const handle = await setupDb();
    try {
      const { db } = handle;
      const seriesKey = 'x:s1:series:10';
      await seedSeriesWithEpisodes(db, {
        sourceId: 's1',
        seriesKey,
        seriesName: 'Northern Signal',
        cover: 'https://img.example/signal.jpg',
        episodes: [
          { key: 'x:s1:episode:101', season: 1, episode: 1, title: 'Pilot', durationSec: 2700 },
          { key: 'x:s1:episode:102', season: 1, episode: 2, title: 'Echo', durationSec: null },
          { key: 'x:s1:episode:103', season: 1, episode: 3, title: '', durationSec: 3000 },
          { key: 'x:s1:episode:201', season: 2, episode: 1, title: 'Return', durationSec: 2800 },
          { key: 'x:s1:episode:202', season: 2, episode: 2, title: 'Drift', durationSec: 2900 },
        ],
      });

      // Pre-seed partial progress on ep 102 with known duration_ms (ep.duration_sec is null)
      // and ep 101 with position_ms > 0 and duration_ms = 0
      await saveWatchProgress(
        db,
        {
          sourceId: 's1',
          itemKey: 'x:s1:episode:102',
          kind: 'episode',
          title: 'Echo',
          seriesKey,
          season: 1,
          episode: 2,
          positionMs: 120_000,
          durationMs: 2_500_000,
          watched: false,
        },
        () => 1_000,
      );
      await saveWatchProgress(
        db,
        {
          sourceId: 's1',
          itemKey: 'x:s1:episode:101',
          kind: 'episode',
          title: 'Pilot',
          seriesKey,
          season: 1,
          episode: 1,
          positionMs: 50_000,
          durationMs: 0,
          watched: false,
        },
        () => 1_500,
      );

      const res = await setSeasonWatchedInDb(db, seriesKey, 1, true, () => 5_000, 'default');
      expect(res).toEqual(ok(3));

      const ep1 = await getWatchProgress(db, 'x:s1:episode:101', 'default');
      expect(ep1).toMatchObject({
        profileId: 'default',
        sourceId: 's1',
        itemKey: 'x:s1:episode:101',
        kind: 'episode',
        title: 'Pilot',
        seriesKey,
        season: 1,
        episode: 1,
        durationMs: 2_700_000,
        positionMs: 2_700_000,
        watched: true,
        updatedAt: 5_000,
      });

      const ep2 = await getWatchProgress(db, 'x:s1:episode:102', 'default');
      expect(ep2).toMatchObject({
        itemKey: 'x:s1:episode:102',
        durationMs: 2_500_000,
        positionMs: 2_500_000,
        watched: true,
        updatedAt: 5_000,
      });

      // Blank episode title falls back to series name, subtitle null, logo from series.cover
      const ep3 = await getWatchProgress(db, 'x:s1:episode:103', 'default');
      expect(ep3).toMatchObject({
        itemKey: 'x:s1:episode:103',
        title: 'Northern Signal',
        subtitle: null,
        logo: 'https://img.example/signal.jpg',
        durationMs: 3_000_000,
        positionMs: 3_000_000,
        watched: true,
        updatedAt: 5_000,
      });

      // Season 2 remains completely untouched
      expect(await getWatchProgress(db, 'x:s1:episode:201', 'default')).toBeNull();
      expect(await getWatchProgress(db, 'x:s1:episode:202', 'default')).toBeNull();

      // Profile isolation: kids profile has no progress
      expect(await getWatchProgress(db, 'x:s1:episode:101', 'kids')).toBeNull();

      // Unplayed counts & Continue Watching Next-Up point cleanly to S2E1
      const counts = await listSeriesUnplayedCounts(db, [seriesKey], 'default');
      expect(counts).toEqual([{ seriesKey, total: 5, unplayed: 2, watched: false }]);

      const cw = await listContinueWatching(db, 10, 'default');
      expect(cw).toHaveLength(1);
      expect(cw[0]?.itemKey).toBe('x:s1:episode:201');
      expect(cw[0]?.watched).toBe(false);
    } finally {
      handle.close();
    }
  });

  it('unmarks a season watched, clears series-level watched flag, and preserves other seasons & profiles', async () => {
    const handle = await setupDb();
    try {
      const { db } = handle;
      const seriesKey = 'x:s1:series:20';
      await seedSeriesWithEpisodes(db, {
        sourceId: 's1',
        seriesKey,
        seriesName: 'Glass Orbit',
        episodes: [
          { key: 'x:s1:episode:301', season: 1, episode: 1, title: 'S1E1', durationSec: 1800 },
          { key: 'x:s1:episode:302', season: 1, episode: 2, title: 'S1E2', durationSec: 1800 },
          { key: 'x:s1:episode:401', season: 2, episode: 1, title: 'S2E1', durationSec: 1800 },
        ],
      });

      // Mark entire series watched for both default and kids profiles
      expect(await setSeriesWatchedInDb(db, seriesKey, true, () => 2_000, 'default')).toEqual(
        ok(3),
      );
      expect(await setSeriesWatchedInDb(db, seriesKey, true, () => 2_500, 'kids')).toEqual(ok(3));

      // Verify fully watched before unmarking season 2
      expect((await listWatched(db, 10, 'default')).map((r) => r.itemKey)).toEqual([seriesKey]);
      expect(await listSeriesUnplayedCounts(db, [seriesKey], 'default')).toEqual([
        { seriesKey, total: 3, unplayed: 0, watched: true },
      ]);

      // Unmark Season 2 only on default profile
      const unmarked = await setSeasonWatchedInDb(db, seriesKey, 2, false, () => 6_000, 'default');
      expect(unmarked).toEqual(ok(1));

      // Season 2 episode reset; Season 1 episodes stay watched
      const s2e1 = await getWatchProgress(db, 'x:s1:episode:401', 'default');
      expect(s2e1).toMatchObject({ watched: false, positionMs: 0, updatedAt: 6_000 });
      expect((await getWatchProgress(db, 'x:s1:episode:301', 'default'))?.watched).toBe(true);
      expect((await getWatchProgress(db, 'x:s1:episode:302', 'default'))?.watched).toBe(true);

      // Series-level flag is cleared so listWatched & listSeriesUnplayedCounts stay accurate
      const seriesRow = await getWatchProgress(db, seriesKey, 'default');
      expect(seriesRow).toMatchObject({ watched: false, positionMs: 0, updatedAt: 6_000 });
      expect(await listWatched(db, 10, 'default')).toEqual([]);
      expect(await listSeriesUnplayedCounts(db, [seriesKey], 'default')).toEqual([
        { seriesKey, total: 3, unplayed: 1, watched: false },
      ]);

      // Kids profile stays completely untouched
      expect((await getWatchProgress(db, 'x:s1:episode:401', 'kids'))?.watched).toBe(true);
      expect((await getWatchProgress(db, seriesKey, 'kids'))?.watched).toBe(true);
      expect((await listWatched(db, 10, 'kids')).map((r) => r.itemKey)).toEqual([seriesKey]);
    } finally {
      handle.close();
    }
  });

  it('marks and unmarks an entire series transactionally across all seasons and stays consistent with listWatched and queryNextEpisode', async () => {
    const handle = await setupDb();
    try {
      const { db } = handle;
      const seriesKey = 'x:s1:series:30';
      await seedSeriesWithEpisodes(db, {
        sourceId: 's1',
        seriesKey,
        seriesName: 'Red Meridian',
        cover: 'https://img.example/meridian.jpg',
        episodes: [
          { key: 'x:s1:episode:501', season: 0, episode: 1, title: 'Special', durationSec: 900 },
          { key: 'x:s1:episode:502', season: 1, episode: 1, title: 'One', durationSec: 2400 },
          { key: 'x:s1:episode:503', season: 1, episode: 2, title: 'Two', durationSec: 2400 },
          { key: 'x:s1:episode:504', season: 2, episode: 1, title: 'Three', durationSec: 2600 },
        ],
      });

      // Mark entire series watched
      const marked = await setSeriesWatchedInDb(db, seriesKey, true, () => 10_000, 'default');
      expect(marked).toEqual(ok(4));

      const progress = await listProgressByKeys(
        db,
        [seriesKey, 'x:s1:episode:501', 'x:s1:episode:502', 'x:s1:episode:503', 'x:s1:episode:504'],
        'default',
      );
      expect(progress).toHaveLength(5);
      for (const row of progress) {
        expect(row.watched).toBe(true);
        expect(row.updatedAt).toBe(10_000);
      }

      const seriesProgress = progress.find((r) => r.itemKey === seriesKey);
      expect(seriesProgress).toMatchObject({
        kind: 'series',
        title: 'Red Meridian',
        logo: 'https://img.example/meridian.jpg',
        watched: true,
      });

      expect((await listWatched(db, 10, 'default')).map((r) => r.itemKey)).toEqual([seriesKey]);
      expect(await listContinueWatching(db, 10, 'default')).toEqual([]);
      expect(await listSeriesUnplayedCounts(db, [seriesKey], 'default')).toEqual([
        { seriesKey, total: 4, unplayed: 0, watched: true },
      ]);
      // Rewatch fallback in queryNextEpisode still advances sequentially from S1E2 -> S2E1
      const next = await queryNextEpisode(db, seriesKey, 'x:s1:episode:503', 'default');
      expect(next?.key).toBe('x:s1:episode:504');

      // Now unmark entire series
      const unmarked = await setSeriesWatchedInDb(db, seriesKey, false, () => 20_000, 'default');
      expect(unmarked).toEqual(ok(4));

      const afterUnmark = await listProgressByKeys(
        db,
        [seriesKey, 'x:s1:episode:501', 'x:s1:episode:502', 'x:s1:episode:503', 'x:s1:episode:504'],
        'default',
      );
      expect(afterUnmark).toHaveLength(5);
      for (const row of afterUnmark) {
        expect(row.watched).toBe(false);
        expect(row.positionMs).toBe(0);
        expect(row.updatedAt).toBe(20_000);
      }
      expect(await listWatched(db, 10, 'default')).toEqual([]);
      expect(await listContinueWatching(db, 10, 'default')).toEqual([]);
      expect(await listSeriesUnplayedCounts(db, [seriesKey], 'default')).toEqual([
        { seriesKey, total: 4, unplayed: 4, watched: false },
      ]);
    } finally {
      handle.close();
    }
  });

  it('clears the stale series-level watched flag when a single episode is unmarked via setItemWatched(ep, false)', async () => {
    const handle = await setupDb();
    try {
      const { db } = handle;
      const seriesKey = 'x:s1:series:35';
      await seedSeriesWithEpisodes(db, {
        sourceId: 's1',
        seriesKey,
        seriesName: 'Drift Line',
        episodes: [
          { key: 'x:s1:episode:551', season: 1, episode: 1, title: 'One', durationSec: 2400 },
          { key: 'x:s1:episode:552', season: 1, episode: 2, title: 'Two', durationSec: 2400 },
        ],
      });

      // Mark full series watched on default and kids profiles
      expect(await setSeriesWatchedInDb(db, seriesKey, true, () => 1_000, 'default')).toEqual(
        ok(2),
      );
      expect(await setSeriesWatchedInDb(db, seriesKey, true, () => 1_000, 'kids')).toEqual(ok(2));
      expect((await listWatched(db, 10, 'default')).map((r) => r.itemKey)).toEqual([seriesKey]);

      // Unmark just episode 1 via single-item setItemWatched(..., false)
      expect(await setItemWatched(db, 'x:s1:episode:551', false, () => 2_000, 'default')).toEqual(
        ok(undefined),
      );

      // Episode 1 & series-level row are cleared; episode 2 stays watched
      expect((await getWatchProgress(db, 'x:s1:episode:551', 'default'))?.watched).toBe(false);
      expect((await getWatchProgress(db, 'x:s1:episode:552', 'default'))?.watched).toBe(true);
      expect(await getWatchProgress(db, seriesKey, 'default')).toMatchObject({
        watched: false,
        positionMs: 0,
        updatedAt: 2_000,
      });
      expect(await listSeriesUnplayedCounts(db, [seriesKey], 'default')).toEqual([
        { seriesKey, total: 2, unplayed: 1, watched: false },
      ]);
      expect(await listWatched(db, 10, 'default')).toEqual([]);

      // Kids profile remains completely untouched
      expect((await getWatchProgress(db, seriesKey, 'kids'))?.watched).toBe(true);
      expect((await listWatched(db, 10, 'kids')).map((r) => r.itemKey)).toEqual([seriesKey]);

      // Also handles fallback to episodes table when only the series-level row existed in watch_progress
      const seriesKey2 = 'x:s1:series:36';
      await seedSeriesWithEpisodes(db, {
        sourceId: 's1',
        seriesKey: seriesKey2,
        seriesName: 'Fallback Line',
        episodes: [
          { key: 'x:s1:episode:561', season: 1, episode: 1, title: 'Only', durationSec: 1800 },
        ],
      });
      expect(await setItemWatched(db, seriesKey2, true, () => 3_000, 'default')).toEqual(
        ok(undefined),
      );
      expect(await setItemWatched(db, 'x:s1:episode:561', false, () => 4_000, 'default')).toEqual(
        ok(undefined),
      );
      expect((await getWatchProgress(db, seriesKey2, 'default'))?.watched).toBe(false);
      expect(await listSeriesUnplayedCounts(db, [seriesKey2], 'default')).toEqual([
        { seriesKey: seriesKey2, total: 1, unplayed: 1, watched: false },
      ]);
      expect(await listWatched(db, 10, 'default')).toEqual([]);
    } finally {
      handle.close();
    }
  });

  it('handles season 0 (NULL season) and validates invalid arguments cleanly', async () => {
    const handle = await setupDb();
    try {
      const { db } = handle;
      const seriesKey = 'x:s1:series:40';
      await seedSeriesWithEpisodes(db, {
        sourceId: 's1',
        seriesKey,
        seriesName: 'Null Season Show',
        episodes: [
          { key: 'x:s1:episode:601', season: null, episode: 1, title: 'Bonus', durationSec: 600 },
        ],
      });

      expect(await setSeasonWatchedInDb(db, seriesKey, 0, true, () => 3_000)).toEqual(ok(1));
      expect((await getWatchProgress(db, 'x:s1:episode:601'))?.watched).toBe(true);
      expect(await setSeasonWatchedInDb(db, seriesKey, 0, false, () => 4_000)).toEqual(ok(1));
      expect((await getWatchProgress(db, 'x:s1:episode:601'))?.watched).toBe(false);

      expect((await setSeasonWatchedInDb(db, '', 1, true)).ok).toBe(false);
      expect((await setSeasonWatchedInDb(db, seriesKey, -1, true)).ok).toBe(false);
      expect((await setSeasonWatchedInDb(db, seriesKey, 1.5, true)).ok).toBe(false);
      expect((await setSeasonWatchedInDb(db, seriesKey, Number.NaN, true)).ok).toBe(false);
      expect((await setSeriesWatchedInDb(db, '   ', true)).ok).toBe(false);
      expect(await setSeasonWatchedInDb(db, 'x:s1:series:missing', 1, true)).toEqual(ok(0));
    } finally {
      handle.close();
    }
  });
});

describe('CatalogService lazy episode hydration for setSeasonWatched & setSeriesWatched', () => {
  async function createXtreamCatalogHarness(seriesInfoImpl: () => Promise<Response | Error>) {
    const handle = await setupDb();
    const secrets = memorySecrets();
    const { store: userData, writes: userDataWrites } = makeMemoryUserDataStore();
    let seriesInfoCalls = 0;

    const http = {
      async get(url: string) {
        if (url.includes('action=get_series_info')) {
          seriesInfoCalls += 1;
          const out = await seriesInfoImpl();
          if (out instanceof Error) {
            return err(elvError('network', 'unreachable', out.message));
          }
          const text = await out.text();
          const bytes = new TextEncoder().encode(text);
          return ok({
            status: out.status,
            headers: { 'content-type': 'application/json' },
            body: {
              async *[Symbol.asyncIterator]() {
                yield bytes;
              },
            },
          });
        }
        return err(elvError('network', 'unreachable', `unexpected url: ${url}`));
      },
    };

    const service = createCatalogService({
      db: handle.db,
      secrets,
      scheduler: countingScheduler(),
      http,
      clock: () => 50_000,
      userData,
    });

    const added = await service.addSource({
      kind: 'xtream',
      name: 'Demo Xtream',
      server: 'http://provider.invalid',
      username: 'u',
      password: 'p',
    });
    if (!added.ok) throw new Error('addSource failed');
    const sourceId = added.value.id;
    const seriesKey = `x:${sourceId}:series:77`;

    await handle.db.run(
      `INSERT INTO series (source_id, key, provider_id, name, name_fold, cover, run_id)
       VALUES (?, ?, '77', 'Orbital', 'orbital', 'https://img.example/orbital.jpg', 1)`,
      [sourceId, seriesKey],
    );

    return {
      handle,
      service,
      sourceId,
      seriesKey,
      userDataWrites,
      getSeriesInfoCalls: () => seriesInfoCalls,
    };
  }

  it('lazily hydrates Xtream episodes on setSeriesWatched(true), syncs userData, and does not re-fetch on subsequent calls', async () => {
    const h = await createXtreamCatalogHarness(
      async () =>
        new Response(
          JSON.stringify({
            episodes: {
              '1': [
                {
                  id: '9001',
                  episode_num: 1,
                  title: 'S1E1',
                  container_extension: 'mp4',
                  info: { duration_secs: 1800 },
                },
                {
                  id: '9002',
                  episode_num: 2,
                  title: 'S1E2',
                  container_extension: 'mp4',
                  info: { duration_secs: 1900 },
                },
              ],
              '2': [
                {
                  id: '9003',
                  episode_num: 1,
                  title: 'S2E1',
                  container_extension: 'mp4',
                  info: { duration_secs: 2000 },
                },
              ],
            },
          }),
          { status: 200 },
        ),
    );
    try {
      const beforeWrites = h.userDataWrites.length;
      const marked = await h.service.setSeriesWatched?.(h.seriesKey, true, 'default');
      expect(marked).toEqual(ok(3));
      expect(h.getSeriesInfoCalls()).toBe(1);
      expect(h.userDataWrites.length).toBeGreaterThan(beforeWrites);

      expect(await h.service.listSeriesUnplayedCounts?.([h.seriesKey], 'default')).toEqual([
        { seriesKey: h.seriesKey, total: 3, unplayed: 0, watched: true },
      ]);
      expect((await h.service.listWatched?.(10, 'default'))?.map((r) => r.itemKey)).toEqual([
        h.seriesKey,
      ]);

      // Subsequent season unmark does not re-fetch HTTP because episodes are already in SQLite
      const unmarkedS2 = await h.service.setSeasonWatched?.(h.seriesKey, 2, false, 'default');
      expect(unmarkedS2).toEqual(ok(1));
      expect(h.getSeriesInfoCalls()).toBe(1);
      expect(await h.service.listSeriesUnplayedCounts?.([h.seriesKey], 'default')).toEqual([
        { seriesKey: h.seriesKey, total: 3, unplayed: 1, watched: false },
      ]);
    } finally {
      await h.service.close();
      h.handle.close();
    }
  });

  it('lazily hydrates Xtream episodes on setSeasonWatched(true) and marks only the requested season', async () => {
    const h = await createXtreamCatalogHarness(
      async () =>
        new Response(
          JSON.stringify({
            episodes: {
              '1': [
                {
                  id: '9101',
                  episode_num: 1,
                  title: 'Alpha',
                  container_extension: 'mp4',
                  info: { duration_secs: 1500 },
                },
                {
                  id: '9102',
                  episode_num: 2,
                  title: 'Beta',
                  container_extension: 'mp4',
                  info: { duration_secs: 1600 },
                },
              ],
              '2': [
                {
                  id: '9103',
                  episode_num: 1,
                  title: 'Gamma',
                  container_extension: 'mp4',
                  info: { duration_secs: 1700 },
                },
              ],
            },
          }),
          { status: 200 },
        ),
    );
    try {
      const res = await h.service.setSeasonWatched?.(h.seriesKey, 1, true, 'default');
      expect(res).toEqual(ok(2));
      expect(h.getSeriesInfoCalls()).toBe(1);

      expect((await h.service.getProgress?.(`x:${h.sourceId}:episode:9101`))?.watched).toBe(true);
      expect((await h.service.getProgress?.(`x:${h.sourceId}:episode:9102`))?.watched).toBe(true);
      expect(await h.service.getProgress?.(`x:${h.sourceId}:episode:9103`)).toBeNull();
    } finally {
      await h.service.close();
      h.handle.close();
    }
  });

  it('propagates lazy hydration errors cleanly without mutating watch_progress', async () => {
    const h = await createXtreamCatalogHarness(async () => new Error('socket closed'));
    try {
      const res = await h.service.setSeriesWatched?.(h.seriesKey, true, 'default');
      expect(res?.ok).toBe(false);
      if (res && !res.ok) {
        expect(res.error.category).toBe('network');
      }
      expect(await h.service.getProgress?.(h.seriesKey)).toBeNull();
    } finally {
      await h.service.close();
      h.handle.close();
    }
  });

  it('clears series-level watched flag offline without HTTP fetch when setSeriesWatched(false) is called with 0 imported episodes', async () => {
    const h = await createXtreamCatalogHarness(async () => new Error('offline'));
    try {
      await setItemWatched(h.handle.db, h.seriesKey, true, () => 1_000, 'default');
      expect((await h.service.getProgress?.(h.seriesKey))?.watched).toBe(true);

      const res = await h.service.setSeriesWatched?.(h.seriesKey, false, 'default');
      expect(res).toEqual(ok(0));
      expect(h.getSeriesInfoCalls()).toBe(0);
      expect((await h.service.getProgress?.(h.seriesKey))?.watched).toBe(false);
    } finally {
      await h.service.close();
      h.handle.close();
    }
  });
});

describe('createCoalescedCatalog bulk series/season watched flushing', () => {
  it('flushes pending progress and watched writes for the profile BEFORE running setSeasonWatched or setSeriesWatched', async () => {
    const timers = createFakeTimers();
    const order: string[] = [];

    const stub: CatalogService = {
      addSource: async () => err(elvError('storage', 'unsupported')),
      addSourceFromLink: async () => err(elvError('storage', 'unsupported')),
      removeSource: async () => ok(undefined),
      importSource: async () => err(elvError('storage', 'unsupported')),
      listSources: async () => [],
      categories: async () => [],
      items: async () => [],
      seasons: async () => ok([]),
      episodes: async () => [],
      resolveStream: async () => err(elvError('storage', 'unsupported')),
      saveProgress: vi.fn(async (input) => {
        order.push(`saveProgress:${input.itemKey}`);
        return ok({
          profileId: input.profileId ?? 'default',
          sourceId: input.sourceId,
          itemKey: input.itemKey,
          kind: input.kind,
          title: input.title,
          subtitle: input.subtitle ?? null,
          logo: input.logo ?? null,
          seriesKey: input.seriesKey ?? null,
          season: input.season ?? null,
          episode: input.episode ?? null,
          positionMs: input.positionMs,
          durationMs: input.durationMs,
          watched: input.watched ?? false,
          updatedAt: 100,
        } satisfies WatchProgressRow);
      }),
      setWatched: vi.fn(async (itemKey, watched) => {
        order.push(`setWatched:${itemKey}:${watched}`);
        return ok(undefined);
      }),
      setSeasonWatched: vi.fn(async (seriesKey, season, watched) => {
        order.push(`setSeasonWatched:${seriesKey}:S${season}:${watched}`);
        return ok(4);
      }),
      setSeriesWatched: vi.fn(async (seriesKey, watched) => {
        order.push(`setSeriesWatched:${seriesKey}:${watched}`);
        return ok(8);
      }),
      close: async () => undefined,
    };

    const coalesced = createCoalescedCatalog(stub, {
      windowMs: 500,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    // Queue debounced progress + watched writes for default profile (do NOT run timers)
    const p1 = coalesced.saveProgress?.({
      sourceId: 's1',
      itemKey: 'x:s1:episode:1',
      kind: 'episode',
      title: 'Ep 1',
      seriesKey: 'x:s1:series:1',
      season: 1,
      episode: 1,
      positionMs: 45_000,
      durationMs: 100_000,
    });
    const p2 = coalesced.setWatched?.('x:s1:episode:2', true, 'default');

    // Immediately bulk-unmark Season 1 -> must flush p1 & p2 first!
    const seasonRes = await coalesced.setSeasonWatched?.('x:s1:series:1', 1, false, 'default');
    await Promise.all([p1, p2]);
    expect(seasonRes).toEqual(ok(4));
    expect(order.slice(0, 2).sort()).toEqual([
      'saveProgress:x:s1:episode:1',
      'setWatched:x:s1:episode:2:true',
    ]);
    expect(order[2]).toBe('setSeasonWatched:x:s1:series:1:S1:false');

    // Queue debounced write on kids profile and bulk-mark series on kids profile
    order.length = 0;
    const p3 = coalesced.saveProgress?.({
      profileId: 'kids',
      sourceId: 's1',
      itemKey: 'x:s1:episode:3',
      kind: 'episode',
      title: 'Ep 3',
      seriesKey: 'x:s1:series:1',
      season: 2,
      episode: 1,
      positionMs: 12_000,
      durationMs: 100_000,
    });
    const seriesRes = await coalesced.setSeriesWatched?.('x:s1:series:1', true, 'kids');
    await p3;
    expect(seriesRes).toEqual(ok(8));
    expect(order).toEqual(['saveProgress:x:s1:episode:3', 'setSeriesWatched:x:s1:series:1:true']);

    await coalesced.close();
  });
});
