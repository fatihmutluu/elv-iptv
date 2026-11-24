import { type HttpClient, ok, type SqlDriver, type SqlValue } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import { createCatalogService } from './catalog';
import { foldText } from './fold';
import { queryCrossChannelEpgSlice } from './guide-queries-slice';
import { openCatalog } from './migrate';
import { queryNextEpisode } from './next-episode';
import {
  buildSqlItemRestrictionClause,
  findRestrictedItemKeys,
  getParentalSettings,
  isItemRestricted,
  listParentalLocks,
  loadActiveParentalFilter,
  markParentalStateDirty,
  refreshParentalFastPath,
  setParentalLock,
  updateParentalSettings,
} from './parental-repo';
import { createProfile, updateProfile } from './profiles-repo';
import { queryAllSourcesItems, queryCategories, queryItems } from './queries';
import { countingScheduler, memorySecrets, testDb } from './test-db';
import { decodeUserDataSnapshot, reconcileUserData, type UserDataStore } from './user-state-backup';
import { createCoalescedCatalog } from './write-coalescer';

function wrapCountingDb(db: SqlDriver): {
  db: SqlDriver;
  count: () => number;
  reset: () => void;
} {
  let queries = 0;
  const wrapped: SqlDriver = {
    exec: (sql) => db.exec(sql),
    run: (sql, params) => {
      queries += 1;
      return db.run(sql, params);
    },
    batch: (sql, rows) => {
      queries += 1;
      return db.batch(sql, rows);
    },
    all: (sql, params) => {
      queries += 1;
      return db.all(sql, params);
    },
    transaction: (fn) => db.transaction(fn),
    ...(db.close ? { close: () => db.close?.() ?? Promise.resolve() } : {}),
  };
  return {
    db: wrapped,
    count: () => queries,
    reset: () => {
      queries = 0;
    },
  };
}

function bytesStream(text: string): AsyncIterable<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return (async function* () {
    yield bytes;
  })();
}

function memoryUserDataStore(): UserDataStore & { value: string | undefined } {
  const store = {
    value: undefined as string | undefined,
    read: () => store.value,
    write: (next: string) => {
      store.value = next;
    },
  };
  return store;
}

describe('Wave F1 data hardening — Finding #1 (SQLite bind-var limit >999)', () => {
  it('handles >1,050 categories and >1,050 locks without SQLITE_ERROR too many SQL variables', async () => {
    const { db, close } = testDb();
    try {
      const opened = await openCatalog(db);
      expect(opened.ok).toBe(true);
      await db.run(
        "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Big', 1, '{}')",
      );
      await db.transaction(async (tx) => {
        for (let i = 0; i < 1_050; i += 1) {
          const catId = `c${i}`;
          const catName = i === 1_049 ? 'VIP 18+ Adult' : `Category ${i}`;
          await tx.run(
            'INSERT INTO categories (source_id, kind, provider_id, name, name_fold, position, run_id) VALUES (?, ?, ?, ?, ?, ?, 1)',
            ['s1', 'live', catId, catName, foldText(catName), i],
          );
          const itemKey = `x:s1:live:${i}`;
          const itemName = i % 100 === 0 ? `Midnight XXX ${i}` : `Channel ${i}`;
          await tx.run(
            'INSERT INTO live (source_id, key, provider_id, name, name_fold, sort_title, run_id) VALUES (?, ?, ?, ?, ?, ?, 1)',
            ['s1', itemKey, String(i), itemName, foldText(itemName), foldText(itemName)],
          );
          await tx.run(
            'INSERT INTO placements (source_id, kind, item_key, category_id, position, run_id) VALUES (?, ?, ?, ?, 0, 1)',
            ['s1', 'live', itemKey, catId],
          );
        }
        // Insert 1,050 item locks and 1,050 category locks to stress buildSqlItemRestrictionClause
        for (let i = 0; i < 1_050; i += 1) {
          await tx.run(
            "INSERT INTO parental_locks (profile_id, source_id, target_kind, item_kind, target_key, created_at) VALUES ('default', 's1', 'item', 'live', ?, 1)",
            [`x:s1:live:locked-${i}`],
          );
          await tx.run(
            "INSERT INTO parental_locks (profile_id, source_id, target_kind, item_kind, target_key, created_at) VALUES ('default', 's1', 'category', 'live', ?, 1)",
            [`locked-cat-${i}`],
          );
        }
      });

      await updateParentalSettings(db, 'default', {
        enabled: true,
        blockAdultKeywords: true,
      });

      const filter = await loadActiveParentalFilter(db, 'default', false);
      expect(filter).not.toBeNull();
      if (filter === null) return;

      const clause = buildSqlItemRestrictionClause(filter, 'live', 't.source_id', 't.key', 's1');
      expect(clause.params.length).toBeLessThanOrEqual(400);

      const cats = await queryCategories(db, 's1', 'live');
      expect(cats).toHaveLength(1_049);
      expect(cats.find((c) => c.id === 's1|live|c0')?.itemCount).toBe(0);
      expect(cats.find((c) => c.id === 's1|live|c1')?.itemCount).toBe(1);

      const items = await queryItems(db, { sourceId: 's1', kind: 'live', providerId: 'c1' }, 0, 10);
      expect(items.map((i) => i.key)).toEqual(['x:s1:live:1']);

      const allItems = await queryAllSourcesItems(db, 'live', 0, 10);
      expect(allItems.length).toBe(10);
    } finally {
      close();
    }
  });
});

describe('Wave F1 data hardening — Finding #2 (batched findRestrictedItemKeys, SQL EPG slice, O(N) pagination)', () => {
  it('batches findRestrictedItemKeys without N+1 queries across 600 items and episodes', async () => {
    const raw = testDb();
    try {
      await openCatalog(raw.db);
      await raw.db.run(
        "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Src', 1, '{}')",
      );
      await raw.db.run(
        "INSERT INTO categories (source_id, kind, provider_id, name, name_fold, position, run_id) VALUES ('s1', 'live', 'ok', 'News', 'news', 0, 1)",
      );
      await raw.db.run(
        "INSERT INTO categories (source_id, kind, provider_id, name, name_fold, position, run_id) VALUES ('s1', 'live', 'bad', 'Locked Group', 'locked group', 1, 1)",
      );
      await raw.db.run(
        "INSERT INTO series (source_id, key, provider_id, name, name_fold, sort_title, run_id) VALUES ('s1', 'x:s1:series:ok', '1', 'Safe Show', 'safe show', 'safe show', 1)",
      );
      await raw.db.run(
        "INSERT INTO series (source_id, key, provider_id, name, name_fold, sort_title, run_id) VALUES ('s1', 'x:s1:series:bad', '2', 'Locked Show', 'locked show', 'locked show', 1)",
      );

      const entries: Array<{
        itemKey: string;
        sourceId: string;
        kind: 'live' | 'episode';
        title: string;
        seriesKey?: string;
      }> = [];
      await raw.db.transaction(async (tx) => {
        for (let i = 0; i < 600; i += 1) {
          const key = `x:s1:live:${i}`;
          const name = i === 10 ? 'XXX Channel' : `Channel ${i}`;
          await tx.run(
            'INSERT INTO live (source_id, key, provider_id, name, name_fold, sort_title, run_id) VALUES (?, ?, ?, ?, ?, ?, 1)',
            ['s1', key, String(i), name, foldText(name), foldText(name)],
          );
          await tx.run(
            'INSERT INTO placements (source_id, kind, item_key, category_id, position, run_id) VALUES (?, ?, ?, ?, ?, 1)',
            ['s1', 'live', key, i === 25 ? 'bad' : 'ok', i],
          );
          entries.push({ itemKey: key, sourceId: 's1', kind: 'live', title: name });
        }
        for (let i = 0; i < 40; i += 1) {
          const key = `x:s1:ep:${i}`;
          const sKey = i < 20 ? 'x:s1:series:ok' : 'x:s1:series:bad';
          await tx.run(
            'INSERT INTO episodes (source_id, key, provider_id, series_key, season, episode, title, title_fold, run_id) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 1)',
            ['s1', key, String(i), sKey, i + 1, `Ep ${i}`, `ep ${i}`],
          );
          entries.push({
            itemKey: key,
            sourceId: 's1',
            kind: 'episode',
            title: `Ep ${i}`,
            seriesKey: sKey,
          });
        }
      });

      await updateParentalSettings(raw.db, 'default', { enabled: true, blockAdultKeywords: true });
      await setParentalLock(
        raw.db,
        { sourceId: 's1', targetKind: 'category', itemKind: 'live', targetKey: 'bad' },
        true,
      );
      await setParentalLock(
        raw.db,
        { sourceId: 's1', targetKind: 'item', itemKind: 'series', targetKey: 'x:s1:series:bad' },
        true,
      );

      const filter = await loadActiveParentalFilter(raw.db, 'default', false);
      expect(filter).not.toBeNull();
      if (filter === null) return;

      const spy = wrapCountingDb(raw.db);
      const restricted = await findRestrictedItemKeys(spy.db, filter, entries);
      expect(spy.count()).toBeLessThanOrEqual(15);
      expect(restricted.has('x:s1:live:10')).toBe(true);
      expect(restricted.has('x:s1:live:25')).toBe(true);
      expect(restricted.has('x:s1:live:0')).toBe(false);
      expect(restricted.has('x:s1:ep:0')).toBe(false);
      expect(restricted.has('x:s1:ep:20')).toBe(true);
      expect(restricted.has('x:s1:ep:39')).toBe(true);
    } finally {
      raw.close();
    }
  });

  it('filters queryCrossChannelEpgSlice in SQL without calling findRestrictedItemKeys per channel', async () => {
    const raw = testDb();
    try {
      await openCatalog(raw.db);
      await raw.db.run(
        "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Src', 1, '{}')",
      );
      await raw.db.run(
        "INSERT INTO categories (source_id, kind, provider_id, name, name_fold, position, run_id) VALUES ('s1', 'live', 'ok', 'General', 'general', 0, 1)",
      );
      await raw.db.run(
        "INSERT INTO categories (source_id, kind, provider_id, name, name_fold, position, run_id) VALUES ('s1', 'live', 'priv', 'Private', 'private', 1, 1)",
      );
      await raw.db.transaction(async (tx) => {
        for (let i = 0; i < 400; i += 1) {
          const key = `x:s1:live:${i}`;
          const name = i === 1 ? 'Midnight XXX' : `Channel ${i}`;
          await tx.run(
            'INSERT INTO live (source_id, key, provider_id, name, name_fold, sort_title, run_id) VALUES (?, ?, ?, ?, ?, ?, 1)',
            ['s1', key, String(i), name, foldText(name), foldText(name)],
          );
          await tx.run(
            'INSERT INTO placements (source_id, kind, item_key, category_id, position, run_id) VALUES (?, ?, ?, ?, ?, 1)',
            ['s1', 'live', key, i === 2 ? 'priv' : 'ok', i],
          );
          await tx.run(
            'INSERT INTO channel_guide (source_id, channel_key, guide_id) VALUES (?, ?, ?)',
            ['s1', key, `g.${i}`],
          );
        }
        await tx.run(
          "INSERT INTO programmes (source_id, guide_id, start, stop, title, rating_value, run_id) VALUES ('s1', 'g.0', 1000, 5000, 'Safe Show', 'G', 1)",
        );
        await tx.run(
          "INSERT INTO programmes (source_id, guide_id, start, stop, title, rating_value, run_id) VALUES ('s1', 'g.1', 1000, 5000, 'Hidden Keyword Ch', 'G', 1)",
        );
        await tx.run(
          "INSERT INTO programmes (source_id, guide_id, start, stop, title, rating_value, run_id) VALUES ('s1', 'g.2', 1000, 5000, 'Hidden Locked Cat Ch', 'G', 1)",
        );
      });

      await updateParentalSettings(raw.db, 'default', { enabled: true, blockAdultKeywords: true });
      await setParentalLock(
        raw.db,
        { sourceId: 's1', targetKind: 'category', itemKind: 'live', targetKey: 'priv' },
        true,
      );

      const spy = wrapCountingDb(raw.db);
      const slice = await queryCrossChannelEpgSlice(spy.db, 's1', 1_000, 5_000, 50);
      expect(spy.count()).toBeLessThanOrEqual(8);
      expect(slice.map((p) => p.title)).toEqual(['Safe Show']);
    } finally {
      raw.close();
    }
  });

  it('avoids O(N^2) OFFSET rescanning on deep pagination with blockAdultKeywords enabled', async () => {
    const raw = testDb();
    try {
      await openCatalog(raw.db);
      await raw.db.run(
        "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'One', 1, '{}')",
      );
      await raw.db.run(
        "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s2', 'xtream', 'Two', 2, '{}')",
      );
      await raw.db.run(
        "INSERT INTO categories (source_id, kind, provider_id, name, name_fold, position, run_id) VALUES ('s1', 'movie', 'all', 'All Movies', 'all movies', 0, 1)",
      );
      await raw.db.transaction(async (tx) => {
        for (let i = 0; i < 600; i += 1) {
          const pad = String(i).padStart(4, '0');
          const name =
            i % 50 === 0
              ? `Movie ${pad} 18+ VIP`
              : i === 555
                ? 'Movie 0555 2018+ Hits'
                : i === 556
                  ? 'Movie 0556 Adultery Drama'
                  : `Movie ${pad}`;
          const fold = foldText(name);
          await tx.run(
            'INSERT INTO movies (source_id, key, provider_id, name, name_fold, sort_title, run_id) VALUES (?, ?, ?, ?, ?, ?, 1)',
            ['s1', `x:s1:movie:${i}`, String(i), name, fold, fold],
          );
          await tx.run(
            'INSERT INTO placements (source_id, kind, item_key, category_id, position, run_id) VALUES (?, ?, ?, ?, ?, 1)',
            ['s1', 'movie', `x:s1:movie:${i}`, 'all', i],
          );
          await tx.run(
            'INSERT INTO movies (source_id, key, provider_id, name, name_fold, sort_title, run_id) VALUES (?, ?, ?, ?, ?, ?, 1)',
            ['s2', `x:s2:movie:${i}`, String(i), name, fold, fold],
          );
        }
      });

      await updateParentalSettings(raw.db, 'default', { enabled: true, blockAdultKeywords: true });
      const spy = wrapCountingDb(raw.db);

      const catPage = await queryItems(
        spy.db,
        { sourceId: 's1', kind: 'movie', providerId: 'all' },
        500,
        20,
      );
      expect(spy.count()).toBeLessThanOrEqual(6);
      expect(catPage).toHaveLength(20);
      expect(catPage.some((m) => m.name.includes('18+ VIP'))).toBe(false);

      spy.reset();
      const singleSrcPage = await queryAllSourcesItems(spy.db, 'movie', 500, 20, ['s1']);
      expect(spy.count()).toBeLessThanOrEqual(6);
      expect(singleSrcPage).toHaveLength(20);

      spy.reset();
      const alphaPage = await queryAllSourcesItems(spy.db, 'movie', 900, 20, undefined, {
        sortBy: 'alpha',
      });
      expect(spy.count()).toBeLessThanOrEqual(6);
      expect(alphaPage).toHaveLength(20);

      spy.reset();
      const multiDefaultPage = await queryAllSourcesItems(spy.db, 'movie', 900, 20);
      expect(spy.count()).toBeLessThanOrEqual(10);
      expect(multiDefaultPage).toHaveLength(20);

      // False-positive guard: '2018+ Hits' and 'Adultery Drama' are NOT excluded
      const tail = await queryItems(
        raw.db,
        { sourceId: 's1', kind: 'movie', providerId: 'all' },
        540,
        60,
      );
      const tailNames = tail.map((m) => m.name);
      expect(tailNames).toContain('Movie 0555 2018+ Hits');
      expect(tailNames).toContain('Movie 0556 Adultery Drama');
    } finally {
      raw.close();
    }
  });
});

describe('Wave F1 data hardening — Finding #5 (parental enforcement on 5 query methods)', () => {
  it('enforces parental controls on liveVariants, itemVersions, seasons (before Xtream fetch), episodes, and queryNextEpisode + coalescer forwarding', async () => {
    const { db, close } = testDb();
    const httpGet = vi.fn(async (url: string) =>
      ok({
        status: 200,
        headers: { 'content-type': 'application/json' },
        finalUrl: url,
        body: bytesStream(
          JSON.stringify({
            episodes: {
              '1': [
                {
                  id: '900',
                  episode_num: 1,
                  title: 'Fetched Episode',
                  container_extension: 'mp4',
                },
              ],
            },
          }),
        ),
      }),
    );
    const http: HttpClient = { get: httpGet };
    try {
      await openCatalog(db);
      const secrets = memorySecrets();
      await secrets.set(
        'source.s1.xtream',
        JSON.stringify({ server: 'http://xt.example', username: 'u', password: 'p' }),
      );
      const base = createCatalogService({
        db,
        secrets,
        scheduler: countingScheduler(),
        http,
        clock: () => 1_000,
      });
      const service = createCoalescedCatalog(base, { windowMs: 0 });

      await db.run(
        "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'XT', 1, '{}')",
      );
      await db.run(
        "INSERT INTO categories (source_id, kind, provider_id, name, name_fold, position, run_id) VALUES ('s1', 'live', 'gen', 'General', 'general', 0, 1)",
      );
      await db.run(
        "INSERT INTO categories (source_id, kind, provider_id, name, name_fold, position, run_id) VALUES ('s1', 'live', 'priv', 'Private', 'private', 1, 1)",
      );
      // Live variants sharing variant_base_fold='sportstv'
      await db.run(
        "INSERT INTO live (source_id, key, provider_id, name, name_fold, variant_base_fold, quality_rank, run_id) VALUES ('s1', 'x:s1:live:hd', '1', 'SportsTV HD', 'sportstv hd', 'sportstv', 2, 1)",
      );
      await db.run(
        "INSERT INTO live (source_id, key, provider_id, name, name_fold, variant_base_fold, quality_rank, run_id) VALUES ('s1', 'x:s1:live:4k', '2', 'SportsTV 4K', 'sportstv 4k', 'sportstv', 3, 1)",
      );
      await db.run(
        "INSERT INTO placements (source_id, kind, item_key, category_id, position, run_id) VALUES ('s1', 'live', 'x:s1:live:hd', 'gen', 0, 1)",
      );
      await db.run(
        "INSERT INTO placements (source_id, kind, item_key, category_id, position, run_id) VALUES ('s1', 'live', 'x:s1:live:4k', 'priv', 0, 1)",
      );

      // Movie versions sharing version_group_key='dune|2024'
      await db.run(
        "INSERT INTO movies (source_id, key, provider_id, name, name_fold, version_group_key, version_label, year, run_id) VALUES ('s1', 'x:s1:movie:safe', '10', 'Dune 1080p', 'dune 1080p', 'dune|2024', '1080p', 2024, 1)",
      );
      await db.run(
        "INSERT INTO movies (source_id, key, provider_id, name, name_fold, version_group_key, version_label, year, run_id) VALUES ('s1', 'x:s1:movie:adult', '11', 'Dune 18+ Uncut 4K', 'dune 18 uncut 4k', 'dune|2024', '4K', 2024, 1)",
      );

      // Two series: one locked with zero local episodes (would trigger Xtream fetch!), one safe with a locked middle episode
      await db.run(
        "INSERT INTO series (id, source_id, key, provider_id, name, name_fold, run_id) VALUES (101, 's1', 'x:s1:series:locked', '101', 'Locked Drama', 'locked drama', 1)",
      );
      await db.run(
        "INSERT INTO series (id, source_id, key, provider_id, name, name_fold, run_id) VALUES (102, 's1', 'x:s1:series:safe', '102', 'Safe Drama', 'safe drama', 1)",
      );
      await db.run(
        "INSERT INTO episodes (id, source_id, key, provider_id, series_key, season, episode, title, title_fold, run_id) VALUES (1, 's1', 'x:s1:ep:1', '1', 'x:s1:series:safe', 1, 1, 'Episode One', 'episode one', 1)",
      );
      await db.run(
        "INSERT INTO episodes (id, source_id, key, provider_id, series_key, season, episode, title, title_fold, run_id) VALUES (2, 's1', 'x:s1:ep:2', '2', 'x:s1:series:safe', 1, 2, 'Episode Two 18+', 'episode two 18', 1)",
      );
      await db.run(
        "INSERT INTO episodes (id, source_id, key, provider_id, series_key, season, episode, title, title_fold, run_id) VALUES (3, 's1', 'x:s1:ep:3', '3', 'x:s1:series:safe', 1, 3, 'Episode Three', 'episode three', 1)",
      );

      await service.updateParentalSettings?.({ enabled: true, blockAdultKeywords: true });
      await service.setParentalLock?.(
        { sourceId: 's1', targetKind: 'category', itemKind: 'live', targetKey: 'priv' },
        true,
      );
      await service.setParentalLock?.(
        {
          sourceId: 's1',
          targetKind: 'item',
          itemKind: 'series',
          targetKey: 'x:s1:series:locked',
        },
        true,
      );

      // 1. liveVariants
      expect((await service.liveVariants?.('x:s1:live:hd'))?.map((v) => v.key)).toEqual([
        'x:s1:live:hd',
      ]);
      expect(await service.liveVariants?.('x:s1:live:4k')).toEqual([]);
      expect(
        (await service.liveVariants?.('x:s1:live:hd', undefined, { parentalUnlocked: true }))?.map(
          (v) => v.key,
        ),
      ).toEqual(['x:s1:live:4k', 'x:s1:live:hd']);

      // 2. itemVersions
      expect((await service.itemVersions?.('x:s1:movie:safe'))?.map((v) => v.key)).toEqual([
        'x:s1:movie:safe',
      ]);
      expect(await service.itemVersions?.('x:s1:movie:adult')).toEqual([]);
      expect(
        (await service.itemVersions?.('x:s1:movie:safe', { parentalUnlocked: true }))?.map(
          (v) => v.key,
        ),
      ).toHaveLength(2);

      // 3. seasons() on locked series MUST block BEFORE Xtream fetch
      const lockedSeasons = await service.seasons(101);
      expect(lockedSeasons).toEqual({
        ok: false,
        error: { category: 'auth', code: 'parental-locked' },
      });
      expect(httpGet).not.toHaveBeenCalled();

      // Unlocked seasons fetches Xtream episodes cleanly
      const unlockedSeasons = await service.seasons(101, { parentalUnlocked: true });
      expect(unlockedSeasons.ok).toBe(true);
      expect(httpGet).toHaveBeenCalledTimes(1);

      // 4. episodes() on locked series returns [], on safe series excludes adult episode
      expect(await service.episodes(101, 1)).toEqual([]);
      expect(await service.episodes(101, 1, { parentalUnlocked: true })).toHaveLength(1);
      expect((await service.episodes(102, 1)).map((e) => e.key)).toEqual([
        'x:s1:ep:1',
        'x:s1:ep:3',
      ]);
      const safeSeasons = await service.seasons(102);
      expect(safeSeasons).toEqual(ok([{ season: 1, episodeCount: 2 }]));

      // 5. queryNextEpisode() blocks locked series and skips restricted episodes
      expect(await service.queryNextEpisode?.('x:s1:series:locked', 'x:s1:ep:900')).toBeNull();
      expect((await service.queryNextEpisode?.('x:s1:series:safe', 'x:s1:ep:1'))?.key).toBe(
        'x:s1:ep:3',
      );
      expect(
        (
          await service.queryNextEpisode?.('x:s1:series:safe', 'x:s1:ep:1', 'default', {
            parentalUnlocked: true,
          })
        )?.key,
      ).toBe('x:s1:ep:2');
      expect(
        (
          await queryNextEpisode(db, 'x:s1:series:safe', 'x:s1:ep:1', 'default', {
            parentalUnlocked: false,
          })
        )?.key,
      ).toBe('x:s1:ep:3');
    } finally {
      close();
    }
  });
});

describe('Wave F1 data hardening — Finding #6 (refreshParentalFastPath async race)', () => {
  it('does not overwrite fast-path to false if markParentalStateDirty ran while refresh was in flight', async () => {
    const { db, close } = testDb();
    try {
      await openCatalog(db);

      let releaseSelect: (() => void) | undefined;
      const selectStarted = new Promise<void>((resolve) => {
        const pausedDb: SqlDriver = {
          exec: (sql) => db.exec(sql),
          run: (sql, params) => db.run(sql, params),
          batch: (sql, rows) => db.batch(sql, rows),
          transaction: (fn) => db.transaction(fn),
          all: async <T>(sql: string, params?: readonly SqlValue[]) => {
            const result = await db.all<T>(sql, params);
            if (sql.includes('parental_settings') && sql.includes('AS active')) {
              resolve();
              await new Promise<void>((r) => {
                releaseSelect = r;
              });
            }
            return result;
          },
        };
        // Start refresh while DB has active=0; pause before it writes parentalActiveByDb
        void refreshParentalFastPath(pausedDb);
      });

      await selectStarted;
      // Concurrently enable parental settings on the same underlying db handle
      await updateParentalSettings(db, 'default', { enabled: true });
      markParentalStateDirty(db);

      // Now let the stale refresh (which read active=0) complete
      releaseSelect?.();
      await Promise.resolve();
      await Promise.resolve();

      // Fast-path MUST still be active so parental filter loads!
      const filter = await loadActiveParentalFilter(db, 'default', false);
      expect(filter).not.toBeNull();
      expect(filter?.enabled).toBe(true);
    } finally {
      close();
    }
  });
});

describe('Wave F1 data hardening — Finding #8 (tvOS reconcileUserData Kids & parental restore)', () => {
  it('backs up and restores parentalSettings + parentalLocks on tvOS purge and re-seeds Kids defaults on legacy v1 snapshots', async () => {
    const first = testDb();
    const purged = testDb();
    const legacyPurged = testDb();
    try {
      await openCatalog(first.db);
      await openCatalog(purged.db);
      await openCatalog(legacyPurged.db);

      const store = memoryUserDataStore();
      const secrets = memorySecrets();
      const service = createCatalogService({
        db: first.db,
        secrets,
        scheduler: countingScheduler(),
        http: {
          get: vi.fn(async () =>
            ok({
              status: 200,
              headers: {},
              finalUrl: 'http://example.invalid',
              body: bytesStream(''),
            }),
          ),
        },
        clock: () => 5_000,
        userData: store,
      });

      const kidsRes = await service.createProfile?.({
        name: 'Kids',
        avatarToken: 'emerald',
        isKids: true,
      });
      expect(kidsRes?.ok).toBe(true);
      const kidsId = kidsRes?.ok ? kidsRes.value.id : '';

      // Mutating parental settings & locks must sync backup without storing any PIN
      await service.setParentalPin?.('1234', 'default');
      await service.updateParentalSettings?.(
        { enabled: true, blockAdultKeywords: true, maxRatingAge: 14 },
        'default',
      );
      await service.setParentalLock?.(
        {
          profileId: kidsId,
          sourceId: 's1',
          targetKind: 'category',
          itemKind: 'live',
          targetKey: 'late',
        },
        true,
      );

      expect(store.value).toBeDefined();
      expect(store.value).not.toContain('1234');
      expect(store.value).not.toContain('v1:');

      const decoded = decodeUserDataSnapshot(store.value);
      expect(decoded.parentalSettings?.length).toBeGreaterThanOrEqual(2);
      expect(decoded.parentalLocks).toHaveLength(1);

      // Restore onto freshly purged DB (whose fast-path was armed to false by openCatalog!)
      const restored = await reconcileUserData(purged.db, store);
      expect(restored.profilesRestored).toBeGreaterThanOrEqual(1);
      expect(restored.parentalSettingsRestored).toBeGreaterThanOrEqual(2);
      expect(restored.parentalLocksRestored).toBe(1);

      const restoredKidsFilter = await loadActiveParentalFilter(purged.db, kidsId, false);
      expect(restoredKidsFilter).not.toBeNull();
      expect(restoredKidsFilter?.enabled).toBe(true);
      expect(restoredKidsFilter?.maxRatingAge).toBe(12);
      expect(await listParentalLocks(purged.db, kidsId)).toHaveLength(1);

      const restoredDefault = await getParentalSettings(purged.db, 'default');
      expect(restoredDefault.enabled).toBe(true);
      expect(restoredDefault.maxRatingAge).toBe(14);

      // Legacy v1 snapshot without parentalSettings/parentalLocks must still re-seed Kids settings + dirty fast-path
      const legacyStore = memoryUserDataStore();
      legacyStore.write(
        JSON.stringify({
          v: 1,
          favorites: [],
          progress: [],
          profiles: [
            { id: 'default', name: 'Default', avatar: 'crimson', isKids: false, createdAt: 0 },
            { id: 'kids_v1', name: 'Kids', avatar: 'emerald', isKids: true, createdAt: 100 },
          ],
        }),
      );
      await reconcileUserData(legacyPurged.db, legacyStore);
      const legacyKidsFilter = await loadActiveParentalFilter(legacyPurged.db, 'kids_v1', false);
      expect(legacyKidsFilter).not.toBeNull();
      expect(legacyKidsFilter?.enabled).toBe(true);
      expect(legacyKidsFilter?.blockAdultKeywords).toBe(true);
      expect(legacyKidsFilter?.maxRatingAge).toBe(12);
    } finally {
      first.close();
      purged.close();
      legacyPurged.close();
    }
  });
});

describe('Wave F1 data hardening — Finding #12 (data hygiene)', () => {
  it('validates profileId before touching SecretStore in PIN methods', async () => {
    const { db, close } = testDb();
    try {
      await openCatalog(db);
      const getSpy = vi.fn(async () => undefined);
      const setSpy = vi.fn(async () => undefined);
      const deleteSpy = vi.fn(async () => undefined);
      const service = createCatalogService({
        db,
        secrets: { get: getSpy, set: setSpy, delete: deleteSpy },
        scheduler: countingScheduler(),
        http: {
          get: vi.fn(async () =>
            ok({
              status: 200,
              headers: {},
              finalUrl: 'http://example.invalid',
              body: bytesStream(''),
            }),
          ),
        },
        clock: () => 1_000,
      });

      expect(await service.hasParentalPin?.('../bad/id')).toBe(false);
      expect(await service.setParentalPin?.('1234', '../bad/id')).toEqual({
        ok: false,
        error: { category: 'source-format', code: 'invalid-profile-id' },
      });
      expect(await service.clearParentalPin?.('1234', '../bad/id')).toEqual({
        ok: false,
        error: { category: 'source-format', code: 'invalid-profile-id' },
      });
      expect(await service.verifyParentalPin?.('1234', '../bad/id')).toEqual({
        ok: false,
        remainingAttempts: 5,
      });
      expect(getSpy).not.toHaveBeenCalled();
      expect(setSpy).not.toHaveBeenCalled();
      expect(deleteSpy).not.toHaveBeenCalled();
    } finally {
      close();
    }
  });

  it('seeds child-safe parental_settings and marks fast-path dirty when updateProfile toggles isKids to true', async () => {
    const { db, close } = testDb();
    try {
      await openCatalog(db);
      const created = await createProfile(
        db,
        { name: 'Room' },
        () => 100,
        () => 'room',
      );
      expect(created.ok).toBe(true);
      expect(await loadActiveParentalFilter(db, 'room', false)).toBeNull();

      const updated = await updateProfile(db, 'room', { isKids: true }, () => 200);
      expect(updated.ok).toBe(true);

      const filter = await loadActiveParentalFilter(db, 'room', false);
      expect(filter).not.toBeNull();
      expect(filter?.enabled).toBe(true);
      expect(filter?.blockAdultKeywords).toBe(true);
      expect(filter?.maxRatingAge).toBe(12);
    } finally {
      close();
    }
  });

  it('guards against self-recursion in isItemRestricted when episode.series_key === itemKey', async () => {
    const { db, close } = testDb();
    try {
      await openCatalog(db);
      await db.run(
        "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'XT', 1, '{}')",
      );
      await db.run(
        "INSERT INTO episodes (source_id, key, provider_id, series_key, season, episode, title, title_fold, run_id) VALUES ('s1', 'x:s1:ep:self', '1', 'x:s1:ep:self', 1, 1, 'Normal Title', 'normal title', 1)",
      );
      await updateParentalSettings(db, 'default', { enabled: true, blockAdultKeywords: true });
      const filter = await loadActiveParentalFilter(db, 'default', false);
      expect(filter).not.toBeNull();
      if (filter === null) return;
      expect(await isItemRestricted(db, filter, 'x:s1:ep:self')).toBe(false);
    } finally {
      close();
    }
  });
});
