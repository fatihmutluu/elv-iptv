import type { ElvError } from '@elv/domain';
import type { MessageId } from '@elv/i18n';
import {
  diagnosePlaybackFailure,
  type PlaybackDiagnosisInput,
  type PlaybackVerdict,
} from '@elv/playback';
import { extractHttpStatus, sanitizeErrorDetail } from '../shared/error-utils';

export { extractHttpStatus, sanitizeErrorDetail };

/** Optional diagnostic context supplied alongside a playback failure error (`#316`). */
export type PlaybackFailureContext = Omit<PlaybackDiagnosisInput, 'error'>;

/** Localized message, recovery hint, verdict, HTTP status, and redacted evidence (`#63`, `#316`). */
export interface DescribedPlaybackFailure {
  readonly messageId: MessageId;
  readonly hintId: MessageId;
  readonly verdict?: PlaybackVerdict;
  readonly httpStatus?: number;
  readonly evidence?: string;
}

const VERDICT_COPY: Readonly<
  Record<PlaybackVerdict, { readonly messageId: MessageId; readonly hintId: MessageId }>
> = {
  offline: {
    messageId: 'player.diag.offline',
    hintId: 'player.hint.unreachable',
  },
  'account-expired': {
    messageId: 'player.diag.accountExpired',
    hintId: 'player.hint.accountExpired',
  },
  'account-disabled': {
    messageId: 'player.diag.accountDisabled',
    hintId: 'player.hint.accountExpired',
  },
  'connection-limit': {
    messageId: 'player.error.connectionLimit',
    hintId: 'player.hint.connectionLimit',
  },
  'auth-failed': {
    messageId: 'player.error.invalidCredentials',
    hintId: 'player.hint.invalidCredentials',
  },
  'not-found': {
    messageId: 'player.error.itemNotFound',
    hintId: 'player.hint.itemNotFound',
  },
  'server-silent': {
    messageId: 'player.diag.serverSilent',
    hintId: 'player.hint.unreachable',
  },
  'codec-unsupported': {
    messageId: 'player.diag.codecUnsupported',
    hintId: 'player.hint.unsupportedFormat',
  },
  'upstream-error': {
    messageId: 'player.error.unreachable',
    hintId: 'player.hint.unreachable',
  },
  'network-error': {
    messageId: 'player.error.unreachable',
    hintId: 'player.hint.unreachable',
  },
  unknown: {
    messageId: 'player.error.streamFailed',
    hintId: 'player.hint.streamFailed',
  },
};

/**
 * Maps a secret-free {@link ElvError} and optional playback diagnostic context to actionable
 * localized copy, optional numeric HTTP status, and strictly redacted evidence (`#63`, `#316`).
 */
export function describePlaybackFailure(
  error: ElvError,
  context?: PlaybackFailureContext,
): DescribedPlaybackFailure {
  if (error.category === 'auth' && error.code === 'parental-locked') {
    return {
      messageId: 'parental.lockedMessage',
      hintId: 'parental.unlockTitle',
      verdict: 'auth-failed',
    };
  }
  if (
    error.category === 'storage' &&
    (error.code === 'secret-key-rotated' || error.code === 'storage/secret-key-rotated')
  ) {
    return {
      messageId: 'source.error.secretKeyRotated',
      hintId: 'source.hint.secretKeyRotated',
      verdict: 'auth-failed',
    };
  }
  const diagnosis = diagnosePlaybackFailure({ ...context, error });
  const isDrmError = diagnosis.verdict === 'unknown' && error.code === 'drm';
  const verdict: PlaybackVerdict = isDrmError ? 'codec-unsupported' : diagnosis.verdict;
  const copy = VERDICT_COPY[verdict];
  const candidateStatus = diagnosis.httpStatus ?? extractHttpStatus(error);
  const httpStatus =
    candidateStatus !== undefined && candidateStatus >= 400 && candidateStatus <= 599
      ? candidateStatus
      : undefined;
  const safeEvidence = sanitizeErrorDetail(diagnosis.evidence);
  return {
    messageId: isDrmError ? 'player.error.drmUnsupported' : copy.messageId,
    hintId: copy.hintId,
    verdict,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(safeEvidence !== undefined ? { evidence: safeEvidence } : {}),
  };
}
