import { ok } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createCatalogService } from './catalog';
import { openCatalog } from './migrate';
import { countingScheduler, memorySecrets, testDb } from './test-db';
import {
  listSeriesUnplayedCounts,
  type SeriesUnplayedSummary,
  saveWatchProgress,
  setItemWatched,
} from './user-state';

async function setupDb() {
  const handle = testDb();
  await openCatalog(handle.db);
  await handle.db.run(
    "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Src 1', 100, '{}')",
  );
  await handle.db.run(
    "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s2', 'xtream', 'Src 2', 100, '{}')",
  );
  return handle;
}

describe('listSeriesUnplayedCounts (#409)', () => {
  it('returns empty array for empty or blank-only input', async () => {
    const { db, close } = await setupDb();
    try {
      expect(await listSeriesUnplayedCounts(db, [])).toEqual([]);
      expect(await listSeriesUnplayedCounts(db, ['', '   '])).toEqual([]);
    } finally {
      close();
    }
  });

  it('aggregates multiple series in one batch: partial, fully watched, explicitly watched, and unfetched', async () => {
    const { db, close } = await setupDb();
    try {
      await db.run(
        `INSERT INTO series (source_id, key, name, name_fold, run_id)
         VALUES
           ('s1', 'x:s1:series:1', 'Partial Show', 'partial show', 1),
           ('s1', 'x:s1:series:2', 'Completed Show', 'completed show', 1),
           ('s1', 'x:s1:series:3', 'Explicit Show', 'explicit show', 1),
           ('s1', 'x:s1:series:4', 'Unfetched Show', 'unfetched show', 1),
           ('s1', 'x:s1:series:5', 'Unfetched Explicit', 'unfetched explicit', 1),
           ('s2', 'x:s2:series:6', 'Other Source Show', 'other source show', 1)`,
      );

      // Series 1: 5 episodes, 2 watched, 1 in-progress (watched=0), 2 untouched -> total 5, unplayed 3, watched false
      for (let i = 1; i <= 5; i += 1) {
        await db.run(
          `INSERT INTO episodes (source_id, key, series_key, season, episode, title, run_id)
           VALUES ('s1', ?, 'x:s1:series:1', 1, ?, ?, 1)`,
          [`x:s1:ep:10${i}`, i, `Ep ${i}`],
        );
      }
      await setItemWatched(db, 'x:s1:ep:101', true, () => 100);
      await setItemWatched(db, 'x:s1:ep:102', true, () => 200);
      await saveWatchProgress(
        db,
        {
          sourceId: 's1',
          itemKey: 'x:s1:ep:103',
          kind: 'episode',
          title: 'Ep 3',
          seriesKey: 'x:s1:series:1',
          season: 1,
          episode: 3,
          positionMs: 30_000,
          durationMs: 120_000,
        },
        () => 300,
      );

      // Series 2: 3 episodes, all 3 watched -> total 3, unplayed 0, watched true
      for (let i = 1; i <= 3; i += 1) {
        await db.run(
          `INSERT INTO episodes (source_id, key, series_key, season, episode, title, run_id)
           VALUES ('s1', ?, 'x:s1:series:2', 1, ?, ?, 1)`,
          [`x:s1:ep:20${i}`, i, `Ep ${i}`],
        );
        await setItemWatched(db, `x:s1:ep:20${i}`, true, () => 400 + i);
      }

      // Series 3: 4 episodes (none watched individually), but series itself explicitly marked watched
      for (let i = 1; i <= 4; i += 1) {
        await db.run(
          `INSERT INTO episodes (source_id, key, series_key, season, episode, title, run_id)
           VALUES ('s1', ?, 'x:s1:series:3', 1, ?, ?, 1)`,
          [`x:s1:ep:30${i}`, i, `Ep ${i}`],
        );
      }
      await setItemWatched(db, 'x:s1:series:3', true, () => 500);

      // Series 4: 0 fetched episodes, not explicitly watched -> must NOT appear in results
      // Series 5: 0 fetched episodes, explicitly marked watched -> total 0, unplayed 0, watched true
      await setItemWatched(db, 'x:s1:series:5', true, () => 600);

      // Series 6 (second source): 2 episodes, 0 watched -> total 2, unplayed 2, watched false
      await db.run(
        `INSERT INTO episodes (source_id, key, series_key, season, episode, title, run_id)
         VALUES
           ('s2', 'x:s2:ep:601', 'x:s2:series:6', 1, 1, 'Pilot', 1),
           ('s2', 'x:s2:ep:602', 'x:s2:series:6', 1, 2, 'Second', 1)`,
      );

      // Another profile's watched state must not leak into default profile
      await setItemWatched(db, 'x:s2:ep:601', true, () => 700, 'kids');

      const result = await listSeriesUnplayedCounts(db, [
        'x:s1:series:1',
        'x:s1:series:1', // duplicate ignored
        'x:s1:series:2',
        'x:s1:series:3',
        'x:s1:series:4',
        'x:s1:series:5',
        'x:s2:series:6',
        '',
      ]);

      const byKey = new Map<string, SeriesUnplayedSummary>(
        result.map((entry) => [entry.seriesKey, entry]),
      );

      expect(byKey.size).toBe(5);
      expect(byKey.get('x:s1:series:1')).toEqual({
        seriesKey: 'x:s1:series:1',
        total: 5,
        unplayed: 3,
        watched: false,
      });
      expect(byKey.get('x:s1:series:2')).toEqual({
        seriesKey: 'x:s1:series:2',
        total: 3,
        unplayed: 0,
        watched: true,
      });
      expect(byKey.get('x:s1:series:3')).toEqual({
        seriesKey: 'x:s1:series:3',
        total: 4,
        unplayed: 0,
        watched: true,
      });
      expect(byKey.has('x:s1:series:4')).toBe(false);
      expect(byKey.get('x:s1:series:5')).toEqual({
        seriesKey: 'x:s1:series:5',
        total: 0,
        unplayed: 0,
        watched: true,
      });
      expect(byKey.get('x:s2:series:6')).toEqual({
        seriesKey: 'x:s2:series:6',
        total: 2,
        unplayed: 2,
        watched: false,
      });

      // Kids profile sees its own watched state on s2:series:6 and none of default's
      const kids = await listSeriesUnplayedCounts(db, ['x:s1:series:2', 'x:s2:series:6'], 'kids');
      const kidsMap = new Map(kids.map((r) => [r.seriesKey, r]));
      expect(kidsMap.get('x:s1:series:2')).toEqual({
        seriesKey: 'x:s1:series:2',
        total: 3,
        unplayed: 3,
        watched: false,
      });
      expect(kidsMap.get('x:s2:series:6')).toEqual({
        seriesKey: 'x:s2:series:6',
        total: 2,
        unplayed: 1,
        watched: false,
      });
    } finally {
      close();
    }
  });

  it('caps lookup to 200 distinct non-empty series keys and supports unprefixed custom keys', async () => {
    const { db, close } = await setupDb();
    try {
      for (let i = 1; i <= 205; i += 1) {
        const sKey = `x:s1:series:${i}`;
        await db.run(
          `INSERT INTO episodes (source_id, key, series_key, season, episode, title, run_id)
           VALUES ('s1', ?, ?, 1, 1, 'Ep 1', 1)`,
          [`x:s1:ep:${i}`, sKey],
        );
      }
      const allKeys = Array.from({ length: 205 }, (_, idx) => `x:s1:series:${idx + 1}`);
      const capped = await listSeriesUnplayedCounts(db, allKeys);
      expect(capped).toHaveLength(200);
      expect(capped.some((r) => r.seriesKey === 'x:s1:series:201')).toBe(false);

      // Unprefixed custom series key fallback
      await db.run(
        `INSERT INTO episodes (source_id, key, series_key, season, episode, title, run_id)
         VALUES ('s1', 'custom-ep-1', 'custom-series-1', 1, 1, 'Pilot', 1)`,
      );
      const custom = await listSeriesUnplayedCounts(db, ['custom-series-1']);
      expect(custom).toEqual([
        { seriesKey: 'custom-series-1', total: 1, unplayed: 1, watched: false },
      ]);
    } finally {
      close();
    }
  });

  it('is exposed via CatalogService.listSeriesUnplayedCounts', async () => {
    const { db, close } = await setupDb();
    try {
      await db.run(
        `INSERT INTO episodes (source_id, key, series_key, season, episode, title, run_id)
         VALUES
           ('s1', 'x:s1:ep:1', 'x:s1:series:99', 1, 1, 'Ep 1', 1),
           ('s1', 'x:s1:ep:2', 'x:s1:series:99', 1, 2, 'Ep 2', 1)`,
      );
      const catalog = createCatalogService({
        db,
        secrets: memorySecrets(),
        scheduler: countingScheduler(),
        http: {
          async get() {
            return ok({
              status: 200,
              headers: {},
              body: { async *[Symbol.asyncIterator]() {} },
            });
          },
        },
        clock: () => 100,
      });

      await catalog.setWatched?.('x:s1:ep:1', true);
      const counts = await catalog.listSeriesUnplayedCounts?.(['x:s1:series:99']);
      expect(counts).toEqual([
        { seriesKey: 'x:s1:series:99', total: 2, unplayed: 1, watched: false },
      ]);
      await catalog.close();
    } finally {
      close();
    }
  });

  it('unwatching a series clears individually watched episode rows for that profile only (#409)', async () => {
    const { db, close } = await setupDb();
    try {
      await db.run(
        `INSERT INTO series (source_id, key, name, name_fold, run_id)
         VALUES
           ('s1', 'x:s1:series:10', 'Show Ten', 'show ten', 1),
           ('s1', 'x:s1:series:20', 'Show Twenty', 'show twenty', 1)`,
      );
      for (let i = 1; i <= 3; i += 1) {
        await db.run(
          `INSERT INTO episodes (source_id, key, series_key, season, episode, title, run_id)
           VALUES ('s1', ?, 'x:s1:series:10', 1, ?, ?, 1)`,
          [`x:s1:ep:10${i}`, i, `Ep ${i}`],
        );
        await setItemWatched(db, `x:s1:ep:10${i}`, true, () => 100 + i, 'default');
        await setItemWatched(db, `x:s1:ep:10${i}`, true, () => 200 + i, 'kids');
      }
      await db.run(
        `INSERT INTO episodes (source_id, key, series_key, season, episode, title, run_id)
         VALUES ('s1', 'x:s1:ep:201', 'x:s1:series:20', 1, 1, 'Other Ep', 1)`,
      );
      await setItemWatched(db, 'x:s1:ep:201', true, () => 300, 'default');

      expect(await listSeriesUnplayedCounts(db, ['x:s1:series:10'], 'default')).toEqual([
        { seriesKey: 'x:s1:series:10', total: 3, unplayed: 0, watched: true },
      ]);

      await setItemWatched(db, 'x:s1:series:10', false, () => 400, 'default');

      expect(await listSeriesUnplayedCounts(db, ['x:s1:series:10'], 'default')).toEqual([
        { seriesKey: 'x:s1:series:10', total: 3, unplayed: 3, watched: false },
      ]);
      // Other profile and other series remain untouched
      expect(await listSeriesUnplayedCounts(db, ['x:s1:series:10'], 'kids')).toEqual([
        { seriesKey: 'x:s1:series:10', total: 3, unplayed: 0, watched: true },
      ]);
      expect(await listSeriesUnplayedCounts(db, ['x:s1:series:20'], 'default')).toEqual([
        { seriesKey: 'x:s1:series:20', total: 1, unplayed: 0, watched: true },
      ]);
    } finally {
      close();
    }
  });

  it('executes a single indexed SQL aggregation over idx_episodes_series without table scans', async () => {
    const { db, close } = await setupDb();
    try {
      const captured: Array<{ sql: string; params: readonly unknown[] }> = [];
      const spyDb = {
        ...db,
        all: async <T>(sql: string, params?: readonly unknown[]) => {
          captured.push({ sql, params: params ?? [] });
          return db.all<T>(sql, params as never);
        },
      };

      await listSeriesUnplayedCounts(spyDb, ['x:s1:series:1', 'x:s1:series:2']);
      expect(captured).toHaveLength(1);
      const query = captured[0];
      expect(query).toBeDefined();
      if (query) {
        const plan = await db.all<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${query.sql}`,
          query.params as never,
        );
        const planText = plan.map((row) => row.detail).join('\n');
        expect(planText).toContain('idx_episodes_series');
        expect(planText).not.toMatch(/\bSCAN\s+(?:e|episodes|wp|watch_progress)\b/i);
      }
    } finally {
      close();
    }
  });
});
