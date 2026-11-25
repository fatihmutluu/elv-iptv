import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSyncApp, type SyncAppConfig } from './app.ts';
import { assertValidJwtSecret, randomBase64Url } from './crypto.ts';
import { createMemoryStorage } from './storage-memory.ts';
import { BODY_LIMITS, PayloadTooLargeError } from './validation.ts';

/** Options for starting the Node HTTP bridge around `createSyncApp`. */
export interface NodeSyncServerOptions {
  readonly port?: number;
  readonly host?: string;
  readonly jwtSecret?: string;
  readonly adminToken?: string;
  readonly telemetryDisabled?: boolean;
  readonly publicOrigin?: string;
  readonly trustProxy?: SyncAppConfig['trustProxy'];
  readonly storage?: SyncAppConfig['storage'];
  readonly verifierHashIterations?: number;
  readonly rateLimits?: SyncAppConfig['rateLimits'];
}

/** Running Node HTTP sync server handle. */
export interface RunningNodeSyncServer {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

function resolveNodeMaxBodyBytes(method: string, pathname: string): number {
  if (method === 'PUT' && pathname === '/v1/vault') return BODY_LIMITS.vault;
  if (method === 'POST' && pathname === '/v1/telemetry') return BODY_LIMITS.telemetry;
  if (method === 'POST' && pathname === '/account-deletion') return BODY_LIMITS.accountDeletion;
  return BODY_LIMITS.auth;
}

function readNodeRequestBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declaredLen = req.headers['content-length'];
  if (typeof declaredLen === 'string') {
    const parsed = Number(declaredLen);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      req.pause();
      return Promise.reject(new PayloadTooLargeError(maxBytes));
    }
  }

  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.byteLength;
      if (total > maxBytes) {
        settled = true;
        req.pause();
        rejectBody(new PayloadTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolveBody(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      rejectBody(err);
    });
    req.on('aborted', () => {
      if (settled) return;
      settled = true;
      rejectBody(new Error('NODE_REQUEST_ABORTED'));
    });
  });
}

function toWebHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(key, entry);
    } else if (typeof value === 'string') {
      headers.set(key, value);
    }
  }
  return headers;
}

async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  if (res.writableEnded || res.destroyed) return;
  const headerEntries: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headerEntries[key] = value;
  });
  res.writeHead(response.status, headerEntries);
  const body = new Uint8Array(await response.arrayBuffer());
  res.end(body);
}

/** Starts the self-hostable Node HTTP sync server and returns its bound port, URL, and `close()`. */
export async function startNodeSyncServer(
  options: NodeSyncServerOptions = {},
): Promise<RunningNodeSyncServer> {
  const host = options.host ?? '127.0.0.1';
  const requestedPort = options.port ?? 8787;
  const jwtSecret =
    options.jwtSecret !== undefined
      ? options.jwtSecret
      : process.env.JWT_SECRET !== undefined
        ? process.env.JWT_SECRET
        : randomBase64Url(32);
  assertValidJwtSecret(jwtSecret);

  const app = createSyncApp({
    storage: options.storage ?? createMemoryStorage(),
    jwtSecret,
    adminToken: options.adminToken ?? process.env.ADMIN_TOKEN ?? '',
    telemetryDisabled: options.telemetryDisabled ?? process.env.TELEMETRY_DISABLED === 'true',
    publicOrigin: options.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? '*',
    trustProxy: options.trustProxy ?? 'none',
    ...(options.verifierHashIterations !== undefined
      ? { verifierHashIterations: options.verifierHashIterations }
      : {}),
    ...(options.rateLimits !== undefined ? { rateLimits: options.rateLimits } : {}),
  });

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const method = (req.method ?? 'GET').toUpperCase();
        const rawHost = req.headers.host ?? `${host}:${requestedPort}`;
        const rawPath = req.url ?? '/';
        let parsedUrl: URL;
        try {
          if (!rawPath.startsWith('/') || /[\s/@\\]/.test(rawHost)) {
            throw new TypeError('Invalid Host header');
          }
          parsedUrl = new URL(`http://${rawHost}${rawPath}`);
        } catch {
          if (!res.writableEnded && !res.destroyed) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'invalid_request_url' }));
          }
          return;
        }

        const headers = toWebHeaders(req);
        const hasBody = method !== 'GET' && method !== 'HEAD';
        const maxBodyBytes = resolveNodeMaxBodyBytes(method, parsedUrl.pathname);
        const bodyBytes = hasBody ? await readNodeRequestBody(req, maxBodyBytes) : undefined;
        const init: RequestInit = { method, headers };
        if (bodyBytes && bodyBytes.byteLength > 0) {
          init.body = new Uint8Array(bodyBytes);
        }
        const webReq = new Request(parsedUrl.toString(), init);
        const webRes = await app.fetch(webReq, {
          clientIp: req.socket.remoteAddress ?? 'unknown',
        });
        await writeWebResponse(res, webRes);
      } catch (error) {
        if (res.writableEnded || res.destroyed) return;
        if (error instanceof PayloadTooLargeError) {
          res.writeHead(413, {
            'Content-Type': 'application/json; charset=utf-8',
            Connection: 'close',
          });
          res.end(JSON.stringify({ error: 'payload_too_large', maxBytes: error.maxBytes }));
          return;
        }
        res.writeHead(500, {
          'Content-Type': 'application/json; charset=utf-8',
        });
        res.end(JSON.stringify({ error: 'internal_error' }));
      }
    })();
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(requestedPort, host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : requestedPort;
  const url = `http://${host}:${boundPort}`;

  return {
    server,
    port: boundPort,
    url,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
      }),
  };
}

const isDirectEntry =
  typeof process !== 'undefined' &&
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectEntry) {
  const port = Number(process.env.PORT ?? '8787');
  const host = process.env.HOST ?? '127.0.0.1';
  if (process.env.JWT_SECRET === undefined) {
    process.stderr.write(
      'warn: JWT_SECRET not set; generated ephemeral secret for this process only.\n',
    );
  }
  void startNodeSyncServer({
    port: Number.isFinite(port) ? port : 8787,
    host,
  }).then((running) => {
    process.stdout.write(`elv-sync-server listening on ${running.url}\n`);
  });
}
