/** The fault a player gate run injects into its first channel. */
export type PlayerFault = '' | 'drop5' | '404' | '509' | 'notice' | 'stall';

/** The stream form a run plays: live MPEG-TS, live HLS or a VOD movie (MP4). */
type PlayerStream = 'ts' | 'hls' | 'vod';

/** Parameters of the gate deep link `elviptv://gate/player?host=10.0.2.2:7878&account=demo&channels=1001,1002&zaps=30&rate=0.5&fault=&stream=ts`. */
export interface PlayerGateParams {
  /** `host[:port]` of the stream simulator; only the development hosts (`10.0.2.2`, `127.0.0.1`, `localhost`). */
  host: string;
  /** Simulator account; the password equals the username. */
  account: string;
  /** Simulator stream ids to zap between, 1 to 20 numeric ids. */
  channels: readonly string[];
  /** Number of automatic zaps after the first tune, 1 to 200. */
  zaps: number;
  /** Automatic zaps per second, 0.1 to 5. */
  rate: number;
  /** Fault injected into the first channel (see {@link faultSpec}); empty for none. */
  fault: PlayerFault;
  /** Stream form of every channel; `vod` ids are simulator movie ids and tune as VOD. */
  stream: PlayerStream;
}

const GATE_URL = /^elviptv:\/\/gate\/player\/?(?:\?([^#]*))?(?:#.*)?$/;
const HOST = /^(?:10\.0\.2\.2|127\.0\.0\.1|localhost)(?::(\d{1,5}))?$/;
const ACCOUNT = /^[A-Za-z0-9_-]{1,32}$/;
const CHANNEL = /^\d{1,9}$/;
const DEFAULT_HOST = '10.0.2.2:7878';
const DEFAULT_CHANNELS: readonly string[] = ['1001', '1002', '1003', '1004'];
const MAX_CHANNELS = 20;
const FAULT_SPECS: Readonly<Record<Exclude<PlayerFault, ''>, string>> = {
  drop5: 'drop@5s',
  '404': 'status=404',
  '509': 'status=509',
  notice: 'text-notice',
  stall: 'stall30s@2s',
};
const FAULTS: ReadonlySet<string> = new Set(Object.keys(FAULT_SPECS));
const STREAMS: ReadonlySet<string> = new Set(['ts', 'hls', 'vod']);

function readHost(value: string | undefined): string {
  if (value === undefined) return DEFAULT_HOST;
  const match = HOST.exec(value);
  if (match === null) return DEFAULT_HOST;
  const port = match[1];
  return port === undefined || Number.parseInt(port, 10) <= 65_535 ? value : DEFAULT_HOST;
}

function readNumber(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  integer: boolean,
): number {
  const pattern = integer ? /^\d+$/ : /^\d+(?:\.\d+)?$/;
  if (value === undefined || !pattern.test(value)) return fallback;
  return Math.min(Math.max(Number(value), min), max);
}

function readChannels(value: string | undefined): readonly string[] {
  if (value === undefined) return DEFAULT_CHANNELS;
  const ids = value.split(',');
  if (!ids.every((id) => CHANNEL.test(id))) return DEFAULT_CHANNELS;
  return ids.slice(0, MAX_CHANNELS);
}

/**
 * Parses a player gate link. Returns `undefined` for anything that is not `elviptv://gate/player`. Missing or malformed
 * values fall back to the defaults (`10.0.2.2:7878`, `demo`, channels 1001 to 1004, 30 zaps, 0.5 per second, no
 * fault, `ts`); a host outside the development hosts is replaced; zaps and rate are clamped; channels beyond 20 are cut.
 */
export function parsePlayerGateUrl(url: string | null): PlayerGateParams | undefined {
  if (url === null) return undefined;
  const match = GATE_URL.exec(url);
  if (match === null) return undefined;
  const query = new Map<string, string>();
  for (const pair of (match[1] ?? '').split('&')) {
    const eq = pair.indexOf('=');
    if (eq > 0) query.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  const account = query.get('account');
  const fault = query.get('fault') ?? '';
  const stream = query.get('stream') ?? 'ts';
  return {
    host: readHost(query.get('host')),
    account: account !== undefined && ACCOUNT.test(account) ? account : 'demo',
    channels: readChannels(query.get('channels')),
    zaps: readNumber(query.get('zaps'), 30, 1, 200, true),
    rate: readNumber(query.get('rate'), 0.5, 0.1, 5, false),
    fault: FAULTS.has(fault) ? (fault as PlayerFault) : '',
    stream: STREAMS.has(stream) ? (stream as PlayerStream) : 'ts',
  };
}

/** The simulator `?fault=` value of a fault run, or `undefined` for none. */
export function faultSpec(fault: PlayerFault): string | undefined {
  return fault === '' ? undefined : FAULT_SPECS[fault];
}

/**
 * The stream URL of one channel. The fault applies to `channels[0]` only; the simulator's account password equals its
 * name, and the URL is built here at play time, as the catalog's resolver will do.
 */
export function streamUrl(params: PlayerGateParams, index: number): string {
  const id = params.channels[index];
  const { account, stream } = params;
  const base =
    stream === 'vod'
      ? `http://${params.host}/movie/${account}/${account}/${id}.mp4`
      : `http://${params.host}/live/${account}/${account}/${id}.${stream === 'hls' ? 'm3u8' : 'ts'}`;
  const spec = index === 0 ? faultSpec(params.fault) : undefined;
  return spec === undefined ? base : `${base}?fault=${spec}`;
}
