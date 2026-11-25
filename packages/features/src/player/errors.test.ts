import { type ErrorCategory, elvError } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { describe, expect, it } from 'vitest';
import { describePlaybackFailure, extractHttpStatus, sanitizeErrorDetail } from './errors';

describe('describePlaybackFailure, extractHttpStatus & sanitizeErrorDetail (#316, #63)', () => {
  it('maps auth, rate-limit, network, codec/format, not-found, and generic errors to localized pairs with HTTP status and redacted evidence', () => {
    expect(describePlaybackFailure(elvError('auth', 'invalid-credentials'))).toEqual({
      messageId: 'player.error.invalidCredentials',
      hintId: 'player.hint.invalidCredentials',
      verdict: 'auth-failed',
      evidence: 'code=auth/invalid-credentials',
    });
    expect(describePlaybackFailure(elvError('playback', 'http-401'))).toEqual({
      messageId: 'player.error.invalidCredentials',
      hintId: 'player.hint.invalidCredentials',
      verdict: 'auth-failed',
      httpStatus: 401,
      evidence: 'code=playback/http-401',
    });
    expect(describePlaybackFailure(elvError('auth', 'account-expired'))).toEqual({
      messageId: 'player.diag.accountExpired',
      hintId: 'player.hint.accountExpired',
      verdict: 'account-expired',
      evidence: 'code=auth/account-expired',
    });
    expect(describePlaybackFailure(elvError('auth', 'account-disabled'))).toEqual({
      messageId: 'player.diag.accountDisabled',
      hintId: 'player.hint.accountExpired',
      verdict: 'account-disabled',
      evidence: 'code=auth/account-disabled',
    });
    expect(describePlaybackFailure(elvError('network', 'rate-limited'))).toEqual({
      messageId: 'player.error.connectionLimit',
      hintId: 'player.hint.connectionLimit',
      verdict: 'connection-limit',
      evidence: 'code=network/rate-limited',
    });
    expect(describePlaybackFailure(elvError('playback', 'connection-limit'))).toEqual({
      messageId: 'player.error.connectionLimit',
      hintId: 'player.hint.connectionLimit',
      verdict: 'connection-limit',
      evidence: 'code=playback/connection-limit',
    });
    expect(describePlaybackFailure(elvError('network', 'unreachable'))).toEqual({
      messageId: 'player.error.unreachable',
      hintId: 'player.hint.unreachable',
      verdict: 'network-error',
      evidence: 'code=network/unreachable',
    });
    expect(describePlaybackFailure(elvError('playback', 'network'))).toEqual({
      messageId: 'player.error.unreachable',
      hintId: 'player.hint.unreachable',
      verdict: 'network-error',
      evidence: 'code=playback/network',
    });
    expect(describePlaybackFailure(elvError('playback', 'unsupported-codec'))).toEqual({
      messageId: 'player.diag.codecUnsupported',
      hintId: 'player.hint.unsupportedFormat',
      verdict: 'codec-unsupported',
      evidence: 'code=playback/unsupported-codec',
    });
    expect(describePlaybackFailure(elvError('playback', 'unsupported-format'))).toEqual({
      messageId: 'player.diag.codecUnsupported',
      hintId: 'player.hint.unsupportedFormat',
      verdict: 'codec-unsupported',
      evidence: 'code=playback/unsupported-format',
    });
    expect(describePlaybackFailure(elvError('playback', 'drm'))).toEqual({
      messageId: 'player.error.drmUnsupported',
      hintId: 'player.hint.unsupportedFormat',
      verdict: 'codec-unsupported',
      evidence: 'code=playback/drm',
    });
    expect(describePlaybackFailure(elvError('storage', 'item-not-found'))).toEqual({
      messageId: 'player.error.itemNotFound',
      hintId: 'player.hint.itemNotFound',
      verdict: 'not-found',
      evidence: 'code=storage/item-not-found',
    });
    expect(describePlaybackFailure(elvError('playback', 'http-404'))).toEqual({
      messageId: 'player.error.itemNotFound',
      hintId: 'player.hint.itemNotFound',
      verdict: 'not-found',
      httpStatus: 404,
      evidence: 'code=playback/http-404',
    });
    expect(describePlaybackFailure(elvError('playback', 'unknown'))).toEqual({
      messageId: 'player.error.streamFailed',
      hintId: 'player.hint.streamFailed',
      verdict: 'unknown',
      evidence: 'code=playback/unknown',
    });
  });

  it('uses diagnoser context for offline, account health, server-silent, upstream 5xx, and strictly host-only redacted evidence', () => {
    const synthUser = 'alice';
    const synthPass = 'supersecret';
    const secretUrl = `http://${synthUser}:${synthPass}@edge.example.test:8080/live/${synthUser}/${synthPass}/101.ts?token=xyz`;

    const offline = describePlaybackFailure(elvError('network', 'unreachable'), {
      online: false,
      url: secretUrl,
    });
    expect(offline).toEqual({
      messageId: 'player.diag.offline',
      hintId: 'player.hint.unreachable',
      verdict: 'offline',
      evidence: 'host=edge.example.test:8080 code=network/unreachable',
    });
    expect(offline.evidence).not.toContain('alice');
    expect(offline.evidence).not.toContain('supersecret');
    expect(offline.evidence).not.toContain('token=xyz');

    const expired = describePlaybackFailure(elvError('network', 'http-403'), {
      url: secretUrl,
      httpStatus: 403,
      accountHealth: { status: 'Expired' },
    });
    expect(expired).toEqual({
      messageId: 'player.diag.accountExpired',
      hintId: 'player.hint.accountExpired',
      verdict: 'account-expired',
      httpStatus: 403,
      evidence: 'host=edge.example.test:8080 status=403',
    });

    const disabled = describePlaybackFailure(elvError('playback', 'http-403'), {
      accountHealth: { status: 'Banned' },
    });
    expect(disabled).toMatchObject({
      messageId: 'player.diag.accountDisabled',
      hintId: 'player.hint.accountExpired',
      verdict: 'account-disabled',
      httpStatus: 403,
    });

    const silent = describePlaybackFailure(elvError('network', 'timeout'), {
      url: secretUrl,
      httpStatus: 503,
      bytesReceived: 0,
    });
    expect(silent).toEqual({
      messageId: 'player.diag.serverSilent',
      hintId: 'player.hint.unreachable',
      verdict: 'server-silent',
      httpStatus: 503,
      evidence: 'host=edge.example.test:8080 status=503 bytes=0',
    });

    const upstream = describePlaybackFailure(elvError('playback', 'stream-failed'), {
      url: secretUrl,
      httpStatus: 502,
      bytesReceived: 2048,
    });
    expect(upstream).toEqual({
      messageId: 'player.error.unreachable',
      hintId: 'player.hint.unreachable',
      verdict: 'upstream-error',
      httpStatus: 502,
      evidence: 'host=edge.example.test:8080 status=502 bytes=2048',
    });
  });

  it('extracts HTTP statuses cleanly, sanitizes raw class/stack/credential details, and localizes every ErrorCategory in EN & TR', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const categories: readonly ErrorCategory[] = [
      'auth',
      'network',
      'source-format',
      'storage',
      'playback',
    ];
    for (const category of categories) {
      const described = describePlaybackFailure(
        elvError(category, 'ExoPlaybackException', 'TypeError: fail at /app/x.ts:1:2'),
      );
      expect(en.t(described.messageId).length).toBeGreaterThan(0);
      expect(tr.t(described.messageId).length).toBeGreaterThan(0);
      expect(en.t(described.hintId).length).toBeGreaterThan(0);
      expect(tr.t(described.hintId).length).toBeGreaterThan(0);
      expect(described.evidence).toBeUndefined();
    }

    expect(extractHttpStatus(elvError('playback', 'http-509'))).toBe(509);
    expect(extractHttpStatus(elvError('network', 'stream-failed', 'HTTP 500'))).toBe(500);
    expect(extractHttpStatus(elvError('network', 'http-200'))).toBeUndefined();
    expect(sanitizeErrorDetail('ExoPlaybackException: decoder error')).toBeUndefined();
    expect(sanitizeErrorDetail('SQLITE_ERROR: locked')).toBeUndefined();
    expect(sanitizeErrorDetail('host=edge.example.test status=503')).toBe(
      'host=edge.example.test status=503',
    );
  });
});
