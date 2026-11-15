import { type ElvError, elvError } from '@elv/domain';
import type { EngineError, EngineErrorCode } from './engine';

/** How the recovery ladder treats a code. */
export type ErrorClass = 'terminal' | 'not-found' | 'limit' | 'recoverable';

/** Maps an engine error to the service-level `playback/<code>` error. */
export function toPlaybackError(error: EngineError): ElvError {
  return elvError('playback', error.code, error.detail);
}

/** Terminal codes skip the ladder, not-found gets one reconnect, limits need a pause. */
export function classifyError(code: EngineErrorCode): ErrorClass {
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
