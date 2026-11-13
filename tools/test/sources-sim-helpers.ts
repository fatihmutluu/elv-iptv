import {
  createFetchHttpClient,
  type Decompressor,
  type FetchLike,
  type HttpClient,
  type TransportSettings,
  transportHeaders,
} from '@elv/domain';
import {
  createXtreamClient,
  type M3uBatch,
  type M3uEntry,
  type M3uHeader,
  type ScanStats,
  scanM3u,
  scanXmltv,
  type XmltvChannel,
  type XmltvProgramme,
  type XtreamClient,
} from '@elv/sources';
import { startSim } from '../src/sim/server.ts';

export type Sim = Awaited<ReturnType<typeof startSim>>;

export const SIM_CLOCK = new Date('2026-06-15T12:00:00Z');

/** Starts a media-less simulator on a free port with a fixed clock. */
export const startTestSim = (): Promise<Sim> =>
  startSim({ port: 0, clock: SIM_CLOCK, ffmpegPath: null });

export const http: HttpClient = createFetchHttpClient(fetch as unknown as FetchLike);

/** Node decompressor built on the global `DecompressionStream`. */
const gunzipAdapter: Decompressor = {
  async *gunzip(chunks) {
    const stream = new DecompressionStream('gzip');
    const writer = stream.writable.getWriter();
    const pump = (async () => {
      try {
        for await (const chunk of chunks) await writer.write(chunk as Uint8Array<ArrayBuffer>);
        await writer.close();
      } catch (e) {
        await writer.abort(e);
      }
    })();
    const reader = stream.readable.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      await pump.catch(() => {});
    }
  },
};

/** Credentials are built at runtime; every simulator account's password equals its username. */
export function clientFor(
  sim: Sim,
  user: string,
  transport?: TransportSettings,
  client: HttpClient = http,
): XtreamClient {
  const password = user;
  return createXtreamClient({
    http: client,
    server: sim.url,
    username: user,
    password,
    ...(transport ? { transport } : {}),
  });
}

export function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`unexpected failure: ${JSON.stringify(r.error)}`);
  return r.value;
}

/** Counts body bytes and tracks the peak live heap (sampled after a forced collection) while a scan runs. */
export interface Meter {
  bytes: number;
  batches: number;
  baseHeap: number;
  peakHeap: number;
}

const SAMPLE_EVERY = 50;

/** Forces a full collection; the tools Vitest config exposes `gc` through `--expose-gc`. */
function collectGarbage(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) throw new Error('gc is not exposed: run Vitest with execArgv --expose-gc');
  gc();
  gc();
}

const newMeter = (): Meter => {
  collectGarbage();
  const base = process.memoryUsage().heapUsed;
  return { bytes: 0, batches: 0, baseHeap: base, peakHeap: base };
};

async function* metered(body: AsyncIterable<Uint8Array>, meter: Meter): AsyncIterable<Uint8Array> {
  for await (const chunk of body) {
    meter.bytes += chunk.byteLength;
    yield chunk;
  }
}

/** Every `SAMPLE_EVERY` batches: collect, then record the live heap, so garbage never counts as retention. */
const sample = (meter: Meter | undefined): void => {
  if (!meter) return;
  meter.batches++;
  if (meter.batches % SAMPLE_EVERY !== 0) return;
  collectGarbage();
  meter.peakHeap = Math.max(meter.peakHeap, process.memoryUsage().heapUsed);
};

export interface PlaylistScan {
  entries: M3uEntry[];
  header: M3uHeader | undefined;
  stats: ScanStats | undefined;
  count: number;
  failed: boolean;
}

/** Scans a playlist URL end to end; `keep: false` counts entries without retaining them. */
export async function scanPlaylist(
  url: string,
  options: { transport?: TransportSettings; keep?: boolean; meter?: Meter } = {},
): Promise<PlaylistScan> {
  const res = must(await http.get(url, { headers: transportHeaders(options.transport) }));
  const out: PlaylistScan = {
    entries: [],
    header: undefined,
    stats: undefined,
    count: 0,
    failed: false,
  };
  const body = options.meter ? metered(res.body, options.meter) : res.body;
  const scan = scanM3u(body, { baseUrl: url });
  for (;;) {
    const step = await scan.next();
    if (step.done) {
      out.failed = !step.value.ok;
      break;
    }
    const batch: M3uBatch = step.value;
    sample(options.meter);
    out.count += batch.entries.length;
    if (options.keep !== false) out.entries.push(...batch.entries);
    if (batch.done) {
      out.header = batch.header;
      out.stats = batch.stats;
    }
  }
  return out;
}

export interface GuideScan {
  channels: XmltvChannel[];
  programmes: XmltvProgramme[];
  programmeCount: number;
  channelCount: number;
  stats: ScanStats | undefined;
  failed: boolean;
}

/** Scans a guide URL end to end; `keep: false` counts programmes without retaining them. */
export async function scanGuide(
  url: string,
  options: { transport?: TransportSettings; gzip?: boolean; keep?: boolean; meter?: Meter } = {},
): Promise<GuideScan> {
  const res = must(await http.get(url, { headers: transportHeaders(options.transport) }));
  const out: GuideScan = {
    channels: [],
    programmes: [],
    programmeCount: 0,
    channelCount: 0,
    stats: undefined,
    failed: false,
  };
  const keep = options.keep !== false;
  const body = options.meter ? metered(res.body, options.meter) : res.body;
  const scan = scanXmltv(body, options.gzip ? { decompressor: gunzipAdapter } : {});
  for (;;) {
    const step = await scan.next();
    if (step.done) {
      out.failed = !step.value.ok;
      break;
    }
    const batch = step.value;
    sample(options.meter);
    out.programmeCount += batch.programmes.length;
    out.channelCount += batch.channels.length;
    if (keep) {
      out.channels.push(...batch.channels);
      out.programmes.push(...batch.programmes);
    }
    if (batch.done) out.stats = batch.stats;
  }
  return out;
}

export interface ScanReport {
  label: string;
  entries: number;
  mb: number;
  seconds: number;
  perSecond: number;
  heapGrowthMb: number;
  line: string;
}

/**
 * Times one scan; `run` returns the number of entries it counted. Heap growth is the peak live heap
 * (sampled after a forced collection every 50 batches) over the heap after the initial collection.
 */
export async function measureScan(
  label: string,
  run: (meter: Meter) => Promise<number>,
): Promise<ScanReport> {
  const meter = newMeter();
  const started = performance.now();
  const entries = await run(meter);
  const seconds = (performance.now() - started) / 1000;
  const mb = meter.bytes / 1_048_576;
  const heapGrowthMb = Math.max(0, meter.peakHeap - meter.baseHeap) / 1_048_576;
  const perSecond = entries / seconds;
  const line = `${label}: ${entries} entries, ${mb.toFixed(1)} MB, ${seconds.toFixed(2)} s, ${Math.round(perSecond)} entries/s, heap +${heapGrowthMb.toFixed(1)} MB`;
  return { label, entries, mb, seconds, perSecond, heapGrowthMb, line };
}
