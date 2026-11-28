import type { EngineEvent, LoadCommand } from '@elv/playback';
import { describe, expect, it, vi } from 'vitest';
import { PLAYER_CHANNELS } from '../../shared/player-ipc.ts';
import type {
  DesktopMediaBridge,
  DesktopMediaCommand,
  DesktopMediaStateSnapshot,
} from '../media-bridge.ts';
import type { TrustedSenderEventLike } from '../trusted-sender.ts';
import type { MpvEngine } from './engine.ts';
import { type IpcMainLike, registerPlayerIpc, type WebContentsLike } from './ipc.ts';

type Listener = (
  event: TrustedSenderEventLike & { sender: WebContentsLike },
  ...args: unknown[]
) => unknown;

function trustedEvent(sender: WebContentsLike) {
  const frame: { url: string; top?: unknown } = { url: 'app://elv/index.html' };
  frame.top = frame;
  return { sender, senderFrame: frame };
}

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
      Promise.resolve(handlers.get(channel)?.(trustedEvent(sender), ...args)),
    emit: (channel: string, sender: WebContentsLike, ...args: unknown[]) =>
      void listeners.get(channel)?.(trustedEvent(sender), ...args),
  };
}

function fakeContents(id: number) {
  const destroyed = false;
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
  return { owner, sent };
}

function stubEngine() {
  const listeners = new Set<(event: EngineEvent) => void>();
  const spies = {
    load: vi.fn((_cmd: LoadCommand) => undefined),
    play: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    seek: vi.fn(),
    setSpeed: vi.fn(),
    setVolume: vi.fn(),
    release: vi.fn(),
  };
  const engine = {
    ...spies,
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
    setAudioDelay: () => undefined,
    setSubtitleDelay: () => undefined,
    setAudioDevice: () => undefined,
    setDeinterlace: () => undefined,
    setHwdec: () => undefined,
    retry: () => undefined,
    recreate: () => undefined,
    subscribe: (listener: (e: EngineEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as MpvEngine;
  return {
    engine,
    spies,
    emit: (event: EngineEvent) => {
      for (const l of [...listeners]) l(event);
    },
  };
}

function fakeMediaBridge() {
  const states: DesktopMediaStateSnapshot[] = [];
  const seeked: number[] = [];
  const commandListeners = new Set<(cmd: DesktopMediaCommand) => void>();
  const bridge: DesktopMediaBridge = {
    updateState: (s) => states.push(s),
    notifySeeked: (pos) => seeked.push(pos),
    onCommand: (l) => {
      commandListeners.add(l);
      return () => commandListeners.delete(l);
    },
    dispose: vi.fn(),
  };
  return {
    bridge,
    states,
    seeked,
    commandListeners,
    sendCommand: (cmd: DesktopMediaCommand) => {
      for (const l of [...commandListeners]) l(cmd);
    },
  };
}

describe('registerPlayerIpc DesktopMediaBridge integration (#238, #301)', () => {
  it('syncs sanitized metadata, state, clock, volume, and dispatches all remote commands', async () => {
    const ipc = fakeIpcMain();
    const sender = fakeContents(1);
    const stub = stubEngine();
    const media = fakeMediaBridge();

    const dispose = registerPlayerIpc({
      ipcMain: ipc.ipcMain,
      now: () => 1000,
      log: () => undefined,
      createEngine: async () => stub.engine,
      mediaBridge: media.bridge,
    });

    const { engineId } = (await ipc.invoke(PLAYER_CHANNELS.open, sender.owner)) as {
      engineId: string;
    };

    // Sanitized setMediaMetadata reaches bridge without credentials
    ipc.emit(PLAYER_CHANNELS.command, sender.owner, {
      engineId,
      command: {
        name: 'setMediaMetadata',
        metadata: {
          title: 'Feature Film',
          subtitle: '2026',
          artworkUrl: 'https://alice:pw@cdn.example.test/poster.jpg?token=secret&w=400',
          kind: 'vod',
          canStepTrack: false,
        },
      },
    });
    expect(media.states.at(-1)?.metadata).toEqual({
      title: 'Feature Film',
      subtitle: '2026',
      artworkUrl: 'https://cdn.example.test/poster.jpg?w=400',
      kind: 'vod',
      canStepTrack: false,
    });

    // Load marks isNavigating=true; playing clears it
    ipc.emit(PLAYER_CHANNELS.command, sender.owner, {
      engineId,
      command: {
        name: 'load',
        cmd: { attempt: 3, url: 'http://sim.test/vod.mp4', headers: {}, kind: 'vod', startMs: 0 },
      },
    });
    expect(media.states.at(-1)).toMatchObject({
      status: 'Stopped',
      isNavigating: true,
      kind: 'vod',
    });

    stub.emit({ attempt: 3, type: 'state', state: 'playing' });
    stub.emit({
      attempt: 3,
      type: 'clock',
      anchor: { positionMs: 20_000, durationMs: 120_000, atMs: 1200, rate: 1 },
    });
    expect(media.states.at(-1)).toMatchObject({
      status: 'Playing',
      isNavigating: false,
      positionUs: 20_000_000,
      durationUs: 120_000_000,
      rate: 1,
    });

    // Transport commands from OS bridge drive engine
    media.sendCommand({ type: 'togglePlayPause' });
    expect(stub.spies.pause).toHaveBeenCalledWith(3);

    stub.emit({ attempt: 3, type: 'state', state: 'paused' });
    media.sendCommand({ type: 'togglePlayPause' });
    expect(stub.spies.play).toHaveBeenCalledWith(3);

    media.sendCommand({ type: 'play' });
    media.sendCommand({ type: 'pause' });
    media.sendCommand({ type: 'seekByUs', offsetUs: 10_000_000 });
    expect(stub.spies.seek).toHaveBeenLastCalledWith(3, 30_000);
    expect(media.seeked.at(-1)).toBe(30_000_000);

    media.sendCommand({ type: 'seekToUs', positionUs: 90_000_000 });
    expect(stub.spies.seek).toHaveBeenLastCalledWith(3, 90_000);
    expect(media.seeked.at(-1)).toBe(90_000_000);

    media.sendCommand({ type: 'setRate', rate: 1.5 });
    expect(stub.spies.setSpeed).toHaveBeenCalledWith(3, 1.5);

    media.sendCommand({ type: 'setVolume', volume: 0.65 });
    expect(stub.spies.setVolume).toHaveBeenCalledWith(65);
    expect(media.states.at(-1)?.volume).toBeCloseTo(0.65);

    // Track step ignored when canStepTrack is false
    media.sendCommand({ type: 'next' });
    media.sendCommand({ type: 'previous' });
    expect(sender.sent.filter((m) => m.channel === PLAYER_CHANNELS.remoteMediaAction)).toHaveLength(
      0,
    );

    // Track step forwarded when canStepTrack is true
    ipc.emit(PLAYER_CHANNELS.command, sender.owner, {
      engineId,
      command: {
        name: 'setMediaMetadata',
        metadata: {
          title: 'Channel 1',
          kind: 'live',
          canStepTrack: true,
        },
      },
    });
    media.sendCommand({ type: 'next' });
    media.sendCommand({ type: 'previous' });
    expect(
      sender.sent
        .filter((m) => m.channel === PLAYER_CHANNELS.remoteMediaAction)
        .map((m) => m.payload),
    ).toEqual([
      { engineId, action: 'next' },
      { engineId, action: 'previous' },
    ]);

    // Stop from OS bridge stops engine and resets state
    media.sendCommand({ type: 'stop' });
    expect(stub.spies.stop).toHaveBeenCalledWith(3);
    expect(media.states.at(-1)?.status).toBe('Stopped');

    // Close clears media bridge state
    await ipc.invoke(PLAYER_CHANNELS.close, sender.owner, engineId);
    expect(media.states.at(-1)).toMatchObject({ status: 'Stopped', metadata: null });

    dispose();
    expect(media.commandListeners.size).toBe(0);
  });

  it('gates mediaBridge.notifySeeked on the active media engine when multiple engines exist', async () => {
    const ipc = fakeIpcMain();
    const sender1 = fakeContents(1);
    const sender2 = fakeContents(2);
    const stub1 = stubEngine();
    const stub2 = stubEngine();
    const media = fakeMediaBridge();
    let idx = 0;

    const dispose = registerPlayerIpc({
      ipcMain: ipc.ipcMain,
      now: () => 1000,
      log: () => undefined,
      createEngine: async () => (idx++ === 0 ? stub1.engine : stub2.engine),
      mediaBridge: media.bridge,
    });

    const open1 = (await ipc.invoke(PLAYER_CHANNELS.open, sender1.owner)) as { engineId: string };
    const open2 = (await ipc.invoke(PLAYER_CHANNELS.open, sender2.owner)) as { engineId: string };
    // engine-2 is now activeMediaEngineId
    ipc.emit(PLAYER_CHANNELS.command, sender1.owner, {
      engineId: open1.engineId,
      command: { name: 'seek', attempt: 1, positionMs: 12_000 },
    });
    expect(media.seeked).toEqual([]);

    ipc.emit(PLAYER_CHANNELS.command, sender2.owner, {
      engineId: open2.engineId,
      command: { name: 'seek', attempt: 1, positionMs: 45_000 },
    });
    expect(media.seeked).toEqual([45_000_000]);

    dispose();
  });
});
