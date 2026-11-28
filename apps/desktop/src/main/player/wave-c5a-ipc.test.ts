import type { EngineEvent } from '@elv/playback';
import { describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_CAPABILITIES,
  PLAYER_CHANNELS,
  type PlayerUiEvent,
} from '../../shared/player-ipc.ts';
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
  const senderFrame: { url: string; top?: unknown } = { url: 'app://elv/index.html' };
  senderFrame.top = senderFrame;
  return {
    ipcMain,
    invoke: (ch: string, sender: WebContentsLike, ...args: unknown[]) =>
      Promise.resolve(handlers.get(ch)?.({ sender, senderFrame }, ...args)),
    send: (ch: string, sender: WebContentsLike, ...args: unknown[]) => {
      for (const l of [...(listeners.get(ch) ?? [])]) l({ sender, senderFrame }, ...args);
    },
  };
}

function fakeOwner(id = 1) {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const owner: WebContentsLike = {
    id,
    isDestroyed: () => false,
    send: (channel, payload) => void sent.push({ channel, payload }),
    once: () => undefined,
    on: () => undefined,
  };
  return { owner, sent };
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

describe('registerPlayerIpc Wave C5A commands and aspect-ratio tracking (#332, #243, #205)', () => {
  it('forwards setDeinterlaceMode, setPitchLock, setAudioNormalization, queueNext, clearQueue, and queueAdvanced', async () => {
    const ipc = fakeIpcMain();
    const { owner, sent } = fakeOwner(7);
    const fe = fakeEngine();
    const aspectUpdates: Array<number | undefined> = [];
    let emitUi!: (event: PlayerUiEvent) => void;

    const dispose = registerPlayerIpc({
      ipcMain: ipc.ipcMain,
      now: () => 100,
      log: vi.fn(),
      onVideoAspectRatioChange: (_owner, aspect) => aspectUpdates.push(aspect),
      createEngine: async (_owner, onUi) => {
        emitUi = onUi;
        return fe.engine;
      },
    });

    const { engineId } = (await ipc.invoke(PLAYER_CHANNELS.open, owner)) as { engineId: string };

    const queueReq = {
      itemKey: 'ep-2',
      stream: { url: 'https://sim.test/ep2.mkv', headers: {} },
    };
    ipc.send(PLAYER_CHANNELS.command, owner, {
      engineId,
      command: { name: 'setDeinterlaceMode', mode: 'bwdif' },
    });
    ipc.send(PLAYER_CHANNELS.command, owner, {
      engineId,
      command: { name: 'setPitchLock', locked: false },
    });
    ipc.send(PLAYER_CHANNELS.command, owner, {
      engineId,
      command: { name: 'setAudioNormalization', enabled: true },
    });
    ipc.send(PLAYER_CHANNELS.command, owner, {
      engineId,
      command: { name: 'queueNext', request: queueReq },
    });
    ipc.send(PLAYER_CHANNELS.command, owner, {
      engineId,
      command: { name: 'clearQueue' },
    });

    expect(fe.calls).toContainEqual(['setDeinterlaceMode', 'bwdif']);
    expect(fe.calls).toContainEqual(['setPitchLock', false]);
    expect(fe.calls).toContainEqual(['setAudioNormalization', true]);
    expect(fe.calls).toContainEqual(['queueNext', queueReq]);
    expect(fe.calls).toContainEqual(['clearQueue']);

    // queueAdvanced UI event reaches renderer
    emitUi({ type: 'queueAdvanced', itemKey: 'ep-2', attempt: 1 });
    expect(sent).toContainEqual({
      channel: PLAYER_CHANNELS.ui,
      payload: { engineId, ui: { type: 'queueAdvanced', itemKey: 'ep-2', attempt: 1 } },
    });

    // DAR tracking updates on mediaInfo and clears on ended/error/stop/release
    fe.emit({
      attempt: 1,
      type: 'mediaInfo',
      info: { width: 1920, height: 1080, aspectRatio: 16 / 9 },
    });
    fe.emit({ attempt: 1, type: 'state', state: 'ended' });
    fe.emit({
      attempt: 2,
      type: 'mediaInfo',
      info: { width: 1920, height: 800, aspectRatio: 2.4 },
    });
    fe.emit({ attempt: 2, type: 'error', error: { code: 'network' } });
    fe.emit({
      attempt: 3,
      type: 'mediaInfo',
      info: { width: 1440, height: 1080, aspectRatio: 4 / 3 },
    });
    ipc.send(PLAYER_CHANNELS.command, owner, {
      engineId,
      command: { name: 'stop', attempt: 3 },
    });

    expect(aspectUpdates).toEqual([16 / 9, undefined, 2.4, undefined, 4 / 3, undefined]);

    dispose();
  });
});
