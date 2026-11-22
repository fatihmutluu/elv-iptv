import {
  type ElvError,
  elvError,
  type HttpResponse,
  httpStatusError,
  ok,
  openAsyncIterator,
  type Result,
  transportHeaders,
} from '@elv/domain';
import { conditionalHeaders, extractValidators, sanitizeValidator } from './http-cache';
import { parseContentLength } from './import-progress';
import { checkAbort, Stop } from './import-run';
import type { ImportDeps } from './import-types';
import { openClient } from './import-xtream';
import type { HttpCacheValidator, SourceRecord } from './sources';
import { resolveTemplate } from './templates';
import { readUrlVars } from './urlvars-store';

const REQUEST_TIMEOUT_MS = 180_000;
const GUIDE_MAX_RETRIES = 2;

/** Default short jittered retry backoff (100–200 ms, then 200–400 ms). */
export function defaultGuideRetryDelayMs(attempt: number): number {
  const base = 200 * 2 ** attempt;
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

function isTransientGuideError(error: ElvError): boolean {
  if (error.code === 'aborted' || error.category !== 'network') return false;
  if (error.code.startsWith('http-')) {
    const status = Number(error.code.slice(5));
    return status === 408 || (status >= 500 && status <= 599 && status !== 509);
  }
  return true;
}

function waitWithAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
  checkAbort({ signal });
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Stop(elvError('network', 'aborted')));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal !== undefined) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

async function discard(body: AsyncIterable<Uint8Array>): Promise<void> {
  try {
    await openAsyncIterator(body).return?.();
  } catch {
    // the response is already classified by its status
  }
}

export interface GuideCandidate {
  slot: string;
  url: string;
}

export type GuideOpen =
  | {
      kind: 'body';
      slot: string;
      body: AsyncIterable<Uint8Array>;
      validator: HttpCacheValidator | undefined;
      contentLength: number | undefined;
      failed: ElvError[];
    }
  | {
      kind: 'not-modified';
      slot: string;
      validator: HttpCacheValidator | undefined;
      failed: ElvError[];
    };

/** Guide candidates to try, in order, resolved in memory only; unresolved placeholders are dropped. */
export async function candidateGuideUrls(
  source: SourceRecord,
  deps: ImportDeps,
): Promise<Result<GuideCandidate[]>> {
  const candidates: GuideCandidate[] = [];
  const vars = await readUrlVars(deps, source.id);
  if (source.kind === 'xtream') {
    const own = source.settings.guideUrl;
    if (own !== undefined && own !== '') {
      candidates.push({ slot: 'override', url: resolveTemplate(own, vars) });
    }
    const client = await openClient(source, deps);
    if (!client.ok) return client;
    candidates.push({ slot: 'xtream', url: client.value.guideUrl() });
  } else {
    if (source.settings.guideUrl !== undefined && source.settings.guideUrl !== '') {
      candidates.push({ slot: 'override', url: resolveTemplate(source.settings.guideUrl, vars) });
    }
    for (const [i, t] of (source.settings.discoveredGuideUrls ?? []).entries()) {
      candidates.push({ slot: `discovered:${i}`, url: resolveTemplate(t, vars) });
    }
  }
  return ok(candidates.filter((c) => c.url !== '' && !c.url.includes('{{')));
}

/** Opens the first candidate URL that answers 2xx or conditional 304, with up to 2 transient retries per URL. */
export async function openGuide(
  candidates: readonly GuideCandidate[],
  source: SourceRecord,
  deps: ImportDeps,
  signal: AbortSignal | undefined,
  allowConditional: boolean,
  retryDelayMs: (attempt: number) => number,
): Promise<GuideOpen> {
  let first: ElvError | undefined;
  const failed: ElvError[] = [];
  const miss = (e: ElvError) => {
    failed.push(elvError(e.category, e.code));
    first ??= failed[0];
  };
  const baseHeaders = transportHeaders(source.settings.transport);
  for (const { slot, url } of candidates) {
    const sent = allowConditional
      ? sanitizeValidator(source.settings.httpCache?.guide?.[slot])
      : undefined;
    let lastError: ElvError | undefined;
    for (let attempt = 0; attempt <= GUIDE_MAX_RETRIES; attempt += 1) {
      checkAbort({ signal });
      if (attempt > 0) await waitWithAbort(retryDelayMs(attempt - 1), signal);
      let response: Result<HttpResponse>;
      try {
        response = await deps.http.get(url, {
          headers: conditionalHeaders(baseHeaders, sent),
          timeoutMs: REQUEST_TIMEOUT_MS,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch {
        checkAbort({ signal });
        lastError = elvError('network', 'request-failed');
        continue;
      }
      if (!response.ok) {
        if (response.error.code === 'aborted' || signal?.aborted) {
          throw new Stop(elvError('network', 'aborted'));
        }
        lastError = response.error;
        if (isTransientGuideError(response.error)) continue;
        break;
      }
      const { status, body, headers } = response.value;
      const validator = extractValidators(headers);
      if (status === 304 && sent !== undefined) {
        await discard(body);
        return { kind: 'not-modified', slot, validator, failed };
      }
      if (status >= 200 && status < 300) {
        return {
          kind: 'body',
          slot,
          body,
          validator,
          contentLength: parseContentLength(headers),
          failed,
        };
      }
      await discard(body);
      lastError = httpStatusError(status);
      if (isTransientGuideError(lastError)) continue;
      break;
    }
    if (lastError !== undefined) miss(lastError);
  }
  throw new Stop(first ?? elvError('source-format', 'no-guide-url'));
}
