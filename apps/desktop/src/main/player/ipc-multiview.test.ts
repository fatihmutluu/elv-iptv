import type { EngineEvent, LoadCommand } from '@elv/playback';
import { describe, expect, it } from 'vitest';
import {
  isPlayerCommandMessage,
  isPlayerOpenOptions,
  MAX_ENGINES_PER_WINDOW,
  PLAYER_CHANNELS,
  type PlayerUiEvent,
} from '../../shared/player-ipc.ts';
import type { DesktopMediaBridge, DesktopMediaStateSnapshot } from '../media-bridge.ts';
import type { TaskbarAction, TaskbarController } from '../taskbar-controls.ts';
import type { MpvEngine } from './engine.ts';
import {
  type IpcMainLike,
  type PlayerIpcDeps,
  registerPlayerIpc,
  type WebContentsLike,
} from './ipc.ts';

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
      Promise.resolve().then(() => handlers.get(channel)?.({ sender }, ...args)),
    emit: (channel: string, sender: WebContentsLike, ...args: unknown[]) =>
      void listeners.get(channel)?.({ sender }, ...args),
  };
}

function fakeContents(id: number) {
  let destroyed = false;
  const onDestroyed: Array<() => void> = [];
  const onNavigate: Array<(d: { isMainFrame: boolean; isSameDocument: boolean }) => void> = [];
  const onCrash: Array<() => void> = [];
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const contents: WebContentsLike & {
    sent: typeof sent;
    destroy(): void;
    navigate(d: { isMainFrame: boolean; isSameDocument: boolean }): void;
    crash(): void;
  } = {
    id,
    sent,
    isDestroyed: () => destroyed,
    send(channel, payload) {
      sent.push({ channel, payload });
    },
    once: (_event, listener) => void onDestroyed.push(listener),
    on(event: string, listener: unknown) {
      if (event === 'did-start-navigation') {
        onNavigate.push(listener as (d: { isMainFrame: boolean; isSameDocument: boolean }) => void);
      } else {
        onCrash.push(listener as () => void);
      }
    },
    navigate(d) {
      for (const l of onNavigate) l(d);
    },
    crash() {
      for (const l of onCrash) l();
    },
    destroy() {
      destroyed = true;
      for (const l of onDestroyed) l();
    },
  };
  return contents;
}

interface StubEngine extends MpvEngine {
  calls: unknown[][];
  released: number;
  emit(event: EngineEvent): void;
}

function stubEngine(): StubEngine {
  const listeners = new Set<(e: EngineEvent) => void>();
  const e = {
    calls: [] as unknown[][],
    released: 0,
    start: () => undefined,
    capabilities: {},
    spawns: 0,
    maxHoldMs: 0,
    lastArea: undefined,
    loadMode: 'replace',
    presenterKind: 'canvas',
    load: (cmd: LoadCommand) => e.calls.push(['load', cmd]),
    retry: (a: number) => e.calls.push(['retry', a]),
    play: (a: number) => e.calls.push(['play', a]),
    pause: (a: number) => e.calls.push(['pause', a]),
    seek: (a: number, ms: number) => e.calls.push(['seek', a, ms]),
    jumpToLiveEdge: (a: number) => e.calls.push(['jumpToLiveEdge', a]),
    setSpeed: (a: number, rate: number) => e.calls.push(['setSpeed', a, rate]),
    selectAudioTrack: (a: number, id: string) => e.calls.push(['selectAudioTrack', a, id]),
    selectSubtitleTrack: (a: number, id: string | null) =>
      e.calls.push(['selectSubtitleTrack', a, id]),
    selectSecondarySubtitleTrack: (a: number, id: string | null) =>
      e.calls.push(['selectSecondarySubtitleTrack', a, id]),
    addExternalSubtitle: () => undefined,
    setSubtitleStyle: () => undefined,
    selectVideoQuality: () => undefined,
    setVolume: (v: number) => e.calls.push(['setVolume', v]),
    setAudioDelay: () => undefined,
    setSubtitleDelay: () => undefined,
    setAudioDevice: () => undefined,
    setDeinterlace: () => undefined,
    setDeinterlaceMode: () => undefined,
    setPitchLock: () => undefined,
    setAudioNormalization: () => undefined,
    queueNext: () => undefined,
    clearQueue: () => undefined,
    onQueueAdvanced: () => () => undefined,
    setHwdec: () => undefined,
    setResizeMode: () => undefined,
    setFilterSdh: () => undefined,
    setSubtitleFontFamily: () => undefined,
    stop: (a: number) => e.calls.push(['stop', a]),
    recreate: (a: number) => e.calls.push(['recreate', a]),
    setArea: () => undefined,
    toggleFullscreen: () => undefined,
    toggleMute: () => e.calls.push(['mute']),
    setMuted: (muted: boolean) => e.calls.push(['setMuted', muted]),
    release: () => {
      e.released += 1;
    },
    subscribe(listener: (ev: EngineEvent) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(event: EngineEvent) {
      for (const l of [...listeners]) l(event);
    },
  };
  return e as unknown as StubEngine;
}

describe('Multi-Engine player IPC (#34)', () => {
  it('validates PlayerOpenOptions and setMuted command strictly', () => {
    expect(MAX_ENGINES_PER_WINDOW).toBe(4);
    expect(PLAYER_CHANNELS.setPrimary).toBe('player:set-primary');

    expect(isPlayerOpenOptions({})).toBe(true);
    expect(isPlayerOpenOptions({ replaceExisting: false })).toBe(true);
    expect(isPlayerOpenOptions({ primary: false })).toBe(true);
    expect(isPlayerOpenOptions({ replaceExisting: false, primary: true })).toBe(true);

    expect(isPlayerOpenOptions(null)).toBe(false);
    expect(isPlayerOpenOptions([])).toBe(false);
    expect(isPlayerOpenOptions({ replaceExisting: 'no' })).toBe(false);
    expect(isPlayerOpenOptions({ primary: 1 })).toBe(false);
    expect(isPlayerOpenOptions({ replaceExisting: false, extra: true })).toBe(false);

    expect(
      isPlayerCommandMessage({ engineId: 'engine-1', command: { name: 'setMuted', muted: true } }),
    ).toBe(true);
    expect(
      isPlayerCommandMessage({ engineId: 'engine-1', command: { name: 'setMuted', muted: false } }),
    ).toBe(true);
    expect(
      isPlayerCommandMessage({ engineId: 'engine-1', command: { name: 'setMuted', muted: 'yes' } }),
    ).toBe(false);
    expect(
      isPlayerCommandMessage({
        engineId: 'engine-1',
        command: { name: 'setMuted', muted: true, extra: 1 },
      }),
    ).toBe(false);
  });

  it('allows up to 4 concurrent engines per WebContents when replaceExisting is false and rejects a 5th', async () => {
    const ipc = fakeIpcMain();
    const sender = fakeContents(1);
    const created: StubEngine[] = [];
    const tileCountGetters: Array<(() => number) | undefined> = [];
    const logs: string[] = [];

    const dispose = registerPlayerIpc({
      ipcMain: ipc.ipcMain,
      now: () => 100,
      log: (line) => logs.push(line),
      createEngine: async (_owner, _onUi, _engineId, getMultiViewTileCount) => {
        const eng = stubEngine();
        created.push(eng);
        tileCountGetters.push(getMultiViewTileCount);
        return eng;
      },
    });

    const r1 = (await ipc.invoke(PLAYER_CHANNELS.open, sender)) as { engineId: string };
    expect(tileCountGetters[0]?.()).toBe(1);
    const r2 = (await ipc.invoke(PLAYER_CHANNELS.open, sender, {
      replaceExisting: false,
      primary: false,
    })) as { engineId: string };
    expect(tileCountGetters[0]?.()).toBe(2);
    expect(tileCountGetters[1]?.()).toBe(2);
    const r3 = (await ipc.invoke(PLAYER_CHANNELS.open, sender, {
      replaceExisting: false,
      primary: false,
    })) as { engineId: string };
    const r4 = (await ipc.invoke(PLAYER_CHANNELS.open, sender, {
      replaceExisting: false,
      primary: false,
    })) as { engineId: string };

    expect(new Set([r1.engineId, r2.engineId, r3.engineId, r4.engineId]).size).toBe(4);
    expect(created.every((e) => e.released === 0)).toBe(true);

    await expect(
      ipc.invoke(PLAYER_CHANNELS.open, sender, { replaceExisting: false, primary: false }),
    ).rejects.toThrow(/4/);
    expect(created).toHaveLength(4);

    // Invalid options are rejected and logged
    await expect(
      ipc.invoke(PLAYER_CHANNELS.open, sender, { replaceExisting: 'no' }),
    ).rejects.toThrow(/invalid/i);
    expect(logs.some((l) => l.includes(PLAYER_CHANNELS.open))).toBe(true);

    // Closing one slot allows opening a replacement
    await ipc.invoke(PLAYER_CHANNELS.close, sender, r4.engineId);
    expect(created[3]?.released).toBe(1);
    expect(tileCountGetters[0]?.()).toBe(3);
    const r5 = (await ipc.invoke(PLAYER_CHANNELS.open, sender, {
      replaceExisting: false,
      primary: false,
    })) as { engineId: string };
    expect(r5.engineId).toBeTruthy();

    dispose();
  });

  it('does not cancel sibling replaceExisting:false opens, but invalidates all on replaceExisting:true or navigation', async () => {
    const ipc = fakeIpcMain();
    const sender = fakeContents(1);
    const resolvers: Array<(eng: StubEngine) => void> = [];
    const engines: StubEngine[] = [];

    const dispose = registerPlayerIpc({
      ipcMain: ipc.ipcMain,
      now: () => 100,
      log: () => undefined,
      createEngine: () =>
        new Promise<MpvEngine>((resolve) => {
          resolvers.push((eng) => {
            engines.push(eng);
            resolve(eng);
          });
        }),
    });

    // Launch two concurrent replaceExisting:false opens
    const p1 = ipc.invoke(PLAYER_CHANNELS.open, sender, { replaceExisting: false, primary: true });
    const p2 = ipc.invoke(PLAYER_CHANNELS.open, sender, { replaceExisting: false, primary: false });
    await Promise.resolve();
    expect(resolvers).toHaveLength(2);

    const e1 = stubEngine();
    const e2 = stubEngine();
    resolvers[0]?.(e1);
    resolvers[1]?.(e2);
    const [r1, r2] = (await Promise.all([p1, p2])) as Array<{ engineId: string }>;
    expect(r1?.engineId).toBeTruthy();
    expect(r2?.engineId).toBeTruthy();
    expect(r1?.engineId).not.toBe(r2?.engineId);
    expect(e1.released).toBe(0);
    expect(e2.released).toBe(0);

    // Now start a 3rd in-flight open, then trigger replaceExisting:true -> cancels 3rd and releases 1 & 2
    const p3 = ipc.invoke(PLAYER_CHANNELS.open, sender, { replaceExisting: false, primary: false });
    await Promise.resolve();
    const p4 = ipc.invoke(PLAYER_CHANNELS.open, sender, { replaceExisting: true, primary: true });
    await Promise.resolve();

    const e3 = stubEngine();
    const e4 = stubEngine();
    resolvers[2]?.(e3);
    resolvers[3]?.(e4);

    await expect(p3).rejects.toThrow(/superseded/);
    const r4 = (await p4) as { engineId: string };
    expect(r4.engineId).toBeTruthy();
    expect(e1.released).toBe(1);
    expect(e2.released).toBe(1);
    expect(e3.released).toBe(1);
    expect(e4.released).toBe(0);

    // Navigation invalidates active engine
    sender.navigate({ isMainFrame: true, isSameDocument: false });
    expect(e4.released).toBe(1);

    dispose();
  });

  it('binds taskbar, aspect ratio, and mediaBridge only for primary engine and transfers cleanly on player:set-primary', async () => {
    const ipc = fakeIpcMain();
    const sender = fakeContents(1);
    const engines = new Map<string, StubEngine>();
    const aspectHistory: Array<number | undefined> = [];
    const mediaUpdates: DesktopMediaStateSnapshot[] = [];
    const taskbarInstances: Array<{
      updates: unknown[];
      clears: number;
      triggerAction: (a: TaskbarAction) => void;
    }> = [];
    const logs: string[] = [];

    const mediaBridge: DesktopMediaBridge = {
      updateState: (state) => mediaUpdates.push(state),
      onCommand: () => () => undefined,
      dispose: () => undefined,
    };

    const deps: PlayerIpcDeps = {
      ipcMain: ipc.ipcMain,
      now: () => 100,
      log: (line) => logs.push(line),
      mediaBridge,
      onVideoAspectRatioChange: (_owner, ar) => aspectHistory.push(ar),
      createTaskbarController: (_owner, onAction) => {
        const record = {
          updates: [] as unknown[],
          clears: 0,
          triggerAction: onAction,
        };
        taskbarInstances.push(record);
        const controller: TaskbarController = {
          updatePlayback: (snap) => record.updates.push(snap),
          clear: () => {
            record.clears += 1;
          },
        };
        return controller;
      },
      createEngine: async (_owner, _onUi: (e: PlayerUiEvent) => void, engineId: string) => {
        const eng = stubEngine();
        engines.set(engineId, eng);
        return eng;
      },
    };

    const dispose = registerPlayerIpc(deps);

    const primaryReply = (await ipc.invoke(PLAYER_CHANNELS.open, sender, {
      replaceExisting: true,
      primary: true,
    })) as { engineId: string };
    const secondaryReply = (await ipc.invoke(PLAYER_CHANNELS.open, sender, {
      replaceExisting: false,
      primary: false,
    })) as { engineId: string };

    // Only primary created a taskbar controller
    expect(taskbarInstances).toHaveLength(1);

    const primaryEng = engines.get(primaryReply.engineId);
    const secondaryEng = engines.get(secondaryReply.engineId);
    if (!primaryEng || !secondaryEng) throw new Error('expected primary and secondary engines');

    // Secondary emits playing + aspect ratio + metadata -> must NOT hijack primary
    ipc.emit(PLAYER_CHANNELS.command, sender, {
      engineId: secondaryReply.engineId,
      command: {
        name: 'setMediaMetadata',
        metadata: { title: 'Secondary Ch', kind: 'live', canStepTrack: true },
      },
    });
    secondaryEng.emit({ attempt: 1, type: 'state', state: 'playing' });
    secondaryEng.emit({
      attempt: 1,
      type: 'mediaInfo',
      info: { width: 1280, height: 720, aspectRatio: 16 / 9 },
    });
    expect(aspectHistory).toEqual([]);
    expect(mediaUpdates).toEqual([]);
    expect(taskbarInstances[0]?.updates).toEqual([]);

    // Forward setMuted to secondary engine
    ipc.emit(PLAYER_CHANNELS.command, sender, {
      engineId: secondaryReply.engineId,
      command: { name: 'setMuted', muted: true },
    });
    expect(secondaryEng.calls).toContainEqual(['setMuted', true]);

    // Primary emits playing + 4:3 aspect ratio -> updates taskbar, aspect ratio, mediaBridge
    primaryEng.emit({ attempt: 1, type: 'state', state: 'playing' });
    primaryEng.emit({
      attempt: 1,
      type: 'mediaInfo',
      info: { width: 640, height: 480, aspectRatio: 4 / 3 },
    });
    expect(aspectHistory).toEqual([4 / 3]);
    expect(taskbarInstances[0]?.updates).toHaveLength(1);
    expect(mediaUpdates.at(-1)?.status).toBe('Playing');

    // Promote secondary to primary via player:set-primary
    await ipc.invoke(PLAYER_CHANNELS.setPrimary, sender, secondaryReply.engineId);
    expect(taskbarInstances[0]?.clears).toBe(1);
    expect(taskbarInstances).toHaveLength(2);
    expect(taskbarInstances[1]?.updates).toHaveLength(1);
    expect(aspectHistory.at(-1)).toBeCloseTo(16 / 9);
    expect(mediaUpdates.at(-1)?.metadata?.title).toBe('Secondary Ch');
    expect(mediaUpdates.at(-1)?.status).toBe('Playing');

    // Releasing the old (now secondary) engine must NOT clear the new primary's aspect ratio or taskbar
    const aspectCountBefore = aspectHistory.length;
    await ipc.invoke(PLAYER_CHANNELS.close, sender, primaryReply.engineId);
    expect(aspectHistory).toHaveLength(aspectCountBefore);
    expect(taskbarInstances[1]?.clears).toBe(0);

    // Invalid set-primary calls are dropped cleanly
    await ipc.invoke(PLAYER_CHANNELS.setPrimary, sender, 'unknown-engine');
    await ipc.invoke(PLAYER_CHANNELS.setPrimary, sender, 42);
    expect(logs.filter((l) => l.includes(PLAYER_CHANNELS.setPrimary))).toHaveLength(2);

    dispose();
  });
});
