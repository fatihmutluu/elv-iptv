import type { EngineEvent, LoadCommand } from '@elv/playback';
import { describe, expect, it, vi } from 'vitest';
import { PLAYER_CHANNELS, type PlayerUiEvent } from '../../shared/player-ipc.ts';
import type {
  TaskbarAction,
  TaskbarController,
  TaskbarPlaybackSnapshot,
} from '../taskbar-controls.ts';
import type { MpvEngine } from './engine.ts';
import { type IpcMainLike, registerPlayerIpc, type WebContentsLike } from './ipc.ts';

type Listener = (event: { sender: WebContentsLike }, ...args: unknown[]) => unknown;

function fakeIpcMain() {
  const handlers = new Map<string, Listener>();
  const listeners = new Map<string, Listener>();
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => void handlers.set(channel, listener),
    on: (channel, listener) => void listeners.set(channel, listener),
    removeHandler: (channel) => void handlers.delete(channel),
    removeListener: (channel) => void listeners.delete(channel),
  };
  return {
    ipcMain,
    invoke: (channel: string, sender: WebContentsLike, ...args: unknown[]) =>
      Promise.resolve(handlers.get(channel)?.({ sender }, ...args)),
    emit: (channel: string, sender: WebContentsLike, ...args: unknown[]) =>
      void listeners.get(channel)?.({ sender }, ...args),
  };
}

function fakeContents(id: number) {
  let destroyed = false;
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const onDestroyed: Array<() => void> = [];
  const owner: WebContentsLike = {
    id,
    isDestroyed: () => destroyed,
    send: (channel, payload) => {
      sent.push({ channel, payload });
    },
    once: (_event, listener) => void onDestroyed.push(listener),
    on: () => undefined,
  };
  return {
    owner,
    sent,
    destroy: () => {
      destroyed = true;
      for (const l of onDestroyed) l();
    },
  };
}

function stubEngine() {
  const listeners = new Set<(event: EngineEvent) => void>();
  const engine = {
    capabilities: {},
    spawns: 0,
    maxHoldMs: 0,
    loadMode: 'replace',
    presenterKind: 'canvas',
    lastArea: undefined,
    start: () => undefined,
    setArea: () => undefined,
    toggleFullscreen: () => undefined,
    toggleMute: () => undefined,
    setVolume: () => undefined,
    setAudioDelay: () => undefined,
    setSubtitleDelay: () => undefined,
    setAudioDevice: () => undefined,
    setDeinterlace: () => undefined,
    setHwdec: () => undefined,
    load: (_cmd: LoadCommand) => undefined,
    retry: () => undefined,
    play: () => undefined,
    pause: () => undefined,
    seek: () => undefined,
    stop: () => undefined,
    recreate: () => undefined,
    release: () => undefined,
    subscribe: (listener: (e: EngineEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as MpvEngine;
  return {
    engine,
    emit: (event: EngineEvent) => {
      for (const l of [...listeners]) l(event);
    },
  };
}

describe('registerPlayerIpc taskbar integration (#410)', () => {
  it('syncs VOD/Live playback status and clock updates to taskbar and forwards thumbar clicks as player:ui keys', async () => {
    const ipc = fakeIpcMain();
    const sender = fakeContents(1);
    const stub = stubEngine();
    const updates: TaskbarPlaybackSnapshot[] = [];
    const clears = vi.fn();
    let triggerAction: ((action: TaskbarAction) => void) | undefined;

    const taskbar: TaskbarController = {
      updatePlayback: (snapshot) => updates.push(snapshot),
      clear: clears,
    };

    const dispose = registerPlayerIpc({
      ipcMain: ipc.ipcMain,
      now: () => 1000,
      log: () => undefined,
      createEngine: async () => stub.engine,
      createTaskbarController: (_owner, onAction) => {
        triggerAction = onAction;
        return taskbar;
      },
    });

    const { engineId } = (await ipc.invoke(PLAYER_CHANNELS.open, sender.owner)) as {
      engineId: string;
    };

    ipc.emit(PLAYER_CHANNELS.command, sender.owner, {
      engineId,
      command: {
        name: 'load',
        cmd: { attempt: 1, url: 'http://sim.test/vod/1.mp4', headers: {}, kind: 'vod', startMs: 0 },
      },
    });
    stub.emit({ attempt: 1, type: 'state', state: 'playing' });
    stub.emit({
      attempt: 1,
      type: 'clock',
      anchor: { positionMs: 30_000, durationMs: 120_000, atMs: 1100, rate: 1 },
    });
    stub.emit({ attempt: 1, type: 'state', state: 'paused' });

    expect(updates).toEqual([
      { active: true, isVod: true, paused: false, positionMs: 0, durationMs: 0, canStep: false },
      {
        active: true,
        isVod: true,
        paused: false,
        positionMs: 30_000,
        durationMs: 120_000,
        canStep: false,
      },
      {
        active: true,
        isVod: true,
        paused: true,
        positionMs: 30_000,
        durationMs: 120_000,
        canStep: false,
      },
    ]);

    // Thumbar clicks forward as player:ui key events to the owning renderer
    triggerAction?.('play-pause');
    triggerAction?.('channel-up');
    triggerAction?.('channel-down');
    expect(
      sender.sent
        .filter((m) => m.channel === PLAYER_CHANNELS.ui)
        .map((m) => (m.payload as { ui: PlayerUiEvent }).ui),
    ).toEqual([
      { type: 'key', key: 'play-pause' },
      { type: 'key', key: 'channel-up' },
      { type: 'key', key: 'channel-down' },
    ]);

    // Switching to live sets canStep: true and isVod: false
    ipc.emit(PLAYER_CHANNELS.command, sender.owner, {
      engineId,
      command: {
        name: 'load',
        cmd: { attempt: 2, url: 'http://sim.test/live/1.ts', headers: {}, kind: 'live' },
      },
    });
    stub.emit({ attempt: 2, type: 'state', state: 'playing' });
    expect(updates.at(-1)).toEqual({
      active: true,
      isVod: false,
      paused: false,
      positionMs: 0,
      durationMs: 0,
      canStep: true,
    });

    // Release clears taskbar cleanly
    const clearsBeforeRelease = clears.mock.calls.length;
    await ipc.invoke(PLAYER_CHANNELS.close, sender.owner, engineId);
    expect(clears.mock.calls.length).toBeGreaterThan(clearsBeforeRelease);

    dispose();
  });
});
