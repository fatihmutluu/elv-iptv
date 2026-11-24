import * as dns from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import type { LookupFunction } from 'node:net';
import {
  createFetchHttpClient,
  type DnsFamilyPreference,
  err,
  type FetchLike,
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

function createNodeHeaders(raw: http.IncomingHttpHeaders): {
  forEach(cb: (value: string, key: string) => void): void;
  get(name: string): string | null;
  getSetCookie(): string[];
} {
  const entries: Array<[string, string]> = [];
  const setCookies: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
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

function streamIncomingMessage(res: http.IncomingMessage): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      try {
        for await (const chunk of res) {
          if (chunk instanceof Uint8Array) {
            yield new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          } else {
            yield Buffer.from(chunk as string);
          }
        }
      } finally {
        if (!res.destroyed) res.destroy();
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

      req.once('error', (error) => {
        detachAbort();
        reject(error);
      });

      req.once('response', (res) => {
        res.once('close', detachAbort);
        resolve({
          status: res.statusCode ?? 0,
          url,
          headers: createNodeHeaders(res.headers),
          body: streamIncomingMessage(res),
        });
      });

      req.end();
    });
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
  const modernClient = createFetchHttpClient(createHttpOnlyFetch(fetchImpl));
  let legacyFetchClient: HttpClient | undefined;
  let legacyAgent: https.Agent | undefined;
  let modernAgent: https.Agent | undefined;

  const getLegacyAgent = (): https.Agent => {
    legacyAgent ??= createLegacyTlsAgent();
    return legacyAgent;
  };
  const getModernAgent = (): https.Agent => {
    modernAgent ??= createModernHttpsAgent();
    return modernAgent;
  };
  const getLegacyFetchClient = (): HttpClient => {
    legacyFetchClient ??= createFetchHttpClient(
      createHttpOnlyFetch(opts?.legacyFetchImpl as FetchLike),
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
      const transportFetch = createNodeTransportFetch({
        agent: allowLegacyTls ? getLegacyAgent() : getModernAgent(),
        dnsFamily,
        hostOverride,
        overrideFamily,
        initialHost,
        dnsLookup: opts?.dnsLookup ?? dns.lookup,
        httpRequest: opts?.httpRequest ?? http.request,
        httpsRequest: opts?.httpsRequest ?? https.request,
      });
      return createFetchHttpClient(createHttpOnlyFetch(transportFetch)).get(url, options);
    },
  };
}
