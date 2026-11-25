import { describe, expect, it, vi } from 'vitest';
import { PLAYER_CHANNELS, type VideoFrameLike } from '../shared/player-ipc.ts';
import {
  createPlayerBridge,
  type IpcRendererLike,
  type SharedTextureReceiverLike,
} from './player-bridge.ts';

function fakeSharedTexture() {
  let receiver:
    | ((
        data: { importedSharedTexture: { getVideoFrame(): VideoFrameLike; release(): void } },
        engineId?: unknown,
      ) => Promise<void> | void)
    | undefined;
  const api: SharedTextureReceiverLike = {
    setSharedTextureReceiver: vi.fn((cb) => {
      receiver = cb;
    }),
  };
  const deliver = async (
    importedSharedTexture: { getVideoFrame(): VideoFrameLike; release(): void },
    engineId?: unknown,
  ) => {
    if (!receiver) throw new Error('sharedTexture receiver not registered');
    await receiver({ importedSharedTexture }, engineId);
  };
  return { api, deliver };
}

function fakeFrame(width = 1920, height = 1080) {
  return {
    codedWidth: width,
    codedHeight: height,
    displayWidth: width,
    displayHeight: height,
    close: vi.fn<() => void>(),
  };
}

function fakeIpcRenderer() {
  const listeners = new Map<string, Set<(event: unknown, ...args: unknown[]) => void>>();
  const ipc = {
    invoke: vi.fn(async (_channel: string, ..._args: unknown[]): Promise<unknown> => undefined),
    send: vi.fn(),
    on: vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
    }),
    removeListener: vi.fn(
      (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
        listeners.get(channel)?.delete(listener);
      },
    ),
  } satisfies IpcRendererLike;
  const deliver = (channel: string, ...args: unknown[]) => {
    for (const l of [...(listeners.get(channel) ?? [])]) l({ sender: 'raw-ipc-event' }, ...args);
  };
  return { ipc, deliver, count: (channel: string) => listeners.get(channel)?.size ?? 0 };
}

describe('createPlayerBridge', () => {
  it('exposes no raw ipcRenderer', () => {
    const { ipc } = fakeIpcRenderer();
    const bridge = createPlayerBridge(ipc);
    expect(Object.keys(bridge).sort()).toEqual(
      [
        'close',
        'onEvent',
        'onFrame',
        'onRemoteMediaAction',
        'onUi',
        'open',
        'pickSubtitleFile',
        'reportGate',
        'send',
        'setArea',
        'setPrimary',
      ].sort(),
    );
    for (const value of Object.values(bridge)) expect(typeof value).toBe('function');
    expect(Object.values(bridge)).not.toContain(ipc);
    expect(Object.isFrozen(bridge)).toBe(true);
  });

  it('hands listeners the message only, never the ipc event', () => {
    const { ipc, deliver } = fakeIpcRenderer();
    const bridge = createPlayerBridge(ipc);
    const seen: unknown[][] = [];
    bridge.onEvent((...args) => seen.push(args));
    const message = { engineId: 'e1', event: { attempt: 1, type: 'state', state: 'playing' } };
    deliver(PLAYER_CHANNELS.event, message);
    expect(seen).toEqual([[message]]);
  });

  it('unsubscribe removes the listener', () => {
    const { ipc, deliver, count } = fakeIpcRenderer();
    const bridge = createPlayerBridge(ipc);
    const onEvent = vi.fn();
    const onUi = vi.fn();
    const onRemote = vi.fn();
    const offEvent = bridge.onEvent(onEvent);
    const offUi = bridge.onUi(onUi);
    const offRemote = bridge.onRemoteMediaAction?.(onRemote);
    expect(count(PLAYER_CHANNELS.event)).toBe(1);
    expect(count(PLAYER_CHANNELS.ui)).toBe(1);
    expect(count(PLAYER_CHANNELS.remoteMediaAction)).toBe(1);
    deliver(PLAYER_CHANNELS.remoteMediaAction, { engineId: 'e1', action: 'next' });
    expect(onRemote).toHaveBeenCalledWith({ engineId: 'e1', action: 'next' });
    offEvent();
    offUi();
    offRemote?.();
    expect(count(PLAYER_CHANNELS.event)).toBe(0);
    expect(count(PLAYER_CHANNELS.ui)).toBe(0);
    expect(count(PLAYER_CHANNELS.remoteMediaAction)).toBe(0);
    deliver(PLAYER_CHANNELS.event, { engineId: 'e1' });
    deliver(PLAYER_CHANNELS.ui, { engineId: 'e1' });
    deliver(PLAYER_CHANNELS.remoteMediaAction, { engineId: 'e1', action: 'previous' });
    expect(onEvent).not.toHaveBeenCalled();
    expect(onUi).not.toHaveBeenCalled();
    expect(onRemote).toHaveBeenCalledTimes(1);
  });

  it('open invokes player:open (with optional options) and validates the reply', async () => {
    const { ipc } = fakeIpcRenderer();
    const bridge = createPlayerBridge(ipc);
    ipc.invoke.mockResolvedValueOnce({ engineId: 'e1', mainNowMs: 123 });
    await expect(bridge.open()).resolves.toEqual({ engineId: 'e1', mainNowMs: 123 });
    expect(ipc.invoke).toHaveBeenCalledWith(PLAYER_CHANNELS.open);
    ipc.invoke.mockResolvedValueOnce({ engineId: 'e2', mainNowMs: 456 });
    await expect(bridge.open({ replaceExisting: false, primary: false })).resolves.toEqual({
      engineId: 'e2',
      mainNowMs: 456,
    });
    expect(ipc.invoke).toHaveBeenLastCalledWith(PLAYER_CHANNELS.open, {
      replaceExisting: false,
      primary: false,
    });
    await bridge.setPrimary?.('e2');
    expect(ipc.invoke).toHaveBeenLastCalledWith(PLAYER_CHANNELS.setPrimary, 'e2');
    ipc.invoke.mockResolvedValueOnce({ engineId: 7 });
    await expect(bridge.open()).rejects.toThrow(/reply/);
    ipc.invoke.mockResolvedValueOnce(null);
    await expect(bridge.open()).rejects.toThrow(/reply/);
  });

  it('close, send, setArea and reportGate use their channels', async () => {
    const { ipc } = fakeIpcRenderer();
    const bridge = createPlayerBridge(ipc);
    await bridge.close('e1');
    expect(ipc.invoke).toHaveBeenCalledWith(PLAYER_CHANNELS.close, 'e1');
    const command = { engineId: 'e1', command: { name: 'stop', attempt: 2 } } as const;
    bridge.send(command);
    expect(ipc.send).toHaveBeenCalledWith(PLAYER_CHANNELS.command, command);
    const displaySyncCmd = {
      engineId: 'e1',
      command: {
        name: 'setDisplaySync',
        policy: { autoFrameRate: 'seamless', autoDynamicRange: true },
      },
    } as const;
    bridge.send(displaySyncCmd);
    expect(ipc.send).toHaveBeenCalledWith(PLAYER_CHANNELS.command, displaySyncCmd);
    const audioOutCmd = {
      engineId: 'e1',
      command: {
        name: 'setDesktopAudioOutput',
        config: {
          passthrough: true,
          codecs: ['ac3', 'eac3'],
          exclusive: false,
          ac3Encode: false,
          channelLayout: 'auto',
        },
      },
    } as const;
    bridge.send(audioOutCmd);
    expect(ipc.send).toHaveBeenCalledWith(PLAYER_CHANNELS.command, audioOutCmd);
    const area = { engineId: 'e1', area: { x: 0, y: 0, width: 2, height: 2, visible: true } };
    bridge.setArea(area);
    expect(ipc.send).toHaveBeenCalledWith(PLAYER_CHANNELS.area, area);
    bridge.reportGate('ELV_GATE_PLAYER {}');
    expect(ipc.send).toHaveBeenCalledWith(PLAYER_CHANNELS.gateReport, 'ELV_GATE_PLAYER {}');
  });

  it('registers sharedTexture receiver once and routes frames by engineId while releasing textures', async () => {
    const { ipc } = fakeIpcRenderer();
    const shared = fakeSharedTexture();
    const bridge = createPlayerBridge(ipc, shared.api);
    expect(shared.api.setSharedTextureReceiver).toHaveBeenCalledTimes(1);

    const seen1: VideoFrameLike[] = [];
    const seen2: VideoFrameLike[] = [];
    const off1 = bridge.onFrame?.('e1', (frame) => seen1.push(frame));
    const off2 = bridge.onFrame?.('e2', (frame) => seen2.push(frame));

    const frame1 = fakeFrame(1280, 720);
    const release1 = vi.fn();
    await shared.deliver({ getVideoFrame: () => frame1, release: release1 }, 'e1');
    expect(seen1).toEqual([frame1]);
    expect(seen2).toEqual([]);
    expect(release1).toHaveBeenCalledTimes(1);
    expect(frame1.close).not.toHaveBeenCalled();

    const frame2 = fakeFrame(1920, 1080);
    const release2 = vi.fn();
    await shared.deliver({ getVideoFrame: () => frame2, release: release2 }, 'e2');
    expect(seen2).toEqual([frame2]);
    expect(release2).toHaveBeenCalledTimes(1);

    off1?.();
    off2?.();
  });

  it('releases importedSharedTexture without creating a VideoFrame when no listener matches or engineId is invalid', async () => {
    const { ipc } = fakeIpcRenderer();
    const shared = fakeSharedTexture();
    createPlayerBridge(ipc, shared.api);

    const getVideoFrame = vi.fn(() => fakeFrame());
    const releaseA = vi.fn();
    await shared.deliver({ getVideoFrame, release: releaseA }, 'missing-engine');
    expect(getVideoFrame).not.toHaveBeenCalled();
    expect(releaseA).toHaveBeenCalledTimes(1);

    const releaseB = vi.fn();
    await shared.deliver({ getVideoFrame, release: releaseB }, 42);
    expect(getVideoFrame).not.toHaveBeenCalled();
    expect(releaseB).toHaveBeenCalledTimes(1);

    const releaseC = vi.fn();
    await shared.deliver({ getVideoFrame, release: releaseC }, undefined);
    expect(getVideoFrame).not.toHaveBeenCalled();
    expect(releaseC).toHaveBeenCalledTimes(1);
  });

  it('closes the VideoFrame and still releases importedSharedTexture when a listener throws', async () => {
    const { ipc } = fakeIpcRenderer();
    const shared = fakeSharedTexture();
    const bridge = createPlayerBridge(ipc, shared.api);

    bridge.onFrame?.('e1', () => {
      throw new Error('draw failure');
    });

    const frame = fakeFrame();
    const release = vi.fn();
    await expect(
      shared.deliver({ getVideoFrame: () => frame, release }, 'e1'),
    ).resolves.toBeUndefined();
    expect(frame.close).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);

    // Even if frame.close() also throws, release() is still called and no error escapes.
    const badFrame = fakeFrame();
    badFrame.close.mockImplementation(() => {
      throw new Error('already closed');
    });
    const release2 = vi.fn();
    await expect(
      shared.deliver({ getVideoFrame: () => badFrame, release: release2 }, 'e1'),
    ).resolves.toBeUndefined();
    expect(badFrame.close).toHaveBeenCalledTimes(1);
    expect(release2).toHaveBeenCalledTimes(1);
  });

  it('releases importedSharedTexture when getVideoFrame throws', async () => {
    const { ipc } = fakeIpcRenderer();
    const shared = fakeSharedTexture();
    const bridge = createPlayerBridge(ipc, shared.api);
    bridge.onFrame?.('e1', vi.fn());

    const release = vi.fn();
    await expect(
      shared.deliver(
        {
          getVideoFrame: () => {
            throw new Error('gpu lost');
          },
          release,
        },
        'e1',
      ),
    ).rejects.toThrow('gpu lost');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('onFrame unsubscribe is idempotent and does not remove a replacement listener', async () => {
    const { ipc } = fakeIpcRenderer();
    const shared = fakeSharedTexture();
    const bridge = createPlayerBridge(ipc, shared.api);

    const first = vi.fn();
    const second = vi.fn();
    const offFirst = bridge.onFrame?.('e1', first);
    const offSecond = bridge.onFrame?.('e1', second);

    // Unsubscribing the replaced first listener must NOT detach the newer second listener.
    offFirst?.();
    offFirst?.();

    const frame1 = fakeFrame();
    const release1 = vi.fn();
    await shared.deliver({ getVideoFrame: () => frame1, release: release1 }, 'e1');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(frame1);
    expect(release1).toHaveBeenCalledTimes(1);

    // Unsubscribing the second listener is idempotent and stops further deliveries.
    offSecond?.();
    offSecond?.();

    const getVideoFrame = vi.fn(() => fakeFrame());
    const release2 = vi.fn();
    await shared.deliver({ getVideoFrame, release: release2 }, 'e1');
    expect(getVideoFrame).not.toHaveBeenCalled();
    expect(release2).toHaveBeenCalledTimes(1);
  });
});
