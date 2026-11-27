import type { SqlDriver } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import {
  buildCatalogImportTelemetryEvent,
  extractSafeSqlOpToken,
  SQLITE_SLOW_OP_THRESHOLD_MS,
  wrapSqlDriverWithSlowOpTelemetry,
} from './catalog-worker-telemetry.ts';

describe('catalog-worker-telemetry (#509)', () => {
  it('extracts only safe uppercase SQL verb tokens and never leaks table names or parameters', () => {
    expect(extractSafeSqlOpToken('  select * from secret_table where token = "abc"')).toBe(
      'SELECT',
    );
    expect(extractSafeSqlOpToken('/* hint */ INSERT OR REPLACE INTO items VALUES (?)')).toBe(
      'INSERT',
    );
    expect(extractSafeSqlOpToken('-- comment\nUPDATE sources SET name = ?')).toBe('UPDATE');
    expect(extractSafeSqlOpToken('DELETE FROM favourites WHERE id = ?')).toBe('DELETE');
    expect(extractSafeSqlOpToken('PRAGMA wal_checkpoint(TRUNCATE)')).toBe('PRAGMA');
    expect(extractSafeSqlOpToken('WITH cte AS (SELECT 1) SELECT * FROM cte')).toBe('WITH');
    expect(extractSafeSqlOpToken('   ')).toBe('EXEC');
    expect(extractSafeSqlOpToken('EXOTIC_SECRET_CMD https://u:p@host/x')).toBe('EXEC');
  });

  it('reports only SQL operations exceeding 250ms across all/run/exec/batch/transaction without throwing', async () => {
    let now = 1_000;
    const base: SqlDriver = {
      exec: vi.fn(async () => {
        now += 100;
      }),
      run: vi.fn(async () => {
        now += 310;
        return { changes: 1 };
      }),
      all: vi.fn(async () => {
        now += 250;
        return [];
      }),
      batch: vi.fn(async () => {
        now += 400;
      }),
      transaction: vi.fn(async (fn) => {
        const res = await fn(base);
        now += 260;
        return res;
      }),
    };

    const reported: Array<{ op: string; durationMs: number }> = [];
    const wrapped = wrapSqlDriverWithSlowOpTelemetry(
      base,
      (op, durationMs) => {
        reported.push({ op, durationMs });
      },
      { now: () => now, thresholdMs: SQLITE_SLOW_OP_THRESHOLD_MS },
    );

    await wrapped.exec('CREATE TABLE t (id INT)'); // 100ms <= 250ms -> ignored
    await wrapped.all('SELECT * FROM items WHERE title = ?', ['Secret']); // 250ms <= 250ms -> ignored
    await wrapped.run('UPDATE items SET title = ?', ['Private']); // 310ms > 250ms -> UPDATE
    await wrapped.batch('INSERT INTO items VALUES (?)', [[1], [2]]); // 400ms > 250ms -> BATCH
    await wrapped.transaction(async (tx) => {
      await tx.exec('PRAGMA optimize');
    }); // inner 100ms ignored; outer TX 360ms > 250ms -> TX

    expect(reported).toEqual([
      { op: 'UPDATE', durationMs: 310 },
      { op: 'BATCH', durationMs: 400 },
      { op: 'TX', durationMs: 360 },
    ]);
  });

  it('builds sanitized catalog_import telemetry events for catalog and guide stages', () => {
    expect(
      buildCatalogImportTelemetryEvent({
        sourceKind: 'xtream',
        stage: 'catalog',
        durationMs: 1_234.6,
        itemCount: 4_200,
        success: true,
      }),
    ).toEqual({
      kind: 'catalog_import',
      sourceKind: 'xtream',
      stage: 'catalog',
      durationMs: 1_235,
      itemCount: 4_200,
      success: true,
    });

    expect(
      buildCatalogImportTelemetryEvent({
        sourceKind: 'unexpected-kind',
        stage: 'guide',
        durationMs: -5,
        itemCount: -1,
        success: false,
        errorCode: 'http-503',
      }),
    ).toEqual({
      kind: 'catalog_import',
      sourceKind: 'unknown',
      stage: 'guide',
      durationMs: 0,
      itemCount: 0,
      success: false,
      errorCode: 'http-503',
    });

    // Rejects unsafe URL/detail strings in errorCode
    expect(
      buildCatalogImportTelemetryEvent({
        sourceKind: 'm3u',
        stage: 'catalog',
        durationMs: 500,
        itemCount: 0,
        success: false,
        errorCode: 'https://secret.example.test/playlist.m3u',
      }),
    ).toEqual({
      kind: 'catalog_import',
      sourceKind: 'm3u',
      stage: 'catalog',
      durationMs: 500,
      itemCount: 0,
      success: false,
      errorCode: 'unknown',
    });
  });
});
