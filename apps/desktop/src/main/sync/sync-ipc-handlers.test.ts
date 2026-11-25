import { describe, expect, it, vi } from 'vitest';
import { SYNC_CHANNELS, type SyncAccountStateIpc } from '../../shared/sync-ipc.ts';
import { isTrustedSyncIpcEvent, registerSyncIpc } from './sync-ipc-handlers.ts';
import type { DesktopSyncService } from './sync-service.ts';

function makeFakeIpcMain() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  return {
    ipcMain: {
      handle: vi.fn((ch: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
        handlers.set(ch, fn);
      }),
      removeHandler: vi.fn((ch: string) => {
        handlers.delete(ch);
      }),
    },
    invoke: async (ch: string, event: unknown, ...args: unknown[]) => {
      const fn = handlers.get(ch);
      if (!fn) throw new Error(`missing handler ${ch}`);
      return fn(event, ...args);
    },
  };
}

function makeStubService() {
  let stateListener: ((state: SyncAccountStateIpc) => void) | undefined;
  const service: DesktopSyncService = {
    hydrate: vi.fn(async () => undefined),
    getState: vi.fn(() => ({
      status: 'signed_in' as const,
      email: 'viewer@example.test',
      lastSyncedAtIso: null,
      pendingRecoveryCode: null,
      errorCode: null,
      // Simulate accidental secret field to ensure handler strips it before crossing IPC
      ...({ accessToken: 'RAW_SECRET_TOKEN', vaultKey: 'RAW_VAULT_KEY' } as Record<
        string,
        unknown
      >),
    })),
    subscribe: vi.fn((listener) => {
      stateListener = listener;
      return () => {
        stateListener = undefined;
      };
    }),
    setServerUrl: vi.fn(),
    signIn: vi.fn(async () => ({
      ok: true,
      ...({ refreshToken: 'RAW_REFRESH' } as Record<string, unknown>),
    })),
    register: vi.fn(async () => ({ ok: true, recoveryCode: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF' })),
    acknowledgeRecoveryCode: vi.fn(),
    syncNow: vi.fn(async () => ({ ok: true })),
    signOut: vi.fn(async () => undefined),
    deleteAccount: vi.fn(async () => ({ ok: true })),
    createQrPairing: vi.fn(async () => ({
      pairingId: 'p-1',
      code: 'ABCDEF123456',
      qrUri: 'elviptv://pair?c=ABCDEF123456&k=AAAAAAAAAAAAAAAAAAAAAA',
      expiresAtMs: Date.now() + 300_000,
      status: 'pending' as const,
      ...({ pollToken: 'SECRET_POLL', ephemeralKey: 'SECRET_KEY' } as Record<string, unknown>),
    })),
    pollQrPairing: vi.fn(async () => 'pending' as const),
    claimQrPairing: vi.fn(async () => ({ ok: true })),
    setTelemetryOptIn: vi.fn((enabled: boolean) => ({
      optedIn: enabled,
      queuedCount: 0,
      previewJson: '{}',
    })),
    getTelemetryStatus: vi.fn(() => ({ optedIn: false, queuedCount: 0, previewJson: '{}' })),
    recordTelemetry: vi.fn(),
    flushTelemetry: vi.fn(async () => undefined),
    submitFeedback: vi.fn(async () => ({ ok: true, id: 'fb-1' })),
    dispose: vi.fn(),
  };
  return {
    service,
    emitState: (state: SyncAccountStateIpc) => stateListener?.(state),
  };
}

describe('registerSyncIpc (#26, #458)', () => {
  it('validates sender frame/origin strictly and rejects untrusted origins or subframes', async () => {
    const topFrame = { url: 'app://elv/' };
    const subFrame = { url: 'app://elv/', top: topFrame };
    expect(isTrustedSyncIpcEvent({ senderFrame: topFrame })).toBe(true);
    expect(isTrustedSyncIpcEvent({ senderFrame: subFrame })).toBe(false);
    expect(isTrustedSyncIpcEvent({ senderFrame: { url: 'https://evil.example.test/' } })).toBe(
      false,
    );
    expect(
      isTrustedSyncIpcEvent(
        { senderFrame: { url: 'http://127.0.0.1:8081/' } },
        'http://127.0.0.1:8081',
      ),
    ).toBe(true);
    expect(isTrustedSyncIpcEvent({ senderFrame: { url: 'http://127.0.0.1:8081/' } }, null)).toBe(
      false,
    );
    // MEDIUM #14: fail closed when senderFrame is null/undefined/empty — NEVER fall back to sender.getURL()
    const trustedSender = { getURL: () => 'app://elv/' };
    expect(isTrustedSyncIpcEvent({ senderFrame: null, sender: trustedSender })).toBe(false);
    expect(isTrustedSyncIpcEvent({ senderFrame: undefined, sender: trustedSender })).toBe(false);
    expect(isTrustedSyncIpcEvent({ senderFrame: { url: '' }, sender: trustedSender })).toBe(false);

    const ipc = makeFakeIpcMain();
    const { service } = makeStubService();
    const log = vi.fn();
    const dispose = registerSyncIpc({ ipcMain: ipc.ipcMain, service, log });

    await expect(
      ipc.invoke(SYNC_CHANNELS.getState, { senderFrame: { url: 'https://evil.test/' } }),
    ).rejects.toThrow(/untrusted/i);
    await expect(
      ipc.invoke(SYNC_CHANNELS.getState, { senderFrame: null, sender: trustedSender }),
    ).rejects.toThrow(/untrusted/i);
    await expect(
      ipc.invoke(
        SYNC_CHANNELS.signIn,
        { senderFrame: subFrame },
        { email: 'a@b.co', password: 'p' },
      ),
    ).rejects.toThrow(/untrusted/i);
    expect(service.signIn).not.toHaveBeenCalled();

    dispose();
  });

  it('strips any non-allowlisted secret fields from IPC responses, rejects malformed payloads, broadcasts only to authorized windows, and disposes cleanly', async () => {
    const ipc = makeFakeIpcMain();
    const { service, emitState } = makeStubService();
    const log = vi.fn();
    const trustedSend = vi.fn();
    const untrustedSend = vi.fn();
    const destroyedSend = vi.fn();
    const trustedEvent = { senderFrame: { url: 'app://elv/' } };

    const dispose = registerSyncIpc({
      ipcMain: ipc.ipcMain,
      service,
      log,
      getBroadcastTargets: () => [
        { isDestroyed: () => false, getURL: () => 'app://elv/', send: trustedSend },
        { isDestroyed: () => false, getURL: () => 'https://evil.test/', send: untrustedSend },
        { isDestroyed: () => true, getURL: () => 'app://elv/', send: destroyedSend },
      ],
    });

    // Response projection strips any accidental secret fields
    const state = (await ipc.invoke(SYNC_CHANNELS.getState, trustedEvent)) as Record<
      string,
      unknown
    >;
    expect(state.accessToken).toBeUndefined();
    expect(state.vaultKey).toBeUndefined();
    expect(state.email).toBe('viewer@example.test');

    const signInRes = (await ipc.invoke(SYNC_CHANNELS.signIn, trustedEvent, {
      email: 'viewer@example.test',
      password: 'StrongPassword123!',
    })) as Record<string, unknown>;
    expect(signInRes).toEqual({ ok: true });
    expect(signInRes.refreshToken).toBeUndefined();

    const qrRes = (await ipc.invoke(SYNC_CHANNELS.createQr, trustedEvent)) as Record<
      string,
      unknown
    >;
    expect(qrRes.pollToken).toBeUndefined();
    expect(qrRes.ephemeralKey).toBeUndefined();
    expect(qrRes.code).toBe('ABCDEF123456');

    // Invalid payloads rejected cleanly without echoing secrets into logs
    await expect(
      ipc.invoke(SYNC_CHANNELS.signIn, trustedEvent, {
        email: 'a@b.co',
        password: 'SUPER_SECRET_PASSWORD',
        extra: true,
      }),
    ).rejects.toThrow();
    await expect(
      ipc.invoke(SYNC_CHANNELS.setServerUrl, trustedEvent, { serverUrl: 'http://evil.test' }),
    ).rejects.toThrow();
    await expect(
      ipc.invoke(SYNC_CHANNELS.telemetryRecord, trustedEvent, { kind: 'bad' }),
    ).rejects.toThrow();
    await expect(
      ipc.invoke(SYNC_CHANNELS.feedbackSubmit, trustedEvent, {
        category: 'bad',
        message: 'hi',
        includeDiagnostics: false,
      }),
    ).rejects.toThrow();
    expect(log.mock.calls.flat().join('\n')).not.toContain('SUPER_SECRET_PASSWORD');

    // Broadcast reaches only authorized non-destroyed windows
    emitState({
      status: 'signed_out',
      email: null,
      lastSyncedAtIso: null,
      pendingRecoveryCode: null,
      errorCode: null,
    });
    expect(trustedSend).toHaveBeenCalledWith(SYNC_CHANNELS.stateChanged, {
      status: 'signed_out',
      email: null,
      lastSyncedAtIso: null,
      pendingRecoveryCode: null,
      errorCode: null,
    });
    expect(untrustedSend).not.toHaveBeenCalled();
    expect(destroyedSend).not.toHaveBeenCalled();

    // Valid telemetry & feedback channels forward cleanly
    expect(
      await ipc.invoke(SYNC_CHANNELS.telemetrySetOptIn, trustedEvent, { enabled: true }),
    ).toEqual({ optedIn: true, queuedCount: 0, previewJson: '{}' });
    await ipc.invoke(SYNC_CHANNELS.telemetryRecord, trustedEvent, {
      kind: 'screen_transition',
      screen: 'live',
      durationMs: 22,
    });
    await ipc.invoke(SYNC_CHANNELS.telemetryFlush, trustedEvent);
    expect(
      await ipc.invoke(SYNC_CHANNELS.feedbackSubmit, trustedEvent, {
        category: 'other',
        message: 'Hello',
        includeDiagnostics: false,
      }),
    ).toEqual({ ok: true, id: 'fb-1' });

    // Dispose tears down all 16 handlers and service
    dispose();
    expect(ipc.ipcMain.removeHandler).toHaveBeenCalledTimes(16);
    expect(service.dispose).toHaveBeenCalledTimes(1);
  });
});
