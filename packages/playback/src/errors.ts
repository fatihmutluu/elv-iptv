import { type ElvError, elvError } from '@elv/domain';
import type { EngineError, EngineErrorCode } from './engine';

/** How the recovery ladder treats a code. */
export type ErrorClass = 'terminal' | 'not-found' | 'limit' | 'recoverable';

const TERMINAL_HTTP_STATUSES = new Set([401, 403, 407, 410, 451]);
const LIMIT_HTTP_STATUSES = new Set([429, 458, 460, 461, 462, 463, 469, 509]);

/** Maps an HTTP status code to its canonical {@link EngineErrorCode}. */
export function codeForHttpStatus(status: number): EngineErrorCode {
  if (status === 401 || status === 407) return 'http-401';
  if (status === 403) return 'http-403';
  if (status === 404 || status === 410 || status === 451) return 'http-404';
  if (status === 429) return 'http-429';
  if (status === 509) return 'http-509';
  if (LIMIT_HTTP_STATUSES.has(status)) return 'connection-limit';
  return 'http-other';
}

/** Maps an engine error to the service-level `playback/<code>` error. */
export function toPlaybackError(error: EngineError): ElvError {
  const code =
    error.code === 'http-other' && error.httpStatus !== undefined
      ? codeForHttpStatus(error.httpStatus)
      : error.code;
  return elvError('playback', code, error.detail);
}

/** Terminal codes skip the ladder, 404 gets one reconnect, limits back off, others enter the ladder. */
export function classifyError(code: EngineErrorCode, httpStatus?: number): ErrorClass {
  if (httpStatus !== undefined) {
    if (TERMINAL_HTTP_STATUSES.has(httpStatus)) return 'terminal';
    if (LIMIT_HTTP_STATUSES.has(httpStatus)) return 'limit';
    if (httpStatus === 404) return 'not-found';
  }
  switch (code) {
    case 'http-401':
    case 'http-403':
    case 'unsupported-format':
    case 'drm':
      return 'terminal';
    case 'http-404':
      return 'not-found';
    case 'http-429':
    case 'http-509':
    case 'connection-limit':
      return 'limit';
    default:
      return 'recoverable';
  }
}
