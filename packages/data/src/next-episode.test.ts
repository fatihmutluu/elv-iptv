import { type HttpRequestOptions, ok, type SqlDriver } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import { M3U_TOKEN } from './import-test-helpers';
import {
  createCatalogService,
  createCoalescedCatalog,
  type NextEpisodeRow,
  openCatalog,
  queryNextEpisode,
  saveWatchProgress,
  setItemWatched,
} from './index';
import { countingScheduler, memorySecrets, testDb } from './test-db';

async function seedSeriesWithEpisodes(
  db: SqlDriver,
  opts: {
    sourceId?: string;
    seriesKey?: string;
    seriesName?: string;
    cover?: string | null;
    episodes: ReadonlyArray<{
      key: string;
      season: number | null;
      episode: number | null;
      title?: string | null;
      durationSec?: number | null;
    }>;
  },
): Promise<void> {
  const sourceId = opts.sourceId ?? 's1';
  const seriesKey = opts.seriesKey ?? `x:${sourceId}:series:300`;
  await db.run(
    `INSERT OR IGNORE INTO sources (id, kind, name, created_at, settings_json)
     VALUES (?, 'xtream', 'Test', 1000, '{}')`,
    [sourceId],
  );
  await db.run(
    `INSERT OR REPLACE INTO series (source_id, key, provider_id, name, name_fold, cover, run_id)
     VALUES (?, ?, '300', ?, 'show one', ?, 1)`,
    [
      sourceId,
      seriesKey,
      opts.seriesName ?? 'Show One',
      opts.cover ?? 'http://img.example/show.png',
    ],
  );
  for (const ep of opts.episodes) {
    await db.run(
      `INSERT INTO episodes (source_id, key, provider_id, series_key, season, episode, title, duration_sec, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        sourceId,
        ep.key,
        ep.key,
        seriesKey,
        ep.season,
        ep.episode,
        ep.title ?? null,
        ep.durationSec ?? 2400,
      ],
    );
  }
}

describe('queryNextEpisode (#392)', () => {
  it('resolves same-season next, multi-digit E09 -> E10, and cross-season S01E10 -> S02E01 regardless of insertion order', async () => {
    const t = testDb();
    try {
      await openCatalog(t.db);
      const seriesKey = 'x:s1:series:300';
      // Intentionally insert S02 before S01 and E10 before E09 to prove ordering is by (season, episode)
      await seedSeriesWithEpisodes(t.db, {
        seriesKey,
        episodes: [
          {
            key: 'x:s1:ep:201',
            season: 2,
            episode: 1,
            title: 'Season Two Premiere',
            durationSec: 2700,
          },
          {
            key: 'x:s1:ep:110',
            season: 1,
            episode: 10,
            title: 'Season One Finale',
            durationSec: 3000,
          },
          { key: 'x:s1:ep:109', season: 1, episode: 9, title: 'Penultimate', durationSec: 2500 },
          { key: 'x:s1:ep:101', season: 1, episode: 1, title: 'Pilot', durationSec: 2400 },
          { key: 'x:s1:ep:102', season: 1, episode: 2, title: 'Second Chapter', durationSec: 2450 },
        ],
      });

      const afterE01 = await queryNextEpisode(t.db, seriesKey, 'x:s1:ep:101');
      expect(afterE01).toEqual<NextEpisodeRow>({
        id: expect.any(Number),
        sourceId: 's1',
        seriesKey,
        seriesTitle: 'Show One',
        logo: 'http://img.example/show.png',
        key: 'x:s1:ep:102',
        season: 1,
        episode: 2,
        title: 'Second Chapter',
        durationSec: 2450,
      });

      const afterE09 = await queryNextEpisode(t.db, seriesKey, 'x:s1:ep:109');
      expect(afterE09?.key).toBe('x:s1:ep:110');
      expect(afterE09?.season).toBe(1);
      expect(afterE09?.episode).toBe(10);

      // Cross-season jump S01E10 -> S02E01
      const afterS01E10 = await queryNextEpisode(t.db, seriesKey, 'x:s1:ep:110');
      expect(afterS01E10).toEqual<NextEpisodeRow>({
        id: expect.any(Number),
        sourceId: 's1',
        seriesKey,
        seriesTitle: 'Show One',
        logo: 'http://img.example/show.png',
        key: 'x:s1:ep:201',
        season: 2,
        episode: 1,
        title: 'Season Two Premiere',
        durationSec: 2700,
      });

      // Series finale returns null
      expect(await queryNextEpisode(t.db, seriesKey, 'x:s1:ep:201')).toBeNull();
    } finally {
      t.close();
    }
  });

  it('handles missing season/episode numbers deterministically', async () => {
    const t = testDb();
    try {
      await openCatalog(t.db);
      const seriesKey = 'x:s1:series:301';
      await seedSeriesWithEpisodes(t.db, {
        seriesKey,
        episodes: [
          { key: 'x:s1:ep:a', season: null, episode: null, title: 'Special A' },
          { key: 'x:s1:ep:b', season: null, episode: null, title: 'Special B' },
          { key: 'x:s1:ep:1', season: 1, episode: 1, title: 'Episode 1' },
        ],
      });

      const nextAfterA = await queryNextEpisode(t.db, seriesKey, 'x:s1:ep:a');
      expect(nextAfterA?.key).toBe('x:s1:ep:b');
      expect(nextAfterA?.season).toBe(0);
      expect(nextAfterA?.episode).toBeNull();

      const nextAfterB = await queryNextEpisode(t.db, seriesKey, 'x:s1:ep:b');
      expect(nextAfterB?.key).toBe('x:s1:ep:1');
      expect(nextAfterB?.season).toBe(1);
      expect(nextAfterB?.episode).toBe(1);
    } finally {
      t.close();
    }
  });

  it('skips already-completed episodes, respects in-progress unwatched episodes, and falls back to immediate next when rewatching', async () => {
    const t = testDb();
    try {
      await openCatalog(t.db);
      const seriesKey = 'x:s1:series:302';
      await seedSeriesWithEpisodes(t.db, {
        seriesKey,
        episodes: [
          { key: 'x:s1:ep:1', season: 1, episode: 1, title: 'E1' },
          { key: 'x:s1:ep:2', season: 1, episode: 2, title: 'E2' },
          { key: 'x:s1:ep:3', season: 1, episode: 3, title: 'E3' },
          { key: 'x:s1:ep:4', season: 2, episode: 1, title: 'S2E1' },
        ],
      });

      // Mark E2 watched and E3 partially watched (watched = 0)
      await setItemWatched(t.db, 'x:s1:ep:2', true, () => 2000);
      await saveWatchProgress(
        t.db,
        {
          sourceId: 's1',
          itemKey: 'x:s1:ep:3',
          kind: 'episode',
          title: 'E3',
          seriesKey,
          season: 1,
          episode: 3,
          positionMs: 120_000,
          durationMs: 2_400_000,
        },
        () => 3000,
      );

      // E1 -> skips completed E2 -> picks in-progress uncompleted E3
      const next = await queryNextEpisode(t.db, seriesKey, 'x:s1:ep:1');
      expect(next?.key).toBe('x:s1:ep:3');

      // Profile isolation: profile-b has NOT watched E2, so profile-b gets E2
      const nextForProfileB = await queryNextEpisode(t.db, seriesKey, 'x:s1:ep:1', 'profile-b');
      expect(nextForProfileB?.key).toBe('x:s1:ep:2');

      // Mark E3 watched -> E1 skips E2 and E3 and jumps cross-season to S2E1
      await setItemWatched(t.db, 'x:s1:ep:3', true, () => 4000);
      expect((await queryNextEpisode(t.db, seriesKey, 'x:s1:ep:1'))?.key).toBe('x:s1:ep:4');

      // Mark S2E1 watched too -> all subsequent episodes completed -> rewatch fallback to immediate next (E2)
      await setItemWatched(t.db, 'x:s1:ep:4', true, () => 5000);
      expect((await queryNextEpisode(t.db, seriesKey, 'x:s1:ep:1'))?.key).toBe('x:s1:ep:2');
      // And from E3 -> immediate next sequential across season boundary is S2E1
      expect((await queryNextEpisode(t.db, seriesKey, 'x:s1:ep:3'))?.key).toBe('x:s1:ep:4');
    } finally {
      t.close();
    }
  });

  it('returns null for unknown itemKey, mismatched seriesKey, or blank inputs', async () => {
    const t = testDb();
    try {
      await openCatalog(t.db);
      const seriesKey = 'x:s1:series:303';
      await seedSeriesWithEpisodes(t.db, {
        seriesKey,
        episodes: [{ key: 'x:s1:ep:1', season: 1, episode: 1, title: 'E1' }],
      });

      expect(await queryNextEpisode(t.db, seriesKey, 'x:s1:ep:missing')).toBeNull();
      expect(await queryNextEpisode(t.db, 'x:s1:series:other', 'x:s1:ep:1')).toBeNull();
      expect(await queryNextEpisode(t.db, '', 'x:s1:ep:1')).toBeNull();
      expect(await queryNextEpisode(t.db, seriesKey, '   ')).toBeNull();

      // Non-prefixed synthetic keys fall back to key-only lookup cleanly
      await seedSeriesWithEpisodes(t.db, {
        sourceId: 's1',
        seriesKey: 'custom-series',
        episodes: [
          { key: 'ep-one', season: 1, episode: 1, title: 'One' },
          { key: 'ep-two', season: 1, episode: 2, title: 'Two' },
        ],
      });
      expect((await queryNextEpisode(t.db, 'custom-series', 'ep-one'))?.key).toBe('ep-two');
    } finally {
      t.close();
    }
  });

  it('works through CatalogService (resolving M3U logos) and createCoalescedCatalog (flushing pending watched writes)', async () => {
    const t = testDb();
    try {
      await openCatalog(t.db);
      const playlistUrl = 'http://panel.example:8080/list.m3u';
      const tok = M3U_TOKEN;
      const playlist = [
        '#EXTM3U',
        `#EXTINF:-1 tvg-logo="http://img.example/${tok}/poster.png" group-title="Shows",Northern Signal S01E01`,
        `http://cdn.example/${tok}/series/101.mp4`,
        `#EXTINF:-1 tvg-logo="http://img.example/${tok}/poster.png" group-title="Shows",Northern Signal S01E02`,
        `http://cdn.example/${tok}/series/102.mp4`,
        `#EXTINF:-1 tvg-logo="http://img.example/${tok}/poster.png" group-title="Shows",Northern Signal S02E01`,
        `http://cdn.example/${tok}/series/201.mp4`,
      ].join('\n');

      const secrets = memorySecrets();
      const baseCatalog = createCatalogService({
        db: t.db,
        secrets,
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
        clock: () => 10_000,
        newId: () => 'srcm3u',
      });

      const added = await baseCatalog.addSource({ kind: 'm3u', name: 'M', playlistUrl });
      if (!added.ok) throw new Error('addSource failed');
      expect((await baseCatalog.importSource(added.value.id)).ok).toBe(true);

      const cats = await baseCatalog.categories(added.value.id, 'series');
      const shows = await baseCatalog.items(cats[0]?.id ?? '', 0, 10);
      const show = shows[0];
      expect(show).toBeDefined();
      const importedEps = await baseCatalog.episodes(show?.id ?? 0, 0);
      expect(importedEps).toHaveLength(3);

      // Attach a templated M3U series cover using the imported urlvars map to prove read-time logo resolution
      const rawVars = await secrets.get(`source.${added.value.id}.urlvars`);
      const varMap = rawVars ? (JSON.parse(rawVars) as Record<string, string>) : {};
      const tokVar = Object.entries(varMap).find(([, value]) => value === tok)?.[0];
      expect(tokVar).toBeDefined();
      await t.db.run('UPDATE series SET cover = ? WHERE source_id = ? AND key = ?', [
        `http://img.example/{{${tokVar}}}/poster.png`,
        added.value.id,
        show?.key ?? '',
      ]);

      // Assign explicit cross-season numbers on the imported M3U episodes
      await t.db.run('UPDATE episodes SET season = 1, episode = 1 WHERE key = ?', [
        importedEps[0]?.key ?? '',
      ]);
      await t.db.run('UPDATE episodes SET season = 1, episode = 2 WHERE key = ?', [
        importedEps[1]?.key ?? '',
      ]);
      await t.db.run('UPDATE episodes SET season = 2, episode = 1 WHERE key = ?', [
        importedEps[2]?.key ?? '',
      ]);

      // CatalogService resolves M3U logo template on NextEpisodeRow and returns null at finale
      const directNext = await baseCatalog.queryNextEpisode?.(
        show?.key ?? '',
        importedEps[0]?.key ?? '',
      );
      expect(directNext?.key).toBe(importedEps[1]?.key);
      expect(directNext?.logo).toBe(`http://img.example/${tok}/poster.png`);
      expect(
        await baseCatalog.queryNextEpisode?.(show?.key ?? '', importedEps[2]?.key ?? ''),
      ).toBeNull();

      // Coalesced catalog flushes pending setWatched before reading queryNextEpisode
      const setWatchedSpy = vi.spyOn(baseCatalog, 'setWatched' as never);
      const timers = new Map<number, () => void>();
      let timerSeq = 1;
      const coalesced = createCoalescedCatalog(baseCatalog, {
        windowMs: 500,
        setTimeoutFn: (fn) => {
          const id = timerSeq++;
          timers.set(id, fn);
          return id as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimeoutFn: (h) => {
          timers.delete(h as unknown as number);
        },
      });

      // Schedule debounced setWatched on S01E02 without firing timer yet
      const markPromise = coalesced.setWatched?.(importedEps[1]?.key ?? '', true);
      expect(timers.size).toBe(1);

      // queryNextEpisode flushes pending watched write and skips S01E02 straight to S02E01!
      const afterFlush = await coalesced.queryNextEpisode?.(
        show?.key ?? '',
        importedEps[0]?.key ?? '',
      );
      await markPromise;
      expect(setWatchedSpy).toHaveBeenCalledTimes(1);
      expect(afterFlush?.key).toBe(importedEps[2]?.key);
      expect(afterFlush?.season).toBe(2);
      expect(afterFlush?.episode).toBe(1);

      await coalesced.close();
    } finally {
      t.close();
    }
  });
});
