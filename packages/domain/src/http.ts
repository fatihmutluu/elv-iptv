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
  /** Covers the time until the response headers arrive; a body already streaming is not timed. */
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
          cancel?(reason?: unknown): Promise<void>;
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

interface ChunkSource {
  next(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
  release(): void;
}

function openSource(body: NonNullable<FetchBody>): ChunkSource {
  if (Symbol.asyncIterator in body) {
    const it = body[Symbol.asyncIterator]();
    return {
      next: async () => {
        const r = await it.next();
        return r.done ? { done: true } : { done: false, value: r.value };
      },
      cancel: async () => {
        await it.return?.();
      },
      release: () => {},
    };
  }
  const reader = body.getReader();
  return {
    next: () => reader.read(),
    cancel: async () => {
      await reader.cancel?.();
    },
    release: () => reader.releaseLock(),
  };
}

async function cancelQuietly(source: ChunkSource): Promise<void> {
  try {
    await source.cancel();
  } catch {
    // The stream is being abandoned; a failing cancel changes nothing for the caller.
  }
}

/** Abandons a body nobody will read (for example the body of an error response). */
async function discardBody(body: FetchBody): Promise<void> {
  if (body === null) return;
  const source = openSource(body);
  await cancelQuietly(source);
  try {
    source.release();
  } catch {
    // Releasing a cancelled reader may throw on some runtimes; nothing left to do.
  }
}

/**
 * Streams chunks until the body ends. Stopping early (break, return, throw) cancels the underlying
 * stream; an abort of `signal` mid-body cancels it and throws an Error with message 'aborted'.
 */
async function* streamBody(
  body: FetchBody,
  signal: AbortSignal,
  dispose: () => void,
): AsyncGenerator<Uint8Array> {
  if (body === null) {
    dispose();
    return;
  }
  const source = openSource(body);
  const aborted = new Promise<never>((_, reject) => {
    const fire = () => reject(new Error('aborted'));
    if (signal.aborted) fire();
    else signal.addEventListener('abort', fire, { once: true });
  });
  aborted.catch(() => {});
  let finished = false;
  try {
    for (;;) {
      if (signal.aborted) throw new Error('aborted');
      const { done, value } = await Promise.race([source.next(), aborted]);
      if (done) {
        finished = true;
        return;
      }
      if (value !== undefined) yield value;
    }
  } finally {
    if (!finished) await cancelQuietly(source);
    try {
      source.release();
    } catch {
      // Releasing after cancel may throw on some runtimes.
    }
    dispose();
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
      let handedOff = false;
      try {
        const init: { headers?: Record<string, string>; signal: AbortSignal } = {
          signal: controller.signal,
        };
        if (options?.headers) init.headers = { ...options.headers };
        const res = await Promise.race([fetchImpl(url, init), aborted]);
        if (res.status < 200 || res.status >= 300) {
          await discardBody(res.body);
          const category = res.status === 401 || res.status === 403 ? 'auth' : 'network';
          return err(elvError(category, `http-${res.status}`));
        }
        const headers: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          headers[key.toLowerCase()] = value;
        });
        handedOff = true;
        const dispose = () => caller?.removeEventListener('abort', onCallerAbort);
        return ok({
          status: res.status,
          headers,
          body: streamBody(res.body, controller.signal, dispose),
        });
      } catch {
        if (timedOut) return err(elvError('network', 'timeout'));
        if (caller?.aborted) return err(elvError('network', 'aborted'));
        return err(elvError('network', 'fetch-failed'));
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (!handedOff) caller?.removeEventListener('abort', onCallerAbort);
      }
    },
  };
}
