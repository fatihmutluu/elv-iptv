import type { MediaKind } from '@elv/playback';

/** Parameters of the corpus gate deep link `elviptv://gate/corpus?host=10.0.2.2:7878&account=demo&burst=0`. */
export interface CorpusGateParams {
  /** `host[:port]` of the stream simulator; only the development hosts (`10.0.2.2`, `127.0.0.1`, `localhost`). */
  host: string;
  /** Simulator account; the password equals the username. */
  account: string;
  /** Initial live MPEG-TS burst in seconds, 0 to 30 (default 0: real time). */
  burst: number;
}

/** One item in the 29-item format corpus sweep. */
export interface CorpusItem {
  id: string;
  label: string;
  kind: MediaKind;
  url: string;
  expect: 'playing' | 'failed';
  /** `category/code` the item must fail with when `expect` is `'failed'`. */
  expectError?: string;
  audioOnly?: boolean;
  selectAudioLang?: string;
  selectSubtitleLang?: string;
  seekMs?: number;
}

/** One item that did not meet its expected corpus outcome. */
export interface CorpusFailure {
  id: string;
  label: string;
  reason: string;
}

/** Payload printed after `ELV_GATE_CORPUS `. */
export interface CorpusReport {
  total: number;
  passed: number;
  failed: CorpusFailure[];
  surfaceCreated: number;
  staleEventsApplied: number;
}

const CORPUS_URL = /^elviptv:\/\/gate\/corpus\/?(?:\?([^#]*))?(?:#.*)?$/;
const HOST = /^(?:10\.0\.2\.2|127\.0\.0\.1|localhost)(?::(\d{1,5}))?$/;
const ACCOUNT = /^[A-Za-z0-9_-]{1,32}$/;
const DEFAULT_HOST = '10.0.2.2:7878';
const DEFAULT_ACCOUNT = 'corpus';
const MAX_BURST_SECONDS = 30;

const LIVE_ENTRIES: readonly (readonly [number, string, string | null, boolean])[] = [
  [1001, 'H.264 720p25 AAC', null, false],
  [1002, 'HEVC 1080p25 8-bit', null, false],
  [1003, 'HEVC 1080p25 10-bit', null, false],
  [1004, 'MPEG-2 576i25 AC-3', null, false],
  [1005, 'H.264 576p25 MP2', null, false],
  [1006, 'AAC radio', null, false],
  [1007, 'H.264 1080i25', null, false],
  [1008, 'H.264 720p50 E-AC-3 5.1', null, false],
  [1009, 'H.264 720p29.97 MP3', null, false],
  [1010, 'Two audio tracks and subtitles', null, true],
  [1011, 'Resolution switch 720p and 1080p', null, false],
  [1012, 'Stream labelled as a web page', 'type=text/html', false],
  [1013, 'Redirect to HLS', 'redirect=hls', false],
  [1014, 'Stream labelled as a playlist', 'type=application/vnd.apple.mpegurl', false],
];

const VOD_ENTRIES: readonly (readonly [number, string, 'mp4' | 'mkv', boolean])[] = [
  [200001, 'H.264 720p25 AAC (MP4)', 'mp4', false],
  [200002, 'HEVC 1080p25 8-bit (MKV)', 'mkv', false],
  [200003, 'HEVC 1080p25 10-bit (MP4)', 'mp4', false],
  [200004, 'MPEG-2 576i25 AC-3 (MKV)', 'mkv', false],
  [200005, 'H.264 576p25 MP2 (MKV)', 'mkv', false],
  [200006, 'AAC radio (MP4)', 'mp4', false],
  [200007, 'H.264 1080i25 (MKV)', 'mkv', false],
  [200008, 'H.264 720p50 E-AC-3 5.1 (MP4)', 'mp4', false],
  [200009, 'H.264 720p29.97 MP3 (MP4)', 'mp4', false],
  [200010, 'Two audio tracks and subtitles (MP4)', 'mp4', true],
  [200011, 'Two audio tracks and subtitles (MKV)', 'mkv', true],
  [200012, 'Resolution switch 720p and 1080p (MKV)', 'mkv', false],
];

function readHost(value: string | undefined): string {
  if (value === undefined) return DEFAULT_HOST;
  const match = HOST.exec(value);
  if (match === null) return DEFAULT_HOST;
  const port = match[1];
  return port === undefined || Number.parseInt(port, 10) <= 65_535 ? value : DEFAULT_HOST;
}

function readBurst(value: string | undefined): number {
  if (value === undefined || !/^\d+(?:\.\d+)?$/.test(value)) return 0;
  return Math.min(Math.max(Number(value), 0), MAX_BURST_SECONDS);
}

function decodeQueryPart(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

/**
 * Parses a corpus gate deep link. Returns `undefined` for anything other than `elviptv://gate/corpus`;
 * invalid hosts, accounts or burst values fall back to `10.0.2.2:7878`, `corpus` and `0`.
 */
export function parseCorpusGateUrl(url: string | null): CorpusGateParams | undefined {
  if (url === null) return undefined;
  const match = CORPUS_URL.exec(url);
  if (match === null) return undefined;
  const query = new Map<string, string>();
  for (const pair of (match[1] ?? '').split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = decodeQueryPart(pair.slice(0, eq));
    const value = decodeQueryPart(pair.slice(eq + 1));
    if (key !== undefined && value !== undefined) query.set(key, value);
  }
  const account = query.get('account');
  return {
    host: readHost(query.get('host')),
    account: account !== undefined && ACCOUNT.test(account) ? account : DEFAULT_ACCOUNT,
    burst: readBurst(query.get('burst')),
  };
}

/** Builds the 29-item format corpus manifest for a simulator base URL and account. */
export function buildCorpusItems(opts: {
  base: string;
  account: string;
  burst?: number;
}): CorpusItem[] {
  const { base, account, burst = 0 } = opts;
  const pair = `${account}/${account}`;
  const items: CorpusItem[] = [];

  for (const [id, label, fault, tracks] of LIVE_ENTRIES) {
    if (fault === 'redirect=hls') {
      items.push({
        id: `live-${id}`,
        label,
        kind: 'live',
        url: `${base}/${pair}/${id}`,
        expect: 'playing',
      });
      continue;
    }
    const queryParts = [
      fault !== null && burst > 0 ? fault : undefined,
      burst > 0 ? `burst=${burst}` : undefined,
    ].filter((part): part is string => part !== undefined);
    const suffix = queryParts.length === 0 ? '' : `?fault=${queryParts.join(',')}`;
    items.push({
      id: `live-${id}`,
      label,
      kind: 'live',
      url: `${base}/live/${pair}/${id}.ts${suffix}`,
      expect: 'playing',
      ...(id === 1006 ? { audioOnly: true } : {}),
      ...(tracks ? { selectAudioLang: 'eng', selectSubtitleLang: 'tur' } : {}),
    });
  }

  items.push({
    id: 'live-1010-hls',
    label: 'Two audio tracks and subtitles (Live HLS WebVTT)',
    kind: 'live',
    url: `${base}/live/${pair}/1010.m3u8`,
    expect: 'playing',
    selectSubtitleLang: 'tur',
  });

  for (const [id, label, ext, tracks] of VOD_ENTRIES) {
    items.push({
      id: `vod-${id}`,
      label,
      kind: 'vod',
      url: `${base}/movie/${pair}/${id}.${ext}`,
      expect: 'playing',
      ...(id === 200006 ? { audioOnly: true } : {}),
      ...(tracks ? { selectAudioLang: 'eng', selectSubtitleLang: 'tur' } : {}),
    });
  }

  items.push({
    id: 'vod-200010-hls',
    label: 'Two audio tracks and subtitles (VOD HLS WebVTT)',
    kind: 'vod',
    url: `${base}/movie/${pair}/200010.m3u8`,
    expect: 'playing',
    selectSubtitleLang: 'tur',
    seekMs: 30_000,
  });

  items.push({
    id: 'vod-200001-empty',
    label: 'Empty 200 VOD response',
    kind: 'vod',
    url: `${base}/movie/${pair}/200001.mp4?fault=empty`,
    expect: 'failed',
    expectError: 'playback/network',
  });

  return items;
}
