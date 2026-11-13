import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { findRepoRoot } from '../root.ts';
import { ACCOUNTS } from './accounts.ts';
import {
  createConnections,
  type RequestMeta,
  type RouteHandler,
  type SimContext,
} from './context.ts';
import { type Fault, FaultParseError, parseFaults } from './faults.ts';
import { type LogEntry, RequestLog, redact } from './log.ts';
import { findFfmpeg } from './media.ts';
import { requestFaults } from './request-faults.ts';
import { dataRoute, sendText } from './routes-data.ts';
import { liveRoute } from './routes-live.ts';
import { mediaRoute } from './routes-media.ts';

/** Options of `startSim`; every field is optional. */
export interface SimOptions {
  port?: number;
  host?: string;
  seed?: number;
  /** Simulator time at start; defaults to the real time. */
  clock?: Date;
  logFile?: string;
  mediaSeconds?: number;
  cacheDir?: string;
  ffmpegPath?: string | null;
}

/** A running simulator. */
export interface SimHandle {
  url: string;
  port: number;
  requests(): LogEntry[];
  events(): unknown[];
  clear(): void;
  close(): Promise<void>;
}

const DEFAULT_PORT = 7878;
const DEFAULT_HOST = '127.0.0.1';
const EVENTS_LIMIT = 1_048_576;
const MEDIA_PATH = /^\/(live|movie|series)\/([^/]+)\/[^/]+\/(\d+)(?:\.[^/]*)?$/;

/** Where generated media is cached unless `cacheDir` is given. */
export function defaultCacheDir(): string {
  return join(findRepoRoot(import.meta.dirname), '.cache', 'sim-media');
}

const DEFAULT_MEDIA_SECONDS = 600;
const routes: RouteHandler[] = [dataRoute, mediaRoute, liveRoute];

function headersOf(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

function sizeOf(chunk: unknown): number {
  if (typeof chunk === 'string') return Buffer.byteLength(chunk);
  return chunk instanceof Uint8Array ? chunk.byteLength : 0;
}

/** Counts bytes and writes the log line when the response ends or the client goes away. */
function track(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SimContext,
  meta: RequestMeta,
): void {
  const started = performance.now();
  const url = new URL(req.url ?? '/', 'http://sim');
  const query: Record<string, string> = {};
  for (const [k, v] of url.searchParams) query[k] = v;
  let bytes = 0;
  let logged = false;
  const record = (): void => {
    if (logged || url.pathname.startsWith('/_sim/')) return;
    logged = true;
    const entry: LogEntry = {
      t: ctx.now().toISOString(),
      method: req.method ?? 'GET',
      path: url.pathname,
      query,
      headers: headersOf(req),
      status: res.statusCode,
      bytes,
      ms: Math.round(performance.now() - started),
      account: meta.account,
      streamId: meta.streamId,
      recipe: meta.recipe,
      fault: meta.fault,
      openConnections: meta.account === null ? 0 : ctx.connections.count(meta.account),
    };
    ctx.log.add(redact(entry));
  };
  const write = res.write.bind(res) as (...a: unknown[]) => boolean;
  const end = res.end.bind(res) as (...a: unknown[]) => ServerResponse;
  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    bytes += sizeOf(chunk);
    return write(chunk, ...rest);
  }) as typeof res.write;
  res.end = ((chunk?: unknown, ...rest: unknown[]) => {
    bytes += sizeOf(chunk);
    record();
    return chunk === undefined ? end() : end(chunk, ...rest);
  }) as typeof res.end;
  res.on('close', record);

  const media = MEDIA_PATH.exec(url.pathname);
  if (media) {
    if (ACCOUNTS.some((a) => a.username === media[2])) meta.account = media[2] as string;
    meta.streamId = Number(media[3]);
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  const parts: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total <= limit) parts.push(chunk as Buffer);
  }
  return total > limit ? null : Buffer.concat(parts).toString('utf8');
}

async function simRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SimContext,
  events: unknown[],
  path: string,
): Promise<boolean> {
  if (path === '/_sim/requests' && req.method === 'GET') {
    sendText(res, 200, 'application/json', JSON.stringify(ctx.log.list()));
  } else if (path === '/_sim/requests' && req.method === 'DELETE') {
    ctx.log.clear();
    sendText(res, 204, 'text/plain');
  } else if (path === '/_sim/events' && req.method === 'GET') {
    sendText(res, 200, 'application/json', JSON.stringify(events));
  } else if (path === '/_sim/events' && req.method === 'POST') {
    const body = await readBody(req, EVENTS_LIMIT);
    if (body === null) {
      sendText(res, 413, 'text/plain', 'events body over 1 MB');
      return true;
    }
    const parsed: unknown[] = [];
    const lines = body.split('\n').filter((l) => l.trim() !== '');
    for (const [i, line] of lines.entries()) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        sendText(res, 400, 'text/plain', `line ${i + 1} is not valid JSON`);
        return true;
      }
    }
    events.push(...parsed);
    sendText(res, 204, 'text/plain');
  } else return false;
  return true;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SimContext,
  events: unknown[],
): Promise<void> {
  const meta: RequestMeta = { account: null, streamId: null, recipe: null, fault: null };
  track(req, res, ctx, meta);
  const url = new URL(req.url ?? '/', 'http://sim');
  if (url.pathname.startsWith('/_sim/')) {
    if (await simRoute(req, res, ctx, events, url.pathname)) return;
    sendText(res, 404, 'text/plain', 'not found');
    return;
  }
  const spec = url.searchParams.get('fault');
  if (spec !== null) {
    meta.fault = spec;
    let faults: Fault[];
    try {
      faults = parseFaults(spec);
    } catch (error) {
      if (!(error instanceof FaultParseError)) throw error;
      sendText(res, 400, 'text/plain', error.message);
      return;
    }
    if (await requestFaults(req, res, faults)) return;
  }
  for (const route of routes) if (await route(req, res, ctx, meta)) return;
  sendText(res, 404, 'text/plain', 'not found');
}

/** Starts the simulator; rejects with a clear message when the port is taken. */
export async function startSim(options: SimOptions = {}): Promise<SimHandle> {
  const host = options.host ?? DEFAULT_HOST;
  const startedAt = Date.now();
  const clock = options.clock ?? new Date(startedAt);
  const log = new RequestLog(options.logFile);
  const events: unknown[] = [];
  const ctx: SimContext = {
    now: () => new Date(clock.getTime() + (Date.now() - startedAt)),
    seed: options.seed ?? 1,
    baseUrl: '',
    log,
    connections: createConnections(),
    media: {
      ffmpeg: options.ffmpegPath === undefined ? findFfmpeg() : options.ffmpegPath,
      cacheDir: options.cacheDir ?? defaultCacheDir(),
      seconds: options.mediaSeconds ?? DEFAULT_MEDIA_SECONDS,
    },
  };
  const server: Server = createServer((req, res) => {
    handle(req, res, ctx, events).catch(() => {
      if (res.headersSent) res.destroy();
      else sendText(res, 500, 'text/plain', 'internal error');
    });
  });
  const wanted = options.port ?? DEFAULT_PORT;
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE' ? new Error(`sim: port ${wanted} is already in use`) : error,
      );
    });
    server.listen(wanted, host, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : wanted;
  const shown = host === '0.0.0.0' ? '127.0.0.1' : host;
  const url = `http://${shown}:${port}`;
  ctx.baseUrl = url;
  return {
    url,
    port,
    requests: () => log.list(),
    events: () => [...events],
    clear: () => {
      log.clear();
      events.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
