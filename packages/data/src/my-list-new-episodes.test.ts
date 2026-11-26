import {
  type HttpClient,
  type HttpResponse,
  ok,
  type Scheduler,
  type SecretStore,
  type SqlDriver,
} from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createCatalogService } from './catalog';
import { openCatalog } from './migrate';
import {
  captureMyListSeriesBaseline,
  dismissMyListNewEpisode,
  listMyListNewEpisodes,
  reconcileMyListNewEpisodes,
} from './my-list-new-episodes';
import { setParentalLock, updateParentalSettings } from './parental-repo';
import { createProfile, deleteProfile } from './profiles-repo';
import { testDb } from './test-db';
import { saveWatchProgress, setFavorite, setItemWatched, toggleFavorite } from './user-state';

const syncScheduler: Scheduler = {
  yieldNow: async () => {},
};

function memorySecrets(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: async (k) => map.get(k),
    set: async (k, v) => {
      map.set(k, v);
    },
    delete: async (k) => {
      map.delete(k);
    },
  };
}

function makeResponse(body: string, status = 200): HttpResponse {
  const bytes = new TextEncoder().encode(body);
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: (async function* () {
      yield bytes;
    })(),
  };
}

async function seedSourceAndSeries(
  db: SqlDriver,
  opts: {
    sourceId: string;
    kind: 'm3u' | 'xtream';
    seriesKey: string;
    seriesName: string;
    providerId?: string;
    cover?: string | null;
  },
) {
  await db.run(
    `INSERT OR IGNORE INTO sources (id, kind, name, created_at, settings_json, deleting)
     VALUES (?, ?, ?, 1000, '{}', 0)`,
    [opts.sourceId, opts.kind, `Source ${opts.sourceId}`],
  );
  await db.run(
    `INSERT OR REPLACE INTO series (source_id, key, provider_id, name, name_fold, cover, run_id)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [
      opts.sourceId,
      opts.seriesKey,
      opts.providerId ?? null,
      opts.seriesName,
      opts.seriesName.toLowerCase(),
      opts.cover ?? 'https://img.test/poster.jpg',
    ],
  );
}

async function seedEpisode(
  db: SqlDriver,
  opts: {
    sourceId: string;
    seriesKey: string;
    key: string;
    season: number;
    episode: number;
    title: string;
  },
) {
  await db.run(
    `INSERT OR REPLACE INTO episodes (source_id, key, series_key, season, episode, title, run_id, title_fold)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    [
      opts.sourceId,
      opts.key,
      opts.seriesKey,
      opts.season,
      opts.episode,
      opts.title,
      opts.title.toLowerCase(),
    ],
  );
}

describe('my-list-new-episodes (#502)', () => {
  it('captures baseline on M3U series favorite without flagging old episodes, then detects newly arrived ones', async () => {
    const { db } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    let now = 1_000_000;
    const clock = () => now;

    await seedSourceAndSeries(db, {
      sourceId: 'm1',
      kind: 'm3u',
      seriesKey: 'm1:s:1',
      seriesName: 'Starlight',
    });
    await seedEpisode(db, {
      sourceId: 'm1',
      seriesKey: 'm1:s:1',
      key: 'm1:e:1',
      season: 1,
      episode: 1,
      title: 'Pilot',
    });

    const fav = await setFavorite(
      db,
      { sourceId: 'm1', itemKey: 'm1:s:1', kind: 'series', title: 'Starlight' },
      true,
      clock,
    );
    expect(fav.ok).toBe(true);

    // Existing episode must NOT be flagged as new.
    expect(await reconcileMyListNewEpisodes(db, 'default', { clock })).toBe(0);
    expect(await listMyListNewEpisodes(db, 24, 'default')).toEqual([]);

    // New episode arrives via M3U re-import.
    now = 2_000_000;
    await seedEpisode(db, {
      sourceId: 'm1',
      seriesKey: 'm1:s:1',
      key: 'm1:e:2',
      season: 1,
      episode: 2,
      title: 'Second Contact',
    });
    expect(await reconcileMyListNewEpisodes(db, 'default', { clock })).toBe(1);

    const rows = await listMyListNewEpisodes(db, 24, 'default');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      profileId: 'default',
      episodeKey: 'm1:e:2',
      seriesKey: 'm1:s:1',
      sourceId: 'm1',
      seriesTitle: 'Starlight',
      seriesLogo: 'https://img.test/poster.jpg',
      season: 1,
      episode: 2,
      episodeTitle: 'Second Contact',
      detectedAt: 2_000_000,
    });

    // Reconciling again does not duplicate.
    expect(await reconcileMyListNewEpisodes(db, 'default', { clock })).toBe(0);
  });

  it('establishes baseline cleanly for pre-v22 favorited series without false positives', async () => {
    const { db } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    let now = 5_000;
    const clock = () => now;

    await seedSourceAndSeries(db, {
      sourceId: 'm1',
      kind: 'm3u',
      seriesKey: 'm1:s:legacy',
      seriesName: 'Legacy Show',
    });
    await seedEpisode(db, {
      sourceId: 'm1',
      seriesKey: 'm1:s:legacy',
      key: 'm1:e:old1',
      season: 1,
      episode: 1,
      title: 'Old Ep 1',
    });
    // Insert directly into favorites without a baseline row (simulating upgrade from v21).
    await db.run(
      `INSERT INTO favorites (profile_id, source_id, item_key, kind, title, added_at, sort_order)
       VALUES ('default', 'm1', 'm1:s:legacy', 'series', 'Legacy Show', 100, 1)`,
    );

    expect(await reconcileMyListNewEpisodes(db, 'default', { clock })).toBe(0);
    expect(await listMyListNewEpisodes(db)).toEqual([]);

    // Next new episode IS detected.
    now = 9_000;
    await seedEpisode(db, {
      sourceId: 'm1',
      seriesKey: 'm1:s:legacy',
      key: 'm1:e:new2',
      season: 1,
      episode: 2,
      title: 'Fresh Ep 2',
    });
    expect(await reconcileMyListNewEpisodes(db, 'default', { clock })).toBe(1);
    const rows = await listMyListNewEpisodes(db);
    expect(rows.map((r) => r.episodeKey)).toEqual(['m1:e:new2']);
  });

  it('auto-hides episodes when finished via saveWatchProgress or marked watched via setItemWatched', async () => {
    const { db } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    let now = 10_000;
    const clock = () => now;

    await seedSourceAndSeries(db, {
      sourceId: 'm1',
      kind: 'm3u',
      seriesKey: 'm1:s:1',
      seriesName: 'Drama',
    });
    await seedEpisode(db, {
      sourceId: 'm1',
      seriesKey: 'm1:s:1',
      key: 'm1:e:1',
      season: 1,
      episode: 1,
      title: 'Ep 1',
    });
    await setFavorite(
      db,
      { sourceId: 'm1', itemKey: 'm1:s:1', kind: 'series', title: 'Drama' },
      true,
      clock,
    );

    now = 20_000;
    await seedEpisode(db, {
      sourceId: 'm1',
      seriesKey: 'm1:s:1',
      key: 'm1:e:2',
      season: 1,
      episode: 2,
      title: 'Ep 2',
    });
    await seedEpisode(db, {
      sourceId: 'm1',
      seriesKey: 'm1:s:1',
      key: 'm1:e:3',
      season: 1,
      episode: 3,
      title: 'Ep 3',
    });
    expect(await reconcileMyListNewEpisodes(db, 'default', { clock })).toBe(2);
    expect((await listMyListNewEpisodes(db)).map((r) => r.episodeKey)).toEqual([
      'm1:e:3',
      'm1:e:2',
    ]);

    // Finish Ep 2 via saveWatchProgress (watched: true) -> disappears immediately.
    await saveWatchProgress(
      db,
      {
        sourceId: 'm1',
        itemKey: 'm1:e:2',
        kind: 'episode',
        title: 'Ep 2',
        seriesKey: 'm1:s:1',
        season: 1,
        episode: 2,
        positionMs: 3_000_000,
        durationMs: 3_000_000,
        watched: true,
      },
      clock,
    );
    expect((await listMyListNewEpisodes(db)).map((r) => r.episodeKey)).toEqual(['m1:e:3']);

    // Mark Ep 3 watched via setItemWatched -> disappears immediately.
    await setItemWatched(db, 'm1:e:3', true, clock, 'default');
    expect(await listMyListNewEpisodes(db)).toEqual([]);
  });

  it('supports dismissal, unfavorite cleanup, profile deletion cleanup, and parental lock filtering', async () => {
    const { db } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    const secrets = memorySecrets();
    let now = 50_000;
    const clock = () => now;

    await seedSourceAndSeries(db, {
      sourceId: 'm1',
      kind: 'm3u',
      seriesKey: 'm1:s:1',
      seriesName: 'Show A',
    });
    await seedEpisode(db, {
      sourceId: 'm1',
      seriesKey: 'm1:s:1',
      key: 'm1:e:1',
      season: 1,
      episode: 1,
      title: 'Ep 1',
    });
    await toggleFavorite(
      db,
      { sourceId: 'm1', itemKey: 'm1:s:1', kind: 'series', title: 'Show A' },
      clock,
    );

    now = 60_000;
    await seedEpisode(db, {
      sourceId: 'm1',
      seriesKey: 'm1:s:1',
      key: 'm1:e:2',
      season: 1,
      episode: 2,
      title: 'Ep 2',
    });
    await seedEpisode(db, {
      sourceId: 'm1',
      seriesKey: 'm1:s:1',
      key: 'm1:e:3',
      season: 1,
      episode: 3,
      title: 'Ep 3',
    });
    await reconcileMyListNewEpisodes(db, 'default', { clock });

    // Dismiss Ep 2 -> hidden even after future reconcile.
    expect((await dismissMyListNewEpisode(db, 'm1:e:2', 'default')).ok).toBe(true);
    expect(await reconcileMyListNewEpisodes(db, 'default', { clock })).toBe(0);
    expect((await listMyListNewEpisodes(db)).map((r) => r.episodeKey)).toEqual(['m1:e:3']);

    // Parental lock on series hides its new episodes when locked, shows when unlocked.
    await updateParentalSettings(db, 'default', { enabled: true }, clock);
    await setParentalLock(
      db,
      {
        profileId: 'default',
        sourceId: 'm1',
        targetKind: 'item',
        itemKind: 'series',
        targetKey: 'm1:s:1',
      },
      true,
      clock,
    );
    expect(await listMyListNewEpisodes(db, 24, 'default', { parentalUnlocked: false })).toEqual([]);
    expect(
      (await listMyListNewEpisodes(db, 24, 'default', { parentalUnlocked: true })).map(
        (r) => r.episodeKey,
      ),
    ).toEqual(['m1:e:3']);

    // Unfavoriting clears both baselines and new episodes.
    await toggleFavorite(
      db,
      { sourceId: 'm1', itemKey: 'm1:s:1', kind: 'series', title: 'Show A' },
      clock,
    );
    expect(await listMyListNewEpisodes(db, 24, 'default', { parentalUnlocked: true })).toEqual([]);
    expect(await db.all('SELECT * FROM my_list_series_baselines')).toEqual([]);

    // Limit clamping edge cases.
    expect(await listMyListNewEpisodes(db, 0, 'default')).toEqual([]);
    expect(await listMyListNewEpisodes(db, -5, 'default')).toEqual([]);

    // Profile deletion cascades cleanly.
    const prof = await createProfile(db, { name: 'Kids', isKids: false }, clock, () => 'p-kids');
    expect(prof.ok).toBe(true);
    await captureMyListSeriesBaseline(db, 'p-kids', 'm1:s:1', 'm1', clock);
    expect(
      await db.all('SELECT * FROM my_list_series_baselines WHERE profile_id = ?', ['p-kids']),
    ).toHaveLength(1);
    expect((await deleteProfile(db, secrets, 'p-kids')).ok).toBe(true);
    expect(
      await db.all('SELECT * FROM my_list_series_baselines WHERE profile_id = ?', ['p-kids']),
    ).toEqual([]);
  });

  it('handles Xtream 0-episode baseline init -> second refresh detection, cooldown, maxSeries cap, and source removal', async () => {
    const { db } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    const secrets = memorySecrets();
    let now = 100_000;
    const clock = () => now;

    // Provider state: series 101 starts with 1 episode, later gains ep 1002; series 102 has 1 episode.
    let series101Episodes = [
      { id: '1001', episode_num: 1, title: 'S1E1', container_extension: 'mp4', season: 1 },
    ];
    let infoCalls = 0;

    const http: HttpClient = {
      get: async (rawUrl) => {
        const url = new URL(rawUrl);
        const action = url.searchParams.get('action');
        if (action === 'get_series_info') {
          infoCalls += 1;
          const sid = url.searchParams.get('series_id');
          if (sid === '101') {
            return ok(
              makeResponse(
                JSON.stringify({
                  info: { name: 'Alpha' },
                  episodes: { '1': series101Episodes },
                }),
              ),
            );
          }
          return ok(
            makeResponse(
              JSON.stringify({
                info: { name: 'Beta' },
                episodes: {
                  '1': [
                    {
                      id: '2001',
                      episode_num: 1,
                      title: 'Beta E1',
                      container_extension: 'mp4',
                      season: 1,
                    },
                  ],
                },
              }),
            ),
          );
        }
        return ok(makeResponse(JSON.stringify({ user_info: { status: 'Active' } })));
      },
    };

    const catalog = createCatalogService({
      db,
      secrets,
      scheduler: syncScheduler,
      http,
      clock,
      newId: () => 'x1',
    });

    const added = await catalog.addSource({
      kind: 'xtream',
      name: 'Xtream Test',
      server: 'http://provider.test',
      username: 'u',
      password: 'p',
    });
    expect(added.ok).toBe(true);

    await seedSourceAndSeries(db, {
      sourceId: 'x1',
      kind: 'xtream',
      seriesKey: 'x1:series:101',
      seriesName: 'Alpha',
      providerId: '101',
    });
    await seedSourceAndSeries(db, {
      sourceId: 'x1',
      kind: 'xtream',
      seriesKey: 'x1:series:102',
      seriesName: 'Beta',
      providerId: '102',
    });

    // Favorite both series BEFORE any episodes are cached (0-episode baseline init).
    await catalog.setFavorite?.(
      { sourceId: 'x1', itemKey: 'x1:series:101', kind: 'series', title: 'Alpha' },
      true,
    );
    await catalog.setFavorite?.(
      { sourceId: 'x1', itemKey: 'x1:series:102', kind: 'series', title: 'Beta' },
      true,
    );

    // First refresh with maxSeries: 1 checks only 1 series and establishes baseline (0 false positives).
    const first = await catalog.refreshMyListNewEpisodes?.('default', { maxSeries: 1 });
    expect(first?.ok).toBe(true);
    if (first?.ok) {
      expect(first.value).toEqual({ checkedSeriesCount: 1, newlyDetectedCount: 0 });
    }
    expect(infoCalls).toBe(1);
    expect(await catalog.listMyListNewEpisodes?.(24, 'default')).toEqual([]);

    // Second refresh with default maxSeries checks the remaining unchecked series (1st is within cooldown).
    now += 5_000;
    const second = await catalog.refreshMyListNewEpisodes?.('default', { cooldownMs: 60_000 });
    expect(second?.ok).toBe(true);
    if (second?.ok) {
      expect(second.value).toEqual({ checkedSeriesCount: 1, newlyDetectedCount: 0 });
    }
    expect(infoCalls).toBe(2);

    // Within cooldown: 0 series checked.
    now += 5_000;
    const withinCooldown = await catalog.refreshMyListNewEpisodes?.('default', {
      cooldownMs: 60_000,
    });
    expect(withinCooldown?.ok).toBe(true);
    if (withinCooldown?.ok) {
      expect(withinCooldown.value).toEqual({ checkedSeriesCount: 0, newlyDetectedCount: 0 });
    }
    expect(infoCalls).toBe(2);

    // Provider publishes Episode 2 for Alpha; force refresh detects it!
    series101Episodes = [
      ...series101Episodes,
      { id: '1002', episode_num: 2, title: 'S1E2 Arrival', container_extension: 'mp4', season: 1 },
    ];
    now += 5_000;
    const forced = await catalog.refreshMyListNewEpisodes?.('default', { force: true });
    expect(forced?.ok).toBe(true);
    if (forced?.ok) {
      expect(forced.value).toEqual({ checkedSeriesCount: 2, newlyDetectedCount: 1 });
    }

    const listed = await catalog.listMyListNewEpisodes?.(24, 'default');
    expect(listed).toHaveLength(1);
    expect(listed?.[0]?.episodeKey).toBe('x:x1:episode:1002');
    expect(listed?.[0]?.episodeTitle).toBe('S1E2 Arrival');

    // Removing the source cleans up baselines and new episodes.
    const removed = await catalog.removeSource('x1');
    expect(removed.ok).toBe(true);
    expect(await db.all('SELECT * FROM my_list_series_baselines')).toEqual([]);
    expect(await db.all('SELECT * FROM my_list_new_episodes')).toEqual([]);
    await catalog.close();
  });
});
