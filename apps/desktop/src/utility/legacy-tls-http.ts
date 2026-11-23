import * as http from 'node:http';
import * as https from 'node:https';
import {
  createFetchHttpClient,
  type FetchLike,
  type HttpClient,
  type HttpRequestOptions,
} from '@elv/domain';

/** Opt-in legacy TLS floor applied strictly to isolated legacy requests (`#182`). */
export const LEGACY_TLS_MIN_VERSION = 'TLSv1' as const;

/** Opt-in OpenSSL cipher list allowing legacy servers while keeping full certificate validation (`#182`). */
export const LEGACY_TLS_CIPHERS = 'DEFAULT:@SECLEVEL=0' as const;

function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
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

function createNodeLegacyTlsFetch(agent: https.Agent = createLegacyTlsAgent()): FetchLike {
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

      const isHttps = parsed.protocol === 'https:';
      const req = isHttps
        ? https.request(parsed, {
            method: 'GET',
            headers: init.headers,
            agent,
          })
        : http.request(parsed, {
            method: 'GET',
            headers: init.headers,
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
 * modern-TLS `fetchImpl`, and routes ONLY requests with `options.allowLegacyTls === true` through
 * a lazily-allocated isolated legacy TLS client (`#182`).
 */
export function createDesktopHttpClient(
  fetchImpl: FetchLike,
  opts?: { readonly legacyFetchImpl?: FetchLike },
): HttpClient {
  const modernClient = createFetchHttpClient(createHttpOnlyFetch(fetchImpl));
  let legacyClient: HttpClient | undefined;

  const getLegacyClient = (): HttpClient => {
    legacyClient ??= createFetchHttpClient(
      createHttpOnlyFetch(opts?.legacyFetchImpl ?? createNodeLegacyTlsFetch()),
    );
    return legacyClient;
  };

  return {
    get(url: string, options?: HttpRequestOptions) {
      if (options?.allowLegacyTls === true) {
        return getLegacyClient().get(url, options);
      }
      return modernClient.get(url, options);
    },
  };
}
