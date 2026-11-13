import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RequestLog } from './log.ts';

/** Open media responses per account; the connection limit reads it. */
export interface Connections {
  open(account: string): number;
  close(account: string): void;
  count(account: string): number;
}

/** Media generation settings; `ffmpeg` is null when FFmpeg is absent. */
interface MediaConfig {
  ffmpeg: string | null;
  cacheDir: string;
  seconds: number;
}

/** Shared state handed to every route handler. */
export interface SimContext {
  /** Simulator time: the configured clock advanced by the time since start. */
  now(): Date;
  seed: number;
  baseUrl: string;
  log: RequestLog;
  connections: Connections;
  media: MediaConfig | null;
}

/** What a handler learned about the request, copied into its log line. */
export interface RequestMeta {
  account: string | null;
  streamId: number | null;
  recipe: string | null;
  fault: string | null;
}

/** Resolves to true when the handler answered the request. */
export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SimContext,
  meta: RequestMeta,
) => Promise<boolean>;

/** Creates an in-memory connection counter. */
export function createConnections(): Connections {
  const counts = new Map<string, number>();
  return {
    open(account) {
      const next = (counts.get(account) ?? 0) + 1;
      counts.set(account, next);
      return next;
    },
    close(account) {
      counts.set(account, Math.max(0, (counts.get(account) ?? 0) - 1));
    },
    count: (account) => counts.get(account) ?? 0,
  };
}

/** The base URL as the client addressed the simulator (its `Host` header), else the bound address. */
export function baseUrlOf(req: IncomingMessage, ctx: SimContext): string {
  const host = req.headers.host;
  return host ? `http://${host}` : ctx.baseUrl;
}
