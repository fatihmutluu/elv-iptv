import type { ElvError } from '@elv/domain';
import type { MessageId } from '@elv/i18n';

/** Localized message and actionable recovery hint for a stream playback failure. */
export interface DescribedPlaybackFailure {
  readonly messageId: MessageId;
  readonly hintId: MessageId;
}

/** Maps a secret-free {@link ElvError} from `PlaybackService` or `resolveStream` to localized copy. */
export function describePlaybackFailure(error: ElvError): DescribedPlaybackFailure {
  if (error.category === 'auth') {
    if (
      error.code === 'invalid-credentials' ||
      error.code === 'http-401' ||
      error.code === 'http-403'
    ) {
      return {
        messageId: 'player.error.invalidCredentials',
        hintId: 'player.hint.invalidCredentials',
      };
    }
    return {
      messageId: 'player.error.accountExpired',
      hintId: 'player.hint.accountExpired',
    };
  }

  if (error.code === 'http-401' || error.code === 'http-403') {
    return {
      messageId: 'player.error.invalidCredentials',
      hintId: 'player.hint.invalidCredentials',
    };
  }

  if (
    error.code === 'rate-limited' ||
    error.code === 'connection-limit' ||
    error.code === 'http-429' ||
    error.code === 'http-509'
  ) {
    return {
      messageId: 'player.error.connectionLimit',
      hintId: 'player.hint.connectionLimit',
    };
  }

  if (
    (error.category === 'network' && error.code !== 'http-404') ||
    error.code === 'network' ||
    error.code === 'unreachable' ||
    error.code === 'timeout'
  ) {
    return {
      messageId: 'player.error.unreachable',
      hintId: 'player.hint.unreachable',
    };
  }

  if (
    error.code === 'unsupported-codec' ||
    error.code === 'unsupported-format' ||
    error.code === 'decoder' ||
    error.code === 'drm'
  ) {
    return {
      messageId: 'player.error.unsupportedFormat',
      hintId: 'player.hint.unsupportedFormat',
    };
  }

  if (error.code === 'item-not-found' || error.code === 'http-404') {
    return {
      messageId: 'player.error.itemNotFound',
      hintId: 'player.hint.itemNotFound',
    };
  }

  return {
    messageId: 'player.error.streamFailed',
    hintId: 'player.hint.streamFailed',
  };
}
