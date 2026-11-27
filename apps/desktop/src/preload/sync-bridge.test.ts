import { describe, expect, it, vi } from 'vitest';
import { SYNC_CHANNELS } from '../shared/sync-ipc.ts';
import { createSyncBridges } from './sync-bridge.ts';

describe('createSyncBridges (#26, #458)', () => {
  it('returns frozen sync, telemetry, and feedback bridges forwarding validated payloads over exact channels', async () => {
    const listeners = new Map<string, Set<(event: unknown, ...args: unknown[]) => void>>();
    const invoke = vi.fn(async (channel: string) => {
      switch (channel) {
        case SYNC_CHANNELS.getState:
          return {
            status: 'signed_out',
            email: null,
            lastSyncedAtIso: null,
            pendingRecoveryCode: null,
            errorCode: null,
          };
        case SYNC_CHANNELS.signIn:
        case SYNC_CHANNELS.syncNow:
        case SYNC_CHANNELS.deleteAccount:
        case SYNC_CHANNELS.claimQr:
          return { ok: true };
        case SYNC_CHANNELS.register:
          return { ok: true, recoveryCode: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF' };
        case SYNC_CHANNELS.createQr:
          return {
            pairingId: 'p1',
            code: 'ABCDEF123456',
            qrUri: 'elviptv://pair?c=ABCDEF123456&k=AAAAAAAAAAAAAAAAAAAAAA',
            expiresAtMs: Date.now() + 300_000,
            status: 'pending',
          };
        case SYNC_CHANNELS.pollQr:
          return 'pending';
        case SYNC_CHANNELS.telemetrySetOptIn:
        case SYNC_CHANNELS.telemetryGetStatus:
          return { optedIn: true, queuedCount: 1, previewJson: '{"events":[]}' };
        case SYNC_CHANNELS.feedbackSubmit:
          return { ok: true, id: 'fb-1' };
        default:
          return undefined;
      }
    });

    const ipc = {
      invoke,
      on: vi.fn((ch: string, fn: (event: unknown, ...args: unknown[]) => void) => {
        const set = listeners.get(ch) ?? new Set();
        set.add(fn);
        listeners.set(ch, set);
      }),
      removeListener: vi.fn((ch: string, fn: (event: unknown, ...args: unknown[]) => void) => {
        listeners.get(ch)?.delete(fn);
      }),
    };

    const bridges = createSyncBridges(ipc);
    expect(Object.isFrozen(bridges)).toBe(true);
    expect(Object.isFrozen(bridges.sync)).toBe(true);
    expect(Object.isFrozen(bridges.telemetry)).toBe(true);
    expect(Object.isFrozen(bridges.feedback)).toBe(true);

    expect((await bridges.sync.getState()).status).toBe('signed_out');
    expect(await bridges.sync.signIn('a@b.co', 'StrongPass123!')).toEqual({ ok: true });
    expect(await bridges.sync.register('a@b.co', 'StrongPass123!', 'StrongPass123!')).toEqual({
      ok: true,
      recoveryCode: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF',
    });
    await bridges.sync.acknowledgeRecoveryCode();
    expect(await bridges.sync.syncNow()).toEqual({ ok: true });
    await bridges.sync.signOut();
    expect(await bridges.sync.deleteAccount('StrongPass123!')).toEqual({ ok: true });
    expect((await bridges.sync.createQrPairing()).code).toBe('ABCDEF123456');
    expect(await bridges.sync.pollQrPairing('p1')).toBe('pending');
    expect(await bridges.sync.claimQrPairing('elviptv://pair?c=ABCDEF123456&k=AAAA')).toEqual({
      ok: true,
    });
    await bridges.sync.setServerUrl('https://sync.example.test');
    await bridges.sync.markSyncDirty?.();
    expect(invoke).toHaveBeenCalledWith(SYNC_CHANNELS.markSyncDirty);

    // State change push listener ignores malformed events and delivers valid ones
    const observed: unknown[] = [];
    const unsub = bridges.sync.onStateChanged((s) => observed.push(s));
    for (const fn of listeners.get(SYNC_CHANNELS.stateChanged) ?? []) {
      fn({}, { bad: true, accessToken: 'leak' });
      fn(
        {},
        {
          status: 'signed_in',
          email: 'a@b.co',
          lastSyncedAtIso: null,
          pendingRecoveryCode: null,
          errorCode: null,
        },
      );
    }
    expect(observed).toHaveLength(1);
    unsub();
    expect(ipc.removeListener).toHaveBeenCalledWith(
      SYNC_CHANNELS.stateChanged,
      expect.any(Function),
    );

    expect(await bridges.telemetry.setOptIn(true)).toEqual({
      optedIn: true,
      queuedCount: 1,
      previewJson: '{"events":[]}',
    });
    expect(await bridges.telemetry.getStatus()).toEqual({
      optedIn: true,
      queuedCount: 1,
      previewJson: '{"events":[]}',
    });
    await bridges.telemetry.record({ kind: 'screen_transition', screen: 'live', durationMs: 14 });
    await bridges.telemetry.flush();

    expect(
      await bridges.feedback.submit({
        category: 'other',
        message: 'Great app',
        includeDiagnostics: false,
      }),
    ).toEqual({ ok: true, id: 'fb-1' });
  });

  it('rejects invalid inputs before invoking IPC and rejects unexpected main replies', async () => {
    const invoke = vi.fn(async () => ({ bad: true }));
    const bridges = createSyncBridges({ invoke, on: vi.fn(), removeListener: vi.fn() });

    await expect(bridges.sync.signIn('', 'pw')).rejects.toThrow();
    await expect(bridges.sync.setServerUrl('http://evil.test')).rejects.toThrow();
    await expect(bridges.telemetry.setOptIn('yes' as unknown as boolean)).rejects.toThrow();
    await expect(
      bridges.telemetry.record({ kind: 'screen_transition', screen: 'live', durationMs: -5 }),
    ).rejects.toThrow();
    await expect(
      bridges.feedback.submit({
        category: 'other',
        message: '   ',
        includeDiagnostics: false,
      }),
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();

    await expect(bridges.sync.getState()).rejects.toThrow(/unexpected/i);
    await expect(bridges.sync.signIn('a@b.co', 'StrongPass123!')).rejects.toThrow(/unexpected/i);
    await expect(bridges.sync.createQrPairing()).rejects.toThrow(/unexpected/i);
    await expect(bridges.telemetry.getStatus()).rejects.toThrow(/unexpected/i);
    await expect(
      bridges.feedback.submit({ category: 'other', message: 'Hi', includeDiagnostics: false }),
    ).rejects.toThrow(/unexpected/i);
  });
});
