import type { SqlDriver } from '@elv/domain';
import type { TelemetryRecordRequest } from '../shared/sync-ipc.ts';

/** Threshold in milliseconds above which a SQLite operation emits `sqlite_slow_op` (`#509`). */
export const SQLITE_SLOW_OP_THRESHOLD_MS = 250;

const ALLOWED_SQL_VERBS = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
  'PRAGMA',
  'CREATE',
  'DROP',
  'ALTER',
  'ATTACH',
  'DETACH',
  'VACUUM',
  'REINDEX',
  'ANALYZE',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'WITH',
]);

const SAFE_ERROR_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Extracts a safe uppercase SQL verb token (`SELECT`, `INSERT`, etc.) from a SQL string,
 * stripping leading comments/whitespace. Never leaks table names, column names, or parameters.
 */
export function extractSafeSqlOpToken(sql: string): string {
  const stripped = sql.replace(/^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/g, '');
  const match = /^([A-Za-z]+)/.exec(stripped);
  const verb = match?.[1]?.toUpperCase();
  return verb !== undefined && ALLOWED_SQL_VERBS.has(verb) ? verb : 'EXEC';
}

/** Options for {@link wrapSqlDriverWithSlowOpTelemetry}. */
export interface SlowSqlTelemetryOptions {
  readonly thresholdMs?: number;
  readonly now?: () => number;
}

/**
 * Wraps a {@link SqlDriver} so any operation whose duration strictly exceeds `thresholdMs`
 * (default 250 ms) invokes `onSlowOp(op, durationMs)` with a safe SQL verb token (`#509`).
 */
export function wrapSqlDriverWithSlowOpTelemetry(
  driver: SqlDriver,
  onSlowOp: (op: string, durationMs: number) => void,
  options?: SlowSqlTelemetryOptions,
): SqlDriver {
  const thresholdMs = options?.thresholdMs ?? SQLITE_SLOW_OP_THRESHOLD_MS;
  const now = options?.now ?? Date.now;

  const notify = (op: string, startedAt: number): void => {
    const elapsed = Math.max(0, Math.round(now() - startedAt));
    if (elapsed <= thresholdMs) return;
    try {
      onSlowOp(op, elapsed);
    } catch {
      // Telemetry callbacks must never fail SQLite operations.
    }
  };

  const wrap = (inner: SqlDriver): SqlDriver => ({
    async exec(sql) {
      const start = now();
      try {
        return await inner.exec(sql);
      } finally {
        notify(extractSafeSqlOpToken(sql), start);
      }
    },
    async run(sql, params) {
      const start = now();
      try {
        return await inner.run(sql, params);
      } finally {
        notify(extractSafeSqlOpToken(sql), start);
      }
    },
    async all<T>(sql: string, params?: readonly import('@elv/domain').SqlValue[]) {
      const start = now();
      try {
        return await inner.all<T>(sql, params);
      } finally {
        notify(extractSafeSqlOpToken(sql), start);
      }
    },
    async batch(sql, rows) {
      const start = now();
      try {
        return await inner.batch(sql, rows);
      } finally {
        notify('BATCH', start);
      }
    },
    async transaction<T>(fn: (tx: SqlDriver) => Promise<T>) {
      const start = now();
      try {
        return await inner.transaction((tx) => fn(wrap(tx)));
      } finally {
        notify('TX', start);
      }
    },
    ...(inner.close ? { close: () => inner.close?.() ?? Promise.resolve() } : {}),
  });

  return wrap(driver);
}

/** Input for {@link buildCatalogImportTelemetryEvent}. */
export interface CatalogImportTelemetryInput {
  readonly sourceKind: string | undefined;
  readonly stage: 'catalog' | 'guide';
  readonly durationMs: number;
  readonly itemCount: number;
  readonly success: boolean;
  readonly errorCode?: string | undefined;
}

/** Sums non-negative finite item counts from an `@elv/data` `ImportSummary.counts` map. */
export function sumImportCounts(counts: Readonly<Record<string, number>> | undefined): number {
  if (!counts) return 0;
  let total = 0;
  for (const val of Object.values(counts)) {
    if (typeof val === 'number' && Number.isFinite(val) && val > 0) total += Math.round(val);
  }
  return total;
}

/** Builds a strictly sanitized `catalog_import` {@link TelemetryRecordRequest} (`#509`). */
export function buildCatalogImportTelemetryEvent(
  input: CatalogImportTelemetryInput,
): TelemetryRecordRequest {
  const sourceKind =
    input.sourceKind === 'm3u' || input.sourceKind === 'xtream' || input.sourceKind === 'stalker'
      ? input.sourceKind
      : 'unknown';
  const durationMs =
    Number.isFinite(input.durationMs) && input.durationMs > 0 ? Math.round(input.durationMs) : 0;
  const itemCount =
    Number.isFinite(input.itemCount) && input.itemCount > 0 ? Math.round(input.itemCount) : 0;
  const safeErrorCode =
    !input.success && input.errorCode !== undefined
      ? SAFE_ERROR_CODE_RE.test(input.errorCode)
        ? input.errorCode
        : 'unknown'
      : undefined;
  return {
    kind: 'catalog_import',
    sourceKind,
    stage: input.stage,
    durationMs,
    itemCount,
    success: input.success,
    ...(safeErrorCode !== undefined ? { errorCode: safeErrorCode } : {}),
  };
}
