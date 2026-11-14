/** Parameters of the gate deep link `elviptv://gate/import?host=10.0.2.2:7878&account=large&batch=1000`. */
export interface ImportParams {
  /** `host[:port]` of the stream simulator; only the development hosts (`10.0.2.2`, `127.0.0.1`, `localhost`). */
  host: string;
  /** Simulator account; the password equals the username. */
  account: 'large' | 'huge';
  /** Rows per write batch, 500 to 20,000. */
  batch: number;
  /** Largest Xtream response body in KiB, 256 to 131,072; bigger lists load per category. */
  maxBody: number;
  /** `series=1`: after the import, open the first series' seasons (episodes load on device). */
  series: boolean;
  /** `probeReads=1`: during the import, time a reader query every 50 ms. */
  probeReads: boolean;
}

const GATE_URL = /^elviptv:\/\/gate\/import\/?(?:\?([^#]*))?(?:#.*)?$/;
const HOST = /^(?:10\.0\.2\.2|127\.0\.0\.1|localhost)(?::(\d{1,5}))?$/;
const DEFAULT_HOST = '10.0.2.2:7878';

function readHost(value: string | undefined): string {
  if (value === undefined) return DEFAULT_HOST;
  const match = HOST.exec(value);
  if (match === null) return DEFAULT_HOST;
  const port = match[1];
  return port === undefined || Number.parseInt(port, 10) <= 65_535 ? value : DEFAULT_HOST;
}

function readInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !/^\d+$/.test(value)) return fallback;
  return Math.min(Math.max(Number.parseInt(value, 10), min), max);
}

/**
 * Parses an import gate link. Returns `undefined` for anything that is not `elviptv://gate/import`. A host outside the
 * development hosts, an unknown account or a malformed number falls back to the default (`10.0.2.2:7878`, `large`, 1000, 4096);
 * the probes are on only with `1`.
 */
export function parseImportUrl(url: string | null): ImportParams | undefined {
  if (url === null) return undefined;
  const match = GATE_URL.exec(url);
  if (match === null) return undefined;
  const query = new Map<string, string>();
  for (const pair of (match[1] ?? '').split('&')) {
    const eq = pair.indexOf('=');
    if (eq > 0) query.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return {
    host: readHost(query.get('host')),
    account: query.get('account') === 'huge' ? 'huge' : 'large',
    batch: readInt(query.get('batch'), 1000, 500, 20_000),
    maxBody: readInt(query.get('maxBody'), 4096, 256, 131_072),
    series: query.get('series') === '1',
    probeReads: query.get('probeReads') === '1',
  };
}
