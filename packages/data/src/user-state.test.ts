import { ok } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createCatalogService } from './catalog';
import { openCatalog } from './migrate';
import { countingScheduler, memorySecrets, testDb } from './test-db';
import {
  clearWatchProgress,
  computeResumePositionMs,
  DEFAULT_PROFILE_ID,
  getWatchProgress,
  isCompletedProgress,
  listContinueWatching,
  listFavoriteKeys,
  listFavorites,
  listProgressByKeys,
  MIN_RESUME_POSITION_MS,
  SMART_RESUME_REWIND_MS,
  saveWatchProgress,
  setItemWatched,
  toggleFavorite,
  WATCHED_THRESHOLD_RATIO,
} from './user-state';

async function setupDb() {
  const handle = testDb();
  await openCatalog(handle.db);
  return handle;
}

describe('user-state pure helpers', () => {
  it('exposes the canonical constants', () => {
    expect(DEFAULT_PROFILE_ID).toBe('default');
    expect(WATCHED_THRESHOLD_RATIO).toBe(0.9);
    expect(MIN_RESUME_POSITION_MS).toBe(10_000);
    expect(SMART_RESUME_REWIND_MS).toBe(5_000);
  });

  it('computes completion threshold accurately', () => {
    expect(isCompletedProgress(89_999, 100_000)).toBe(false);
    expect(isCompletedProgress(90_000, 100_000)).toBe(true);
    expect(isCompletedProgress(100_000, 100_000)).toBe(true);
    expect(isCompletedProgress(50_000, 0)).toBe(false);
    expect(isCompletedProgress(-1, 100_000)).toBe(false);
    expect(isCompletedProgress(Number.NaN, 100_000)).toBe(false);
    expect(isCompletedProgress(50_000, Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('computes smart resume rewind with minimum resume threshold', () => {
    expect(computeResumePositionMs({ positionMs: 50_000, watched: true })).toBe(0);
    expect(computeResumePositionMs({ positionMs: 9_999, watched: false })).toBe(0);
    expect(computeResumePositionMs({ positionMs: 10_000, watched: false })).toBe(5_000);
    expect(computeResumePositionMs({ positionMs: 42_500.4, watched: false })).toBe(37_500);
    expect(computeResumePositionMs({ positionMs: Number.NaN, watched: false })).toBe(0);
  });
});

describe('watch progress queries & mutations', () => {
  it('saves, upserts, auto-completes at >= 90%, clamps negatives, and enforces profile isolation', async () => {
    const { db } = await setupDb();
    let now = 1_000;
    const clock = () => now;

    const first = await saveWatchProgress(
      db,
      {
        sourceId: 's1',
        itemKey: 'm:s1:1',
        kind: 'movie',
        title: 'Silent Horizon',
        logo: 'https://img.example/poster.jpg',
        positionMs: 40_000,
        durationMs: 100_000,
      },
      clock,
    );
    expect(first).toEqual({
      ok: true,
      value: {
        profileId: 'default',
        sourceId: 's1',
        itemKey: 'm:s1:1',
        kind: 'movie',
        title: 'Silent Horizon',
        subtitle: null,
        logo: 'https://img.example/poster.jpg',
        seriesKey: null,
        season: null,
        episode: null,
        positionMs: 40_000,
        durationMs: 100_000,
        watched: false,
        updatedAt: 1_000,
      },
    });

    // Upsert same item at 92% marks watched = true
    now = 2_000;
    const completed = await saveWatchProgress(
      db,
      {
        sourceId: 's1',
        itemKey: 'm:s1:1',
        kind: 'movie',
        title: 'Silent Horizon',
        positionMs: 92_000,
        durationMs: 100_000,
      },
      clock,
    );
    expect(completed.ok && completed.value.watched).toBe(true);
    expect(completed.ok && completed.value.updatedAt).toBe(2_000);

    // Different profile maintains independent state and clamps negative numbers
    now = 3_000;
    const kids = await saveWatchProgress(
      db,
      {
        profileId: 'kids',
        sourceId: 's1',
        itemKey: 'm:s1:1',
        kind: 'movie',
        title: 'Silent Horizon',
        positionMs: -500,
        durationMs: -10,
      },
      clock,
    );
    expect(kids.ok && kids.value).toMatchObject({
      profileId: 'kids',
      positionMs: 0,
      durationMs: 0,
      watched: false,
    });

    expect((await getWatchProgress(db, 'm:s1:1'))?.watched).toBe(true);
    expect((await getWatchProgress(db, 'm:s1:1', 'kids'))?.positionMs).toBe(0);
    expect(await getWatchProgress(db, 'missing')).toBeNull();
    expect(await getWatchProgress(db, '')).toBeNull();

    // Rejects invalid empty identifiers
    const bad = await saveWatchProgress(
      db,
      { sourceId: '', itemKey: 'k', kind: 'movie', title: 'T', positionMs: 0, durationMs: 0 },
      clock,
    );
    expect(bad).toMatchObject({ ok: false, error: { category: 'source-format' } });
  });

  it('lists Continue Watching ordered by updatedAt DESC, excludes watched and < 10s, and clamps limits', async () => {
    const { db } = await setupDb();
    let now = 100;
    const clock = () => (now += 100);

    await saveWatchProgress(
      db,
      {
        sourceId: 's1',
        itemKey: 'short',
        kind: 'movie',
        title: 'Too Short',
        positionMs: 9_000,
        durationMs: 100_000,
      },
      clock,
    );
    await saveWatchProgress(
      db,
      {
        sourceId: 's1',
        itemKey: 'done',
        kind: 'movie',
        title: 'Finished Film',
        positionMs: 95_000,
        durationMs: 100_000,
      },
      clock,
    );
    await saveWatchProgress(
      db,
      {
        sourceId: 's1',
        itemKey: 'ep1',
        kind: 'episode',
        title: 'Northern Signal',
        subtitle: 'S1 E1',
        seriesKey: 'ser:1',
        season: 1,
        episode: 1,
        positionMs: 30_000,
        durationMs: 100_000,
      },
      clock,
    );
    await saveWatchProgress(
      db,
      {
        sourceId: 's1',
        itemKey: 'mov2',
        kind: 'movie',
        title: 'Orbital Nine',
        positionMs: 50_000,
        durationMs: 120_000,
      },
      clock,
    );
    await saveWatchProgress(
      db,
      {
        profileId: 'guest',
        sourceId: 's1',
        itemKey: 'guest-item',
        kind: 'movie',
        title: 'Guest Film',
        positionMs: 25_000,
        durationMs: 100_000,
      },
      clock,
    );

    const list = await listContinueWatching(db, 10);
    expect(list.map((r) => r.itemKey)).toEqual(['mov2', 'ep1']);
    expect(list[1]).toMatchObject({ seriesKey: 'ser:1', season: 1, episode: 1, subtitle: 'S1 E1' });
    expect((await listContinueWatching(db, 1)).map((r) => r.itemKey)).toEqual(['mov2']);
    expect(await listContinueWatching(db, 0)).toEqual([]);
    expect((await listContinueWatching(db, 200, 'guest')).map((r) => r.itemKey)).toEqual([
      'guest-item',
    ]);
  });

  it('deduplicates multiple in-progress episodes of the same series while keeping movies and other series separate', async () => {
    const { db } = await setupDb();

    // Series A: S1E1 at t=100, S1E2 at t=200 -> only S1E2 should surface
    await saveWatchProgress(
      db,
      {
        sourceId: 's1',
        itemKey: 'ep:a:1',
        kind: 'episode',
        title: 'Northern Signal',
        subtitle: 'S1 E1',
        seriesKey: 'ser:a',
        season: 1,
        episode: 1,
        positionMs: 30_000,
        durationMs: 100_000,
      },
      () => 100,
    );
    await saveWatchProgress(
      db,
      {
        sourceId: 's1',
        itemKey: 'ep:a:2',
        kind: 'episode',
        title: 'Northern Signal',
        subtitle: 'S1 E2',
        seriesKey: 'ser:a',
        season: 1,
        episode: 2,
        positionMs: 40_000,
        durationMs: 100_000,
      },
      () => 200,
    );
    // Two standalone movies (seriesKey: null) must both remain
    await saveWatchProgress(
      db,
      {
        sourceId: 's1',
        itemKey: 'mov:1',
        kind: 'movie',
        title: 'Aurora Dawn',
        positionMs: 25_000,
        durationMs: 100_000,
      },
      () => 150,
    );
    await saveWatchProgress(
      db,
      {
        sourceId: 's1',
        itemKey: 'mov:2',
        kind: 'movie',
        title: 'Coastal Wind',
        positionMs: 20_000,
        durationMs: 100_000,
      },
      () => 250,
    );
    // Second series B must appear independently alongside Series A
    await saveWatchProgress(
      db,
      {
        sourceId: 's1',
        itemKey: 'ep:b:1',
        kind: 'episode',
        title: 'Harbor Watch',
        subtitle: 'S1 E1',
        seriesKey: 'ser:b',
        season: 1,
        episode: 1,
        positionMs: 15_000,
        durationMs: 100_000,
      },
      () => 180,
    );

    const list = await listContinueWatching(db, 10);
    expect(list.map((r) => r.itemKey)).toEqual(['mov:2', 'ep:a:2', 'ep:b:1', 'mov:1']);

    // Marking S1E2 watched surfaces S1E1 because S1E1 is still unwatched and >= 10s
    await setItemWatched(db, 'ep:a:2', true, () => 300);
    const afterWatched = await listContinueWatching(db, 10);
    expect(afterWatched.map((r) => r.itemKey)).toEqual(['mov:2', 'ep:b:1', 'mov:1', 'ep:a:1']);
  });

  it('supports setItemWatched, listProgressByKeys (bounded to 200), and clearWatchProgress', async () => {
    const { db } = await setupDb();
    let now = 500;
    const clock = () => (now += 100);

    await saveWatchProgress(
      db,
      {
        sourceId: 's1',
        itemKey: 'k1',
        kind: 'movie',
        title: 'Film One',
        positionMs: 45_000,
        durationMs: 100_000,
      },
      clock,
    );
    await saveWatchProgress(
      db,
      {
        sourceId: 's1',
        itemKey: 'k2',
        kind: 'movie',
        title: 'Film Two',
        positionMs: 20_000,
        durationMs: 100_000,
      },
      clock,
    );

    // Mark watched then unwatched (resets positionMs to 0)
    expect((await setItemWatched(db, 'k1', true, clock)).ok).toBe(true);
    expect((await getWatchProgress(db, 'k1'))?.watched).toBe(true);
    expect((await getWatchProgress(db, 'k1'))?.positionMs).toBe(45_000);

    expect((await setItemWatched(db, 'k1', false, clock)).ok).toBe(true);
    expect(await getWatchProgress(db, 'k1')).toMatchObject({ watched: false, positionMs: 0 });

    // Safe no-op for unknown key
    expect((await setItemWatched(db, 'unknown', true, clock)).ok).toBe(true);

    // listProgressByKeys
    expect(await listProgressByKeys(db, [])).toEqual([]);
    const byKeys = await listProgressByKeys(db, ['k1', 'k2', 'k1', 'nope']);
    expect(byKeys.map((r) => r.itemKey).sort()).toEqual(['k1', 'k2']);

    // Bounds > 200 keys cleanly
    const many = Array.from({ length: 250 }, (_, i) => `m${i}`);
    many[0] = 'k1';
    many[240] = 'k2'; // beyond cap of 200
    const bounded = await listProgressByKeys(db, many);
    expect(bounded.map((r) => r.itemKey)).toEqual(['k1']);

    // clearWatchProgress
    expect((await clearWatchProgress(db, 'k1')).ok).toBe(true);
    expect(await getWatchProgress(db, 'k1')).toBeNull();
    expect(await getWatchProgress(db, 'k2')).not.toBeNull();
  });
});

describe('favorites queries & mutations', () => {
  it('toggles, lists in addedAt DESC order, isolates profiles, and lists keys', async () => {
    const { db } = await setupDb();
    let now = 1_000;
    const clock = () => (now += 100);

    const added1 = await toggleFavorite(
      db,
      {
        sourceId: 's1',
        itemKey: 'm:s1:1',
        kind: 'movie',
        title: 'Orbital Nine',
        logo: 'https://img.example/1.jpg',
        year: 2025,
        rating: 8.2,
      },
      clock,
    );
    expect(added1).toEqual({ ok: true, value: true });

    const added2 = await toggleFavorite(
      db,
      {
        sourceId: 's1',
        itemKey: 's:s1:2',
        kind: 'series',
        title: 'Northern Signal',
        year: 2026,
        rating: 8.8,
      },
      clock,
    );
    expect(added2).toEqual({ ok: true, value: true });

    // Profile isolation
    await toggleFavorite(
      db,
      {
        profileId: 'kids',
        sourceId: 's1',
        itemKey: 'm:s1:1',
        kind: 'movie',
        title: 'Orbital Nine',
      },
      clock,
    );

    const favs = await listFavorites(db, 10);
    expect(favs.map((f) => f.itemKey)).toEqual(['s:s1:2', 'm:s1:1']);
    expect(favs[1]).toMatchObject({ year: 2025, rating: 8.2, logo: 'https://img.example/1.jpg' });
    expect(await listFavorites(db, 0)).toEqual([]);
    expect(await listFavoriteKeys(db)).toEqual(['s:s1:2', 'm:s1:1']);
    expect(await listFavoriteKeys(db, 'kids')).toEqual(['m:s1:1']);

    // Toggle off removes only from default profile
    const removed = await toggleFavorite(
      db,
      { sourceId: 's1', itemKey: 'm:s1:1', kind: 'movie', title: 'Orbital Nine' },
      clock,
    );
    expect(removed).toEqual({ ok: true, value: false });
    expect(await listFavoriteKeys(db)).toEqual(['s:s1:2']);
    expect(await listFavoriteKeys(db, 'kids')).toEqual(['m:s1:1']);

    // Rejects invalid empty fields
    const bad = await toggleFavorite(
      db,
      { sourceId: 's1', itemKey: '', kind: 'movie', title: 'X' },
      clock,
    );
    expect(bad).toMatchObject({ ok: false, error: { category: 'source-format' } });
  });
});

describe('CatalogService user-state integration', () => {
  it('never persists resolved M3U logo tokens into SQLite while still resolving templates on reads, and cascades on removeSource', async () => {
    const { db } = await setupDb();
    const secrets = memorySecrets();
    const tok = ['logo', 'Tok', '998877'].join('');
    const playlist = [
      '#EXTM3U',
      `#EXTINF:-1 tvg-logo="http://img.example/${tok}/film1.png" group-title="Films",Silent Horizon (2026)`,
      `http://cdn.example/${tok}/vod/1.mkv`,
      `#EXTINF:-1 tvg-logo="http://img.example/${tok}/film2.png" group-title="Films",Orbital Nine (2025)`,
      `http://cdn.example/${tok}/vod/2.mkv`,
      `#EXTINF:-1 tvg-logo="http://img.example/${tok}/show1.png" group-title="Shows",Northern Signal S01E01`,
      `http://cdn.example/${tok}/series/10.mp4`,
    ].join('\n');
    let now = 10_000;
    const service = createCatalogService({
      db,
      secrets,
      scheduler: countingScheduler(),
      http: {
        async get() {
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
      clock: () => (now += 100),
      newId: () => 'src1',
    });

    const added = await service.addSource({
      kind: 'm3u',
      name: 'M3U',
      playlistUrl: 'http://panel.example/list.m3u',
    });
    expect(added.ok).toBe(true);
    expect((await service.importSource('src1')).ok).toBe(true);

    // Confirm catalog.items() returns the RESOLVED token-bearing URL
    const movieCat = (await service.categories('src1', 'movie'))[0];
    const movies = await service.items(movieCat?.id ?? '', 0, 10);
    const film = movies[0];
    expect(film?.logo).toBe(`http://img.example/${tok}/film1.png`);

    // Pass the RESOLVED logo (exact real UI flow!) into saveProgress & toggleFavorite
    const saved = await service.saveProgress?.({
      sourceId: 'src1',
      itemKey: film?.key ?? '',
      kind: 'movie',
      title: film?.name ?? 'Silent Horizon',
      logo: film?.logo ?? null,
      positionMs: 30_000,
      durationMs: 100_000,
    });
    expect(saved?.ok && saved.value.logo).toBe(`http://img.example/${tok}/film1.png`);

    expect(
      await service.toggleFavorite?.({
        sourceId: 'src1',
        itemKey: film?.key ?? '',
        kind: 'movie',
        title: film?.name ?? 'Silent Horizon',
        logo: film?.logo ?? null,
      }),
    ).toEqual({ ok: true, value: true });

    // Also test M3U episode + unimported M3U item with caller-supplied resolved token URL
    const seriesCat = (await service.categories('src1', 'series'))[0];
    const show = (await service.items(seriesCat?.id ?? '', 0, 10))[0];
    const eps = await service.episodes(show?.id ?? 0, 0);
    const epKey = eps[0]?.key ?? '';
    await service.saveProgress?.({
      sourceId: 'src1',
      itemKey: epKey,
      kind: 'episode',
      title: show?.name ?? 'Northern Signal',
      seriesKey: show?.key ?? null,
      logo: `http://img.example/${tok}/leaked-episode.png`,
      positionMs: 20_000,
      durationMs: 100_000,
    });
    await service.saveProgress?.({
      sourceId: 'src1',
      itemKey: 'm:src1:missing-item',
      kind: 'movie',
      title: 'Unmatched M3U Item',
      logo: `http://img.example/${tok}/should-not-persist.png`,
      positionMs: 25_000,
      durationMs: 100_000,
    });

    // CRITICAL: raw SQLite watch_progress & favorites MUST contain ZERO occurrences of the token!
    const rawProgress = await db.all<{ item_key: string; logo: string | null }>(
      'SELECT item_key, logo FROM watch_progress',
    );
    const rawFavorites = await db.all<{ item_key: string; logo: string | null }>(
      'SELECT item_key, logo FROM favorites',
    );
    for (const row of [...rawProgress, ...rawFavorites]) {
      expect(row.logo ?? '').not.toContain(tok);
    }
    const storedFilmProgress = rawProgress.find((r) => r.item_key === film?.key);
    expect(storedFilmProgress?.logo).toContain('{{');
    const storedFilmFav = rawFavorites.find((r) => r.item_key === film?.key);
    expect(storedFilmFav?.logo).toContain('{{');
    const storedMissing = rawProgress.find((r) => r.item_key === 'm:src1:missing-item');
    expect(storedMissing?.logo).toBeNull();

    // Reads still resolve templates back to the full logo URL via playtime.resolveRowLogos
    const fetched = await service.getProgress?.(film?.key ?? '');
    expect(fetched?.logo).toBe(`http://img.example/${tok}/film1.png`);
    const cw = await service.listContinueWatching?.(10);
    expect(cw?.find((r) => r.itemKey === film?.key)?.logo).toBe(
      `http://img.example/${tok}/film1.png`,
    );
    // Synthetic M3U series has cover = null, so caller-supplied leaked episode logo was dropped
    expect(cw?.find((r) => r.itemKey === epKey)?.logo).toBeNull();
    // When parent series has a raw cover template, saving episode progress inherits & resolves it
    await db.run('UPDATE series SET cover = ? WHERE source_id = ? AND key = ?', [
      storedFilmProgress?.logo ?? null,
      'src1',
      show?.key ?? '',
    ]);
    await service.saveProgress?.({
      sourceId: 'src1',
      itemKey: epKey,
      kind: 'episode',
      title: show?.name ?? 'Northern Signal',
      seriesKey: show?.key ?? null,
      logo: `http://img.example/${tok}/leaked-episode.png`,
      positionMs: 22_000,
      durationMs: 100_000,
    });
    const rawEpAfter = await db.all<{ logo: string | null }>(
      'SELECT logo FROM watch_progress WHERE item_key = ?',
      [epKey],
    );
    expect(rawEpAfter[0]?.logo).toBe(storedFilmProgress?.logo);
    expect(rawEpAfter[0]?.logo ?? '').not.toContain(tok);
    expect((await service.getProgress?.(epKey))?.logo).toBe(`http://img.example/${tok}/film1.png`);
    const byKey = await service.listProgressByKeys?.([film?.key ?? '']);
    expect(byKey?.[0]?.logo).toBe(`http://img.example/${tok}/film1.png`);
    expect((await service.listFavorites?.(10))?.[0]?.logo).toBe(
      `http://img.example/${tok}/film1.png`,
    );
    expect(await service.listFavoriteKeys?.()).toEqual([film?.key]);

    // Keep an entry on another source to ensure removeSource is scoped
    await service.saveProgress?.({
      sourceId: 'src2',
      itemKey: 'm:src2:9',
      kind: 'movie',
      title: 'Other Film',
      logo: 'https://plain.example/art.png',
      positionMs: 25_000,
      durationMs: 100_000,
    });
    await service.toggleFavorite?.({
      sourceId: 'src2',
      itemKey: 'm:src2:9',
      kind: 'movie',
      title: 'Other Film',
      logo: 'https://plain.example/art.png',
    });

    expect((await service.removeSource('src1')).ok).toBe(true);
    expect(await service.getProgress?.(film?.key ?? '')).toBeNull();
    expect((await service.listContinueWatching?.(10))?.map((r) => r.itemKey)).toEqual(['m:src2:9']);
    expect((await service.listFavorites?.(10))?.map((r) => r.itemKey)).toEqual(['m:src2:9']);
    expect((await service.listFavorites?.(10))?.[0]?.logo).toBe('https://plain.example/art.png');

    expect((await service.setWatched?.('m:src2:9', true))?.ok).toBe(true);
    expect((await service.clearProgress?.('m:src2:9'))?.ok).toBe(true);
    expect(await service.getProgress?.('m:src2:9')).toBeNull();
  });

  it('does not merge unrelated items when series_key is empty or whitespace in saveWatchProgress or legacy rows', async () => {
    const { db } = await setupDb();
    const r1 = await saveWatchProgress(
      db,
      {
        sourceId: 's1',
        itemKey: 'x:s1:movie:1',
        kind: 'movie',
        title: 'Blank Series 1',
        seriesKey: '',
        positionMs: 25_000,
        durationMs: 100_000,
      },
      () => 1_000,
    );
    const r2 = await saveWatchProgress(
      db,
      {
        sourceId: 's1',
        itemKey: 'x:s1:movie:2',
        kind: 'movie',
        title: 'Blank Series 2',
        seriesKey: '   ',
        positionMs: 30_000,
        durationMs: 100_000,
      },
      () => 2_000,
    );
    expect(r1.ok && r1.value.seriesKey).toBeNull();
    expect(r2.ok && r2.value.seriesKey).toBeNull();

    // Also insert two legacy raw SQLite rows with literal empty-string series_key = ''
    await db.run(
      `INSERT INTO watch_progress
       (profile_id, source_id, item_key, kind, title, subtitle, logo, series_key, season, episode, position_ms, duration_ms, watched, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, '', NULL, NULL, ?, ?, 0, ?)`,
      ['default', 's1', 'x:s1:movie:legacy1', 'movie', 'Legacy 1', 20_000, 100_000, 3_000],
    );
    await db.run(
      `INSERT INTO watch_progress
       (profile_id, source_id, item_key, kind, title, subtitle, logo, series_key, season, episode, position_ms, duration_ms, watched, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, '', NULL, NULL, ?, ?, 0, ?)`,
      ['default', 's1', 'x:s1:movie:legacy2', 'movie', 'Legacy 2', 20_000, 100_000, 4_000],
    );

    const cw = await listContinueWatching(db, 10);
    expect(cw.map((r) => r.itemKey)).toEqual([
      'x:s1:movie:legacy2',
      'x:s1:movie:legacy1',
      'x:s1:movie:2',
      'x:s1:movie:1',
    ]);
  });
});
