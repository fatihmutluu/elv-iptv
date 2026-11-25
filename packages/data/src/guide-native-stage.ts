import { type ElvError, elvError, httpStatusError, transportHeaders } from '@elv/domain';
import type { GuideCandidate } from './guide-fetch';
import { sanitizeValidator } from './http-cache';
import { checkAbort, type RunCtx, Stop } from './import-run';
import type { NativeGuideStageResult, NativeGuideStager } from './import-types';
import type { HttpCacheValidator, SourceRecord } from './sources';

const REQUEST_TIMEOUT_MS = 180_000;
const GUIDE_MAX_RETRIES = 2;

export type NativeGuideOpen =
  | {
      kind: 'staged';
      slot: string;
      result: Extract<NativeGuideStageResult, { kind: 'staged' }>;
      validator: HttpCacheValidator | undefined;
      failed: ElvError[];
    }
  | {
      kind: 'not-modified';
      slot: string;
      validator: HttpCacheValidator | undefined;
      failed: ElvError[];
    };

/** Returns `true` when `url` uses `http://` or `https://` and can be fetched natively. */
function isNativeStageUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** Returns `true` when the native XMLTV stager can handle every candidate URL for this source. */
export function canUseNativeGuideStager(
  stager: NativeGuideStager | undefined,
  source: SourceRecord,
  candidates: readonly GuideCandidate[],
): boolean {
  if (stager === undefined || candidates.length === 0) return false;
  if (source.settings.transport?.allowLegacyTls === true) return false;
  if (source.settings.transport?.hostOverride !== undefined) return false;
  return candidates.every((cand) => isNativeStageUrl(cand.url));
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

function classifyHttpError(
  errResult: Extract<NativeGuideStageResult, { kind: 'http-error' }>,
): ElvError {
  if (errResult.code === 'aborted') return elvError('network', 'aborted');
  if (errResult.status >= 400 && errResult.status <= 599) return httpStatusError(errResult.status);
  return elvError('network', errResult.code || 'request-failed');
}

/**
 * Runs the native XMLTV stager across candidate URLs with the exact same retry, conditional 304,
 * fallback, and abort contract as {@link openGuide}, writing staged rows directly into
 * `programmes_next` off the JS thread (`#478`).
 */
export async function stageGuideNative(
  c: RunCtx,
  stager: NativeGuideStager,
  source: SourceRecord,
  candidates: readonly GuideCandidate[],
  allowConditional: boolean,
  fromMs: number,
  toMs: number,
  retryDelayMs: (attempt: number) => number,
): Promise<NativeGuideOpen> {
  let first: ElvError | undefined;
  const failed: ElvError[] = [];
  const miss = (e: ElvError) => {
    failed.push(elvError(e.category, e.code));
    first ??= failed[0];
  };
  const baseHeaders = transportHeaders(source.settings.transport);
  const hasHeaders = Object.keys(baseHeaders).length > 0;

  for (const { slot, url, validator: candidateValidator } of candidates) {
    const sent = allowConditional
      ? sanitizeValidator(candidateValidator ?? source.settings.httpCache?.guide?.[slot])
      : undefined;
    let lastError: ElvError | undefined;
    for (let attempt = 0; attempt <= GUIDE_MAX_RETRIES; attempt += 1) {
      checkAbort(c);
      if (attempt > 0) await waitWithAbort(retryDelayMs(attempt - 1), c.signal);
      await c.db.run('DELETE FROM programmes_next WHERE source_id = ?', [c.sourceId]);

      const jobId = `${c.sourceId}:${c.runId}:${slot}:${attempt}`;
      const onAbort = () => {
        try {
          stager.cancel?.(jobId);
        } catch {
          // Best-effort cancellation of native staging job.
        }
      };
      if (c.signal !== undefined) {
        if (c.signal.aborted) {
          onAbort();
          throw new Stop(elvError('network', 'aborted'));
        }
        c.signal.addEventListener('abort', onAbort, { once: true });
      }
      let res: NativeGuideStageResult;
      try {
        res = await stager.stage({
          jobId,
          url,
          sourceId: c.sourceId,
          runId: c.runId,
          fromMs,
          toMs,
          timeoutMs: REQUEST_TIMEOUT_MS,
          ...(hasHeaders ? { headers: baseHeaders } : {}),
          ...(sent?.etag === undefined ? {} : { ifNoneMatch: sent.etag }),
          ...(sent?.lastModified === undefined ? {} : { ifModifiedSince: sent.lastModified }),
          ...(source.settings.xmltvTimezone
            ? { defaultTimeZone: source.settings.xmltvTimezone }
            : {}),
        });
      } catch {
        checkAbort(c);
        lastError = elvError('network', 'request-failed');
        continue;
      } finally {
        c.signal?.removeEventListener('abort', onAbort);
      }

      if (c.signal?.aborted) throw new Stop(elvError('network', 'aborted'));

      if (res.kind === 'not-modified') {
        if (sent !== undefined) {
          const validator = sanitizeValidator({
            ...(res.etag === undefined ? {} : { etag: res.etag }),
            ...(res.lastModified === undefined ? {} : { lastModified: res.lastModified }),
          });
          return { kind: 'not-modified', slot, validator, failed };
        }
        lastError = httpStatusError(304);
        break;
      }

      if (res.kind === 'staged') {
        const validator = sanitizeValidator({
          ...(res.etag === undefined ? {} : { etag: res.etag }),
          ...(res.lastModified === undefined ? {} : { lastModified: res.lastModified }),
        });
        return { kind: 'staged', slot, result: res, validator, failed };
      }

      if (res.code === 'aborted') throw new Stop(elvError('network', 'aborted'));
      lastError = classifyHttpError(res);
      if (res.retryable) continue;
      break;
    }
    if (lastError !== undefined) miss(lastError);
  }
  throw new Stop(first ?? elvError('source-format', 'no-guide-url'));
}
