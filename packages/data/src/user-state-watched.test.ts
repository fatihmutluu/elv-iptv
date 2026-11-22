import { describe, expect, it } from 'vitest';
import { openCatalog } from './migrate';
import { testDb } from './test-db';
import {
  getWatchProgress,
  listContinueWatching,
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
