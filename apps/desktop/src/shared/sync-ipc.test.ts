import { describe, expect, it } from 'vitest';
import {
  isBidirectionalPairingSnapshot,
  isFeedbackSubmitRequest,
  isFeedbackSubmitResult,
  isSyncAccountState,
  isSyncActionResult,
  isSyncCheckEmailPayload,
  isSyncClaimQrRequest,
  isSyncDeleteAccountRequest,
  isSyncEmailCheckStatus,
  isSyncPairConfirmRequest,
  isSyncPairJoinRequest,
  isSyncPollQrRequest,
  isSyncQrPairingSession,
  isSyncQrPollStatus,
  isSyncRegisterRequest,
  isSyncSetServerUrlRequest,
  isSyncSetViewingActiveRequest,
  isSyncSignInRequest,
  isTelemetryRecordRequest,
  isTelemetrySetOptInRequest,
  isTelemetryStatus,
  SYNC_CHANNELS,
} from './sync-ipc.ts';

describe('sync-ipc guards (#26, #458)', () => {
  it('exposes exact frozen IPC channel names', () => {
    expect(Object.isFrozen(SYNC_CHANNELS)).toBe(true);
    expect(SYNC_CHANNELS).toEqual({
      getState: 'sync:getState',
      checkEmail: 'sync:check-email',
      signIn: 'sync:signIn',
      register: 'sync:register',
      ackRecovery: 'sync:ackRecovery',
      syncNow: 'sync:syncNow',
      signOut: 'sync:signOut',
      deleteAccount: 'sync:deleteAccount',
      createQr: 'sync:createQr',
      pollQr: 'sync:pollQr',
      claimQr: 'sync:claimQr',
      setServerUrl: 'sync:setServerUrl',
      setSyncablePrefs: 'sync:setSyncablePrefs',
      initialPrefsReceived: 'sync:initialPrefsReceived',
      stateChanged: 'sync:stateChanged',
      markSyncDirty: 'sync:markSyncDirty',
      notifySyncDirty: 'sync:notifySyncDirty',
      notifyPlaybackPause: 'sync:notifyPlaybackPause',
      notifyPlaybackExitOrSwitch: 'sync:notifyPlaybackExitOrSwitch',
      setViewingActive: 'sync:setViewingActive',
      notifyReconnect: 'sync:notifyReconnect',
      pairStart: 'sync:pairStart',
      pairJoin: 'sync:pairJoin',
      pairPoll: 'sync:pairPoll',
      pairConfirm: 'sync:pairConfirm',
      pairCancel: 'sync:pairCancel',
      consumePendingPairUri: 'sync:consumePendingPairUri',
      pairDeepLink: 'sync:pairDeepLink',
      telemetrySetOptIn: 'telemetry:setOptIn',
      telemetryGetStatus: 'telemetry:getStatus',
      telemetryRecord: 'telemetry:record',
      telemetryFlush: 'telemetry:flush',
      feedbackSubmit: 'feedback:submit',
    });
  });

  it('validates sync auth/account requests and rejects extra keys or prototype pollution', () => {
    expect(isSyncSignInRequest({ email: 'a@b.co', password: 'secret' })).toBe(true);
    expect(isSyncCheckEmailPayload('a@b.co')).toBe(true);
    expect(isSyncCheckEmailPayload('a'.repeat(320))).toBe(true);
    expect(isSyncCheckEmailPayload('a'.repeat(321))).toBe(false);
    expect(isSyncCheckEmailPayload(42)).toBe(false);
    expect(isSyncEmailCheckStatus('exists')).toBe(true);
    expect(isSyncEmailCheckStatus('not_found')).toBe(true);
    expect(isSyncEmailCheckStatus('unknown')).toBe(true);
    expect(isSyncEmailCheckStatus('other')).toBe(false);
    expect(isSyncSignInRequest({ email: '', password: 'secret' })).toBe(false);
    expect(isSyncSignInRequest({ email: 'a@b.co', password: 'secret', extra: 1 })).toBe(false);
    expect(
      isSyncSignInRequest(JSON.parse('{"email":"a@b.co","password":"s","__proto__":{}}')),
    ).toBe(false);

    expect(
      isSyncRegisterRequest({ email: 'a@b.co', password: 'secret', confirmPassword: 'secret' }),
    ).toBe(true);
    expect(isSyncRegisterRequest({ email: 'a@b.co', password: 'secret' })).toBe(false);

    expect(isSyncDeleteAccountRequest({ password: 'secret' })).toBe(true);
    expect(isSyncDeleteAccountRequest({ password: '' })).toBe(false);

    expect(isSyncPollQrRequest({ pairingId: 'pair-1' })).toBe(true);
    expect(isSyncPollQrRequest({ pairingId: '' })).toBe(false);

    expect(isSyncClaimQrRequest({ codeOrUri: 'elviptv://pair?c=ABC123&k=xyz' })).toBe(true);
    expect(isSyncClaimQrRequest({ codeOrUri: '   ' })).toBe(false);

    expect(isSyncSetServerUrlRequest({ serverUrl: '' })).toBe(true);
    expect(isSyncSetServerUrlRequest({ serverUrl: 'https://sync.example.test' })).toBe(true);
    expect(isSyncSetServerUrlRequest({ serverUrl: 'http://127.0.0.1:8787' })).toBe(true);
    expect(isSyncSetServerUrlRequest({ serverUrl: 'http://evil.example.test' })).toBe(false);
    expect(isSyncSetServerUrlRequest({ serverUrl: 'javascript:alert(1)' })).toBe(false);
  });

  it('validates sync responses and strictly rejects leaked secrets/tokens', () => {
    const validState = {
      status: 'signed_in',
      email: 'viewer@example.test',
      lastSyncedAtIso: '2026-11-25T10:00:00.000Z',
      pendingRecoveryCode: null,
      errorCode: null,
    };
    expect(isSyncAccountState(validState)).toBe(true);
    expect(isSyncAccountState({ ...validState, accessToken: 'tok' })).toBe(false);
    expect(isSyncAccountState({ ...validState, vaultKey: 'key' })).toBe(false);
    expect(isSyncAccountState({ ...validState, status: 'bogus' })).toBe(false);

    expect(isSyncActionResult({ ok: true, recoveryCode: 'AAAA-BBBB' })).toBe(true);
    expect(isSyncActionResult({ ok: false, errorCode: 'invalid_credentials' })).toBe(true);
    expect(isSyncActionResult({ ok: true, refreshToken: 'leak' })).toBe(false);

    const qr = {
      pairingId: 'p1',
      code: 'ABCDEF123456',
      qrUri: 'elviptv://pair?c=ABCDEF123456&k=AAAAAAAAAAAAAAAAAAAAAA',
      expiresAtMs: Date.now() + 300_000,
      status: 'pending',
    };
    expect(isSyncQrPairingSession(qr)).toBe(true);
    expect(isSyncQrPairingSession({ ...qr, pollToken: 'leak' })).toBe(false);
    expect(isSyncQrPairingSession({ ...qr, qrUri: `elviptv://pair?c=${'a'.repeat(214)}` })).toBe(
      false,
    );

    expect(isSyncQrPollStatus('pending')).toBe(true);
    expect(isSyncQrPollStatus('claimed')).toBe(true);
    expect(isSyncQrPollStatus('expired')).toBe(true);
    expect(isSyncQrPollStatus('unknown')).toBe(false);
  });

  it('validates telemetry and feedback requests and responses', () => {
    expect(isTelemetrySetOptInRequest({ enabled: true })).toBe(true);
    expect(isTelemetrySetOptInRequest({ enabled: 'yes' })).toBe(false);

    expect(
      isTelemetryRecordRequest({ kind: 'screen_transition', screen: 'live', durationMs: 25 }),
    ).toBe(true);
    expect(
      isTelemetryRecordRequest({ kind: 'screen_transition', screen: 'live', durationMs: -1 }),
    ).toBe(false);
    expect(
      isTelemetryRecordRequest({
        kind: 'media_decode_failure',
        engine: 'mpv',
        container: 'mkv',
        videoCodec: 'hevc',
        audioCodec: 'ac3',
        errorCode: 'decoder',
        hdrFormat: 'hdr10',
        isLive: false,
      }),
    ).toBe(true);
    expect(
      isTelemetryRecordRequest({
        kind: 'playback_error',
        engine: 'mpv',
        errorCode: 'http-509',
        isLive: true,
      }),
    ).toBe(true);
    expect(isTelemetryRecordRequest({ kind: 'unknown' })).toBe(false);

    expect(isTelemetryStatus({ optedIn: false, queuedCount: 0, previewJson: '{}' })).toBe(true);
    expect(isTelemetryStatus({ optedIn: false, queuedCount: -1, previewJson: '{}' })).toBe(false);

    expect(
      isFeedbackSubmitRequest({
        category: 'playback_issue',
        message: 'Stutters on 4K',
        includeDiagnostics: true,
      }),
    ).toBe(true);
    expect(
      isFeedbackSubmitRequest({
        category: 'invalid',
        message: 'Hi',
        includeDiagnostics: false,
      }),
    ).toBe(false);

    expect(isFeedbackSubmitResult({ ok: true, id: 'fb-1' })).toBe(true);
    expect(isFeedbackSubmitResult({ ok: false, errorCode: 'network' })).toBe(true);
    expect(isFeedbackSubmitResult({ ok: true, extra: 1 })).toBe(false);
  });

  it('validates Wave P9 auto-sync, bidirectional pairing, and all 13 telemetry event kinds', () => {
    expect(
      isSyncAccountState({
        status: 'signed_in',
        email: 'a@b.co',
        lastSyncedAtIso: null,
        pendingRecoveryCode: null,
        errorCode: null,
        autoSyncState: 'pending',
      }),
    ).toBe(true);
    expect(isSyncSetViewingActiveRequest({ active: true })).toBe(true);
    expect(isSyncSetViewingActiveRequest({ active: 'yes' })).toBe(false);
    expect(isSyncPairJoinRequest({ codeOrUri: '12345678' })).toBe(true);
    expect(
      isSyncPairConfirmRequest({ pairingId: 'p-1', chosenDirection: 'host_to_responder' }),
    ).toBe(true);
    expect(isSyncPairConfirmRequest({ pairingId: 'p-1', chosenDirection: 'bad' })).toBe(false);
    expect(
      isBidirectionalPairingSnapshot({
        pairingId: 'p-1',
        role: 'host',
        code: '12345678',
        expiresAtMs: 999999,
        status: 'awaiting_sas',
        sas: '0421',
        direction: 'responder_to_host',
        localMaskedEmail: null,
        peerMaskedEmail: 'a***@b.co',
      }),
    ).toBe(true);
    expect(
      isBidirectionalPairingSnapshot({
        pairingId: 'p-1',
        role: 'host',
        code: '12345678',
        expiresAtMs: 999999,
        status: 'pending',
        sas: null,
        direction: null,
        localMaskedEmail: null,
        peerMaskedEmail: null,
        pollToken: 'SECRET_LEAK',
      }),
    ).toBe(false);

    const p9Events = [
      { kind: 'startup', durationMs: 300, coldStart: true },
      { kind: 'frame_jank', screen: 'guide', droppedFrames: 3, maxFrameMs: 55 },
      { kind: 'js_stall', screen: 'home', durationMs: 210 },
      { kind: 'memory_pressure', level: 'critical', usedMb: 700 },
      { kind: 'playback_start', engine: 'mpv', ttffMs: 250, isLive: false, container: 'mp4' },
      { kind: 'playback_rebuffer', engine: 'mpv', durationMs: 800, isLive: true },
      { kind: 'sqlite_slow_op', op: 'SELECT', durationMs: 280 },
      { kind: 'app_crash', errorName: 'Error', stackSig: 'App.tsx:10', fatal: true },
      { kind: 'unhandled_error', errorName: 'TypeError', stackSig: 'Main:12', source: 'main' },
      {
        kind: 'catalog_import',
        sourceKind: 'm3u',
        stage: 'guide',
        durationMs: 900,
        itemCount: 400,
        success: true,
      },
    ];
    for (const ev of p9Events) {
      expect(isTelemetryRecordRequest(ev)).toBe(true);
    }
  });
});
