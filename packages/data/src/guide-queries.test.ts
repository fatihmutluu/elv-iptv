import type { SqlDriver, SqlValue } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import {
  bucketProgrammesByLocalDay,
  localDayKey,
  MAX_EPG_WINDOW_KEYS,
  MAX_EPG_WINDOW_SPAN_MS,
  MAX_NOW_NEXT_KEYS,
  queryChannelByNumber,
  queryEpgWindow,
  queryNowNext,
} from './guide-queries';
import { openCatalog } from './migrate';
import { testDb } from './test-db';

const HOUR = 3_600_000;
const BASE = 1_700_000_000_000;

async function seedSource(db: SqlDriver, id: string, createdAt = 1_000): Promise<void> {
  await db.run(
    'INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES (?, ?, ?, ?, ?)',
    [id, 'xtream', `Source ${id}`, createdAt, '{}'],
  );
}

async function seedLive(
  db: SqlDriver,
  rows: readonly (readonly [
    sourceId: string,
    key: string,
    providerId: string,
    num: number | null,
    name: string,
    logo: string | null,
  ])[],
): Promise<void> {
  await db.batch(
    `INSERT INTO live (source_id, key, provider_id, num, name, name_fold, logo, run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    rows.map(([sourceId, key, providerId, num, name, logo]) => [
      sourceId,
      key,
      providerId,
      num,
      name,
      name.toLowerCase(),
      logo,
    ]),
  );
}

async function seedGuideMap(
  db: SqlDriver,
  rows: readonly (readonly [sourceId: string, channelKey: string, guideId: string])[],
): Promise<void> {
  await db.batch(
    'INSERT INTO channel_guide (source_id, channel_key, guide_id) VALUES (?, ?, ?)',
    rows.map(([sourceId, channelKey, guideId]) => [sourceId, channelKey, guideId]),
  );
}

async function seedProgrammes(
  db: SqlDriver,
  rows: readonly (readonly [
    sourceId: string,
    guideId: string,
    start: number,
    stop: number,
    title: string,
    subTitle?: string | null,
    description?: string | null,
    episodeNum?: string | null,
    icon?: string | null,
  ])[],
): Promise<void> {
  await db.batch(
    `INSERT INTO programmes
      (source_id, guide_id, start, stop, title, sub_title, description, episode_num, icon, run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    rows.map(([sourceId, guideId, start, stop, title, subTitle, desc, epNum, icon]) => [
      sourceId,
      guideId,
      start,
      stop,
      title,
      subTitle ?? null,
      desc ?? null,
      epNum ?? null,
      icon ?? null,
    ]),
  );
}

function spyQueries(db: SqlDriver): { db: SqlDriver; queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    db: {
      ...db,
      all: <T>(sql: string, params?: readonly SqlValue[]) => {
        queries.push(sql);
        return db.all<T>(sql, params);
      },
    },
  };
}

describe('guide-queries', () => {
  describe('queryNowNext', () => {
    it('returns active now + upcoming next, handles gaps, boundaries, and shared guide_ids across sources', async () => {
      const h = testDb();
      await openCatalog(h.db);
      await seedSource(h.db, 's1', 100);
      await seedSource(h.db, 's2', 200);
      await seedGuideMap(h.db, [
        ['s1', 'x:s1:live:1', 'g-cinema'],
        ['s1', 'x:s1:live:2', 'g-cinema'],
        ['s1', 'x:s1:live:3', 'g-gap'],
        ['s1', 'x:s1:live:4', 'g-empty'],
        ['s2', 'm:s2:live:10', 'g-news'],
      ]);
      await seedProgrammes(h.db, [
        // Ended right at BASE (not active)
        ['s1', 'g-cinema', BASE - HOUR, BASE, 'Finished Film'],
        // Active at BASE (start === BASE)
        [
          's1',
          'g-cinema',
          BASE,
          BASE + HOUR,
          'Evening Feature',
          'Director Cut',
          'A coastal mystery.',
          'S01E02',
          'http://img.example/1.png',
        ],
        // Next starts right when current stops
        ['s1', 'g-cinema', BASE + HOUR, BASE + 2 * HOUR, 'Late Feature'],
        ['s1', 'g-cinema', BASE + 2 * HOUR, BASE + 3 * HOUR, 'After Hours'],
        // Gap at BASE, next starts 30m later
        ['s1', 'g-gap', BASE - 2 * HOUR, BASE - HOUR, 'Old Show'],
        ['s1', 'g-gap', BASE + 0.5 * HOUR, BASE + 1.5 * HOUR, 'Upcoming Show'],
        // Second source active + next
        ['s2', 'g-news', BASE - 0.5 * HOUR, BASE + 0.5 * HOUR, 'World Brief'],
        ['s2', 'g-news', BASE + 0.5 * HOUR, BASE + 1.5 * HOUR, 'Market Hour'],
      ]);

      const entries = await queryNowNext(
        h.db,
        [
          'x:s1:live:1',
          'x:s1:live:2',
          'x:s1:live:3',
          'x:s1:live:4',
          'm:s2:live:10',
          'x:s1:live:unmapped',
        ],
        BASE,
      );

      expect(entries.map((e) => e.channelKey)).toEqual([
        'x:s1:live:1',
        'x:s1:live:2',
        'x:s1:live:3',
        'x:s1:live:4',
        'm:s2:live:10',
      ]);

      expect(entries[0]).toEqual({
        channelKey: 'x:s1:live:1',
        now: {
          channelKey: 'x:s1:live:1',
          sourceId: 's1',
          guideId: 'g-cinema',
          start: BASE,
          stop: BASE + HOUR,
          title: 'Evening Feature',
          subTitle: 'Director Cut',
          description: 'A coastal mystery.',
          episodeNum: 'S01E02',
          icon: 'http://img.example/1.png',
        },
        next: {
          channelKey: 'x:s1:live:1',
          sourceId: 's1',
          guideId: 'g-cinema',
          start: BASE + HOUR,
          stop: BASE + 2 * HOUR,
          title: 'Late Feature',
          subTitle: null,
          description: null,
          episodeNum: null,
          icon: null,
        },
      });
      // Shared guide_id maps cleanly onto second channel with its own channelKey
      expect(entries[1]?.now?.channelKey).toBe('x:s1:live:2');
      expect(entries[1]?.now?.title).toBe('Evening Feature');
      expect(entries[1]?.next?.title).toBe('Late Feature');
      // Gap between shows
      expect(entries[2]).toMatchObject({
        channelKey: 'x:s1:live:3',
        now: null,
        next: { title: 'Upcoming Show', start: BASE + 0.5 * HOUR },
      });
      // Mapped channel with no programmes in window
      expect(entries[3]).toEqual({ channelKey: 'x:s1:live:4', now: null, next: null });
      // Second source
      expect(entries[4]).toMatchObject({
        channelKey: 'm:s2:live:10',
        now: { title: 'World Brief' },
        next: { title: 'Market Hour' },
      });

      h.close();
    });

    it('issues zero queries for empty/invalid keys and deduplicates + clamps to MAX_NOW_NEXT_KEYS', async () => {
      const h = testDb();
      await openCatalog(h.db);
      const spied = spyQueries(h.db);

      expect(await queryNowNext(spied.db, [], BASE)).toEqual([]);
      expect(await queryNowNext(spied.db, ['bad', '', 'x:', 'z:s1:1'], BASE)).toEqual([]);
      expect(await queryNowNext(spied.db, ['x:s1:live:1'], Number.NaN)).toEqual([]);
      expect(spied.queries).toHaveLength(0);

      await seedSource(h.db, 's1');
      const total = MAX_NOW_NEXT_KEYS + 15;
      await seedGuideMap(
        h.db,
        Array.from({ length: total }, (_, i) => ['s1', `x:s1:live:${i}`, `g-${i}`] as const),
      );
      await seedProgrammes(
        h.db,
        Array.from(
          { length: total },
          (_, i) => ['s1', `g-${i}`, BASE, BASE + HOUR, `Show ${i}`] as const,
        ),
      );

      const keysWithDupes = [
        'x:s1:live:0',
        'x:s1:live:0',
        ...Array.from({ length: total }, (_, i) => `x:s1:live:${i}`),
      ];
      const res = await queryNowNext(h.db, keysWithDupes, BASE + 1000);
      expect(res).toHaveLength(MAX_NOW_NEXT_KEYS);
      expect(res[0]?.channelKey).toBe('x:s1:live:0');
      expect(res.at(-1)?.channelKey).toBe(`x:s1:live:${MAX_NOW_NEXT_KEYS - 1}`);

      h.close();
    });
  });

  describe('queryEpgWindow', () => {
    it('returns overlapping programmes at both window edges ordered by start and handles shared guide_ids', async () => {
      const h = testDb();
      await openCatalog(h.db);
      await seedSource(h.db, 's1');
      await seedGuideMap(h.db, [
        ['s1', 'x:s1:live:1', 'g-shared'],
        ['s1', 'x:s1:live:2', 'g-shared'],
      ]);
      const fromMs = BASE;
      const toMs = BASE + 3 * HOUR;
      await seedProgrammes(h.db, [
        // Ends exactly at fromMs -> excluded
        ['s1', 'g-shared', BASE - HOUR, BASE, 'Before'],
        // Starts before fromMs, ends inside window -> included
        ['s1', 'g-shared', BASE - 0.5 * HOUR, BASE + 0.5 * HOUR, 'Overlap Left'],
        // Completely inside
        ['s1', 'g-shared', BASE + 0.5 * HOUR, BASE + 2 * HOUR, 'Middle'],
        // Starts inside, ends after toMs -> included
        ['s1', 'g-shared', BASE + 2.5 * HOUR, BASE + 4 * HOUR, 'Overlap Right'],
        // Starts exactly at toMs -> excluded
        ['s1', 'g-shared', BASE + 3 * HOUR, BASE + 4 * HOUR, 'After'],
      ]);

      const win = await queryEpgWindow(h.db, ['x:s1:live:1', 'x:s1:live:2'], fromMs, toMs);
      expect(win['x:s1:live:1']?.map((p) => p.title)).toEqual([
        'Overlap Left',
        'Middle',
        'Overlap Right',
      ]);
      expect(win['x:s1:live:2']?.map((p) => p.title)).toEqual([
        'Overlap Left',
        'Middle',
        'Overlap Right',
      ]);
      expect(win['x:s1:live:2']?.every((p) => p.channelKey === 'x:s1:live:2')).toBe(true);
      h.close();
    });

    it('clamps > MAX_EPG_WINDOW_KEYS and > MAX_EPG_WINDOW_SPAN_MS and skips queries on invalid input', async () => {
      const h = testDb();
      await openCatalog(h.db);
      const spied = spyQueries(h.db);

      expect(await queryEpgWindow(spied.db, [], BASE, BASE + HOUR)).toEqual({});
      expect(await queryEpgWindow(spied.db, ['invalid'], BASE, BASE + HOUR)).toEqual({});
      expect(await queryEpgWindow(spied.db, ['x:s1:live:1'], BASE, BASE)).toEqual({});
      expect(await queryEpgWindow(spied.db, ['x:s1:live:1'], BASE + HOUR, BASE)).toEqual({});
      expect(await queryEpgWindow(spied.db, ['x:s1:live:1'], -1, BASE)).toEqual({});
      expect(spied.queries).toHaveLength(0);

      await seedSource(h.db, 's1');
      const total = MAX_EPG_WINDOW_KEYS + 10;
      await seedGuideMap(
        h.db,
        Array.from({ length: total }, (_, i) => ['s1', `x:s1:live:${i}`, `g-${i}`] as const),
      );
      await seedProgrammes(h.db, [
        ...Array.from(
          { length: total },
          (_, i) => ['s1', `g-${i}`, BASE, BASE + HOUR, `Slot 0 Ch ${i}`] as const,
        ),
        // Beyond 48h cap
        [
          's1',
          'g-0',
          BASE + MAX_EPG_WINDOW_SPAN_MS + HOUR,
          BASE + MAX_EPG_WINDOW_SPAN_MS + 2 * HOUR,
          'Beyond 48h',
        ],
      ]);

      const keys = Array.from({ length: total }, (_, i) => `x:s1:live:${i}`);
      const win = await queryEpgWindow(h.db, keys, BASE, BASE + MAX_EPG_WINDOW_SPAN_MS + 24 * HOUR);
      expect(Object.keys(win)).toHaveLength(MAX_EPG_WINDOW_KEYS);
      expect(win['x:s1:live:0']?.map((p) => p.title)).toEqual(['Slot 0 Ch 0']);
      expect(win[`x:s1:live:${MAX_EPG_WINDOW_KEYS}`]).toBeUndefined();

      h.close();
    });
  });

  describe('queryChannelByNumber & query plans', () => {
    it('finds channel by number with and without sourceId and rejects invalid numbers with zero queries', async () => {
      const h = testDb();
      await openCatalog(h.db);
      await seedSource(h.db, 's1', 100);
      await seedSource(h.db, 's2', 200);
      await seedLive(h.db, [
        ['s1', 'x:s1:live:10', '10', 101, 'Channel 101 S1', 'http://img/101.png'],
        ['s2', 'x:s2:live:20', '20', 101, 'Channel 101 S2', null],
        ['s2', 'x:s2:live:21', '21', 205, 'Channel 205 S2', null],
      ]);

      const spied = spyQueries(h.db);
      expect(await queryChannelByNumber(spied.db, -1)).toBeUndefined();
      expect(await queryChannelByNumber(spied.db, 1.5)).toBeUndefined();
      expect(await queryChannelByNumber(spied.db, Number.NaN)).toBeUndefined();
      expect(spied.queries).toHaveLength(0);

      expect(await queryChannelByNumber(h.db, 101, 's2')).toMatchObject({
        key: 'x:s2:live:20',
        sourceId: 's2',
        num: 101,
        kind: 'live',
      });
      expect(await queryChannelByNumber(h.db, 101)).toMatchObject({
        key: 'x:s1:live:10',
        sourceId: 's1',
        num: 101,
      });
      expect(await queryChannelByNumber(h.db, 205)).toMatchObject({
        key: 'x:s2:live:21',
        sourceId: 's2',
        num: 205,
      });
      expect(await queryChannelByNumber(h.db, 999)).toBeUndefined();

      // Verify EXPLAIN QUERY PLAN uses idx_live_num & PKs with zero full-table SCANs
      const livePlan = await h.db.all<{ detail: string }>(
        'EXPLAIN QUERY PLAN SELECT id, key, source_id, provider_id, name, logo, num FROM live WHERE source_id = ? AND num = ? ORDER BY id LIMIT 1',
        ['s1', 101],
      );
      const liveDetail = livePlan.map((r) => r.detail).join('\n');
      expect(liveDetail).toContain('SEARCH live USING INDEX idx_live_num');
      expect(liveDetail).not.toMatch(/\bSCAN live\b/);

      const guidePlan = await h.db.all<{ detail: string }>(
        'EXPLAIN QUERY PLAN SELECT channel_key, guide_id FROM channel_guide WHERE source_id = ? AND channel_key IN (?, ?)',
        ['s1', 'x:s1:live:10', 'x:s1:live:11'],
      );
      const guideDetail = guidePlan.map((r) => r.detail).join('\n');
      expect(guideDetail).toContain('SEARCH channel_guide USING PRIMARY KEY');
      expect(guideDetail).not.toMatch(/\bSCAN channel_guide\b/);

      const progPlan = await h.db.all<{ detail: string }>(
        'EXPLAIN QUERY PLAN SELECT guide_id, start, stop, title, sub_title, description, episode_num, icon FROM programmes WHERE source_id = ? AND guide_id IN (?, ?) AND start < ? AND stop > ? ORDER BY guide_id, start',
        ['s1', 'g-1', 'g-2', BASE + 3 * HOUR, BASE],
      );
      const progDetail = progPlan.map((r) => r.detail).join('\n');
      expect(progDetail).toContain('SEARCH programmes USING PRIMARY KEY');
      expect(progDetail).not.toMatch(/\bSCAN programmes\b/);

      h.close();
    });
  });

  describe('1,000-channel x 7-day EPG performance', () => {
    it('runs queryEpgWindow (20 ch x 3h) and queryNowNext (30 ch) in < 15ms each', async () => {
      const h = testDb();
      await openCatalog(h.db);
      await seedSource(h.db, 's1');

      const CHANNELS = 1_000;
      const SLOTS_PER_CHANNEL = 35; // 7 days x 5 programmes/day = 35,000 programmes
      const SLOT_MS = Math.floor((7 * 24 * HOUR) / SLOTS_PER_CHANNEL); // ~4.8h slots

      await seedLive(
        h.db,
        Array.from(
          { length: CHANNELS },
          (_, i) => ['s1', `x:s1:live:${i}`, String(i), i + 1, `Channel ${i + 1}`, null] as const,
        ),
      );
      await seedGuideMap(
        h.db,
        Array.from({ length: CHANNELS }, (_, i) => ['s1', `x:s1:live:${i}`, `g-${i}`] as const),
      );

      // Batch insert 35,000 programmes in chunks of 5,000
      const allProgs: (readonly [string, string, number, number, string])[] = [];
      for (let ch = 0; ch < CHANNELS; ch += 1) {
        for (let slot = 0; slot < SLOTS_PER_CHANNEL; slot += 1) {
          const start = BASE + slot * SLOT_MS;
          allProgs.push(['s1', `g-${ch}`, start, start + SLOT_MS, `Ch ${ch} Slot ${slot}`]);
        }
      }
      for (let i = 0; i < allProgs.length; i += 5_000) {
        await seedProgrammes(h.db, allProgs.slice(i, i + 5_000));
      }

      const windowKeys = Array.from({ length: 20 }, (_, i) => `x:s1:live:${400 + i}`);
      const nowNextKeys = Array.from({ length: 30 }, (_, i) => `x:s1:live:${600 + i}`);
      const probeTime = BASE + 2 * 24 * HOUR + HOUR;

      // Warm up statement cache slightly and measure
      const t0 = performance.now();
      const win = await queryEpgWindow(h.db, windowKeys, probeTime, probeTime + 3 * HOUR);
      const windowMs = performance.now() - t0;

      const t1 = performance.now();
      const nn = await queryNowNext(h.db, nowNextKeys, probeTime);
      const nowNextMs = performance.now() - t1;

      const t2 = performance.now();
      const jumped = await queryChannelByNumber(h.db, 777);
      const jumpMs = performance.now() - t2;

      expect(Object.keys(win)).toHaveLength(20);
      expect(win['x:s1:live:400']?.length).toBeGreaterThanOrEqual(1);
      expect(nn).toHaveLength(30);
      expect(nn[0]?.now?.title).toMatch(/^Ch 600 Slot \d+$/);
      expect(nn[0]?.next?.title).toMatch(/^Ch 600 Slot \d+$/);
      expect(jumped?.key).toBe('x:s1:live:776');

      expect(windowMs).toBeLessThan(15);
      expect(nowNextMs).toBeLessThan(15);
      expect(jumpMs).toBeLessThan(15);

      h.close();
    });
  });

  describe('falsy "0" IDs and local-timezone day bucketing (#175)', () => {
    it('preserves source_id="0" and guide_id="0" with strict source_id isolation', async () => {
      const h = testDb();
      await openCatalog(h.db);
      await seedSource(h.db, '0', 100);
      await seedSource(h.db, '1', 200);
      await seedLive(h.db, [
        ['0', 'x:0:live:0', '0', 0, 'Zero Source Ch', null],
        ['1', 'x:1:live:0', '0', 0, 'One Source Ch', null],
      ]);
      await seedGuideMap(h.db, [
        ['0', 'x:0:live:0', '0'],
        ['1', 'x:1:live:0', '0'],
      ]);
      await seedProgrammes(h.db, [
        ['0', '0', BASE, BASE + HOUR, 'Zero Now'],
        ['0', '0', BASE + HOUR, BASE + 2 * HOUR, 'Zero Next'],
        ['1', '0', BASE, BASE + HOUR, 'One Now'],
      ]);

      const nn = await queryNowNext(h.db, ['x:0:live:0'], BASE + 1000);
      expect(nn).toHaveLength(1);
      expect(nn[0]?.now).toMatchObject({ sourceId: '0', guideId: '0', title: 'Zero Now' });
      expect(nn[0]?.next).toMatchObject({ sourceId: '0', guideId: '0', title: 'Zero Next' });

      const win = await queryEpgWindow(h.db, ['x:0:live:0'], BASE, BASE + 2 * HOUR);
      expect(win['x:0:live:0']?.map((p) => `${p.sourceId}:${p.guideId}:${p.title}`)).toEqual([
        '0:0:Zero Now',
        '0:0:Zero Next',
      ]);

      const ch = await queryChannelByNumber(h.db, 0, '0');
      expect(ch).toMatchObject({ key: 'x:0:live:0', sourceId: '0', num: 0 });

      h.close();
    });

    it('buckets programmes by local calendar day across UTC, America/New_York, and Europe/Istanbul midnight boundaries', () => {
      // 2026-11-13 22:30 UTC -> Nov 13 UTC, Nov 13 NY (17:30 EST), Nov 14 Istanbul (01:30 TRT)
      const lateUtc = Date.UTC(2026, 10, 13, 22, 30, 0);
      // 2026-11-14 02:30 UTC -> Nov 14 UTC, Nov 13 NY (21:30 EST), Nov 14 Istanbul (05:30 TRT)
      const earlyUtc = Date.UTC(2026, 10, 14, 2, 30, 0);
      // 2026-11-14 15:00 UTC -> Nov 14 everywhere
      const midDay = Date.UTC(2026, 10, 14, 15, 0, 0);

      expect(localDayKey(lateUtc, 'UTC')).toBe('2026-11-13');
      expect(localDayKey(lateUtc, 'America/New_York')).toBe('2026-11-13');
      expect(localDayKey(lateUtc, 'Europe/Istanbul')).toBe('2026-11-14');

      expect(localDayKey(earlyUtc, 'UTC')).toBe('2026-11-14');
      expect(localDayKey(earlyUtc, 'America/New_York')).toBe('2026-11-13');
      expect(localDayKey(earlyUtc, 'Europe/Istanbul')).toBe('2026-11-14');

      expect(localDayKey(Number.NaN, 'UTC')).toBe('');
      expect(localDayKey(1e20, 'UTC')).toBe('');
      expect(localDayKey(-1e20, 'America/New_York')).toBe('');
      expect(localDayKey(1e20)).toBe('');
      // Invalid timezone and omitted timezone safely fall back without throwing
      expect(localDayKey(midDay, 'Invalid/Timezone_Name')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(localDayKey(midDay)).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      const items = [
        { title: 'LateUTC', start: lateUtc },
        { title: 'EarlyUTC', start: earlyUtc },
        { title: 'MidDay', start: midDay },
        { title: 'BadTime', start: Number.NaN },
        { title: 'OverflowTime', start: 1e20 },
      ];

      const utcBuckets = bucketProgrammesByLocalDay(items, 'UTC');
      expect([...utcBuckets.keys()]).toEqual(['2026-11-13', '2026-11-14']);
      expect(utcBuckets.get('2026-11-13')?.map((p) => p.title)).toEqual(['LateUTC']);
      expect(utcBuckets.get('2026-11-14')?.map((p) => p.title)).toEqual(['EarlyUTC', 'MidDay']);

      const nyBuckets = bucketProgrammesByLocalDay(items, 'America/New_York');
      expect([...nyBuckets.keys()]).toEqual(['2026-11-13', '2026-11-14']);
      expect(nyBuckets.get('2026-11-13')?.map((p) => p.title)).toEqual(['LateUTC', 'EarlyUTC']);
      expect(nyBuckets.get('2026-11-14')?.map((p) => p.title)).toEqual(['MidDay']);

      const istBuckets = bucketProgrammesByLocalDay(items, 'Europe/Istanbul');
      expect([...istBuckets.keys()]).toEqual(['2026-11-14']);
      expect(istBuckets.get('2026-11-14')?.map((p) => p.title)).toEqual([
        'LateUTC',
        'EarlyUTC',
        'MidDay',
      ]);
    });
  });
});
