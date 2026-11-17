/** The fault a player gate run injects into its first channel. */
export type GateFault = '' | 'drop5' | '404' | '509' | 'notice' | 'stall' | 'silent' | 'slowstart';

/**
 * Parameters of the gate query
 * `elv-gate=player&base=http://127.0.0.1:7878&account=demo&channels=1001,1002&zaps=30&rate=0.5&vod=900&fault=`.
 */
export interface GateParams {
  /** `http://host[:port]` of the stream simulator; a loopback, RFC 1918 or RFC 6598 (Tailscale) address only. */
  base: string;
  /** Simulator account; the password equals the username. */
  account: string;
  /** Simulator stream ids to zap between, 1 to 20 numeric ids. */
  channels: readonly string[];
  /** Automatic zaps after the first tune, 1 to 200. */
  zaps: number;
  /** Automatic zaps per second, 0.05 to 5. */
  rate: number;
  /** Simulator movie id for the VOD part, or null to skip it. */
  vod: string | null;
  /** Fault injected into the first channel; empty for none. */
  fault: GateFault;
  /** True when running the 29-item format corpus sweep (`elv-gate=corpus` or `corpus=1`). */
  corpus?: boolean;
  /** Initial live MPEG-TS burst in seconds for corpus runs, 0 to 30. */
  burst?: number;
}

const DEFAULT_BASE = 'http://127.0.0.1:7878';
const DEFAULT_CHANNELS: readonly string[] = ['1001', '1002', '1003', '1004'];
const MAX_CHANNELS = 20;
const ACCOUNT = /^[A-Za-z0-9_-]{1,32}$/;
const ID = /^\d{1,9}$/;
const BASE = /^http:\/\/([a-z0-9.]+)(?::(\d{1,5}))?$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const FAULT_SPECS: Readonly<Record<Exclude<GateFault, ''>, string>> = {
  drop5: 'drop@5s',
  '404': 'status=404',
  '509': 'status=509',
  notice: 'text-notice',
  stall: 'stall30s@2s',
  silent: 'stall30s@0s',
  slowstart: 'slow-start=3',
};
const FAULTS: ReadonlySet<string> = new Set(Object.keys(FAULT_SPECS));

function isPrivateHost(host: string): boolean {
  if (host === 'localhost') return true;
  const match = IPV4.exec(host);
  if (match === null) return false;
  const [a, b, c, d] = match.slice(1).map(Number) as [number, number, number, number];
  if ([a, b, c, d].some((part) => part > 255)) return false;
  return (
    a === 127 ||
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function readBase(value: string | null): string {
  if (value === null) return DEFAULT_BASE;
  const match = BASE.exec(value);
  if (match === null || !isPrivateHost(match[1] ?? '')) return DEFAULT_BASE;
  const port = match[2];
  return port === undefined || Number(port) <= 65_535 ? value : DEFAULT_BASE;
}

function readNumber(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
  integer: boolean,
): number {
  const pattern = integer ? /^\d+$/ : /^\d+(?:\.\d+)?$/;
  if (value === null || !pattern.test(value)) return fallback;
  return Math.min(Math.max(Number(value), min), max);
}

function readChannels(value: string | null): readonly string[] {
  if (value === null) return DEFAULT_CHANNELS;
  const ids = value.split(',');
  return ids.every((id) => ID.test(id)) ? ids.slice(0, MAX_CHANNELS) : DEFAULT_CHANNELS;
}

/**
 * Parses a gate query string (with or without the leading `?`). Returns `undefined` unless it carries
 * `elv-gate=player`. Malformed values fall back to the defaults (`http://127.0.0.1:7878`, `demo`, channels 1001 to
 * 1004, 30 zaps, 0.5 per second, no VOD, no fault); a base that is not a loopback or private `http://` address is
 * replaced; zaps and rate are clamped; channels beyond 20 are cut.
 */
export function parseGateParams(query: string): GateParams | undefined {
  const q = new URLSearchParams(query);
  const mode = q.get('elv-gate');
  if (mode !== 'player' && mode !== 'corpus') return undefined;
  const corpus = mode === 'corpus' || q.get('corpus') === '1';
  const account = q.get('account');
  const vod = q.get('vod');
  const fault = q.get('fault') ?? '';
  const fallbackAccount = corpus ? 'corpus' : 'demo';
  return {
    base: readBase(q.get('base')),
    account: account !== null && ACCOUNT.test(account) ? account : fallbackAccount,
    channels: readChannels(q.get('channels')),
    zaps: readNumber(q.get('zaps'), 30, 1, 200, true),
    rate: readNumber(q.get('rate'), 0.5, 0.05, 5, false),
    vod: vod !== null && ID.test(vod) ? vod : null,
    fault: FAULTS.has(fault) ? (fault as GateFault) : '',
    ...(corpus ? { corpus: true, burst: readNumber(q.get('burst'), 0, 0, 30, false) } : {}),
  };
}

/** The simulator `?fault=` value of a fault run, or `undefined` for none. */
export function faultSpec(fault: GateFault): string | undefined {
  return fault === '' ? undefined : FAULT_SPECS[fault];
}

/** The live stream URL of one channel; built at play time. The fault applies to `channels[0]` only. */
export function streamUrl(params: GateParams, index: number): string {
  const id = params.channels[index];
  const url = `${params.base}/live/${params.account}/${params.account}/${id}.ts`;
  const spec = index === 0 ? faultSpec(params.fault) : undefined;
  return spec === undefined ? url : `${url}?fault=${spec}`;
}

/** The movie URL for the VOD part; `params.vod` must be set. */
export function vodUrl(params: GateParams): string {
  return `${params.base}/movie/${params.account}/${params.account}/${params.vod}.mp4`;
}

/**
 * The gate parameters for a page, only when the preload says main started in gate mode (`window.elv.gate`); a page
 * that merely carries the query gets none.
 */
export function resolveGate(
  search: string,
  elv: { readonly gate?: boolean } | undefined,
): GateParams | undefined {
  return elv?.gate === true ? parseGateParams(search) : undefined;
}
