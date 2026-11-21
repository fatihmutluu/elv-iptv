import type { ElvError } from '@elv/domain';
import type { MessageId } from '@elv/i18n';
import {
  diagnosePlaybackFailure,
  type PlaybackDiagnosisInput,
  type PlaybackVerdict,
} from '@elv/playback';

/** Optional diagnostic context supplied alongside a playback failure error (`#316`). */
export type PlaybackFailureContext = Omit<PlaybackDiagnosisInput, 'error'>;

/** Localized message, actionable recovery hint, verdict, and optional redacted evidence (`#316`). */
export interface DescribedPlaybackFailure {
  readonly messageId: MessageId;
  readonly hintId: MessageId;
  readonly verdict?: PlaybackVerdict;
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
 * localized copy and a strictly host-only redacted evidence line (`#316`).
 */
export function describePlaybackFailure(
  error: ElvError,
  context?: PlaybackFailureContext,
): DescribedPlaybackFailure {
  const diagnosis = diagnosePlaybackFailure({ ...context, error });
  const verdict: PlaybackVerdict =
    diagnosis.verdict === 'unknown' && error.code === 'drm'
      ? 'codec-unsupported'
      : diagnosis.verdict;
  const copy = VERDICT_COPY[verdict];
  return {
    messageId: copy.messageId,
    hintId: copy.hintId,
    verdict,
    ...(diagnosis.evidence.length > 0 ? { evidence: diagnosis.evidence } : {}),
  };
}
