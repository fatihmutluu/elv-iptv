import type { SqlDriver, SqlValue } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EPG_SLICE_LIMIT,
  MAX_EPG_SLICE_LIMIT,
  queryCrossChannelEpgSlice,
} from './guide-queries';
import { openCatalog } from './migrate';
import { testDb } from './test-db';

const HOUR = 3_600_000;
const BASE = 1_700_000_000_000;

async function seedSource(db: SqlDriver, id: string): Promise<void> {
  await db.run(
    'INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES (?, ?, ?, ?, ?)',
    [id, 'xtream', `Source ${id}`, 100, '{}'],
  );
}

describe('queryCrossChannelEpgSlice (#113)', () => {
  it('returns programmes across all channels overlapping [fromMs, toMs), ordered by start ASC, guide_id ASC, using idx_programmes_source_start_stop', async () => {
    const { db, close } = testDb();
    try {
      await openCatalog(db);
      await seedSource(db, '0');
      await seedSource(db, 's2');

      await db.batch(
        `INSERT INTO programmes
          (source_id, guide_id, start, stop, title, sub_title, description, episode_num, icon, run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          // Ends exactly at BASE -> excluded
          ['0', 'g-a', BASE - HOUR, BASE, 'Ended At Boundary', null, null, null, null],
          // Overlaps left edge
          [
            '0',
            'g-b',
            BASE - 0.5 * HOUR,
            BASE + 0.5 * HOUR,
            'Overlap Left B',
            'Sub B',
            'Desc B',
            'S01E01',
            'http://img/b.png',
          ],
          // Same start as Overlap Left B but earlier guide_id -> sorts before g-b
          [
            '0',
            'g-a',
            BASE - 0.5 * HOUR,
            BASE + 0.5 * HOUR,
            'Overlap Left A',
            null,
            null,
            null,
            null,
          ],
          // Contained inside
          ['0', 'g-c', BASE + HOUR, BASE + 2 * HOUR, 'Mid Show', null, null, null, null],
          // Overlaps right edge
          ['0', 'g-a', BASE + 2.5 * HOUR, BASE + 4 * HOUR, 'Overlap Right', null, null, null, null],
          // Starts exactly at BASE + 3*HOUR -> excluded
          [
            '0',
            'g-a',
            BASE + 3 * HOUR,
            BASE + 4 * HOUR,
            'Starts At Boundary',
            null,
            null,
            null,
            null,
          ],
          // Different source -> excluded
          ['s2', 'g-a', BASE, BASE + HOUR, 'Other Source Show', null, null, null, null],
        ],
      );

      // Invalid inputs run zero SQL queries
      const captured: { sql: string; params: readonly SqlValue[] | undefined }[] = [];
      const spy: SqlDriver = {
        ...db,
        all: <T>(sql: string, params?: readonly SqlValue[]) => {
          captured.push({ sql, params });
          return db.all<T>(sql, params);
        },
      };

      expect(await queryCrossChannelEpgSlice(spy, '', BASE, BASE + HOUR)).toEqual([]);
      expect(await queryCrossChannelEpgSlice(spy, '0', BASE, BASE)).toEqual([]);
      expect(await queryCrossChannelEpgSlice(spy, '0', BASE + HOUR, BASE)).toEqual([]);
      expect(await queryCrossChannelEpgSlice(spy, '0', -1, BASE + HOUR)).toEqual([]);
      expect(await queryCrossChannelEpgSlice(spy, '0', Number.NaN, BASE + HOUR)).toEqual([]);
      expect(await queryCrossChannelEpgSlice(spy, '0', BASE, BASE + HOUR, 0)).toEqual([]);
      expect(captured).toHaveLength(0);

      const rows = await queryCrossChannelEpgSlice(spy, '0', BASE, BASE + 3 * HOUR);
      expect(rows.map((r) => `${r.guideId}:${r.title}`)).toEqual([
        'g-a:Overlap Left A',
        'g-b:Overlap Left B',
        'g-c:Mid Show',
        'g-a:Overlap Right',
      ]);
      expect(rows[1]).toEqual({
        sourceId: '0',
        guideId: 'g-b',
        start: BASE - 0.5 * HOUR,
        stop: BASE + 0.5 * HOUR,
        title: 'Overlap Left B',
        subTitle: 'Sub B',
        description: 'Desc B',
        episodeNum: 'S01E01',
        icon: 'http://img/b.png',
      });

      // Verify EXPLAIN QUERY PLAN uses idx_programmes_source_start_stop and never full-table SCANs programmes
      expect(captured).toHaveLength(1);
      const plan = await db.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${captured[0]?.sql ?? ''}`,
        captured[0]?.params,
      );
      const planText = plan.map((r) => r.detail).join('\n');
      expect(planText).toContain('idx_programmes_source_start_stop');
      expect(planText).not.toMatch(/\bSCAN programmes\b/i);

      // Respects explicit limit
      const limited = await queryCrossChannelEpgSlice(db, '0', BASE, BASE + 3 * HOUR, 2);
      expect(limited).toHaveLength(2);
    } finally {
      close();
    }
  });

  it('caps default and max limits and executes cross-channel slice over 20,000 programmes in < 15ms', async () => {
    expect(DEFAULT_EPG_SLICE_LIMIT).toBe(200);
    expect(MAX_EPG_SLICE_LIMIT).toBe(500);

    const { db, close } = testDb();
    try {
      await openCatalog(db);
      await seedSource(db, 's1');

      const CHANNELS = 600;
      const SLOTS = 35; // 21,000 programmes
      const SLOT_MS = 2 * HOUR;
      const chunk: [string, string, number, number, string][] = [];
      for (let ch = 0; ch < CHANNELS; ch += 1) {
        for (let slot = 0; slot < SLOTS; slot += 1) {
          const start = BASE + slot * SLOT_MS;
          chunk.push([
            's1',
            `g-${String(ch).padStart(4, '0')}`,
            start,
            start + SLOT_MS,
            `Show ${ch}-${slot}`,
          ]);
          if (chunk.length === 5_000) {
            await db.batch(
              'INSERT INTO programmes (source_id, guide_id, start, stop, title, run_id) VALUES (?, ?, ?, ?, ?, 1)',
              chunk,
            );
            chunk.length = 0;
          }
        }
      }
      if (chunk.length > 0) {
        await db.batch(
          'INSERT INTO programmes (source_id, guide_id, start, stop, title, run_id) VALUES (?, ?, ?, ?, ?, 1)',
          chunk,
        );
      }

      const probe = BASE + 15 * SLOT_MS;
      // Warm SQLite page cache once before measuring index-backed slice latency under parallel workers
      await queryCrossChannelEpgSlice(db, 's1', probe, probe + SLOT_MS);
      const t0 = performance.now();
      const defaultSlice = await queryCrossChannelEpgSlice(db, 's1', probe, probe + SLOT_MS);
      const elapsedMs = performance.now() - t0;

      expect(defaultSlice).toHaveLength(DEFAULT_EPG_SLICE_LIMIT);
      expect(elapsedMs).toBeLessThan(25);

      const maxSlice = await queryCrossChannelEpgSlice(db, 's1', probe, probe + SLOT_MS, 9_999);
      expect(maxSlice).toHaveLength(MAX_EPG_SLICE_LIMIT);
    } finally {
      close();
    }
  });
});
