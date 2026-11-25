import type { DesktopAudioOutputConfig, DisplaySyncPolicy, EngineEvent } from '@elv/playback';
import { describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_CAPABILITIES,
  PLAYER_CHANNELS,
  type PlayerUiEvent,
} from '../../shared/player-ipc.ts';
import {
  createDesktopDisplayRefreshController,
  type DesktopDisplayMode,
  type DesktopDisplayRefreshAdapter,
} from './display-refresh.ts';
import type { MpvEngine } from './engine.ts';
import { type IpcMainLike, registerPlayerIpc, type WebContentsLike } from './ipc.ts';

function fakeIpcMain() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const ipcMain: IpcMainLike = {
    handle: (ch, fn) => void handlers.set(ch, fn as (...args: unknown[]) => unknown),
    on: (ch, fn) => {
      let set = listeners.get(ch);
      if (!set) {
        set = new Set();
        listeners.set(ch, set);
      }
      set.add(fn as (...args: unknown[]) => void);
    },
    removeHandler: (ch) => void handlers.delete(ch),
    removeListener: (ch, fn) => void listeners.get(ch)?.delete(fn as (...args: unknown[]) => void),
  };
  return {
    ipcMain,
    invoke: (ch: string, sender: WebContentsLike, ...args: unknown[]) =>
      Promise.resolve(handlers.get(ch)?.({ sender }, ...args)),
    send: (ch: string, sender: WebContentsLike, ...args: unknown[]) => {
      for (const l of [...(listeners.get(ch) ?? [])]) l({ sender }, ...args);
    },
  };
}

function fakeOwner(id = 1) {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  let destroyed = false;
  let onDestroyed: (() => void) | undefined;
  const owner: WebContentsLike = {
    id,
    isDestroyed: () => destroyed,
    send: (channel, payload) => void sent.push({ channel, payload }),
    once: (event, listener) => {
      if (event === 'destroyed') onDestroyed = listener;
    },
    on: () => undefined,
  };
  return {
    owner,
    sent,
    destroy: () => {
      destroyed = true;
      onDestroyed?.();
    },
  };
}

function fakeEngine() {
  const calls: unknown[][] = [];
  const listeners = new Set<(event: EngineEvent) => void>();
  const engine: MpvEngine = {
    capabilities: DESKTOP_CAPABILITIES,
    spawns: 1,
    maxHoldMs: 0,
    loadMode: 'replace',
    presenterKind: 'canvas',
    lastArea: undefined,
    start: () => void calls.push(['start']),
    setArea: (a) => void calls.push(['setArea', a]),
    toggleFullscreen: () => void calls.push(['toggleFullscreen']),
    toggleMute: () => void calls.push(['toggleMute']),
    setVolume: (v) => void calls.push(['setVolume', v]),
    setAudioDelay: (d) => void calls.push(['setAudioDelay', d]),
    setSubtitleDelay: (d) => void calls.push(['setSubtitleDelay', d]),
    setAudioDevice: (d) => void calls.push(['setAudioDevice', d]),
    setDeinterlace: (e) => void calls.push(['setDeinterlace', e]),
    setDeinterlaceMode: (m) => void calls.push(['setDeinterlaceMode', m]),
    setPitchLock: (l) => void calls.push(['setPitchLock', l]),
    setAudioNormalization: (e) => void calls.push(['setAudioNormalization', e]),
    setDisplaySync: (p) => void calls.push(['setDisplaySync', p]),
    setDesktopAudioOutput: (c) => void calls.push(['setDesktopAudioOutput', c]),
    queueNext: (r) => void calls.push(['queueNext', r]),
    clearQueue: () => void calls.push(['clearQueue']),
    onQueueAdvanced: () => () => undefined,
    setHwdec: (p) => void calls.push(['setHwdec', p]),
    setResizeMode: (m) => void calls.push(['setResizeMode', m]),
    setFilterSdh: (e) => void calls.push(['setFilterSdh', e]),
    setSubtitleFontFamily: (f) => void calls.push(['setSubtitleFontFamily', f]),
    load: (c) => void calls.push(['load', c]),
    retry: (a) => void calls.push(['retry', a]),
    play: (a) => void calls.push(['play', a]),
    pause: (a) => void calls.push(['pause', a]),
    seek: (a, p) => void calls.push(['seek', a, p]),
    setSpeed: (a, r) => void calls.push(['setSpeed', a, r]),
    selectAudioTrack: (a, id) => void calls.push(['selectAudioTrack', a, id]),
    selectSubtitleTrack: (a, id) => void calls.push(['selectSubtitleTrack', a, id]),
    stop: (a) => void calls.push(['stop', a]),
    recreate: (a) => void calls.push(['recreate', a]),
    release: () => void calls.push(['release']),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    engine,
    calls,
    emit: (event: EngineEvent) => {
      for (const l of [...listeners]) l(event);
    },
  };
}

const MODES: readonly DesktopDisplayMode[] = [
  { id: '1080p-23976', width: 1920, height: 1080, refreshRateHz: 23.976 },
  { id: '1080p-50', width: 1920, height: 1080, refreshRateHz: 50 },
  { id: '1080p-60', width: 1920, height: 1080, refreshRateHz: 60, isCurrent: true },
];

function createDisplayAdapter() {
  let currentId = '1080p-60';
  const applied: string[] = [];
  const restored: string[] = [];
  const adapter: DesktopDisplayRefreshAdapter = {
    listModes: () => MODES.map((m) => ({ ...m, isCurrent: m.id === currentId })),
    applyMode: (_displayId, mode) => {
      currentId = mode.id;
      applied.push(mode.id);
      return true;
    },
    restoreMode: (_displayId, mode) => {
      currentId = mode.id;
      restored.push(mode.id);
      return true;
    },
  };
  return { adapter, applied, restored, currentId: () => currentId };
}

describe('registerPlayerIpc Wave F7A commands, passthroughFallback, and fullscreen AFR (#213, #214)', () => {
  it('forwards setDisplaySync, setDesktopAudioOutput, and passthroughFallback UI events', async () => {
    const ipc = fakeIpcMain();
    const { owner, sent } = fakeOwner(11);
    const fe = fakeEngine();
    let emitUi!: (event: PlayerUiEvent) => void;

    const dispose = registerPlayerIpc({
      ipcMain: ipc.ipcMain,
      now: () => 100,
      log: vi.fn(),
      createEngine: async (_owner, onUi) => {
        emitUi = onUi;
        return fe.engine;
      },
    });

    const { engineId } = (await ipc.invoke(PLAYER_CHANNELS.open, owner)) as { engineId: string };

    const policy: DisplaySyncPolicy = { autoFrameRate: 'seamless', autoDynamicRange: true };
    const audioConfig: DesktopAudioOutputConfig = {
      passthrough: true,
      codecs: ['ac3', 'eac3', 'dts'],
      exclusive: true,
      ac3Encode: false,
      channelLayout: 'auto',
    };

    ipc.send(PLAYER_CHANNELS.command, owner, {
      engineId,
      command: { name: 'setDisplaySync', policy },
    });
    ipc.send(PLAYER_CHANNELS.command, owner, {
      engineId,
      command: { name: 'setDesktopAudioOutput', config: audioConfig },
    });

    expect(fe.calls).toContainEqual(['setDisplaySync', policy]);
    expect(fe.calls).toContainEqual(['setDesktopAudioOutput', audioConfig]);

    emitUi({ type: 'passthroughFallback' });
    expect(sent).toContainEqual({
      channel: PLAYER_CHANNELS.ui,
      payload: { engineId, ui: { type: 'passthroughFallback' } },
    });

    dispose();
  });

  it('switches display refresh rate only during fullscreen playback and guarantees restore on stop, exit fullscreen, ended, error, window close, and dispose', async () => {
    const ipc = fakeIpcMain();
    const { owner, destroy } = fakeOwner(22);
    const fe = fakeEngine();
    const display = createDisplayAdapter();
    const displayRefreshController = createDesktopDisplayRefreshController(display.adapter);
    let emitUi!: (event: PlayerUiEvent) => void;

    const dispose = registerPlayerIpc({
      ipcMain: ipc.ipcMain,
      now: () => 100,
      log: vi.fn(),
      displayRefreshController,
      getDisplayId: () => 'disp-main',
      createEngine: async (_owner, onUi) => {
        emitUi = onUi;
        return fe.engine;
      },
    });

    const { engineId } = (await ipc.invoke(PLAYER_CHANNELS.open, owner)) as { engineId: string };

    ipc.send(PLAYER_CHANNELS.command, owner, {
      engineId,
      command: {
        name: 'setDisplaySync',
        policy: { autoFrameRate: 'seamless', autoDynamicRange: true },
      },
    });

    // Windowed playback must NOT switch refresh rate
    fe.emit({ attempt: 1, type: 'state', state: 'playing' });
    fe.emit({ attempt: 1, type: 'mediaInfo', info: { width: 1920, height: 1080, fps: 23.976 } });
    expect(display.currentId()).toBe('1080p-60');

    // Entering fullscreen switches to 23.976 Hz
    emitUi({ type: 'fullscreen-changed', fullscreen: true });
    expect(display.currentId()).toBe('1080p-23976');

    // Exiting fullscreen restores 60 Hz
    emitUi({ type: 'fullscreen-changed', fullscreen: false });
    expect(display.currentId()).toBe('1080p-60');

    // Re-enter fullscreen -> switches to 23.976 Hz, then stop -> restores 60 Hz
    emitUi({ type: 'fullscreen-changed', fullscreen: true });
    expect(display.currentId()).toBe('1080p-23976');
    ipc.send(PLAYER_CHANNELS.command, owner, {
      engineId,
      command: { name: 'stop', attempt: 1 },
    });
    expect(display.currentId()).toBe('1080p-60');

    // Start new media in fullscreen at 25 fps -> switches to 50 Hz, then window destroyed -> restores 60 Hz
    ipc.send(PLAYER_CHANNELS.command, owner, {
      engineId,
      command: {
        name: 'load',
        cmd: {
          attempt: 2,
          kind: 'live',
          url: 'https://sim.example.test/live.ts',
          headers: {},
          options: { displaySync: { autoFrameRate: 'always', autoDynamicRange: true } },
        },
      },
    });
    fe.emit({ attempt: 2, type: 'state', state: 'playing' });
    fe.emit({ attempt: 2, type: 'mediaInfo', info: { width: 1920, height: 1080, fps: 25 } });
    expect(display.currentId()).toBe('1080p-50');

    destroy();
    expect(display.currentId()).toBe('1080p-60');

    dispose();
  });
});
