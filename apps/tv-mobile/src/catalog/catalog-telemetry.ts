import type { CatalogService } from '@elv/data';
import type { TelemetryPort } from '../sync/sync-helpers';

/** Catalog/guide import timing telemetry payload matching `TelemetryPort.recordCatalogImport`. */
export type TelemetryCatalogImport = Parameters<TelemetryPort['recordCatalogImport']>[0];

const SAFE_ERROR_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function normalizeSourceKind(raw: string | undefined): TelemetryCatalogImport['sourceKind'] {
  return raw === 'm3u' || raw === 'xtream' || raw === 'stalker' ? raw : 'unknown';
}

function sumImportCounts(counts: Readonly<Record<string, number>> | undefined): number {
  if (!counts) return 0;
  let total = 0;
  for (const val of Object.values(counts)) {
    if (typeof val === 'number' && Number.isFinite(val) && val > 0) total += Math.round(val);
  }
  return total;
}

function sanitizeErrorCode(code: string | undefined): string | undefined {
  if (code === undefined) return undefined;
  return SAFE_ERROR_CODE_RE.test(code) ? code : 'unknown';
}

/**
 * Wraps a mobile/TV {@link CatalogService} so `importSource` (`stage: 'catalog'`) and
 * `importGuide` (`stage: 'guide'`) emit sanitized `catalog_import` timing metrics (`#509`).
 */
export function wrapCatalogWithImportTelemetry(
  catalog: CatalogService,
  recordCatalogImport: (meta: TelemetryCatalogImport) => void,
  clock: () => number = Date.now,
): CatalogService {
  const resolveKind = async (sourceId: string): Promise<TelemetryCatalogImport['sourceKind']> => {
    try {
      const sources = await catalog.listSources();
      return normalizeSourceKind(sources.find((s) => s.id === sourceId)?.kind);
    } catch {
      return 'unknown';
    }
  };

  const safeRecord = (meta: TelemetryCatalogImport): void => {
    try {
      recordCatalogImport(meta);
    } catch {
      // Telemetry hooks must never fail catalog imports.
    }
  };

  const baseImportGuide = catalog.importGuide;

  return {
    ...catalog,
    async importSource(id, opts) {
      const startedAt = clock();
      const sourceKind = await resolveKind(id);
      const res = await catalog.importSource(id, opts);
      const errorCode = res.ok ? undefined : sanitizeErrorCode(res.error.code);
      safeRecord({
        sourceKind,
        stage: 'catalog',
        durationMs: Math.max(0, Math.round(clock() - startedAt)),
        itemCount: res.ok ? sumImportCounts(res.value.counts) : 0,
        success: res.ok,
        ...(errorCode !== undefined ? { errorCode } : {}),
      });
      return res;
    },
    ...(baseImportGuide
      ? {
          async importGuide(sourceId, opts) {
            const startedAt = clock();
            const sourceKind = await resolveKind(sourceId);
            const res = await baseImportGuide(sourceId, opts);
            const errorCode = res.ok ? undefined : sanitizeErrorCode(res.error.code);
            safeRecord({
              sourceKind,
              stage: 'guide',
              durationMs: Math.max(0, Math.round(clock() - startedAt)),
              itemCount: res.ok ? sumImportCounts(res.value.counts) : 0,
              success: res.ok,
              ...(errorCode !== undefined ? { errorCode } : {}),
            });
            return res;
          },
        }
      : {}),
  };
}
