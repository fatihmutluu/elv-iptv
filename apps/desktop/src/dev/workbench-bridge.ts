import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import {
  type CatalogService,
  createCatalogService,
  createSyncSqlDriver,
  openCatalog,
  type SyncDatabase,
} from '@elv/data';
import { createFetchHttpClient, elvError, err, type FetchLike, type SqlDriver } from '@elv/domain';
import Database from 'better-sqlite3';
import { createNodeGzipDecompressor } from '../utility/node-gzip-decompressor.ts';
import { ALLOWED_RPC_METHODS, dispatchWorkbenchRpc, isPositiveSafeInt } from './workbench-rpc.ts';
import { createWorkbenchSecretStore } from './workbench-secret-store.ts';

const MAX_BODY_BYTES = 256 * 1024;
const LOOPBACK_HOST_RE = /^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/i;
const LOOPBACK_ORIGIN_RE = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/i;

/** Options for starting the dev-only loopback workbench data bridge. */
export interface WorkbenchBridgeOptions {
  dataDir: string;
  token: string;
  host?: string;
  port?: number;
  fetchImpl?: FetchLike;
  openDatabase?: (filePath: string) => SyncDatabase;
}

/** Running loopback workbench data bridge handle. */
export interface WorkbenchBridgeHandle {
  readonly port: number;
  readonly baseUrl: string;
  close(): Promise<void>;
}

class PayloadTooLargeError extends Error {}

function isHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

function createHttpOnlyFetch(fetchImpl: FetchLike): FetchLike {
  return async (url, init) => {
    if (!isHttpUrl(url)) throw new TypeError('unsupported URL protocol');
    return fetchImpl(url, init);
  };
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const declaredLen = req.headers['content-length'];
  if (typeof declaredLen === 'string') {
    const parsedLen = Number(declaredLen);
    if (Number.isFinite(parsedLen) && parsedLen > MAX_BODY_BYTES) {
      req.resume();
      throw new PayloadTooLargeError();
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.byteLength;
    if (total > MAX_BODY_BYTES) throw new PayloadTooLargeError();
    chunks.push(buf);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function defaultOpenDatabase(filePath: string): SyncDatabase {
  mkdirSync(dirname(filePath), { recursive: true });
  return new Database(filePath);
}

/**
 * Starts the dev-only loopback HTTP bridge exposing a real SQLite-backed {@link CatalogService}
 * to the browser UI Workbench (`pnpm dev:ui`). Never returns real provider stream URLs or
 * credentials over HTTP.
 */
export async function createWorkbenchBridge(
  opts: WorkbenchBridgeOptions,
): Promise<WorkbenchBridgeHandle> {
  const host = opts.host ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error('workbench bridge host must be loopback');
  }
  if (typeof opts.token !== 'string' || opts.token.trim().length === 0) {
    throw new Error('workbench bridge token must be non-empty');
  }

  const expectedTokenHash = createHash('sha256').update(opts.token, 'utf8').digest();
  const isValidToken = (raw: string | string[] | undefined): boolean => {
    if (typeof raw !== 'string' || raw.length === 0) return false;
    return timingSafeEqual(createHash('sha256').update(raw, 'utf8').digest(), expectedTokenHash);
  };

  const openDb = opts.openDatabase ?? defaultOpenDatabase;
  const db: SqlDriver = createSyncSqlDriver(openDb(join(opts.dataDir, 'catalog.db')));
  const opened = await openCatalog(db, Date.now);
  if (!opened.ok) {
    await db.close?.().catch(() => undefined);
    throw new Error(`failed to open workbench catalog: ${opened.error.code}`);
  }

  const service: CatalogService = createCatalogService({
    db,
    secrets: createWorkbenchSecretStore(opts.dataDir),
    scheduler: { yieldNow: () => new Promise<void>((resolve) => setImmediate(resolve)) },
    http: createFetchHttpClient(
      createHttpOnlyFetch(opts.fetchImpl ?? (fetch as unknown as FetchLike)),
    ),
    clock: Date.now,
    decompressor: createNodeGzipDecompressor(),
  });

  const activeImports = new Set<AbortController>();
  const inFlight = new Set<Promise<void>>();
  const checkpointWal = () => db.exec('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => undefined);
  const rpcCtx = { db, service, activeImports, checkpointWal };

  const handleImport = async (
    body: Record<string, unknown>,
    res: ServerResponse,
  ): Promise<void> => {
    const id = body.id;
    const batchSize = body.batchSize;
    const maxBodyBytes = body.maxBodyBytes;
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      (batchSize !== undefined && !isPositiveSafeInt(batchSize)) ||
      (maxBodyBytes !== undefined && !isPositiveSafeInt(maxBodyBytes))
    ) {
      writeJson(res, 400, { error: { category: 'source-format', code: 'invalid-request' } });
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.flushHeaders();

    const ctl = new AbortController();
    activeImports.add(ctl);
    const onClose = () => {
      if (!res.writableEnded) ctl.abort();
    };
    res.on('close', onClose);
    try {
      const result = await service.importSource(id, {
        signal: ctl.signal,
        ...(batchSize === undefined ? {} : { batchSize }),
        ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
        onProgress: (progress) => {
          if (!res.writableEnded && !res.destroyed) {
            res.write(`${JSON.stringify({ type: 'progress', progress })}\n`);
          }
        },
      });
      await checkpointWal();
      if (!res.writableEnded && !res.destroyed) {
        res.write(`${JSON.stringify({ type: 'result', result })}\n`);
        res.end();
      }
    } catch {
      if (!res.writableEnded && !res.destroyed) {
        res.write(
          `${JSON.stringify({ type: 'result', result: err(elvError('storage', 'sql-failed')) })}\n`,
        );
        res.end();
      }
    } finally {
      res.off('close', onClose);
      activeImports.delete(ctl);
    }
  };

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const hostHeader = typeof req.headers.host === 'string' ? req.headers.host : '';
    if (!LOOPBACK_HOST_RE.test(hostHeader)) {
      writeJson(res, 403, { error: { category: 'security', code: 'forbidden-host' } });
      return;
    }

    const originHeader = req.headers.origin;
    if (originHeader !== undefined) {
      if (typeof originHeader !== 'string' || !LOOPBACK_ORIGIN_RE.test(originHeader)) {
        writeJson(res, 403, { error: { category: 'security', code: 'forbidden-origin' } });
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', originHeader);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Elv-Workbench-Token');
    }

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (!isValidToken(req.headers['x-elv-workbench-token'])) {
      writeJson(res, 401, { error: { category: 'auth', code: 'unauthorized' } });
      return;
    }

    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (req.method === 'GET' && pathname === '/health') {
      writeJson(res, 200, { ok: true, version: 1 });
      return;
    }

    if (req.method === 'POST' && (pathname === '/rpc' || pathname === '/rpc/import')) {
      let body: Record<string, unknown> | null;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        const status = error instanceof PayloadTooLargeError ? 413 : 400;
        const code = status === 413 ? 'payload-too-large' : 'invalid-request';
        writeJson(res, status, { error: { category: 'storage', code } });
        return;
      }
      if (body === null) {
        writeJson(res, 400, { error: { category: 'source-format', code: 'invalid-request' } });
        return;
      }
      if (pathname === '/rpc/import') {
        await handleImport(body, res);
        return;
      }
      const method = body.method;
      const args = body.args;
      if (typeof method !== 'string' || !Array.isArray(args)) {
        writeJson(res, 400, { error: { category: 'source-format', code: 'invalid-request' } });
        return;
      }
      if (!ALLOWED_RPC_METHODS.has(method)) {
        writeJson(res, 400, { error: { category: 'storage', code: 'unknown-method' } });
        return;
      }
      try {
        writeJson(res, 200, { value: await dispatchWorkbenchRpc(rpcCtx, method, args, res) });
      } catch {
        writeJson(res, 500, { error: { category: 'storage', code: 'rpc-failed' } });
      }
      return;
    }

    writeJson(res, 404, { error: { category: 'storage', code: 'not-found' } });
  };

  const server: Server = createServer((req, res) => {
    const task = handleRequest(req, res).catch(() => {
      writeJson(res, 500, { error: { category: 'storage', code: 'internal-error' } });
    });
    inFlight.add(task);
    void task.finally(() => {
      inFlight.delete(task);
    });
  });

  const boundPort = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('unexpected server address'));
        return;
      }
      resolve(addr.port);
    });
  }).catch(async (error: unknown) => {
    await service.close().catch(() => undefined);
    throw error;
  });

  let closePromise: Promise<void> | undefined;
  return {
    port: boundPort,
    baseUrl: `http://${host}:${boundPort}`,
    close() {
      if (closePromise !== undefined) return closePromise;
      closePromise = (async () => {
        for (const ctl of activeImports) ctl.abort();
        activeImports.clear();
        await new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        });
        if (inFlight.size > 0) await Promise.allSettled([...inFlight]);
        await service.close().catch(() => undefined);
      })();
      return closePromise;
    },
  };
}
