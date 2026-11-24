import type { CatalogService } from '../../catalog';
import { type ReadProbe, startReadProbe } from './read-probe';
import type { ImportParams } from './route';
import type { StallMeter } from './stall-meter';

/** Numbers of the optional probes; present only when the route asked for them. */
interface ProbeResult {
  /** `probeReads=1`: longest reader query during the import, and how many ran or failed. */
  maxReadMs?: number;
  reads?: number;
  readErrors?: number;
  /** `series=1`: seasons and episodes of the first series, and how long opening it took. */
  seasons?: number;
  episodes?: number;
  seriesMs?: number;
  /** `series=1` and the series could not be opened: a `category/code`. */
  seriesError?: string;
  /** `guide=1`: XMLTV guide import duration in ms (`#25`, budget `< 60_000 ms`). */
  guideDurationMs?: number;
  /** `guide=1`: total programmes written to SQLite. */
  guideProgrammes?: number;
  /** `guide=1`: number of live channels matched to XMLTV guide channels. */
  guideMatchedChannels?: number;
  /** `guide=1`: longest JS stall during XMLTV guide import. */
  guideMaxStallMs?: number;
  /** `guide=1` and the guide import failed: a `category/code`. */
  guideError?: string;
}

/** What one import run prints; `error` is a `category/code` and replaces the numbers when the run failed. */
export type ImportResult = (
  | {
      account: string;
      batch: number;
      maxBody: number;
      rows: number;
      durationMs: number;
      maxStallMs: number;
    }
  | { account: string; batch: number; maxBody: number; error: string; maxStallMs: number }
) &
  ProbeResult;

/** The `ELV_GATE_IMPORT {json}` line the gate runners read from logcat or the simulator log. */
export function importLine(result: ImportResult): string {
  return `ELV_GATE_IMPORT ${JSON.stringify(result)}`;
}

const code = (e: { category: string; code: string }) => `${e.category}/${e.code}`;

/** Opens the first series that has items: its seasons load the episodes through `tx.batch` on device. */
async function openFirstSeries(catalog: CatalogService, sourceId: string): Promise<ProbeResult> {
  const started = performance.now();
  const category = (await catalog.categories(sourceId, 'series')).find((c) => c.itemCount > 0);
  const series = category === undefined ? undefined : (await catalog.items(category.id, 0, 1))[0];
  if (series === undefined) return { seriesError: 'storage/item-not-found' };
  const seasons = await catalog.seasons(series.id);
  if (!seasons.ok) return { seriesError: code(seasons.error) };
  return {
    seasons: seasons.value.length,
    episodes: seasons.value.reduce((n, s) => n + s.episodeCount, 0),
    seriesMs: Math.round((performance.now() - started) * 10) / 10,
  };
}

async function importGuideProbe(
  catalog: CatalogService,
  sourceId: string,
  batchSize: number,
  startMeter: () => StallMeter,
): Promise<ProbeResult> {
  if (catalog.importGuide === undefined) {
    return { guideError: 'source-format/unsupported-source' };
  }
  const meter = startMeter();
  const guide = await catalog.importGuide(sourceId, { batchSize });
  const guideMaxStallMs = meter.stop();
  if (!guide.ok) {
    return { guideError: code(guide.error), guideMaxStallMs };
  }
  return {
    guideDurationMs: guide.value.durationMs,
    guideProgrammes: guide.value.counts.programmes ?? 0,
    guideMatchedChannels: guide.value.counts.mapped ?? 0,
    guideMaxStallMs,
  };
}

/**
 * Adds the simulator account to a fresh `catalog`, imports it with `params.batch` rows per write and measures the longest
 * JS stall during the import only (`startMeter` starts right before it). Rows are live, movie and series items. With
 * `probeReads` a reader query (the live categories) is timed every 50 ms during the import; with `series` the first
 * series is opened after it; with `guide` XMLTV guide programmes are streamed into SQLite afterwards (`#25`).
 */
export async function runImport(
  catalog: CatalogService,
  params: ImportParams,
  startMeter: () => StallMeter,
  startProbe: (read: () => Promise<unknown>) => ReadProbe = startReadProbe,
): Promise<ImportResult> {
  const { account, batch, maxBody } = params;
  const added = await catalog.addSource({
    kind: 'xtream',
    name: `gate-${account}`,
    server: `http://${params.host}`,
    username: account,
    password: account,
  });
  if (!added.ok) return { account, batch, maxBody, error: code(added.error), maxStallMs: 0 };
  const sourceId = added.value.id;
  const meter = startMeter();
  const probe = params.probeReads
    ? startProbe(() => catalog.categories(sourceId, 'live'))
    : undefined;
  const imported = await catalog.importSource(sourceId, {
    batchSize: batch,
    maxBodyBytes: maxBody * 1024,
  });
  const maxStallMs = meter.stop();
  const reads: ProbeResult = probe === undefined ? {} : await probe.stop();
  if (!imported.ok) {
    return { account, batch, maxBody, error: code(imported.error), maxStallMs, ...reads };
  }
  const { counts, durationMs } = imported.value;
  const rows = (counts.live ?? 0) + (counts.movies ?? 0) + (counts.series ?? 0);
  const series = params.series ? await openFirstSeries(catalog, sourceId) : {};
  const guide = params.guide ? await importGuideProbe(catalog, sourceId, batch, startMeter) : {};
  return { account, batch, maxBody, rows, durationMs, maxStallMs, ...reads, ...series, ...guide };
}
