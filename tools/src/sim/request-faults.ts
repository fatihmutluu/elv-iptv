import type { IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { ACCOUNTS } from './accounts.ts';
import { type Fault, mediaType } from './faults.ts';
import { sendText } from './routes-data.ts';

const LIVE_FORM = /^\/live\/([^/]+\/[^/]+\/\d+)(?:\.ts)?$/;
const SHORT_FORM = /^\/([^/]+)\/([^/]+\/\d+)$/;
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  mkv: 'video/x-matroska',
  ts: 'video/mp2t',
  vtt: 'text/vtt',
};
const HLS_STREAM_PATH = /^\/(?:live|movie|series|hls)\/.*\.m3u8$/i;

/** The content type an empty answer keeps for a media path, else `text/plain`. */
function emptyMediaType(path: string): string {
  if (HLS_STREAM_PATH.test(path)) return 'application/vnd.apple.mpegurl';
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  if (ext !== undefined && MEDIA_TYPES[ext] !== undefined) return MEDIA_TYPES[ext];
  return hlsRedirectPath(path) !== null ? 'video/mp2t' : 'text/plain';
}

/** The `.m3u8` path a live stream URL redirects to, or null for paths that are not live TS forms. */
export function hlsRedirectPath(path: string): string | null {
  const live = LIVE_FORM.exec(path);
  if (live) return `/live/${live[1]}.m3u8`;
  const short = SHORT_FORM.exec(path);
  if (short && ACCOUNTS.some((a) => a.username === short[1]))
    return `/live/${short[1]}/${short[2]}.m3u8`;
  return null;
}

/** Applies request-level faults; true when one of them answered the request or the client disconnected early. */
export async function requestFaults(
  req: IncomingMessage,
  res: ServerResponse,
  faults: readonly Fault[],
): Promise<boolean> {
  if (res.closed || res.destroyed) return true;
  if (faults.some((f) => f.kind === 'slow-start')) {
    const abort = new AbortController();
    const onClose = (): void => abort.abort();
    res.once('close', onClose);
    try {
      for (const f of faults) {
        if (f.kind !== 'slow-start') continue;
        await sleep(f.sec * 1000, undefined, { signal: abort.signal }).catch(() => undefined);
        if (res.closed || res.destroyed) return true;
      }
    } finally {
      res.off('close', onClose);
    }
  }
  if (res.closed || res.destroyed) return true;
  for (const f of faults) {
    if (f.kind === 'status') sendText(res, f.code, 'text/plain');
    else if (f.kind === 'text-notice') sendText(res, 200, 'text/plain', 'Max connections reached');
    else if (f.kind === 'empty') {
      const fallback = emptyMediaType(new URL(req.url ?? '/', 'http://sim').pathname);
      res.writeHead(200, { 'content-type': mediaType(faults, fallback), 'content-length': 0 });
      res.end();
    } else if (f.kind === 'redirect' || f.kind === 'redirect-hls') {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'sim'}`);
      url.searchParams.delete('fault');
      let location = url.toString();
      if (f.kind === 'redirect-hls') {
        const target = hlsRedirectPath(url.pathname);
        if (target === null) continue;
        location = `${url.origin}${target}${url.search}`;
      }
      res.writeHead(302, { location });
      res.end();
    } else continue;
    return true;
  }
  return false;
}
