import { describe, expect, it, vi } from 'vitest';
import type {
  FeedbackBridge,
  SyncAccountStateIpc,
  SyncBridge,
  TelemetryBridge,
  TelemetryStatusIpc,
} from '../../../src/shared/sync-ipc.ts';
import { createDesktopSyncPorts, extractSafeRendererErrorSignature } from './desktop-sync-ports.ts';

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
    ports.telemetry?.recordStartup(340, true);
    ports.telemetry?.recordPlaybackStart({
      engine: 'mpv',
      ttffMs: 220,
      isLive: true,
      container: 'ts',
    });
    ports.telemetry?.recordPlaybackRebuffer({ engine: 'mpv', durationMs: 450, isLive: true });
    ports.telemetry?.recordSqliteSlowOp({ op: 'SELECT', durationMs: 310 });
    ports.telemetry?.recordCatalogImport({
      sourceKind: 'm3u',
      stage: 'catalog',
      durationMs: 900,
      itemCount: 150,
      success: true,
    });
    ports.telemetry?.recordUnhandledError({
      errorName: 'TypeError',
      stackSig: 'App.tsx:42',
      source: 'renderer',
    });
    await vi.waitFor(() => expect(telemetryBridge.record).toHaveBeenCalledTimes(7));
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

  it('forwards markSyncDirty() over IPC and redacts provider URLs/host:ports BEFORE extracting renderer stack signatures (P1-3, P1-6)', () => {
    const markSyncDirty = vi.fn(async () => undefined);
    const notifySyncDirty = vi.fn(async () => undefined);
    const ports = createDesktopSyncPorts({
      sync: {
        getState: vi.fn(async () => ({
          status: 'signed_out' as const,
          email: null,
          lastSyncedAtIso: null,
          pendingRecoveryCode: null,
          errorCode: null,
        })),
        onStateChanged: vi.fn(() => () => undefined),
        signIn: vi.fn(async () => ({ ok: true })),
        register: vi.fn(async () => ({ ok: true })),
        acknowledgeRecoveryCode: vi.fn(async () => undefined),
        syncNow: vi.fn(async () => ({ ok: true })),
        signOut: vi.fn(async () => undefined),
        deleteAccount: vi.fn(async () => ({ ok: true })),
        createQrPairing: vi.fn(async () => ({
          pairingId: 'p1',
          code: '123456',
          qrUri: 'elviptv://pair?c=123456&k=AAAAAAAAAAAAAAAAAAAAAA',
          expiresAtMs: Date.now() + 300_000,
          status: 'pending' as const,
        })),
        pollQrPairing: vi.fn(async () => 'pending' as const),
        claimQrPairing: vi.fn(async () => ({ ok: true })),
        setServerUrl: vi.fn(async () => undefined),
        markSyncDirty,
        notifySyncDirty,
      },
    });
    ports.syncAccount?.markSyncDirty();
    expect(markSyncDirty).toHaveBeenCalledTimes(1);
    expect(notifySyncDirty).not.toHaveBeenCalled();
    ports.dispose();

    const leaked = extractSafeRendererErrorSignature(
      Object.assign(new TypeError('stream failed'), {
        stack:
          'TypeError: stream failed\n    at load (https://myprovider.de:8080/live/u/p/99.ts:12:4)\n    at myprovider.de:8080/playlist.m3u',
      }),
      'https://myprovider.de:8080/live/99.ts',
      8080,
    );
    expect(leaked.errorName).toBe('TypeError');
    expect(leaked.stackSig).not.toContain('myprovider');
    expect(leaked.stackSig).not.toContain('8080');
    expect(leaked.stackSig).not.toContain('99.ts');

    const safeBundle = extractSafeRendererErrorSignature(
      Object.assign(new Error('boom'), {
        stack: 'Error: boom\n    at onPlay (App.tsx:77:3)',
      }),
    );
    expect(safeBundle).toEqual({ errorName: 'Error', stackSig: 'App.tsx:77' });
  });

  it('guards hydrate() with a monotonic mutation counter so in-flight hydrate() never overwrites a newer setOptIn(true) and notifies onTelemetryStatusChanged after record/flush (MEDIUM #15)', async () => {
    let resolveHydrateStatus!: (status: {
      optedIn: boolean;
      queuedCount: number;
      previewJson: string;
    }) => void;
    let getStatusCalls = 0;
    let queuedCount = 0;
    let optedIn = false;

    const telemetryBridge: TelemetryBridge = {
      setOptIn: vi.fn(async (enabled) => {
        optedIn = enabled;
        if (!enabled) queuedCount = 0;
        return { optedIn, queuedCount, previewJson: `{"optedIn":${String(optedIn)}}` };
      }),
      getStatus: vi.fn((): Promise<TelemetryStatusIpc> => {
        getStatusCalls += 1;
        if (getStatusCalls === 1) {
          // Simulate slow initial hydrate() returning stale optedIn: false AFTER user toggles opt-in
          return new Promise<TelemetryStatusIpc>((resolve) => {
            resolveHydrateStatus = resolve;
          });
        }
        return Promise.resolve({
          optedIn,
          queuedCount,
          previewJson: `{"optedIn":${String(optedIn)},"queued":${queuedCount}}`,
        });
      }),
      record: vi.fn(async () => {
        queuedCount += 1;
      }),
      flush: vi.fn(async () => {
        queuedCount = 0;
      }),
    };

    const ports = createDesktopSyncPorts({ telemetry: telemetryBridge });
    const observed: Array<{ optedIn: boolean; queuedCount: number; previewJson: string }> = [];
    const unsub = ports.onTelemetryStatusChanged((status) => observed.push(status));

    // Start hydrate() (in-flight)
    const hydratePromise = ports.hydrate();

    // User enables opt-in while hydrate() is still in flight
    ports.telemetry?.setOptIn(true);
    expect(ports.telemetry?.isOptedIn()).toBe(true);

    // Stale hydrate() resolves with optedIn: false -> MUST NOT overwrite setOptIn(true)!
    resolveHydrateStatus({ optedIn: false, queuedCount: 0, previewJson: '{"stale":true}' });
    await hydratePromise;

    expect(ports.telemetry?.isOptedIn()).toBe(true);
    expect(ports.telemetry?.getPayloadPreviewJson()).not.toContain('"stale":true');

    // Recording an event refreshes queuedCount & previewJson and notifies subscribers
    ports.telemetry?.recordPlaybackError({ engine: 'mpv', errorCode: 'network', isLive: true });
    await vi.waitFor(() => {
      expect(ports.telemetry?.queuedCount()).toBe(1);
      expect(ports.telemetry?.getPayloadPreviewJson()).toContain('"queued":1');
    });
    expect(observed.some((s) => s.queuedCount === 1)).toBe(true);

    // Flushing refreshes queuedCount back to 0 and notifies subscribers
    await ports.telemetry?.flush();
    expect(ports.telemetry?.queuedCount()).toBe(0);
    expect(ports.telemetry?.getPayloadPreviewJson()).toContain('"queued":0');
    expect(observed[observed.length - 1]?.queuedCount).toBe(0);

    unsub();
    ports.dispose();
  });

  it('exposes empty supportedOAuthProviders and forwards checkEmail with graceful unknown fallback (#513)', async () => {
    const baseBridge: SyncBridge = {
      getState: vi.fn(async () => ({
        status: 'signed_out' as const,
        email: null,
        lastSyncedAtIso: null,
        pendingRecoveryCode: null,
        errorCode: null,
      })),
      onStateChanged: vi.fn(() => () => undefined),
      signIn: vi.fn(async () => ({ ok: true })),
      register: vi.fn(async () => ({ ok: true })),
      acknowledgeRecoveryCode: vi.fn(async () => undefined),
      syncNow: vi.fn(async () => ({ ok: true })),
      signOut: vi.fn(async () => undefined),
      deleteAccount: vi.fn(async () => ({ ok: true })),
      createQrPairing: vi.fn(async () => ({
        pairingId: 'p1',
        code: '123456',
        qrUri: 'elviptv://pair?c=123456&k=AAAAAAAAAAAAAAAAAAAAAA',
        expiresAtMs: Date.now() + 300_000,
        status: 'pending' as const,
      })),
      pollQrPairing: vi.fn(async () => 'pending' as const),
      claimQrPairing: vi.fn(async () => ({ ok: true })),
      setServerUrl: vi.fn(async () => undefined),
    };

    // Without preload checkEmail method -> falls back gracefully to 'unknown'
    const portsWithoutCheck = createDesktopSyncPorts({ sync: baseBridge });
    expect(portsWithoutCheck.syncAccount?.supportedOAuthProviders).toEqual([]);
    expect(await portsWithoutCheck.syncAccount?.checkEmail('alice@example.com')).toBe('unknown');
    portsWithoutCheck.dispose();

    // With preload checkEmail -> forwards exists / not_found and swallows IPC errors
    const checkEmailMock = vi
      .fn<(email: string) => Promise<'exists' | 'not_found' | 'unknown'>>()
      .mockResolvedValueOnce('exists')
      .mockResolvedValueOnce('not_found')
      .mockRejectedValueOnce(new Error('ipc timeout'));

    const portsWithCheck = createDesktopSyncPorts({
      sync: Object.assign({}, baseBridge, { checkEmail: checkEmailMock }),
    });
    expect(await portsWithCheck.syncAccount?.checkEmail('alice@example.com')).toBe('exists');
    expect(await portsWithCheck.syncAccount?.checkEmail('new@example.com')).toBe('not_found');
    expect(await portsWithCheck.syncAccount?.checkEmail('offline@example.com')).toBe('unknown');
    portsWithCheck.dispose();
  });
});
