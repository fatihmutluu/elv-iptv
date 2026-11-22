import type { SqlDriver } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { openCatalog } from './migrate';
import {
  queryAllSourcesItems,
  queryAllSourcesItemsByCursor,
  type SourceNameCursor,
} from './queries';
import { testDb } from './test-db';

async function seedSource(
  db: SqlDriver,
  id: string,
  createdAt: number,
  deleting = 0,
): Promise<void> {
  await db.run(
    'INSERT INTO sources (id, kind, name, created_at, settings_json, deleting) VALUES (?, ?, ?, ?, ?, ?)',
    [id, 'xtream', `Source ${id}`, createdAt, '{}', deleting],
  );
}

describe('queryAllSourcesItems multi-source fair browse quotas (#193)', () => {
  it('allocates fair per-source quotas with remainder redistribution when smaller sources exhaust early', async () => {
    const { db, close } = testDb();
    try {
      await openCatalog(db);
      await seedSource(db, 'big', 100);
      await seedSource(db, 'tiny', 200);
      await seedSource(db, 'med', 300);
      await seedSource(db, 'gone', 400, 1);

      await db.transaction(async (tx) => {
        const rows: [string, string, string, string, number, number][] = [];
        for (let i = 0; i < 120; i += 1) {
          const pad = String(i).padStart(3, '0');
          rows.push(['big', `x:big:movie:${i}`, `Big ${pad}`, `big ${pad}`, 0, 1]);
        }
        // Hidden items on tiny must not count toward quota
        rows.push(['tiny', 'x:tiny:movie:h', 'Tiny Hidden', 'tiny hidden', 1, 1]);
        rows.push(['tiny', 'x:tiny:movie:0', 'Tiny 000', 'tiny 000', 0, 1]);
        rows.push(['tiny', 'x:tiny:movie:1', 'Tiny 001', 'tiny 001', 0, 1]);
        for (let i = 0; i < 40; i += 1) {
          const pad = String(i).padStart(3, '0');
          rows.push(['med', `x:med:movie:${i}`, `Med ${pad}`, `med ${pad}`, 0, 1]);
        }
        // Items on deleting=1 source must be excluded
        rows.push(['gone', 'x:gone:movie:0', 'Deleting 000', 'deleting 000', 0, 1]);
        await tx.batch(
          'INSERT INTO movies (source_id, key, name, name_fold, is_hidden, run_id) VALUES (?, ?, ?, ?, ?, ?)',
          rows,
        );
      });

      // Limit 10 across big(120), tiny(2), med(40) -> tiny gets 2, remainder redistributed fairly: big=4, med=4
      const page1 = await queryAllSourcesItems(db, 'movie', 0, 10);
      expect(page1).toHaveLength(10);
      expect(page1.filter((r) => r.sourceId === 'big')).toHaveLength(4);
      expect(page1.filter((r) => r.sourceId === 'tiny')).toHaveLength(2);
      expect(page1.filter((r) => r.sourceId === 'med')).toHaveLength(4);
      expect(page1.some((r) => r.sourceId === 'gone')).toBe(false);
      expect(page1.some((r) => r.key === 'x:tiny:movie:h')).toBe(false);

      // Pagination across pages has zero duplicates and zero gaps and matches full slice
      const pA = await queryAllSourcesItems(db, 'movie', 0, 5);
      const pB = await queryAllSourcesItems(db, 'movie', 5, 5);
      const pC = await queryAllSourcesItems(db, 'movie', 10, 10);
      expect([...pA, ...pB].map((r) => r.key)).toEqual(page1.map((r) => r.key));
      expect(pC).toHaveLength(10);
      expect(pC.filter((r) => r.sourceId === 'big')).toHaveLength(5);
      expect(pC.filter((r) => r.sourceId === 'med')).toHaveLength(5);
      const combinedKeys = new Set([...page1, ...pC].map((r) => r.key));
      expect(combinedKeys.size).toBe(20);
    } finally {
      close();
    }
  });

  it('handles empty DB, limit=0, single source, sourceIds filter, exhausted offsets, and live/series kinds', async () => {
    const { db, close } = testDb();
    try {
      await openCatalog(db);
      expect(await queryAllSourcesItems(db, 'live', 0, 10)).toEqual([]);
      expect(await queryAllSourcesItems(db, 'live', 0, 0)).toEqual([]);

      await seedSource(db, 's1', 100);
      await seedSource(db, 's2', 200);
      await db.run(
        `INSERT INTO live (source_id, key, num, name, name_fold, logo, is_hidden, run_id) VALUES
           ('s1', 'x:s1:live:1', 1, 'Alpha TV', 'alpha tv', 'http://img/a.png', 0, 1),
           ('s1', 'x:s1:live:2', 2, 'Beta TV', 'beta tv', NULL, 1, 1),
           ('s2', 'x:s2:live:1', 10, 'Gamma TV', 'gamma tv', NULL, 0, 1)`,
      );
      await db.run(
        `INSERT INTO series (source_id, key, name, name_fold, cover, rating, year, is_hidden, run_id) VALUES
           ('s1', 'x:s1:series:1', 'Show A', 'show a', 'http://img/sa.png', 8.5, 2025, 0, 1),
           ('s2', 'x:s2:series:1', 'Show B', 'show b', NULL, 7.9, 2024, 0, 1)`,
      );

      // Single-source via sourceIds
      const onlyS1 = await queryAllSourcesItems(db, 'live', 0, 10, ['s1', 's1', 'missing']);
      expect(onlyS1.map((r) => r.key)).toEqual(['x:s1:live:1']);
      expect(onlyS1[0]).toMatchObject({ kind: 'live', num: 1, logo: 'http://img/a.png' });

      // Empty sourceIds yields empty
      expect(await queryAllSourcesItems(db, 'live', 0, 10, [])).toEqual([]);

      // Offset beyond total items yields empty
      expect(await queryAllSourcesItems(db, 'live', 50, 10)).toEqual([]);

      // Series kind maps cover -> logo, rating, year
      const allSeries = await queryAllSourcesItems(db, 'series', 0, 10);
      expect(allSeries.map((r) => r.key)).toEqual(['x:s1:series:1', 'x:s2:series:1']);
      expect(allSeries[0]).toMatchObject({
        kind: 'series',
        logo: 'http://img/sa.png',
        rating: 8.5,
        year: 2025,
      });
    } finally {
      close();
    }
  });

  it('queryAllSourcesItemsByCursor paginates fairly across sources with zero skipped or duplicated items under concurrent mutations (#176)', async () => {
    const { db, close } = testDb();
    try {
      await openCatalog(db);
      expect(await queryAllSourcesItemsByCursor(db, 'movie', {}, 10)).toEqual({
        items: [],
        nextCursors: {},
        hasMore: false,
      });

      await seedSource(db, 'big', 100);
      await seedSource(db, 'tiny', 200);
      await seedSource(db, 'med', 300);
      await seedSource(db, 'gone', 400, 1);

      await db.transaction(async (tx) => {
        const rows: [string, string, string, string, number, number][] = [];
        for (let i = 0; i < 10; i += 1) {
          const pad = String(i).padStart(2, '0');
          rows.push(['big', `x:big:movie:${i}`, `Big ${pad}`, `big ${pad}`, 0, 1]);
        }
        // Two tiny rows with IDENTICAL name_fold to verify id ASC tie-breaking!
        rows.push(['tiny', 'x:tiny:movie:h', 'Tiny Hidden', 'tiny hidden', 1, 1]);
        rows.push(['tiny', 'x:tiny:movie:0', 'Tiny Same', 'tiny same', 0, 1]);
        rows.push(['tiny', 'x:tiny:movie:1', 'Tiny Same', 'tiny same', 0, 1]);
        for (let i = 0; i < 6; i += 1) {
          const pad = String(i).padStart(2, '0');
          rows.push(['med', `x:med:movie:${i}`, `Med ${pad}`, `med ${pad}`, 0, 1]);
        }
        rows.push(['gone', 'x:gone:movie:0', 'Deleting', 'deleting', 0, 1]);
        await tx.batch(
          'INSERT INTO movies (source_id, key, name, name_fold, is_hidden, run_id) VALUES (?, ?, ?, ?, ?, ?)',
          rows,
        );
      });

      expect(await queryAllSourcesItemsByCursor(db, 'movie', {}, 0)).toEqual({
        items: [],
        nextCursors: {},
        hasMore: false,
      });

      // Page 1 (limit 6): big=2, tiny=2, med=2
      const p1 = await queryAllSourcesItemsByCursor(db, 'movie', {}, 6);
      expect(p1.items).toHaveLength(6);
      expect(p1.hasMore).toBe(true);
      expect(p1.items.filter((r) => r.sourceId === 'big').map((r) => r.key)).toEqual([
        'x:big:movie:0',
        'x:big:movie:1',
      ]);
      expect(p1.items.filter((r) => r.sourceId === 'tiny').map((r) => r.key)).toEqual([
        'x:tiny:movie:0',
        'x:tiny:movie:1',
      ]);
      expect(p1.items.filter((r) => r.sourceId === 'med').map((r) => r.key)).toEqual([
        'x:med:movie:0',
        'x:med:movie:1',
      ]);
      expect(p1.nextCursors.big?.nameFold).toBe('big 01');
      expect(p1.nextCursors.tiny?.nameFold).toBe('tiny same');
      expect(p1.nextCursors.med?.nameFold).toBe('med 01');

      // Concurrent mutation before cursors: insert earlier rows and delete consumed rows!
      await db.run(
        "INSERT INTO movies (source_id, key, name, name_fold, is_hidden, run_id) VALUES ('big', 'x:big:movie:aaa', 'AAA Early', 'aaa early', 0, 1)",
      );
      await db.run("DELETE FROM movies WHERE key = 'x:med:movie:0'");

      // Walk all remaining pages using cursors -> zero duplicates, zero skips among remaining items!
      let cursors: Record<string, SourceNameCursor> = p1.nextCursors;
      let hasMore = p1.hasMore;
      const seen = new Set(p1.items.map((r) => r.key));
      const collectedAfterP1: string[] = [];
      while (hasMore) {
        const page = await queryAllSourcesItemsByCursor(db, 'movie', cursors, 5);
        for (const item of page.items) {
          expect(seen.has(item.key)).toBe(false);
          seen.add(item.key);
          collectedAfterP1.push(item.key);
        }
        cursors = page.nextCursors;
        hasMore = page.hasMore;
      }
      // Remaining after p1: big 2..9 (8 items) + med 2..5 (4 items) = 12 items, tiny exhausted!
      expect(collectedAfterP1).toHaveLength(12);
      expect(collectedAfterP1).not.toContain('x:big:movie:aaa');
      expect(collectedAfterP1).toContain('x:big:movie:2');
      expect(collectedAfterP1).toContain('x:med:movie:2');

      // Single-source cursor path via sourceIds filter + tie-breaking on equal name_fold
      const single1 = await queryAllSourcesItemsByCursor(db, 'movie', {}, 1, ['tiny']);
      expect(single1.items.map((r) => r.key)).toEqual(['x:tiny:movie:0']);
      expect(single1.hasMore).toBe(true);
      const single2 = await queryAllSourcesItemsByCursor(db, 'movie', single1.nextCursors, 1, [
        'tiny',
      ]);
      expect(single2.items.map((r) => r.key)).toEqual(['x:tiny:movie:1']);
      expect(single2.hasMore).toBe(false);
    } finally {
      close();
    }
  });
});
