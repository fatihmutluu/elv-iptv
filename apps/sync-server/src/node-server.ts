import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSyncApp, type SyncAppConfig } from './app.ts';
import { randomBase64Url } from './crypto.ts';
import { createMemoryStorage } from './storage-memory.ts';

/** Options for starting the Node HTTP bridge around `createSyncApp`. */
export interface NodeSyncServerOptions {
  readonly port?: number;
  readonly host?: string;
  readonly jwtSecret?: string;
  readonly adminToken?: string;
  readonly telemetryDisabled?: boolean;
  readonly publicOrigin?: string;
  readonly storage?: SyncAppConfig['storage'];
  readonly verifierHashIterations?: number;
}

/** Running Node HTTP sync server handle. */
export interface RunningNodeSyncServer {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

const MAX_NODE_STREAM_BYTES = 5 * 1024 * 1024;

function readNodeRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.byteLength;
      if (total > MAX_NODE_STREAM_BYTES) {
        settled = true;
        req.destroy();
        rejectBody(new Error('NODE_BODY_LIMIT_EXCEEDED'));
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
  if (!headers.has('x-forwarded-for') && req.socket.remoteAddress) {
    headers.set('x-forwarded-for', req.socket.remoteAddress);
  }
  return headers;
}

async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
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
  const jwtSecret = options.jwtSecret ?? process.env.JWT_SECRET ?? randomBase64Url(32);

  const app = createSyncApp({
    storage: options.storage ?? createMemoryStorage(),
    jwtSecret,
    adminToken: options.adminToken ?? process.env.ADMIN_TOKEN ?? '',
    telemetryDisabled: options.telemetryDisabled ?? process.env.TELEMETRY_DISABLED === 'true',
    publicOrigin: options.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? '*',
    ...(options.verifierHashIterations !== undefined
      ? { verifierHashIterations: options.verifierHashIterations }
      : {}),
  });

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const method = (req.method ?? 'GET').toUpperCase();
        const url = `http://${req.headers.host ?? `${host}:${requestedPort}`}${req.url ?? '/'}`;
        const headers = toWebHeaders(req);
        const hasBody = method !== 'GET' && method !== 'HEAD';
        const bodyBytes = hasBody ? await readNodeRequestBody(req) : undefined;
        const init: RequestInit = { method, headers };
        if (bodyBytes && bodyBytes.byteLength > 0) {
          init.body = new Uint8Array(bodyBytes);
        }
        const webReq = new Request(url, init);
        const webRes = await app.fetch(webReq);
        await writeWebResponse(res, webRes);
      } catch (error) {
        const isTooLarge = error instanceof Error && error.message === 'NODE_BODY_LIMIT_EXCEEDED';
        res.writeHead(isTooLarge ? 413 : 500, {
          'Content-Type': 'application/json; charset=utf-8',
        });
        res.end(JSON.stringify({ error: isTooLarge ? 'payload_too_large' : 'internal_error' }));
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
  if (!process.env.JWT_SECRET) {
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
