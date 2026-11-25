import { describe, expect, it, vi } from 'vitest';
import type { PlayerBridge, PlayerCommandMessage } from '../../../src/shared/player-ipc.ts';
import type { WindowBridge } from '../../../src/shared/window-ipc.ts';
import { createDesktopVideoHost } from './desktop-video-host.tsx';

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  StyleSheet: { create: <T>(s: T): T => s },
}));

function fakePlayerBridge() {
  const sent: PlayerCommandMessage[] = [];
  const open = vi.fn(async () => ({ engineId: 'engine-1', mainNowMs: 100 }));
  const close = vi.fn(async () => undefined);
  const setPrimary = vi.fn(async () => undefined);
  const bridge: PlayerBridge = {
    open,
    close,
    setPrimary,
    send: (m) => void sent.push(m),
    setArea: () => undefined,
    onEvent: () => () => undefined,
    onUi: () => () => undefined,
    onRemoteMediaAction: () => () => undefined,
    reportGate: () => undefined,
  };
  return { bridge, sent, open, close, setPrimary };
}

function fakeWindowBridge(): WindowBridge {
  return {
    setAlwaysOnTop: vi.fn(async (flag: boolean) => flag),
    getAlwaysOnTop: vi.fn(async () => false),
    onAlwaysOnTopChanged: () => () => undefined,
    setAspectRatioLock: vi.fn(async (flag: boolean) => flag),
    setMinimizeToTray: vi.fn(async (flag: boolean) => flag),
    openPopout: vi.fn(async () => true),
    closePopout: vi.fn(async () => undefined),
    getPopoutPayload: vi.fn(async () => null),
    onPopoutPayload: () => () => undefined,
    dockPopout: vi.fn(async () => undefined),
    onPopoutDocked: () => () => undefined,
    onWindowRestored: () => () => undefined,
    onHiddenToTray: () => () => undefined,
  };
}

describe('createDesktopVideoHost (#34)', () => {
  it('sets supportsMultiView true only when presenterKind is canvas', () => {
    const pb = fakePlayerBridge().bridge;
    expect(
      createDesktopVideoHost({ playerBridge: pb, presenterKind: 'canvas' }).supportsMultiView,
    ).toBe(true);
    expect(
      createDesktopVideoHost({ playerBridge: pb, presenterKind: 'child-window' }).supportsMultiView,
    ).toBe(false);
    expect(
      createDesktopVideoHost({ playerBridge: pb, presenterKind: 'own-window' }).supportsMultiView,
    ).toBe(false);
    expect(createDesktopVideoHost({ playerBridge: pb }).supportsMultiView).toBe(false);
  });

  it('forwards replaceExisting/primary open options and exposes setMuted & setPrimary on OpenVideoEngine', async () => {
    const fake = fakePlayerBridge();
    const wb = fakeWindowBridge();
    const host = createDesktopVideoHost({
      playerBridge: fake.bridge,
      windowBridge: wb,
      presenterKind: 'canvas',
    });

    const opened = await host.open({ replaceExisting: false, primary: false });
    expect(opened).not.toBeNull();
    expect(fake.open).toHaveBeenCalledWith({ replaceExisting: false, primary: false });

    opened?.setMuted?.(true);
    opened?.setMuted?.(false);
    opened?.setPrimary?.();

    expect(fake.sent).toContainEqual({
      engineId: 'engine-1',
      command: { name: 'setMuted', muted: true },
    });
    expect(fake.sent).toContainEqual({
      engineId: 'engine-1',
      command: { name: 'setMuted', muted: false },
    });
    expect(fake.setPrimary).toHaveBeenCalledWith('engine-1');

    opened?.engine.release();
  });

  it('returns null when no playerBridge is available', async () => {
    const host = createDesktopVideoHost({ playerBridge: undefined });
    await expect(host.open()).resolves.toBeNull();
  });
});
