import { describe, expect, it } from 'vitest';
import { createCatalogService } from './catalog';
import { openCatalog } from './migrate';
import { setParentalLock, updateParentalSettings } from './parental-repo';
import { testDb } from './test-db';
import {
  getWatchProgress,
  listContinueWatching,
  listWatched,
  saveWatchProgress,
  setItemWatched,
} from './user-state';

async function setupDb() {
  const handle = testDb();
  await openCatalog(handle.db);
  return handle;
}

describe('user-state #432 fixes (setItemWatched UPSERT, monotonic watched, duration_ms > 0)', () => {
  it('upserts watch_progress on setItemWatched(true) for unplayed catalog items and keeps unmarking/unknown keys no-op', async () => {
    const { db, close } = await setupDb();
    try {
      await db.run(
        "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Src', 100, '{}')",
      );
      await db.run(
        "INSERT INTO movies (source_id, key, name, name_fold, logo, run_id) VALUES ('s1', 'x:s1:movie:10', 'Unplayed Film', 'unplayed film', 'https://img/f10.png', 1)",
      );
      await db.run(
        "INSERT INTO series (source_id, key, name, name_fold, cover, run_id) VALUES ('s1', 'x:s1:series:20', 'Unplayed Show', 'unplayed show', 'https://img/s20.png', 1)",
      );
      await db.run(
        `INSERT INTO episodes (source_id, key, series_key, season, episode, title, run_id)
         VALUES
           ('s1', 'x:s1:ep:201', 'x:s1:series:20', 2, 4, 'Night Signal', 1),
           ('s1', 'x:s1:ep:202', 'x:s1:series:20', 2, 5, NULL, 1)`,
      );
      await db.run(
        "INSERT INTO live (source_id, key, name, name_fold, logo, run_id) VALUES ('s1', 'x:s1:live:30', 'News 24', 'news 24', 'https://img/l30.png', 1)",
      );
      // Also test non-prefixed catalog key fallback
      await db.run(
        "INSERT INTO movies (source_id, key, name, name_fold, logo, run_id) VALUES ('s1', 'custom-key-1', 'Custom Key Film', 'custom key film', NULL, 1)",
      );

      // Unmarking an unplayed item is a safe no-op and inserts no row
      expect((await setItemWatched(db, 'x:s1:movie:10', false, () => 100)).ok).toBe(true);
      expect(await getWatchProgress(db, 'x:s1:movie:10')).toBeNull();

      // Unknown non-catalog key & empty key remain safe no-ops
      expect((await setItemWatched(db, 'x:s1:movie:999', true, () => 150)).ok).toBe(true);
      expect(await getWatchProgress(db, 'x:s1:movie:999')).toBeNull();
      expect((await setItemWatched(db, '', true, () => 150)).ok).toBe(true);

      // Marking unplayed catalog movie, series, episodes, and live inserts watched rows
      expect((await setItemWatched(db, 'x:s1:movie:10', true, () => 200)).ok).toBe(true);
      expect(await getWatchProgress(db, 'x:s1:movie:10')).toMatchObject({
        profileId: 'default',
        sourceId: 's1',
        kind: 'movie',
        title: 'Unplayed Film',
        logo: 'https://img/f10.png',
        positionMs: 0,
        durationMs: 0,
        watched: true,
        updatedAt: 200,
      });

      expect((await setItemWatched(db, 'x:s1:ep:201', true, () => 300, 'kids')).ok).toBe(true);
      expect(await getWatchProgress(db, 'x:s1:ep:201', 'kids')).toMatchObject({
        profileId: 'kids',
        sourceId: 's1',
        kind: 'episode',
        title: 'Night Signal',
        logo: 'https://img/s20.png',
        seriesKey: 'x:s1:series:20',
        season: 2,
        episode: 4,
        positionMs: 0,
        durationMs: 0,
        watched: true,
        updatedAt: 300,
      });
      expect(await getWatchProgress(db, 'x:s1:ep:201')).toBeNull();

      // Episode with null title falls back to parent series name
      expect((await setItemWatched(db, 'x:s1:ep:202', true, () => 350)).ok).toBe(true);
      expect(await getWatchProgress(db, 'x:s1:ep:202')).toMatchObject({
        kind: 'episode',
        title: 'Unplayed Show',
        logo: 'https://img/s20.png',
        seriesKey: 'x:s1:series:20',
        season: 2,
        episode: 5,
        watched: true,
      });

      expect((await setItemWatched(db, 'x:s1:series:20', true, () => 400)).ok).toBe(true);
      expect(await getWatchProgress(db, 'x:s1:series:20')).toMatchObject({
        kind: 'series',
        title: 'Unplayed Show',
        logo: 'https://img/s20.png',
        watched: true,
      });

      expect((await setItemWatched(db, 'x:s1:live:30', true, () => 500)).ok).toBe(true);
      expect(await getWatchProgress(db, 'x:s1:live:30')).toMatchObject({
        kind: 'live',
        title: 'News 24',
        logo: 'https://img/l30.png',
        watched: true,
      });

      expect((await setItemWatched(db, 'custom-key-1', true, () => 600)).ok).toBe(true);
      expect(await getWatchProgress(db, 'custom-key-1')).toMatchObject({
        kind: 'movie',
        title: 'Custom Key Film',
        watched: true,
      });
    } finally {
      close();
    }
  });

  it('preserves watched=true monotonically on rewatch at 10% and filters duration_ms=0 from Continue Watching', async () => {
    const { db, close } = await setupDb();
    try {
      const done = await saveWatchProgress(
        db,
        {
          sourceId: 's1',
          itemKey: 'x:s1:movie:rw',
          kind: 'movie',
          title: 'Rewatch Film',
          positionMs: 95_000,
          durationMs: 100_000,
        },
        () => 1_000,
      );
      expect(done.ok && done.value.watched).toBe(true);

      // Rewatching at 10% keeps watched=true in both return value and SQLite
      const rewatch = await saveWatchProgress(
        db,
        {
          sourceId: 's1',
          itemKey: 'x:s1:movie:rw',
          kind: 'movie',
          title: 'Rewatch Film',
          positionMs: 10_000,
          durationMs: 100_000,
        },
        () => 2_000,
      );
      expect(rewatch.ok && rewatch.value.watched).toBe(true);
      expect(rewatch.ok && rewatch.value.positionMs).toBe(10_000);
      expect(await getWatchProgress(db, 'x:s1:movie:rw')).toMatchObject({
        watched: true,
        positionMs: 10_000,
      });

      // Only explicit setItemWatched(false) clears watched
      expect((await setItemWatched(db, 'x:s1:movie:rw', false, () => 3_000)).ok).toBe(true);
      expect(await getWatchProgress(db, 'x:s1:movie:rw')).toMatchObject({
        watched: false,
        positionMs: 0,
      });

      // listContinueWatching excludes duration_ms = 0 entries even when position_ms >= 10s
      await saveWatchProgress(
        db,
        {
          sourceId: 's1',
          itemKey: 'x:s1:live:nodur',
          kind: 'live',
          title: 'Unknown Duration Stream',
          positionMs: 45_000,
          durationMs: 0,
        },
        () => 4_000,
      );
      await saveWatchProgress(
        db,
        {
          sourceId: 's1',
          itemKey: 'x:s1:movie:valid',
          kind: 'movie',
          title: 'Known Duration Film',
          positionMs: 25_000,
          durationMs: 120_000,
        },
        () => 4_500,
      );
      const cw = await listContinueWatching(db, 10);
      expect(cw.map((r) => r.itemKey)).toEqual(['x:s1:movie:valid']);
    } finally {
      close();
    }
  });
});

describe('listWatched (P0-3)', () => {
  it('returns watched movies, explicitly watched series, and episode-completed series ordered by updatedAt DESC, itemKey ASC', async () => {
    const { db, close } = await setupDb();
    try {
      await db.run(
        "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Src', 100, '{}')",
      );
      await db.run(
        `INSERT INTO movies (source_id, key, name, name_fold, logo, run_id, version_group_key)
         VALUES
           ('s1', 'x:s1:movie:1', 'Movie One', 'movie one', 'https://img/m1.png', 1, 'vg:m1'),
           ('s1', 'x:s1:movie:1b', 'Movie One 4K', 'movie one 4k', 'https://img/m1b.png', 1, 'vg:m1'),
           ('s1', 'x:s1:movie:2', 'Movie Two', 'movie two', 'https://img/m2.png', 1, ''),
           ('s1', 'x:s1:movie:3', 'In Progress Movie', 'in progress movie', NULL, 1, '')`,
      );
      await db.run(
        `INSERT INTO series (source_id, key, name, name_fold, cover, run_id)
         VALUES
           ('s1', 'x:s1:series:explicit', 'Explicit Series', 'explicit series', 'https://img/se.png', 1),
           ('s1', 'x:s1:series:epdone', 'Episode Completed Series', 'episode completed series', 'https://img/sd.png', 1),
           ('s1', 'x:s1:series:partial', 'Partial Series', 'partial series', 'https://img/sp.png', 1)`,
      );
      await db.run(
        `INSERT INTO episodes (source_id, key, series_key, season, episode, title, run_id)
         VALUES
           ('s1', 'x:s1:ep:d1', 'x:s1:series:epdone', 1, 1, 'Ep 1', 1),
           ('s1', 'x:s1:ep:d2', 'x:s1:series:epdone', 1, 2, 'Ep 2', 1),
           ('s1', 'x:s1:ep:p1', 'x:s1:series:partial', 1, 1, 'Part 1', 1),
           ('s1', 'x:s1:ep:p2', 'x:s1:series:partial', 1, 2, 'Part 2', 1)`,
      );
      await db.run(
        "INSERT INTO live (source_id, key, name, name_fold, logo, run_id) VALUES ('s1', 'x:s1:live:1', 'Live Ch', 'live ch', NULL, 1)",
      );

      // Multi-version movie watched (both versions in watch_progress -> should deduplicate to 1)
      await saveWatchProgress(
        db,
        {
          sourceId: 's1',
          itemKey: 'x:s1:movie:1',
          kind: 'movie',
          title: 'Movie One',
          positionMs: 95_000,
          durationMs: 100_000,
        },
        () => 1_000,
      );
      await saveWatchProgress(
        db,
        {
          sourceId: 's1',
          itemKey: 'x:s1:movie:1b',
          kind: 'movie',
          title: 'Movie One 4K',
          positionMs: 95_000,
          durationMs: 100_000,
        },
        () => 1_500,
      );

      // Movie Two watched at 2_000 (same timestamp tie-break check with Explicit Series)
      await setItemWatched(db, 'x:s1:movie:2', true, () => 2_000);
      // In-progress movie (must NOT appear)
      await saveWatchProgress(
        db,
        {
          sourceId: 's1',
          itemKey: 'x:s1:movie:3',
          kind: 'movie',
          title: 'In Progress Movie',
          positionMs: 30_000,
          durationMs: 100_000,
        },
        () => 5_000,
      );
      // Live item marked watched (must NOT appear in movie/series listWatched)
      await setItemWatched(db, 'x:s1:live:1', true, () => 6_000);

      // Explicit series watched at 2_000 (tie-breaks after x:s1:movie:2 by itemKey ASC)
      await setItemWatched(db, 'x:s1:series:explicit', true, () => 2_000);

      // All episodes watched for epdone (parent series NOT explicitly in watch_progress)
      await setItemWatched(db, 'x:s1:ep:d1', true, () => 2_500);
      await setItemWatched(db, 'x:s1:ep:d2', true, () => 3_000);

      // Only 1 of 2 episodes watched for partial -> must NOT appear
      await setItemWatched(db, 'x:s1:ep:p1', true, () => 4_000);

      // Another profile's watched movie -> isolated
      await setItemWatched(db, 'x:s1:movie:2', true, () => 9_000, 'kids');

      // Omitted kind returns movies + series (explicit + episode-completed), ordered by updatedAt DESC, itemKey ASC
      const all = await listWatched(db, 100, 'default');
      expect(all.map((r) => [r.itemKey, r.kind, r.title, r.updatedAt])).toEqual([
        ['x:s1:series:epdone', 'series', 'Episode Completed Series', 3_000],
        ['x:s1:movie:2', 'movie', 'Movie Two', 2_000],
        ['x:s1:series:explicit', 'series', 'Explicit Series', 2_000],
        ['x:s1:movie:1', 'movie', 'Movie One', 1_500],
      ]);

      // Filter kind='movie'
      const moviesOnly = await listWatched(db, 100, 'default', { kind: 'movie' });
      expect(moviesOnly.map((r) => r.itemKey)).toEqual(['x:s1:movie:2', 'x:s1:movie:1']);

      // Filter kind='series'
      const seriesOnly = await listWatched(db, 100, 'default', { kind: 'series' });
      expect(seriesOnly.map((r) => r.itemKey)).toEqual([
        'x:s1:series:epdone',
        'x:s1:series:explicit',
      ]);

      // Limit clamping (0 -> empty, 2 -> top 2)
      expect(await listWatched(db, 0, 'default')).toEqual([]);
      expect((await listWatched(db, 2, 'default')).map((r) => r.itemKey)).toEqual([
        'x:s1:series:epdone',
        'x:s1:movie:2',
      ]);

      // Profile isolation
      expect((await listWatched(db, 100, 'kids')).map((r) => r.itemKey)).toEqual(['x:s1:movie:2']);

      // Unmarking epdone series clears episode watched flags -> disappears from listWatched
      await setItemWatched(db, 'x:s1:series:epdone', false, () => 4_500);
      expect(
        (await listWatched(db, 100, 'default', { kind: 'series' })).map((r) => r.itemKey),
      ).toEqual(['x:s1:series:explicit']);
    } finally {
      close();
    }
  });

  it('enforces parental locks unless parentalUnlocked is true and wires through CatalogService', async () => {
    const { db, close } = await setupDb();
    try {
      await db.run(
        "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Src', 100, '{}')",
      );
      await db.run(
        `INSERT INTO movies (source_id, key, name, name_fold, logo, run_id)
         VALUES
           ('s1', 'x:s1:movie:safe', 'Family Film', 'family film', NULL, 1),
           ('s1', 'x:s1:movie:locked', 'Restricted Film', 'restricted film', NULL, 1)`,
      );
      await setItemWatched(db, 'x:s1:movie:safe', true, () => 1_000);
      await setItemWatched(db, 'x:s1:movie:locked', true, () => 2_000);
      await updateParentalSettings(db, 'default', { enabled: true });
      await setParentalLock(
        db,
        {
          profileId: 'default',
          sourceId: 's1',
          targetKind: 'item',
          itemKind: 'movie',
          targetKey: 'x:s1:movie:locked',
        },
        true,
      );

      expect((await listWatched(db, 10, 'default')).map((r) => r.itemKey)).toEqual([
        'x:s1:movie:safe',
      ]);
      expect(
        (await listWatched(db, 10, 'default', { parentalUnlocked: true })).map((r) => r.itemKey),
      ).toEqual(['x:s1:movie:locked', 'x:s1:movie:safe']);

      const secrets = new Map<string, string>();
      const svc = createCatalogService({
        db,
        secrets: {
          get: async (k) => secrets.get(k),
          set: async (k, v) => {
            secrets.set(k, v);
          },
          delete: async (k) => {
            secrets.delete(k);
          },
        },
        scheduler: { yieldNow: async () => undefined },
        http: {
          get: async () => {
            throw new Error('unused');
          },
        },
        clock: () => 3_000,
      });
      expect(
        (await svc.listWatched?.(10, 'default', { kind: 'movie' }))?.map((r) => r.itemKey),
      ).toEqual(['x:s1:movie:safe']);
      await svc.close();
    } finally {
      close();
    }
  });
});
