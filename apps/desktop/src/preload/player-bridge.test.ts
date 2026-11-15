import { describe, expect, it, vi } from 'vitest';
import { PLAYER_CHANNELS } from '../shared/player-ipc.ts';
import { createPlayerBridge, type IpcRendererLike } from './player-bridge.ts';

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
      ['close', 'onEvent', 'onUi', 'open', 'reportGate', 'send', 'setArea'].sort(),
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
    const offEvent = bridge.onEvent(onEvent);
    const offUi = bridge.onUi(onUi);
    expect(count(PLAYER_CHANNELS.event)).toBe(1);
    expect(count(PLAYER_CHANNELS.ui)).toBe(1);
    offEvent();
    offUi();
    expect(count(PLAYER_CHANNELS.event)).toBe(0);
    expect(count(PLAYER_CHANNELS.ui)).toBe(0);
    deliver(PLAYER_CHANNELS.event, { engineId: 'e1' });
    deliver(PLAYER_CHANNELS.ui, { engineId: 'e1' });
    expect(onEvent).not.toHaveBeenCalled();
    expect(onUi).not.toHaveBeenCalled();
  });

  it('open invokes player:open and validates the reply', async () => {
    const { ipc } = fakeIpcRenderer();
    const bridge = createPlayerBridge(ipc);
    ipc.invoke.mockResolvedValueOnce({ engineId: 'e1', mainNowMs: 123 });
    await expect(bridge.open()).resolves.toEqual({ engineId: 'e1', mainNowMs: 123 });
    expect(ipc.invoke).toHaveBeenCalledWith(PLAYER_CHANNELS.open);
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
    const area = { engineId: 'e1', area: { x: 0, y: 0, width: 2, height: 2, visible: true } };
    bridge.setArea(area);
    expect(ipc.send).toHaveBeenCalledWith(PLAYER_CHANNELS.area, area);
    bridge.reportGate('ELV_GATE_PLAYER {}');
    expect(ipc.send).toHaveBeenCalledWith(PLAYER_CHANNELS.gateReport, 'ELV_GATE_PLAYER {}');
  });
});
