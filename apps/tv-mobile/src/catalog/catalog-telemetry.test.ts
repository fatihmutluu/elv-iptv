import type { CatalogService, SourceRow } from '@elv/data';
import { elvError, err, ok } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import { wrapCatalogWithImportTelemetry } from './catalog-telemetry';

describe('wrapCatalogWithImportTelemetry (#509)', () => {
  it('measures importSource and importGuide duration, item count, sourceKind, and safe errorCode', async () => {
    let now = 5_000;
    const recorded: unknown[] = [];
    const sources = [
      {
        id: 'src-1',
        kind: 'stalker',
        name: 'Portal',
        createdAt: 1,
        updatedAt: 1,
      },
    ] as unknown as SourceRow[];

    const base = {
      listSources: vi.fn(async () => sources),
      importSource: vi.fn(async () => {
        now += 850;
        return ok({
          runId: 1,
          counts: { live: 120, movies: 40, series: 10 },
          warnings: 0,
          warningCodes: [],
          durationMs: 850,
        });
      }),
      importGuide: vi.fn(async () => {
        now += 320;
        return err(elvError('network', 'http-503', 'https://secret.example.test/xmltv.xml'));
      }),
    } as unknown as CatalogService;

    const wrapped = wrapCatalogWithImportTelemetry(
      base,
      (meta) => {
        recorded.push(meta);
      },
      () => now,
    );

    const catRes = await wrapped.importSource('src-1');
    expect(catRes.ok).toBe(true);
    const guideRes = await wrapped.importGuide?.('src-1');
    expect(guideRes?.ok).toBe(false);

    expect(recorded).toEqual([
      {
        sourceKind: 'stalker',
        stage: 'catalog',
        durationMs: 850,
        itemCount: 170,
        success: true,
      },
      {
        sourceKind: 'stalker',
        stage: 'guide',
        durationMs: 320,
        itemCount: 0,
        success: false,
        errorCode: 'http-503',
      },
    ]);
  });
});
