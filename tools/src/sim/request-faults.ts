import type { IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { ACCOUNTS } from './accounts.ts';
import type { Fault } from './faults.ts';
import { sendText } from './routes-data.ts';

const LIVE_FORM = /^\/live\/([^/]+\/[^/]+\/\d+)(?:\.ts)?$/;
const SHORT_FORM = /^\/([^/]+)\/([^/]+\/\d+)$/;

/** The `.m3u8` path a live stream URL redirects to, or null for paths that are not live TS forms. */
export function hlsRedirectPath(path: string): string | null {
  const live = LIVE_FORM.exec(path);
  if (live) return `/live/${live[1]}.m3u8`;
  const short = SHORT_FORM.exec(path);
  if (short && ACCOUNTS.some((a) => a.username === short[1]))
    return `/live/${short[1]}/${short[2]}.m3u8`;
  return null;
}

/** Applies request-level faults; true when one of them answered the request. */
export async function requestFaults(
  req: IncomingMessage,
  res: ServerResponse,
  faults: readonly Fault[],
): Promise<boolean> {
  for (const f of faults) if (f.kind === 'slow-start') await sleep(f.sec * 1000);
  for (const f of faults) {
    if (f.kind === 'status') sendText(res, f.code, 'text/plain');
    else if (f.kind === 'text-notice') sendText(res, 200, 'text/plain', 'Max connections reached');
    else if (f.kind === 'redirect' || f.kind === 'redirect-hls') {
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
