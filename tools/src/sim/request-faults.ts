import type { IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Fault } from './faults.ts';
import { sendText } from './routes-data.ts';

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
    else if (f.kind === 'redirect') {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'sim'}`);
      url.searchParams.delete('fault');
      res.writeHead(302, { location: url.toString() });
      res.end();
    } else continue;
    return true;
  }
  return false;
}
