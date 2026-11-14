import type { CatalogService } from '../../catalog';
import type { ImportParams } from './route';
import type { StallMeter } from './stall-meter';

/** What one import run prints; `error` is a `category/code` and replaces the numbers when the run failed. */
export type ImportResult =
  | { account: string; batch: number; rows: number; durationMs: number; maxStallMs: number }
  | { account: string; batch: number; error: string; maxStallMs: number };

/** The `ELV_GATE_IMPORT {json}` line the gate runners read from logcat or the simulator log. */
export function importLine(result: ImportResult): string {
  return `ELV_GATE_IMPORT ${JSON.stringify(result)}`;
}

/**
 * Adds the simulator account to a fresh `catalog`, imports it with `params.batch` rows per write and measures the longest
 * JS stall during the import only (`startMeter` starts right before it). Rows are live, movie and series items.
 */
export async function runImport(
  catalog: CatalogService,
  params: ImportParams,
  startMeter: () => StallMeter,
): Promise<ImportResult> {
  const { account, batch } = params;
  const added = await catalog.addSource({
    kind: 'xtream',
    name: `gate-${account}`,
    server: `http://${params.host}`,
    username: account,
    password: account,
  });
  if (!added.ok) {
    return { account, batch, error: `${added.error.category}/${added.error.code}`, maxStallMs: 0 };
  }
  const meter = startMeter();
  const imported = await catalog.importSource(added.value.id, { batchSize: batch });
  const maxStallMs = meter.stop();
  if (!imported.ok) {
    return {
      account,
      batch,
      error: `${imported.error.category}/${imported.error.code}`,
      maxStallMs,
    };
  }
  const { counts, durationMs } = imported.value;
  const rows = (counts.live ?? 0) + (counts.movies ?? 0) + (counts.series ?? 0);
  return { account, batch, rows, durationMs, maxStallMs };
}
