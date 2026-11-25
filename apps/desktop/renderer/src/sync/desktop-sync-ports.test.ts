import { describe, expect, it, vi } from 'vitest';
import type {
  FeedbackBridge,
  SyncAccountStateIpc,
  SyncBridge,
  TelemetryBridge,
} from '../../../src/shared/sync-ipc.ts';
import { createDesktopSyncPorts } from './desktop-sync-ports.ts';

describe('createDesktopSyncPorts (#26, #458)', () => {
  it('returns undefined ports when Electron preload bridges are absent', () => {
    const ports = createDesktopSyncPorts(undefined);
    expect(ports.syncAccount).toBeUndefined();
    expect(ports.telemetry).toBeUndefined();
    expect(ports.feedback).toBeUndefined();
    ports.dispose();
  });

  it('adapts sync, telemetry, and feedback preload bridges cleanly with zero telemetry IPC when opted out', async () => {
    let stateListener: ((state: SyncAccountStateIpc) => void) | undefined;
    let currentState: SyncAccountStateIpc = {
      status: 'signed_out',
      email: null,
      lastSyncedAtIso: null,
      pendingRecoveryCode: null,
      errorCode: null,
    };

    const syncBridge: SyncBridge = {
      getState: vi.fn(async () => currentState),
      onStateChanged: vi.fn((cb) => {
        stateListener = cb;
        return () => {
          stateListener = undefined;
        };
      }),
      signIn: vi.fn(async (email) => {
        currentState = {
          status: 'signed_in',
          email,
          lastSyncedAtIso: null,
          pendingRecoveryCode: null,
          errorCode: null,
        };
        return { ok: true };
      }),
      register: vi.fn(async (email) => {
        currentState = {
          status: 'signed_in',
          email,
          lastSyncedAtIso: null,
          pendingRecoveryCode: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF',
          errorCode: null,
        };
        return { ok: true, recoveryCode: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF' };
      }),
      acknowledgeRecoveryCode: vi.fn(async () => undefined),
      syncNow: vi.fn(async () => ({ ok: true })),
      signOut: vi.fn(async () => {
        currentState = {
          status: 'signed_out',
          email: null,
          lastSyncedAtIso: null,
          pendingRecoveryCode: null,
          errorCode: null,
        };
      }),
      deleteAccount: vi.fn(async () => ({ ok: true })),
      createQrPairing: vi.fn(async () => ({
        pairingId: 'p1',
        code: 'ABCDEF123456',
        qrUri: 'elviptv://pair?c=ABCDEF123456&k=AAAAAAAAAAAAAAAAAAAAAA',
        expiresAtMs: Date.now() + 300_000,
        status: 'pending' as const,
      })),
      pollQrPairing: vi.fn(async () => 'claimed' as const),
      claimQrPairing: vi.fn(async () => ({ ok: true })),
      setServerUrl: vi.fn(async () => undefined),
    };

    let optedIn = false;
    let queuedCount = 0;
    const telemetryBridge: TelemetryBridge = {
      setOptIn: vi.fn(async (enabled) => {
        optedIn = enabled;
        if (!enabled) queuedCount = 0;
        return { optedIn, queuedCount, previewJson: `{"optedIn":${String(optedIn)}}` };
      }),
      getStatus: vi.fn(async () => ({
        optedIn,
        queuedCount,
        previewJson: `{"optedIn":${String(optedIn)},"queued":${queuedCount}}`,
      })),
      record: vi.fn(async () => {
        queuedCount += 1;
      }),
      flush: vi.fn(async () => {
        queuedCount = 0;
      }),
    };

    const feedbackBridge: FeedbackBridge = {
      submit: vi.fn(async () => ({ ok: true, id: 'fb-9' })),
    };

    const ports = createDesktopSyncPorts({
      sync: syncBridge,
      telemetry: telemetryBridge,
      feedback: feedbackBridge,
    });

    await ports.hydrate();
    await ports.setServerUrl('https://sync.example.test');
    expect(syncBridge.setServerUrl).toHaveBeenCalledWith('https://sync.example.test');

    // SyncAccountPort actions + push updates
    const seen: string[] = [];
    const unsub = ports.syncAccount?.subscribe((s) => seen.push(s.status));
    const reg = await ports.syncAccount?.register(
      'viewer@example.test',
      'StrongPass123!',
      'StrongPass123!',
    );
    expect(reg?.ok).toBe(true);
    expect(ports.syncAccount?.getState().pendingRecoveryCode).toBe('AAAA-BBBB-CCCC-DDDD-EEEE-FFFF');
    ports.syncAccount?.acknowledgeRecoveryCode();
    expect(ports.syncAccount?.getState().pendingRecoveryCode).toBeNull();
    expect(syncBridge.acknowledgeRecoveryCode).toHaveBeenCalledTimes(1);

    stateListener?.({
      status: 'syncing',
      email: 'viewer@example.test',
      lastSyncedAtIso: null,
      pendingRecoveryCode: null,
      errorCode: null,
    });
    expect(ports.syncAccount?.getState().status).toBe('syncing');
    expect(seen).toContain('syncing');
    unsub?.();

    // TelemetryPort emits ZERO IPC calls while opted out
    expect(ports.telemetry?.isOptedIn()).toBe(false);
    ports.telemetry?.recordScreenTransition('live', 15);
    ports.telemetry?.recordMediaDecodeFailure({
      engine: 'mpv',
      videoCodec: 'hevc',
      errorCode: 'decoder',
      isLive: true,
    });
    ports.telemetry?.recordPlaybackError({ engine: 'mpv', errorCode: 'http-404', isLive: true });
    await ports.telemetry?.flush();
    expect(telemetryBridge.record).not.toHaveBeenCalled();
    expect(telemetryBridge.flush).not.toHaveBeenCalled();

    // Opting in enables record + flush
    ports.telemetry?.setOptIn(true);
    expect(ports.telemetry?.isOptedIn()).toBe(true);
    ports.telemetry?.recordScreenTransition('live', 20);
    await vi.waitFor(() => expect(telemetryBridge.record).toHaveBeenCalledTimes(1));
    await ports.telemetry?.flush();
    expect(telemetryBridge.flush).toHaveBeenCalledTimes(1);

    // FeedbackPort forwards cleanly
    expect(
      await ports.feedback?.submit({
        category: 'playback_issue',
        message: 'Frame drop',
        includeDiagnostics: true,
      }),
    ).toEqual({ ok: true, id: 'fb-9' });

    ports.dispose();
    expect(stateListener).toBeUndefined();
  });
});
