import type { SqlDriver } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createCatalogService } from './catalog';
import { openCatalog } from './migrate';
import { setParentalLock, updateParentalSettings } from './parental-repo';
import { createProfile, deleteProfile } from './profiles-repo';
import { removeSource, TABLES_BY_SOURCE } from './sources';
import { countingScheduler, memorySecrets, testDb } from './test-db';
import {
  clearWatchProgress,
  getWatchProgress,
  listContinueWatching,
  saveWatchProgress,
  setItemWatched,
} from './user-state';

async function setupSeriesCatalog() {
  const handle = testDb();
  const { db } = handle;
  await openCatalog(db);
  await db.run(
    "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Main', 100, '{}')",
  );
  await db.run(
    `INSERT INTO categories (source_id, kind, provider_id, name, name_fold, position, run_id)
     VALUES ('s1', 'series', 'cat1', 'Drama', 'drama', 0, 1)`,
  );
  await db.run(
    `INSERT INTO series (source_id, key, name, name_fold, cover, run_id)
     VALUES
       ('s1', 'x:s1:series:1', 'Northern Signal', 'northern signal', 'https://img.example/ns.jpg', 1),
       ('s1', 'x:s1:series:2', 'Harbor Watch', 'harbor watch', 'https://img.example/hw.jpg', 1)`,
  );
  await db.run(
    `INSERT INTO placements (source_id, kind, item_key, category_id, position, run_id)
     VALUES
       ('s1', 'series', 'x:s1:series:1', 'cat1', 0, 1),
       ('s1', 'series', 'x:s1:series:2', 'cat1', 1, 1)`,
  );
  await db.run(
    `INSERT INTO episodes (source_id, key, series_key, season, episode, title, duration_sec, run_id)
     VALUES
       ('s1', 'x:s1:ep:101', 'x:s1:series:1', 1, 1, 'Pilot', 2700, 1),
       ('s1', 'x:s1:ep:102', 'x:s1:series:1', 1, 2, 'Cold Harbor', 2820, 1),
       ('s1', 'x:s1:ep:103', 'x:s1:series:1', 1, 3, 'Silent Crossing', 2940, 1),
       ('s1', 'x:s1:ep:104', 'x:s1:series:1', 1, 4, 'Breakwater', 3000, 1),
       ('s1', 'x:s1:ep:110', 'x:s1:series:1', 1, 10, 'Season Finale', 3300, 1),
       ('s1', 'x:s1:ep:201', 'x:s1:series:1', 2, 1, 'New Horizon', 3100, 1),
       ('s1', 'x:s1:ep:hw1', 'x:s1:series:2', 1, 1, 'First Watch', 2400, 1),
       ('s1', 'x:s1:ep:hw2', 'x:s1:series:2', 1, 2, 'Second Watch', 2500, 1)`,
  );
  return handle;
}

async function seedEpisodeProgress(
  db: SqlDriver,
  opts: {
    itemKey: string;
    seriesKey?: string;
    season: number;
    episode: number;
    title?: string;
    subtitle?: string;
    positionMs: number;
    durationMs: number;
    watched?: boolean;
    profileId?: string;
    at: number;
  },
) {
  return saveWatchProgress(
    db,
    {
      ...(opts.profileId === undefined ? {} : { profileId: opts.profileId }),
      sourceId: 's1',
      itemKey: opts.itemKey,
      kind: 'episode',
      title: opts.title ?? 'Northern Signal',
      subtitle: opts.subtitle ?? null,
      seriesKey: opts.seriesKey ?? 'x:s1:series:1',
      season: opts.season,
      episode: opts.episode,
      positionMs: opts.positionMs,
      durationMs: opts.durationMs,
      ...(opts.watched === undefined ? {} : { watched: opts.watched }),
    },
    () => opts.at,
  );
}

describe('Continue Watching Next-Up episode progression', () => {
  it('surfaces S1E2 with positionMs 0 after finishing S1E1 via saveWatchProgress or setItemWatched', async () => {
    const { db, close } = await setupSeriesCatalog();
    try {
      await seedEpisodeProgress(db, {
        itemKey: 'x:s1:ep:101',
        season: 1,
        episode: 1,
        positionMs: 2_500_000,
        durationMs: 2_700_000,
        watched: true,
        at: 10_000,
      });

      const list = await listContinueWatching(db, 10);
      expect(list).toHaveLength(1);
      expect(list[0]).toEqual({
        profileId: 'default',
        sourceId: 's1',
        itemKey: 'x:s1:ep:102',
        kind: 'episode',
        title: 'Northern Signal',
        subtitle: 'S1 · E2 — Cold Harbor',
        logo: 'https://img.example/ns.jpg',
        seriesKey: 'x:s1:series:1',
        season: 1,
        episode: 2,
        positionMs: 0,
        durationMs: 2_820_000,
        watched: false,
        updatedAt: 10_000,
      });

      // Also verify setItemWatched on an unplayed episode surfaces the next episode
      await setItemWatched(db, 'x:s1:ep:hw1', true, () => 20_000);
      const listAfterSetWatched = await listContinueWatching(db, 10);
      expect(listAfterSetWatched.map((r) => r.itemKey)).toEqual(['x:s1:ep:hw2', 'x:s1:ep:102']);
      expect(listAfterSetWatched[0]).toMatchObject({
        title: 'Harbor Watch',
        subtitle: 'S1 · E2 — Second Watch',
        logo: 'https://img.example/hw.jpg',
        seriesKey: 'x:s1:series:2',
        season: 1,
        episode: 2,
        positionMs: 0,
        durationMs: 2_500_000,
        watched: false,
        updatedAt: 20_000,
      });
    } finally {
      close();
    }
  });

  it('rolls over across seasons: finishing S1E10 surfaces S2E01', async () => {
    const { db, close } = await setupSeriesCatalog();
    try {
      await seedEpisodeProgress(db, {
        itemKey: 'x:s1:ep:110',
        season: 1,
        episode: 10,
        positionMs: 3_100_000,
        durationMs: 3_300_000,
        watched: true,
        at: 15_000,
      });

      const list = await listContinueWatching(db, 10);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        itemKey: 'x:s1:ep:201',
        seriesKey: 'x:s1:series:1',
        title: 'Northern Signal',
        subtitle: 'S2 · E1 — New Horizon',
        season: 2,
        episode: 1,
        positionMs: 0,
        durationMs: 3_100_000,
        watched: false,
        updatedAt: 15_000,
      });
    } finally {
      close();
    }
  });

  it('skips already-watched middle episodes and never surfaces an already-watched episode', async () => {
    const { db, close } = await setupSeriesCatalog();
    try {
      // S1E2 was already watched earlier; then user finishes S1E1 most recently -> must surface S1E3
      await setItemWatched(db, 'x:s1:ep:102', true, () => 5_000);
      await seedEpisodeProgress(db, {
        itemKey: 'x:s1:ep:101',
        season: 1,
        episode: 1,
        positionMs: 2_600_000,
        durationMs: 2_700_000,
        watched: true,
        at: 10_000,
      });

      const listAfterS1E1 = await listContinueWatching(db, 10);
      expect(listAfterS1E1.map((r) => r.itemKey)).toEqual(['x:s1:ep:103']);

      // When S1E2 is finished after S1E1, S1E3 is also surfaced
      await setItemWatched(db, 'x:s1:ep:102', true, () => 12_000);
      const listAfterS1E2 = await listContinueWatching(db, 10);
      expect(listAfterS1E2.map((r) => r.itemKey)).toEqual(['x:s1:ep:103']);

      // When ALL subsequent episodes are already watched (rewatching S1E1), surface nothing for this series
      await setItemWatched(db, 'x:s1:ep:103', true, () => 13_000);
      await setItemWatched(db, 'x:s1:ep:104', true, () => 14_000);
      await setItemWatched(db, 'x:s1:ep:110', true, () => 15_000);
      await setItemWatched(db, 'x:s1:ep:201', true, () => 16_000);
      await setItemWatched(db, 'x:s1:ep:101', true, () => 20_000);

      expect(await listContinueWatching(db, 10)).toEqual([]);
    } finally {
      close();
    }
  });

  it('shows nothing in Continue Watching after finishing the series finale or stopping < 10s', async () => {
    const { db, close } = await setupSeriesCatalog();
    try {
      await seedEpisodeProgress(db, {
        itemKey: 'x:s1:ep:201',
        season: 2,
        episode: 1,
        positionMs: 3_000_000,
        durationMs: 3_100_000,
        watched: true,
        at: 10_000,
      });

      // Series 2: started S1E1 for only 4s (< MIN_RESUME_POSITION_MS), not watched
      await seedEpisodeProgress(db, {
        itemKey: 'x:s1:ep:hw1',
        seriesKey: 'x:s1:series:2',
        title: 'Harbor Watch',
        season: 1,
        episode: 1,
        positionMs: 4_000,
        durationMs: 2_400_000,
        watched: false,
        at: 11_000,
      });

      expect(await listContinueWatching(db, 10)).toEqual([]);
    } finally {
      close();
    }
  });

  it('prefers an active in-progress episode over synthesized Next-Up for the same series', async () => {
    const { db, close } = await setupSeriesCatalog();
    try {
      // S1E1 completed earlier, S1E2 actively in progress at 12 min
      await seedEpisodeProgress(db, {
        itemKey: 'x:s1:ep:101',
        season: 1,
        episode: 1,
        positionMs: 2_650_000,
        durationMs: 2_700_000,
        watched: true,
        at: 10_000,
      });
      await seedEpisodeProgress(db, {
        itemKey: 'x:s1:ep:102',
        season: 1,
        episode: 2,
        subtitle: 'Cold Harbor',
        positionMs: 720_000,
        durationMs: 2_820_000,
        watched: false,
        at: 15_000,
      });

      const list = await listContinueWatching(db, 10);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        itemKey: 'x:s1:ep:102',
        positionMs: 720_000,
        durationMs: 2_820_000,
        watched: false,
      });

      // Even if S1E1 is re-marked watched at a later timestamp while S1E2 is in progress,
      // the active in-progress S1E2 takes precedence over a Next-Up row for the same series.
      await setItemWatched(db, 'x:s1:ep:101', true, () => 25_000);
      const listAfterRewatch = await listContinueWatching(db, 10);
      expect(listAfterRewatch).toHaveLength(1);
      expect(listAfterRewatch[0]).toMatchObject({
        itemKey: 'x:s1:ep:102',
        positionMs: 720_000,
      });
    } finally {
      close();
    }
  });

  it('dismisses Next-Up via clearWatchProgress without erasing S1E1 watched status and resumes after watching a later episode', async () => {
    const { db, close } = await setupSeriesCatalog();
    try {
      await seedEpisodeProgress(db, {
        itemKey: 'x:s1:ep:101',
        season: 1,
        episode: 1,
        positionMs: 2_650_000,
        durationMs: 2_700_000,
        watched: true,
        at: 10_000,
      });

      expect((await listContinueWatching(db, 10)).map((r) => r.itemKey)).toEqual(['x:s1:ep:102']);

      // Dismiss Next-Up S1E2 ("Önermeyi kapat")
      const cleared = await clearWatchProgress(db, 'x:s1:ep:102', 'default', () => 20_000);
      expect(cleared.ok).toBe(true);

      // S1E2 disappears from Continue Watching, while S1E1 watched history stays intact!
      expect(await listContinueWatching(db, 10)).toEqual([]);
      expect((await getWatchProgress(db, 'x:s1:ep:101'))?.watched).toBe(true);

      // Later watching S1E3 (updatedAt > dismissedAt) wakes Next-Up back up for S1E4!
      await seedEpisodeProgress(db, {
        itemKey: 'x:s1:ep:103',
        season: 1,
        episode: 3,
        positionMs: 2_800_000,
        durationMs: 2_940_000,
        watched: true,
        at: 30_000,
      });

      const resumed = await listContinueWatching(db, 10);
      expect(resumed).toHaveLength(1);
      expect(resumed[0]).toMatchObject({
        itemKey: 'x:s1:ep:104',
        subtitle: 'S1 · E4 — Breakwater',
        season: 1,
        episode: 4,
        positionMs: 0,
        updatedAt: 30_000,
      });
    } finally {
      close();
    }
  });

  it('hides restricted series Next-Up entries when parental controls are locked and shows them when unlocked', async () => {
    const { db, close } = await setupSeriesCatalog();
    try {
      await seedEpisodeProgress(db, {
        itemKey: 'x:s1:ep:101',
        season: 1,
        episode: 1,
        positionMs: 2_650_000,
        durationMs: 2_700_000,
        watched: true,
        at: 10_000,
      });
      await seedEpisodeProgress(db, {
        itemKey: 'x:s1:ep:hw1',
        seriesKey: 'x:s1:series:2',
        title: 'Harbor Watch',
        season: 1,
        episode: 1,
        positionMs: 2_300_000,
        durationMs: 2_400_000,
        watched: true,
        at: 12_000,
      });

      await updateParentalSettings(db, 'default', { enabled: true });
      await setParentalLock(
        db,
        {
          profileId: 'default',
          sourceId: 's1',
          targetKind: 'item',
          itemKind: 'series',
          targetKey: 'x:s1:series:1',
        },
        true,
      );

      const lockedList = await listContinueWatching(db, 10, 'default', { parentalUnlocked: false });
      expect(lockedList.map((r) => r.itemKey)).toEqual(['x:s1:ep:hw2']);

      const unlockedList = await listContinueWatching(db, 10, 'default', {
        parentalUnlocked: true,
      });
      expect(unlockedList.map((r) => r.itemKey)).toEqual(['x:s1:ep:hw2', 'x:s1:ep:102']);
    } finally {
      close();
    }
  });

  it('cleans up continue_watching_dismissals on source removal, profile deletion, and honors CatalogService clock', async () => {
    const { db, close } = await setupSeriesCatalog();
    try {
      expect(TABLES_BY_SOURCE).toContain('continue_watching_dismissals');
      const secrets = memorySecrets();
      let now = 50_000;
      const service = createCatalogService({
        db,
        secrets,
        scheduler: countingScheduler(),
        http: {
          async get() {
            throw new Error('unused');
          },
        },
        clock: () => (now += 1_000),
      });

      const kidsProfile = await createProfile(
        db,
        { name: 'Kids' },
        () => 1_000,
        () => 'kids',
      );
      expect(kidsProfile.ok).toBe(true);

      await service.saveProgress?.({
        profileId: 'kids',
        sourceId: 's1',
        itemKey: 'x:s1:ep:101',
        kind: 'episode',
        title: 'Northern Signal',
        seriesKey: 'x:s1:series:1',
        season: 1,
        episode: 1,
        positionMs: 2_650_000,
        durationMs: 2_700_000,
        watched: true,
      });
      await service.clearProgress?.('x:s1:ep:102', 'kids');

      expect(
        await db.all('SELECT profile_id, series_key FROM continue_watching_dismissals'),
      ).toEqual([{ profile_id: 'kids', series_key: 'x:s1:series:1' }]);

      // Deleting the profile cascades its dismissal rows
      expect((await deleteProfile(db, secrets, 'kids')).ok).toBe(true);
      expect(await db.all('SELECT * FROM continue_watching_dismissals')).toEqual([]);

      // Re-create a dismissal on default profile and verify removeSource cleans it up
      await service.saveProgress?.({
        sourceId: 's1',
        itemKey: 'x:s1:ep:101',
        kind: 'episode',
        title: 'Northern Signal',
        seriesKey: 'x:s1:series:1',
        season: 1,
        episode: 1,
        positionMs: 2_650_000,
        durationMs: 2_700_000,
        watched: true,
      });
      await service.clearProgress?.('x:s1:ep:102');
      expect(await db.all('SELECT source_id FROM continue_watching_dismissals')).toEqual([
        { source_id: 's1' },
      ]);

      expect((await removeSource('s1', { db, secrets })).ok).toBe(true);
      expect(await db.all('SELECT * FROM continue_watching_dismissals')).toEqual([]);
    } finally {
      close();
    }
  });

  it('dismisses an in-progress episode without re-spawning Next-Up, isolates profiles, and handles fallback metadata & tie-breaking', async () => {
    const { db, close } = await setupSeriesCatalog();
    try {
      // S1E1 completed, S1E2 started in progress, then user removes S1E2 from Continue Watching
      await seedEpisodeProgress(db, {
        itemKey: 'x:s1:ep:101',
        season: 1,
        episode: 1,
        positionMs: 2_650_000,
        durationMs: 2_700_000,
        watched: true,
        at: 10_000,
      });
      await seedEpisodeProgress(db, {
        itemKey: 'x:s1:ep:102',
        season: 1,
        episode: 2,
        positionMs: 300_000,
        durationMs: 2_820_000,
        watched: false,
        at: 12_000,
      });
      // Kids profile also completed S1E1 independently
      await seedEpisodeProgress(db, {
        profileId: 'kids',
        itemKey: 'x:s1:ep:101',
        season: 1,
        episode: 1,
        positionMs: 2_650_000,
        durationMs: 2_700_000,
        watched: true,
        at: 10_000,
      });

      await clearWatchProgress(db, 'x:s1:ep:102', 'default', () => 15_000);
      // Default profile: S1E2 deleted, S1E1 remains watched, Next-Up stays dismissed
      expect(await listContinueWatching(db, 10, 'default')).toEqual([]);
      expect((await getWatchProgress(db, 'x:s1:ep:101', 'default'))?.watched).toBe(true);
      expect(await getWatchProgress(db, 'x:s1:ep:102', 'default')).toBeNull();
      // Kids profile is unaffected by default's dismissal
      expect((await listContinueWatching(db, 10, 'kids')).map((r) => r.itemKey)).toEqual([
        'x:s1:ep:102',
      ]);

      // Clearing a movie or blank key must not insert into continue_watching_dismissals
      const beforeDismissals = await db.all('SELECT * FROM continue_watching_dismissals');
      await clearWatchProgress(db, '', 'default', () => 16_000);
      await clearWatchProgress(db, 'x:s1:movie:99', 'default', () => 16_000);
      expect(await db.all('SELECT * FROM continue_watching_dismissals')).toEqual(beforeDismissals);

      // Orphan series without a row in `series` table and null duration_sec falls back cleanly
      await db.run(
        `INSERT INTO episodes (source_id, key, series_key, season, episode, title, duration_sec, run_id)
         VALUES
           ('s1', 'orphan-ep-1', 'orphan-ser', 1, 1, 'Orphan 1', NULL, 1),
           ('s1', 'orphan-ep-2', 'orphan-ser', 1, 2, 'Orphan 2', NULL, 1)`,
      );
      await saveWatchProgress(
        db,
        {
          sourceId: 's1',
          itemKey: 'orphan-ep-1',
          kind: 'episode',
          title: 'Fallback Show',
          seriesKey: 'orphan-ser',
          season: 1,
          episode: 1,
          positionMs: 95_000,
          durationMs: 100_000,
          watched: true,
        },
        () => 20_000,
      );
      await db.run(
        "UPDATE watch_progress SET logo = 'https://img.example/fallback.jpg' WHERE item_key = 'orphan-ep-1'",
      );
      // Tie-break at identical updatedAt (20_000) with a movie: itemKey ASC orders 'm:s1:1' before 'orphan-ep-2'
      await saveWatchProgress(
        db,
        {
          sourceId: 's1',
          itemKey: 'm:s1:1',
          kind: 'movie',
          title: 'Alpha Movie',
          positionMs: 40_000,
          durationMs: 100_000,
        },
        () => 20_000,
      );

      const tied = await listContinueWatching(db, 10, 'default');
      expect(tied.map((r) => r.itemKey)).toEqual(['m:s1:1', 'orphan-ep-2']);
      expect(tied[1]).toMatchObject({
        title: 'Fallback Show',
        subtitle: 'S1 · E2 — Orphan 2',
        logo: 'https://img.example/fallback.jpg',
        positionMs: 0,
        durationMs: 0,
      });

      // Limit = 1 returns the top item after merging & sorting
      expect((await listContinueWatching(db, 1, 'default')).map((r) => r.itemKey)).toEqual([
        'm:s1:1',
      ]);

      // Dismissing an episode key without a source prefix (looks up episodes WHERE key = ?)
      await clearWatchProgress(db, 'orphan-ep-2', 'default', () => 25_000);
      expect((await listContinueWatching(db, 10, 'default')).map((r) => r.itemKey)).toEqual([
        'm:s1:1',
      ]);
    } finally {
      close();
    }
  });

  it('keeps surfacing S1E2 when S1E1 is watched and S1E2 was marked watched then unmarked (#502)', async () => {
    const { db, close } = await setupSeriesCatalog();
    try {
      await seedEpisodeProgress(db, {
        itemKey: 'x:s1:ep:101',
        season: 1,
        episode: 1,
        positionMs: 2_650_000,
        durationMs: 2_700_000,
        watched: true,
        at: 10_000,
      });
      await setItemWatched(db, 'x:s1:ep:102', true, () => 20_000);
      await setItemWatched(db, 'x:s1:ep:102', false, () => 30_000);

      const list = await listContinueWatching(db, 10);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        itemKey: 'x:s1:ep:102',
        subtitle: 'S1 · E2 — Cold Harbor',
        season: 1,
        episode: 2,
        positionMs: 0,
        watched: false,
        updatedAt: 10_000,
      });
    } finally {
      close();
    }
  });

  it('formats synthesized Next-Up subtitles cleanly when title or season/episode metadata is missing (#502)', async () => {
    const { db, close } = await setupSeriesCatalog();
    try {
      await db.run(
        `INSERT INTO series (source_id, key, name, name_fold, cover, run_id)
         VALUES
           ('s1', 'x:s1:series:empty', 'Empty Ep Title Show', 'empty ep title show', NULL, 1),
           ('s1', 'x:s1:series:nullse', 'Null Meta Show', 'null meta show', NULL, 1)`,
      );
      await db.run(
        `INSERT INTO episodes (source_id, key, series_key, season, episode, title, duration_sec, run_id)
         VALUES
           ('s1', 'x:s1:ep:e1', 'x:s1:series:empty', 1, 1, 'Ep 1', 1800, 1),
           ('s1', 'x:s1:ep:e2', 'x:s1:series:empty', 1, 2, '   ', 1800, 1),
           ('s1', 'x:s1:ep:n1', 'x:s1:series:nullse', NULL, NULL, 'Part One', 1800, 1),
           ('s1', 'x:s1:ep:n2', 'x:s1:series:nullse', NULL, NULL, 'Special Bonus', 1800, 1)`,
      );
      await setItemWatched(db, 'x:s1:ep:e1', true, () => 40_000);
      await setItemWatched(db, 'x:s1:ep:n1', true, () => 35_000);

      const list = await listContinueWatching(db, 10);
      expect(list).toHaveLength(2);
      expect(list[0]).toMatchObject({
        itemKey: 'x:s1:ep:e2',
        subtitle: 'S1 · E2',
      });
      expect(list[1]).toMatchObject({
        itemKey: 'x:s1:ep:n2',
        subtitle: 'Special Bonus',
      });
      expect(list[1]?.subtitle).not.toContain('null');
    } finally {
      close();
    }
  });
});
