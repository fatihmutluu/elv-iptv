import { elvError } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { describePlaybackFailure } from './errors';

describe('describePlaybackFailure', () => {
  it('maps auth, rate-limit, network, codec/format, not-found, and generic errors to distinct localized pairs', () => {
    expect(describePlaybackFailure(elvError('auth', 'invalid-credentials'))).toEqual({
      messageId: 'player.error.invalidCredentials',
      hintId: 'player.hint.invalidCredentials',
    });
    expect(describePlaybackFailure(elvError('playback', 'http-401'))).toEqual({
      messageId: 'player.error.invalidCredentials',
      hintId: 'player.hint.invalidCredentials',
    });
    expect(describePlaybackFailure(elvError('auth', 'account-expired'))).toEqual({
      messageId: 'player.error.accountExpired',
      hintId: 'player.hint.accountExpired',
    });
    expect(describePlaybackFailure(elvError('network', 'rate-limited'))).toEqual({
      messageId: 'player.error.connectionLimit',
      hintId: 'player.hint.connectionLimit',
    });
    expect(describePlaybackFailure(elvError('playback', 'connection-limit'))).toEqual({
      messageId: 'player.error.connectionLimit',
      hintId: 'player.hint.connectionLimit',
    });
    expect(describePlaybackFailure(elvError('network', 'unreachable'))).toEqual({
      messageId: 'player.error.unreachable',
      hintId: 'player.hint.unreachable',
    });
    expect(describePlaybackFailure(elvError('playback', 'network'))).toEqual({
      messageId: 'player.error.unreachable',
      hintId: 'player.hint.unreachable',
    });
    expect(describePlaybackFailure(elvError('playback', 'unsupported-codec'))).toEqual({
      messageId: 'player.error.unsupportedFormat',
      hintId: 'player.hint.unsupportedFormat',
    });
    expect(describePlaybackFailure(elvError('playback', 'unsupported-format'))).toEqual({
      messageId: 'player.error.unsupportedFormat',
      hintId: 'player.hint.unsupportedFormat',
    });
    expect(describePlaybackFailure(elvError('storage', 'item-not-found'))).toEqual({
      messageId: 'player.error.itemNotFound',
      hintId: 'player.hint.itemNotFound',
    });
    expect(describePlaybackFailure(elvError('playback', 'http-404'))).toEqual({
      messageId: 'player.error.itemNotFound',
      hintId: 'player.hint.itemNotFound',
    });
    expect(describePlaybackFailure(elvError('playback', 'unknown'))).toEqual({
      messageId: 'player.error.streamFailed',
      hintId: 'player.hint.streamFailed',
    });
  });
});
