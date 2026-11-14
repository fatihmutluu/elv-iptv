/** Parameters of the gate deep link `elviptv://gate/import?host=10.0.2.2:7878&account=large&batch=1000`. */
export interface ImportParams {
  /** `host[:port]` of the stream simulator; only the development hosts (`10.0.2.2`, `127.0.0.1`, `localhost`). */
  host: string;
  /** Simulator account; the password equals the username. */
  account: 'large' | 'huge';
  /** Rows per write batch, 500 to 20,000. */
  batch: number;
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

function readBatch(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) return 1000;
  return Math.min(Math.max(Number.parseInt(value, 10), 500), 20_000);
}

/**
 * Parses an import gate link. Returns `undefined` for anything that is not `elviptv://gate/import`. A host outside the
 * development hosts, an unknown account or a malformed batch falls back to the default (`10.0.2.2:7878`, `large`, 1000).
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
    batch: readBatch(query.get('batch')),
  };
}
