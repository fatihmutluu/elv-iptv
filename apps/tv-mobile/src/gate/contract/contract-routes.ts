/** Parameters of the contract gate deep link `elviptv://gate/contract?host=127.0.0.1:7878&account=demo`. */
export interface ContractGateParams {
  /** `host[:port]` of the stream simulator; only the development hosts (`10.0.2.2`, `127.0.0.1`, `localhost`). */
  host: string;
  /** Simulator account; the password equals the username. */
  account: string;
}

const CONTRACT_URL = /^elviptv:\/\/gate\/contract\/?(?:\?([^#]*))?(?:#.*)?$/;
const HOST = /^(?:10\.0\.2\.2|127\.0\.0\.1|localhost)(?::(\d{1,5}))?$/;
const ACCOUNT = /^[A-Za-z0-9_-]{1,32}$/;
const DEFAULT_HOST = '127.0.0.1:7878';
const DEFAULT_ACCOUNT = 'demo';

function readHost(value: string | undefined): string {
  if (value === undefined) return DEFAULT_HOST;
  const match = HOST.exec(value);
  if (match === null) return DEFAULT_HOST;
  const port = match[1];
  return port === undefined || Number.parseInt(port, 10) <= 65_535 ? value : DEFAULT_HOST;
}

/**
 * Parses a contract gate link. Returns `undefined` for anything other than `elviptv://gate/contract`;
 * invalid hosts or accounts fall back to `127.0.0.1:7878` and `demo`.
 */
export function parseContractGateUrl(url: string | null): ContractGateParams | undefined {
  if (url === null) return undefined;
  const match = CONTRACT_URL.exec(url);
  if (match === null) return undefined;
  const query = new Map<string, string>();
  for (const pair of (match[1] ?? '').split('&')) {
    const eq = pair.indexOf('=');
    if (eq > 0) query.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  const account = query.get('account');
  return {
    host: readHost(query.get('host')),
    account: account !== undefined && ACCOUNT.test(account) ? account : DEFAULT_ACCOUNT,
  };
}
