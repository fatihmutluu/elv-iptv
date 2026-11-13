import { elvError, err, ok, type Result } from './result';

/** A response whose body streams in chunks. */
export interface HttpResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: AsyncIterable<Uint8Array>;
}

/** Per-request options. */
export interface HttpRequestOptions {
  headers?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Port for HTTP GET; platforms supply an implementation. Errors never contain credentials. */
export interface HttpClient {
  get(url: string, options?: HttpRequestOptions): Promise<Result<HttpResponse>>;
}

/** The subset of WHATWG `fetch` this port needs. */
export type FetchLike = (
  url: string,
  init: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  status: number;
  headers: { forEach(cb: (value: string, key: string) => void): void };
  body:
    | AsyncIterable<Uint8Array>
    | {
        getReader(): {
          read(): Promise<{ done: boolean; value?: Uint8Array }>;
          releaseLock(): void;
        };
      }
    | null;
}>;

/** Port for gzip decoding of a chunk stream. */
export interface Decompressor {
  gunzip(chunks: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array>;
}

type FetchBody = Awaited<ReturnType<FetchLike>>['body'];

async function* streamBody(body: FetchBody): AsyncGenerator<Uint8Array> {
  if (body === null) return;
  if (Symbol.asyncIterator in body) {
    yield* body;
    return;
  }
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value !== undefined) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Adapts a WHATWG fetch with a streaming body (Node/Electron fetch, expo/fetch). */
export function createFetchHttpClient(
  fetchImpl: FetchLike,
  defaults?: { timeoutMs?: number },
): HttpClient {
  return {
    async get(url, options) {
      const timeoutMs = options?.timeoutMs ?? defaults?.timeoutMs;
      const controller = new AbortController();
      let timedOut = false;
      const caller = options?.signal;
      if (caller?.aborted) return err(elvError('network', 'aborted'));
      const onCallerAbort = () => controller.abort();
      caller?.addEventListener('abort', onCallerAbort);
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              controller.abort();
            }, timeoutMs);
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
      aborted.catch(() => {});
      try {
        const init: { headers?: Record<string, string>; signal: AbortSignal } = {
          signal: controller.signal,
        };
        if (options?.headers) init.headers = { ...options.headers };
        const res = await Promise.race([fetchImpl(url, init), aborted]);
        if (res.status === 401 || res.status === 403)
          return err(elvError('auth', `http-${res.status}`));
        if (res.status < 200 || res.status >= 300)
          return err(elvError('network', `http-${res.status}`));
        const headers: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          headers[key.toLowerCase()] = value;
        });
        return ok({ status: res.status, headers, body: streamBody(res.body) });
      } catch {
        if (timedOut) return err(elvError('network', 'timeout'));
        if (caller?.aborted) return err(elvError('network', 'aborted'));
        return err(elvError('network', 'fetch-failed'));
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        caller?.removeEventListener('abort', onCallerAbort);
      }
    },
  };
}
