import * as dns from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import type { LookupFunction } from 'node:net';
import { Duplex, type Transform } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate, createInflateRaw } from 'node:zlib';
import {
  createFetchHttpClient,
  type DnsFamilyPreference,
  err,
  type FetchLike,
  type HostConnectivityGuard,
  type HttpClient,
  type HttpRequestOptions,
  ipLiteralFamily,
  normalizeDnsFamily,
  validateHostOverride,
} from '@elv/domain';

/** Opt-in legacy TLS floor applied strictly to isolated legacy requests (`#182`). */
export const LEGACY_TLS_MIN_VERSION = 'TLSv1' as const;

/** Opt-in OpenSSL cipher list allowing legacy servers while keeping full certificate validation (`#182`). */
export const LEGACY_TLS_CIPHERS = 'DEFAULT:@SECLEVEL=0' as const;

/** Optional transport overrides injected by tests for {@link createDesktopHttpClient}. */
export interface DesktopHttpClientOptions {
  readonly legacyFetchImpl?: FetchLike;
  readonly dnsLookup?: typeof dns.lookup;
  readonly httpRequest?: typeof http.request;
  readonly httpsRequest?: typeof https.request;
  readonly connectivityGuard?: HostConnectivityGuard;
}

function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function isHttpUrl(raw: string): boolean {
  if (raw === '' || hasControlChar(raw)) return false;
  try {
    const parsed = new URL(raw);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

async function cancelFetchBody(body: Awaited<ReturnType<FetchLike>>['body']): Promise<void> {
  if (body == null) return;
  const cancellable = body as {
    cancel?: () => Promise<void>;
    getReader?: () => { cancel?: () => Promise<void> };
  };
  if (typeof cancellable.cancel === 'function') {
    await cancellable.cancel().catch(() => undefined);
    return;
  }
  if (typeof cancellable.getReader === 'function') {
    await cancellable
      .getReader()
      .cancel?.()
      .catch(() => undefined);
  }
}

function createHttpOnlyFetch(fetchImpl: FetchLike): FetchLike {
  return async (url, init) => {
    if (!isHttpUrl(url)) {
      throw new TypeError('unsupported URL protocol');
    }
    const res = await fetchImpl(url, init);
    const finalUrl = (res as { readonly url?: unknown }).url;
    if (typeof finalUrl === 'string' && finalUrl !== '' && !isHttpUrl(finalUrl)) {
      await cancelFetchBody(res.body);
      throw new TypeError('unsupported redirect URL protocol');
    }
    return res;
  };
}

/**
 * Creates an isolated Node `https.Agent` allowing TLS 1.0+ and legacy ciphers strictly for opt-in
 * legacy sources (`#182`). Certificate verification (`rejectUnauthorized: true`) is NEVER disabled.
 */
export function createLegacyTlsAgent(): https.Agent {
  return new https.Agent({
    minVersion: LEGACY_TLS_MIN_VERSION,
    ciphers: LEGACY_TLS_CIPHERS,
    keepAlive: false,
    rejectUnauthorized: true,
  });
}

function createModernHttpsAgent(): https.Agent {
  return new https.Agent({
    keepAlive: false,
    rejectUnauthorized: true,
  });
}

type ContentEncoding = 'gzip' | 'deflate' | 'br';

const NO_BODY_STATUSES = new Set([204, 205, 304]);
const MAX_CONTENT_ENCODING_LAYERS = 4;

function parseContentEncodings(
  raw: string | string[] | undefined,
  status: number,
): readonly ContentEncoding[] | undefined {
  if (raw === undefined || status < 200 || NO_BODY_STATUSES.has(status)) return undefined;
  const joined = Array.isArray(raw) ? raw.join(',') : raw;
  const parsed: ContentEncoding[] = [];
  for (const part of joined.split(',')) {
    const token = part.trim().toLowerCase();
    if (token === '' || token === 'identity') continue;
    if (token === 'gzip' || token === 'x-gzip') parsed.push('gzip');
    else if (token === 'deflate' || token === 'x-deflate') parsed.push('deflate');
    else if (token === 'br') parsed.push('br');
    else return undefined;
  }
  if (parsed.length === 0 || parsed.length > MAX_CONTENT_ENCODING_LAYERS) return undefined;
  return parsed;
}

function isZlibHeader(b0: number, b1: number): boolean {
  return (b0 & 0x0f) === 8 && b0 >>> 4 <= 7 && ((b0 << 8) | b1) % 31 === 0;
}

const MAX_SMART_INFLATE_REPLAY_BYTES = 64 * 1024;

type WriteCallback = (error?: Error | null) => void;

/**
 * Inflates HTTP `Content-Encoding: deflate`, handling both RFC 1950 zlib-wrapped streams and
 * servers emitting raw RFC 1951 deflate without a zlib header (checking first-2-byte header and
 * falling back cleanly on pre-output `Z_DATA_ERROR`, with bounded 64 KiB replay buffer and full
 * readable/writable backpressure).
 */
export function createSmartInflate(opts?: { readonly highWaterMark?: number }): Duplex {
  const hwm = opts?.highWaterMark;
  let inner: Transform | undefined;
  let headBuf: Buffer = Buffer.alloc(0);
  let initialChunks: Buffer[] = [];
  let initialBytes = 0;
  let replayDisabled = false;
  let emittedOutput = false;
  let fellBack = false;
  let flushing = false;
  let flushCb: WriteCallback | undefined;
  let pendingWriteCb: WriteCallback | undefined;

  const recordInitial = (buf: Buffer): void => {
    if (emittedOutput || fellBack || replayDisabled) return;
    if (initialBytes + buf.length > MAX_SMART_INFLATE_REPLAY_BYTES) {
      initialChunks = [];
      initialBytes = 0;
      replayDisabled = true;
      return;
    }
    initialChunks.push(buf);
    initialBytes += buf.length;
  };

  const writeToInner = (stream: Transform, buf: Buffer, cb: WriteCallback): void => {
    if (stream.write(buf)) {
      cb();
      return;
    }
    pendingWriteCb = cb;
    stream.once('drain', () => {
      if (inner !== stream) return;
      const done = pendingWriteCb;
      pendingWriteCb = undefined;
      done?.();
    });
  };

  const outer = new Duplex({
    ...(hwm === undefined ? {} : { readableHighWaterMark: hwm, writableHighWaterMark: hwm }),
    read() {
      inner?.resume();
    },
    write(chunk: Buffer, _enc, cb) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buf.length === 0) {
        cb();
        return;
      }
      if (inner !== undefined) {
        recordInitial(buf);
        writeToInner(inner, buf, cb);
        return;
      }
      headBuf = headBuf.length === 0 ? buf : Buffer.concat([headBuf, buf]);
      if (headBuf.length < 2) {
        cb();
        return;
      }
      const combined = headBuf;
      headBuf = Buffer.alloc(0);
      attachInner(isZlibHeader(combined[0] as number, combined[1] as number), combined, cb);
    },
    final(cb) {
      flushing = true;
      flushCb = cb;
      if (inner === undefined) {
        if (headBuf.length === 0) {
          outer.push(null);
          flushCb = undefined;
          cb();
          return;
        }
        const tail = headBuf;
        headBuf = Buffer.alloc(0);
        attachInner(false, tail, (err) => {
          if (err) {
            const done = flushCb;
            flushCb = undefined;
            done?.(err);
          } else {
            inner?.end();
          }
        });
        return;
      }
      inner.end();
    },
    destroy(error, cb) {
      initialChunks = [];
      initialBytes = 0;
      headBuf = Buffer.alloc(0);
      pendingWriteCb = undefined;
      flushCb = undefined;
      if (inner !== undefined && !inner.destroyed) inner.destroy();
      inner = undefined;
      cb(error);
    },
  });

  const attachInner = (useZlib: boolean, firstChunk: Buffer, cb: WriteCallback): void => {
    const zlibOpts = hwm === undefined ? undefined : { chunkSize: Math.max(64, hwm) };
    const stream = useZlib ? createInflate(zlibOpts) : createInflateRaw(zlibOpts);
    inner = stream;
    if (useZlib && !fellBack) recordInitial(firstChunk);
    const onData = (out: Buffer) => {
      if (inner !== stream) return;
      emittedOutput = true;
      initialChunks = [];
      initialBytes = 0;
      if (!outer.push(out)) stream.pause();
    };
    const onEnd = () => {
      if (inner !== stream) return;
      outer.push(null);
      const done = flushCb;
      flushCb = undefined;
      done?.();
    };
    const onError = (error: NodeJS.ErrnoException) => {
      if (inner !== stream) return;
      if (
        useZlib &&
        !emittedOutput &&
        !fellBack &&
        !replayDisabled &&
        error.code === 'Z_DATA_ERROR'
      ) {
        fellBack = true;
        stream.off('data', onData);
        stream.off('end', onEnd);
        stream.off('error', onError);
        stream.destroy();
        const savedWriteCb = pendingWriteCb;
        pendingWriteCb = undefined;
        const replay = Buffer.concat(initialChunks);
        initialChunks = [];
        initialBytes = 0;
        attachInner(false, replay, (replayErr) => {
          savedWriteCb?.(replayErr);
          if (!replayErr && flushing) inner?.end();
        });
        return;
      }
      const wDone = pendingWriteCb;
      pendingWriteCb = undefined;
      const fDone = flushCb;
      flushCb = undefined;
      if (wDone !== undefined) wDone(error);
      else if (fDone !== undefined) fDone(error);
      else outer.destroy(error);
    };
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
    writeToInner(stream, firstChunk, cb);
  };

  return outer;
}

function createEncodingStage(encoding: ContentEncoding): Duplex {
  if (encoding === 'gzip') return createGunzip();
  if (encoding === 'br') return createBrotliDecompress();
  return createSmartInflate();
}

function createNodeHeaders(
  raw: http.IncomingHttpHeaders,
  stripEncoding: boolean,
): {
  forEach(cb: (value: string, key: string) => void): void;
  get(name: string): string | null;
  getSetCookie(): string[];
} {
  const entries: Array<[string, string]> = [];
  const setCookies: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (stripEncoding && (lower === 'content-encoding' || lower === 'content-length')) continue;
    if (lower === 'set-cookie') {
      if (Array.isArray(value)) setCookies.push(...value);
      else setCookies.push(value);
    }
    entries.push([lower, Array.isArray(value) ? value.join(', ') : value]);
  }
  const map = new Map<string, string>(entries);
  return {
    forEach(cb) {
      for (const [k, v] of entries) cb(v, k);
    },
    get(name) {
      return map.get(name.toLowerCase()) ?? null;
    },
    getSetCookie() {
      return [...setCookies];
    },
  };
}

function toUint8Array(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  return Buffer.from(chunk as string);
}

function streamIncomingMessage(
  res: http.IncomingMessage,
  encodings: readonly ContentEncoding[] | undefined,
  signal: AbortSignal | undefined,
): AsyncIterable<Uint8Array> {
  if (encodings === undefined || encodings.length === 0) {
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        try {
          for await (const chunk of res) {
            yield toUint8Array(chunk);
          }
        } finally {
          if (!res.destroyed) res.destroy();
        }
      },
    };
  }

  return {
    async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      const it = res[Symbol.asyncIterator]();
      const abortFirst = (): void => {
        if (!res.destroyed) {
          res.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }
      };
      if (signal?.aborted) {
        abortFirst();
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      signal?.addEventListener('abort', abortFirst, { once: true });
      let firstChunk: Uint8Array | undefined;
      try {
        for (;;) {
          const step = await it.next();
          if (step.done) return;
          const bytes = toUint8Array(step.value);
          if (bytes.length > 0) {
            firstChunk = bytes;
            break;
          }
        }
      } catch (error) {
        if (!res.destroyed) res.destroy();
        throw error;
      } finally {
        signal?.removeEventListener('abort', abortFirst);
      }

      const stages = [...encodings].reverse().map(createEncodingStage);
      const firstStage = stages[0] as Duplex;
      const lastStage = stages[stages.length - 1] as Duplex;
      for (let i = 0; i < stages.length - 1; i++) {
        (stages[i] as Duplex).pipe(stages[i + 1] as Duplex);
      }

      let cancelled = false;
      const destroyAll = (error?: Error): void => {
        for (const stage of stages) {
          if (!stage.destroyed) stage.destroy(stage === lastStage ? error : undefined);
        }
        if (!res.destroyed) res.destroy();
      };
      for (let i = 0; i < stages.length - 1; i++) {
        (stages[i] as Duplex).on('error', (error) => {
          destroyAll(error instanceof Error ? error : new Error(String(error)));
        });
      }
      const onAbort = (): void => {
        cancelled = true;
        destroyAll(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const writeChunk = async (chunk: Uint8Array): Promise<void> => {
        if (cancelled || firstStage.destroyed) return;
        if (!firstStage.write(chunk)) {
          await new Promise<void>((resolve) => {
            if (
              cancelled ||
              firstStage.destroyed ||
              firstStage.closed ||
              firstStage.errored ||
              firstStage.writableEnded
            ) {
              resolve();
              return;
            }
            const done = () => {
              firstStage.off('drain', done);
              firstStage.off('close', done);
              firstStage.off('error', done);
              resolve();
            };
            firstStage.once('drain', done);
            firstStage.once('close', done);
            firstStage.once('error', done);
          });
        }
      };

      const pump = (async () => {
        try {
          if (firstChunk !== undefined) await writeChunk(firstChunk);
          for (;;) {
            if (cancelled || firstStage.destroyed) break;
            const step = await it.next();
            if (step.done) break;
            const bytes = toUint8Array(step.value);
            if (bytes.length > 0) await writeChunk(bytes);
          }
          if (!cancelled && !firstStage.destroyed) firstStage.end();
        } catch (error) {
          destroyAll(error instanceof Error ? error : new Error(String(error)));
        }
      })();
      pump.catch(() => undefined);

      try {
        for await (const out of lastStage) {
          yield toUint8Array(out);
        }
      } finally {
        cancelled = true;
        signal?.removeEventListener('abort', onAbort);
        destroyAll();
        await it.return?.().catch(() => undefined);
        await pump;
      }
    },
  };
}

interface NodeTransportConfig {
  readonly agent: https.Agent;
  readonly dnsFamily: DnsFamilyPreference;
  readonly hostOverride: string | undefined;
  readonly overrideFamily: 4 | 6 | undefined;
  readonly initialHost: string;
  readonly dnsLookup: typeof dns.lookup;
  readonly httpRequest: typeof http.request;
  readonly httpsRequest: typeof https.request;
  readonly onConnect?: (url: string) => void;
}

function createScopedLookup(cfg: NodeTransportConfig, allowOverrideOnHop: boolean): LookupFunction {
  return (hostname, lookupOpts, cb) => {
    const normalizedOpts: dns.LookupOptions =
      typeof lookupOpts === 'number' ? { family: lookupOpts } : { ...lookupOpts };
    const lookupHost = stripBrackets(hostname).toLowerCase();
    if (
      allowOverrideOnHop &&
      lookupHost === cfg.initialHost &&
      cfg.hostOverride !== undefined &&
      cfg.overrideFamily !== undefined
    ) {
      if (normalizedOpts.all === true) {
        (cb as (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void)(null, [
          { address: cfg.hostOverride, family: cfg.overrideFamily },
        ]);
      } else {
        (cb as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(
          null,
          cfg.hostOverride,
          cfg.overrideFamily,
        );
      }
      return;
    }
    if (cfg.dnsFamily === 'ipv4' || cfg.dnsFamily === 'ipv6') {
      const family = cfg.dnsFamily === 'ipv4' ? 4 : 6;
      cfg.dnsLookup(hostname, { ...normalizedOpts, family }, cb as never);
      return;
    }
    cfg.dnsLookup(hostname, normalizedOpts, cb as never);
  };
}

function createNodeTransportFetch(cfg: NodeTransportConfig): FetchLike {
  return (url, init) =>
    new Promise((resolve, reject) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch (error) {
        reject(error);
        return;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        reject(new TypeError('unsupported URL protocol'));
        return;
      }
      if (init.signal?.aborted) {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        return;
      }

      const hopHost = stripBrackets(parsed.hostname).toLowerCase();
      const allowOverrideOnHop =
        cfg.hostOverride !== undefined &&
        cfg.overrideFamily !== undefined &&
        hopHost === cfg.initialHost;
      const lookup = createScopedLookup(cfg, allowOverrideOnHop);
      const isHttps = parsed.protocol === 'https:';
      const isIpHost = ipLiteralFamily(hopHost) !== undefined;
      const req = isHttps
        ? cfg.httpsRequest(parsed, {
            method: 'GET',
            headers: init.headers,
            agent: cfg.agent,
            rejectUnauthorized: true,
            lookup,
            ...(isIpHost ? {} : { servername: parsed.hostname }),
          })
        : cfg.httpRequest(parsed, {
            method: 'GET',
            headers: init.headers,
            agent: false,
            lookup,
          });

      const onAbort = (): void => {
        req.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      };
      init.signal?.addEventListener('abort', onAbort, { once: true });

      const detachAbort = (): void => {
        init.signal?.removeEventListener('abort', onAbort);
      };

      if (cfg.onConnect !== undefined) {
        const notifyConnected = cfg.onConnect;
        req.once('socket', (socket) => {
          if (!socket.connecting) notifyConnected(url);
          else socket.once('connect', () => notifyConnected(url));
        });
      }

      req.once('error', (error) => {
        detachAbort();
        reject(error);
      });

      req.once('response', (res) => {
        res.once('close', detachAbort);
        const status = res.statusCode ?? 0;
        const encodings = parseContentEncodings(res.headers['content-encoding'], status);
        resolve({
          status,
          url,
          headers: createNodeHeaders(res.headers, encodings !== undefined),
          body: streamIncomingMessage(res, encodings, init.signal),
        });
      });

      req.end();
    });
}

/** Single-hop request descriptor for {@link createDesktopSingleHopTransport}. */
interface SingleHopTransportRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly allowLegacyTls?: boolean;
  readonly dnsFamily?: DnsFamilyPreference;
  readonly hostOverride?: string;
  readonly initialHost?: string;
}

/** Single-hop raw HTTP/HTTPS transport preserving 3xx status codes and `Location` headers. */
export interface DesktopSingleHopTransport {
  fetchHop(req: SingleHopTransportRequest): ReturnType<FetchLike>;
}

function createLazyAgentSelector(): (allowLegacyTls: boolean) => https.Agent {
  let legacyAgent: https.Agent | undefined;
  let modernAgent: https.Agent | undefined;
  return (allowLegacyTls) => {
    if (allowLegacyTls) {
      legacyAgent ??= createLegacyTlsAgent();
      return legacyAgent;
    }
    modernAgent ??= createModernHttpsAgent();
    return modernAgent;
  };
}

/**
 * Creates a single-hop Node HTTP/HTTPS transport that supports opt-in legacy TLS, `dnsFamily`,
 * and initial-host-scoped `hostOverride` WITHOUT following 3xx redirects internally so callers
 * can drive manual hop-by-hop SSRF validation.
 */
export function createDesktopSingleHopTransport(
  opts?: DesktopHttpClientOptions,
): DesktopSingleHopTransport {
  const selectAgent = createLazyAgentSelector();

  return {
    async fetchHop(req: SingleHopTransportRequest) {
      const hostRes = validateHostOverride(req.hostOverride);
      if (!hostRes.ok) {
        throw new Error(hostRes.error.code);
      }
      if (!isHttpUrl(req.url)) {
        throw new TypeError('unsupported URL protocol');
      }
      const hostOverride = hostRes.value;
      const dnsFamily: DnsFamilyPreference = normalizeDnsFamily(req.dnsFamily) ?? 'system';
      const allowLegacyTls = req.allowLegacyTls === true;
      const hasCustomNetwork = dnsFamily !== 'system' || hostOverride !== undefined;
      const hopInit = {
        headers: req.headers,
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
        redirect: 'manual' as const,
      };

      if (allowLegacyTls && !hasCustomNetwork && opts?.legacyFetchImpl !== undefined) {
        return opts.legacyFetchImpl(req.url, hopInit);
      }

      const hopHost = stripBrackets(new URL(req.url).hostname).toLowerCase();
      const scopedInitialHost =
        req.initialHost !== undefined && req.initialHost.trim().length > 0
          ? stripBrackets(req.initialHost.trim()).toLowerCase()
          : hopHost;
      const overrideFamily = hostOverride !== undefined ? ipLiteralFamily(hostOverride) : undefined;
      const transportFetch = createNodeTransportFetch({
        agent: selectAgent(allowLegacyTls),
        dnsFamily,
        hostOverride,
        overrideFamily,
        initialHost: scopedInitialHost,
        dnsLookup: opts?.dnsLookup ?? dns.lookup,
        httpRequest: opts?.httpRequest ?? http.request,
        httpsRequest: opts?.httpsRequest ?? https.request,
      });
      return transportFetch(req.url, hopInit);
    },
  };
}

/**
 * Desktop catalog {@link HttpClient}: routes default requests strictly through the standard
 * modern-TLS `fetchImpl`, and routes requests specifying `allowLegacyTls`, `dnsFamily: 'ipv4' | 'ipv6'`,
 * or a validated `hostOverride` through Node `http.request`/`https.request` with scoped DNS lookup,
 * preserved TLS SNI, and strict certificate verification (`#182`, `#172`).
 */
export function createDesktopHttpClient(
  fetchImpl: FetchLike,
  opts?: DesktopHttpClientOptions,
): HttpClient {
  const fetchClientDefaults =
    opts?.connectivityGuard === undefined
      ? undefined
      : { connectivityGuard: opts.connectivityGuard, trustTimeoutAsPreConnect: false };
  const nodeTransportDefaults =
    opts?.connectivityGuard === undefined
      ? undefined
      : { connectivityGuard: opts.connectivityGuard, trustTimeoutAsPreConnect: true };
  const modernClient = createFetchHttpClient(createHttpOnlyFetch(fetchImpl), fetchClientDefaults);
  const selectAgent = createLazyAgentSelector();
  let legacyFetchClient: HttpClient | undefined;
  const getLegacyFetchClient = (): HttpClient => {
    legacyFetchClient ??= createFetchHttpClient(
      createHttpOnlyFetch(opts?.legacyFetchImpl as FetchLike),
      fetchClientDefaults,
    );
    return legacyFetchClient;
  };

  return {
    get(url: string, options?: HttpRequestOptions) {
      const hostRes = validateHostOverride(options?.hostOverride);
      if (!hostRes.ok) {
        return Promise.resolve(err(hostRes.error));
      }
      const hostOverride = hostRes.value;
      const dnsFamily: DnsFamilyPreference = normalizeDnsFamily(options?.dnsFamily) ?? 'system';
      const allowLegacyTls = options?.allowLegacyTls === true;
      const hasCustomNetwork = dnsFamily !== 'system' || hostOverride !== undefined;

      if (!allowLegacyTls && !hasCustomNetwork) {
        return modernClient.get(url, options);
      }
      if (allowLegacyTls && !hasCustomNetwork && opts?.legacyFetchImpl !== undefined) {
        return getLegacyFetchClient().get(url, options);
      }

      if (!isHttpUrl(url)) {
        return modernClient.get(url, options);
      }
      const initialHost = stripBrackets(new URL(url).hostname).toLowerCase();
      const overrideFamily = hostOverride !== undefined ? ipLiteralFamily(hostOverride) : undefined;
      const connectivityGuard = opts?.connectivityGuard;
      const transportFetch = createNodeTransportFetch({
        agent: selectAgent(allowLegacyTls),
        dnsFamily,
        hostOverride,
        overrideFamily,
        initialHost,
        dnsLookup: opts?.dnsLookup ?? dns.lookup,
        httpRequest: opts?.httpRequest ?? http.request,
        httpsRequest: opts?.httpsRequest ?? https.request,
        ...(connectivityGuard === undefined
          ? {}
          : {
              onConnect: (connectedUrl: string) =>
                connectivityGuard.reportOriginConnected(connectedUrl),
            }),
      });
      return createFetchHttpClient(createHttpOnlyFetch(transportFetch), nodeTransportDefaults).get(
        url,
        options,
      );
    },
  };
}
