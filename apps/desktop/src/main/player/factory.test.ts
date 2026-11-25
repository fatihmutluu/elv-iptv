import type { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerUiEvent, PresenterKind } from '../../shared/player-ipc.ts';
import type { MpvEngine, MpvEngineDeps } from './engine.ts';
import type { ReadaheadTierStore } from './mpv/readahead.ts';
import type { VideoPresenter } from './presenter/types.ts';

const mocks = vi.hoisted(() => ({
  presenterCalls: [] as Array<{
    kind: PresenterKind;
    owner: unknown;
    platform: NodeJS.Platform;
    opts: unknown;
  }>,
  retargetCalls: [] as unknown[],
  engineDeps: [] as MpvEngineDeps[],
  spawnCalls: [] as unknown[],
}));

vi.mock('./presenter/create.ts', () => ({
  createPresenter: (
    kind: PresenterKind,
    owner: unknown,
    platform: NodeJS.Platform,
    opts?: unknown,
  ): VideoPresenter => {
    mocks.presenterCalls.push({ kind, owner, platform, opts });
    return {
      kind,
      coversArea: kind === 'child-window',
      prepare: async () => [],
      attach: () => undefined,
      setArea: () => undefined,
      toggleFullscreen: () => undefined,
      ...(kind === 'canvas'
        ? {
            retargetWindow: (nextWindow: unknown) => {
              mocks.retargetCalls.push(nextWindow);
            },
          }
        : {}),
      onEvent: () => () => undefined,
      dispose: () => undefined,
    };
  },
}));

vi.mock('./engine.ts', () => ({
  createMpvEngine: (deps: MpvEngineDeps): MpvEngine => {
    mocks.engineDeps.push(deps);
    return {
      presenterKind: deps.presenter.kind,
      ...(deps.presenter.retargetWindow
        ? {
            retargetWindow: (
              nextWindow: Parameters<NonNullable<VideoPresenter['retargetWindow']>>[0],
            ) => {
              deps.presenter.retargetWindow?.(nextWindow);
              return true;
            },
          }
        : {}),
      release: vi.fn(),
    } as unknown as MpvEngine;
  },
}));

vi.mock('./mpv/process.ts', () => ({
  spawnMpv: (opts: unknown) => {
    mocks.spawnCalls.push(opts);
    return Promise.resolve({} as never);
  },
}));

const { createEngineFor } = await import('./factory.ts');

const fakeOwner = { id: 'owner-window' } as unknown as BrowserWindow;
const runtime = { executable: 'C:\\mpv\\elv-mpv.exe', inputConf: 'C:\\mpv\\mpv-input.conf' };
const stubReadaheadStore: ReadaheadTierStore = {
  get: () => undefined,
  set: () => undefined,
  size: 0,
};

beforeEach(() => {
  mocks.presenterCalls = [];
  mocks.retargetCalls = [];
  mocks.engineDeps = [];
  mocks.spawnCalls = [];
});

describe('createEngineFor', () => {
  it('defaults win32 to canvas, forwards engineId, auto-enables renderContext, and emits presenter UI', async () => {
    const uiEvents: PlayerUiEvent[] = [];
    const engine = await createEngineFor(fakeOwner, {
      runtime,
      platform: 'win32',
      loadMode: 'replace',
      pidFile: 'C:\\tmp\\mpv-pids.json',
      engineId: 'engine-7',
      readaheadStore: stubReadaheadStore,
      onUi: (ev) => uiEvents.push(ev),
    });

    expect(engine.presenterKind).toBe('canvas');
    expect(mocks.presenterCalls).toEqual([
      { kind: 'canvas', owner: fakeOwner, platform: 'win32', opts: { engineId: 'engine-7' } },
    ]);
    const baseArgs = mocks.engineDeps[0]?.baseArgs ?? [];
    expect(baseArgs).toContain('--force-window=no');
    expect(baseArgs).toContain('--vo=libmpv');
    expect(baseArgs).toContain('--video-timing-offset=0');
    expect(baseArgs).not.toContain('--force-window=immediate');
    expect(uiEvents).toEqual([{ type: 'presenter', kind: 'canvas', coversArea: false }]);
  });

  it('respects presenterOverride and disables renderContext for non-canvas presenters', async () => {
    const uiEvents: PlayerUiEvent[] = [];
    const engine = await createEngineFor(fakeOwner, {
      runtime,
      platform: 'win32',
      loadMode: 'replace',
      pidFile: 'C:\\tmp\\mpv-pids.json',
      engineId: 'engine-8',
      presenterOverride: 'child-window',
      readaheadStore: stubReadaheadStore,
      onUi: (ev) => uiEvents.push(ev),
    });

    expect(engine.presenterKind).toBe('child-window');
    expect(mocks.presenterCalls[0]?.kind).toBe('child-window');
    const baseArgs = mocks.engineDeps[0]?.baseArgs ?? [];
    expect(baseArgs).toContain('--force-window=immediate');
    expect(baseArgs).not.toContain('--force-window=no');
    expect(baseArgs).not.toContain('--vo=libmpv');
    expect(baseArgs).not.toContain('--video-timing-offset=0');
    expect(uiEvents).toEqual([{ type: 'presenter', kind: 'child-window', coversArea: true }]);
  });

  it('allows explicit renderContext and hwdec overrides', async () => {
    await createEngineFor(fakeOwner, {
      runtime,
      platform: 'win32',
      loadMode: 'replace',
      pidFile: 'C:\\tmp\\mpv-pids.json',
      renderContext: false,
      hwdec: 'no',
      readaheadStore: stubReadaheadStore,
      onUi: () => undefined,
    });

    const baseArgs = mocks.engineDeps[0]?.baseArgs ?? [];
    expect(baseArgs).toContain('--force-window=immediate');
    expect(baseArgs).toContain('--hwdec=no');
    expect(baseArgs).not.toContain('--vo=libmpv');
    expect(baseArgs).not.toContain('--video-timing-offset=0');
  });

  it('forwards runtime.fontsDir as --sub-fonts-dir in baseArgs (#163)', async () => {
    await createEngineFor(fakeOwner, {
      runtime: { ...runtime, fontsDir: 'C:\\res\\fonts' },
      platform: 'win32',
      loadMode: 'replace',
      pidFile: 'C:\\tmp\\mpv-pids.json',
      readaheadStore: stubReadaheadStore,
      onUi: () => undefined,
    });

    const baseArgs = mocks.engineDeps[0]?.baseArgs ?? [];
    expect(baseArgs).toContain('--sub-fonts-dir=C:\\res\\fonts');
  });

  it('defaults darwin with canvasExecutable and ioSurfaceAddon to canvas, forwards ioSurfaceAddon, enables renderContext, and spawns canvasExecutable', async () => {
    const uiEvents: PlayerUiEvent[] = [];
    const macRuntime = {
      executable: '/res/mpv/ELV IPTV Player.app/Contents/MacOS/mpv',
      canvasExecutable: '/res/mpv/ELV IPTV Player.app/Contents/MacOS/elv-mpv',
      ioSurfaceAddon: '/res/mpv/elv-iosurface.node',
      inputConf: '/res/mpv-input.conf',
    };
    const engine = await createEngineFor(fakeOwner, {
      runtime: macRuntime,
      platform: 'darwin',
      loadMode: 'replace',
      pidFile: '/tmp/mpv-pids.json',
      engineId: 'engine-mac-1',
      readaheadStore: stubReadaheadStore,
      onUi: (ev) => uiEvents.push(ev),
    });

    expect(engine.presenterKind).toBe('canvas');
    expect(mocks.presenterCalls).toEqual([
      {
        kind: 'canvas',
        owner: fakeOwner,
        platform: 'darwin',
        opts: { engineId: 'engine-mac-1', ioSurfaceAddon: macRuntime.ioSurfaceAddon },
      },
    ]);
    const baseArgs = mocks.engineDeps[0]?.baseArgs ?? [];
    expect(baseArgs).toContain('--force-window=no');
    expect(baseArgs).toContain('--vo=libmpv');
    expect(baseArgs).toContain('--video-timing-offset=0');
    expect(uiEvents).toEqual([{ type: 'presenter', kind: 'canvas', coversArea: false }]);

    await mocks.engineDeps[0]?.spawn(['--arg'], new AbortController().signal);
    expect(mocks.spawnCalls[0]).toMatchObject({ executable: macRuntime.canvasExecutable });
  });

  it('respects own-window presenterOverride on darwin, disables renderContext, and spawns standalone mpv', async () => {
    const uiEvents: PlayerUiEvent[] = [];
    const macRuntime = {
      executable: '/res/mpv/ELV IPTV Player.app/Contents/MacOS/mpv',
      canvasExecutable: '/res/mpv/ELV IPTV Player.app/Contents/MacOS/elv-mpv',
      ioSurfaceAddon: '/res/mpv/elv-iosurface.node',
      inputConf: '/res/mpv-input.conf',
    };
    const engine = await createEngineFor(fakeOwner, {
      runtime: macRuntime,
      platform: 'darwin',
      loadMode: 'replace',
      pidFile: '/tmp/mpv-pids.json',
      engineId: 'engine-mac-2',
      presenterOverride: 'own-window',
      readaheadStore: stubReadaheadStore,
      onUi: (ev) => uiEvents.push(ev),
    });

    expect(engine.presenterKind).toBe('own-window');
    expect(mocks.presenterCalls).toEqual([
      {
        kind: 'own-window',
        owner: fakeOwner,
        platform: 'darwin',
        opts: { engineId: 'engine-mac-2' },
      },
    ]);
    const baseArgs = mocks.engineDeps[0]?.baseArgs ?? [];
    expect(baseArgs).toContain('--force-window=immediate');
    expect(baseArgs).not.toContain('--vo=libmpv');
    expect(uiEvents).toEqual([{ type: 'presenter', kind: 'own-window', coversArea: false }]);

    await mocks.engineDeps[0]?.spawn(['--arg'], new AbortController().signal);
    expect(mocks.spawnCalls[0]).toMatchObject({ executable: macRuntime.executable });
  });

  it('falls back to own-window without renderContext on darwin when canvas artifacts are absent', async () => {
    const uiEvents: PlayerUiEvent[] = [];
    const macFallbackRuntime = {
      executable: '/res/mpv/ELV IPTV Player.app/Contents/MacOS/mpv',
      inputConf: '/res/mpv-input.conf',
    };
    await createEngineFor(fakeOwner, {
      runtime: macFallbackRuntime,
      platform: 'darwin',
      loadMode: 'replace',
      pidFile: '/tmp/mpv-pids.json',
      readaheadStore: stubReadaheadStore,
      onUi: (ev) => uiEvents.push(ev),
    });

    expect(mocks.presenterCalls[0]?.kind).toBe('own-window');
    const baseArgs = mocks.engineDeps[0]?.baseArgs ?? [];
    expect(baseArgs).toContain('--force-window=immediate');
    expect(baseArgs).not.toContain('--vo=libmpv');
    expect(uiEvents).toEqual([{ type: 'presenter', kind: 'own-window', coversArea: false }]);

    await mocks.engineDeps[0]?.spawn(['--arg'], new AbortController().signal);
    expect(mocks.spawnCalls[0]).toMatchObject({ executable: macFallbackRuntime.executable });
  });

  it('falls back to own-window on darwin under Mac App Store sandbox (isMas: true) even when canvas artifacts exist', async () => {
    const uiEvents: PlayerUiEvent[] = [];
    const macRuntime = {
      executable: '/res/mpv/ELV IPTV Player.app/Contents/MacOS/mpv',
      canvasExecutable: '/res/mpv/ELV IPTV Player.app/Contents/MacOS/elv-mpv',
      ioSurfaceAddon: '/res/mpv/elv-iosurface.node',
      inputConf: '/res/mpv-input.conf',
    };
    const engine = await createEngineFor(fakeOwner, {
      runtime: macRuntime,
      platform: 'darwin',
      isMas: true,
      loadMode: 'replace',
      pidFile: '/tmp/mpv-pids.json',
      engineId: 'engine-mas-1',
      readaheadStore: stubReadaheadStore,
      onUi: (ev) => uiEvents.push(ev),
    });

    expect(engine.presenterKind).toBe('own-window');
    expect(mocks.presenterCalls).toEqual([
      {
        kind: 'own-window',
        owner: fakeOwner,
        platform: 'darwin',
        opts: { engineId: 'engine-mas-1' },
      },
    ]);
    const baseArgs = mocks.engineDeps[0]?.baseArgs ?? [];
    expect(baseArgs).toContain('--force-window=immediate');
    expect(baseArgs).not.toContain('--vo=libmpv');
    expect(uiEvents).toEqual([{ type: 'presenter', kind: 'own-window', coversArea: false }]);

    await mocks.engineDeps[0]?.spawn(['--arg'], new AbortController().signal);
    expect(mocks.spawnCalls[0]).toMatchObject({ executable: macRuntime.executable });
  });

  it('keeps canvas presenter on darwin when isMas is explicitly false and canvas artifacts exist', async () => {
    const macRuntime = {
      executable: '/res/mpv/ELV IPTV Player.app/Contents/MacOS/mpv',
      canvasExecutable: '/res/mpv/ELV IPTV Player.app/Contents/MacOS/elv-mpv',
      ioSurfaceAddon: '/res/mpv/elv-iosurface.node',
      inputConf: '/res/mpv-input.conf',
    };
    const engine = await createEngineFor(fakeOwner, {
      runtime: macRuntime,
      platform: 'darwin',
      isMas: false,
      loadMode: 'replace',
      pidFile: '/tmp/mpv-pids.json',
      engineId: 'engine-mac-non-mas',
      readaheadStore: stubReadaheadStore,
      onUi: () => undefined,
    });

    expect(engine.presenterKind).toBe('canvas');
    expect(mocks.presenterCalls[0]?.kind).toBe('canvas');
  });

  it('forwards owner enter-full-screen and leave-full-screen events as fullscreen-changed UI and detaches on release (#394)', async () => {
    const listeners = new Map<string, Set<() => void>>();
    let fullScreen = true;
    const windowOwner = {
      isFullScreen: () => fullScreen,
      isDestroyed: () => false,
      on: vi.fn((event: string, listener: () => void) => {
        let set = listeners.get(event);
        if (!set) {
          set = new Set();
          listeners.set(event, set);
        }
        set.add(listener);
      }),
      removeListener: vi.fn((event: string, listener: () => void) => {
        listeners.get(event)?.delete(listener);
      }),
    } as unknown as BrowserWindow;

    const uiEvents: PlayerUiEvent[] = [];
    const engine = await createEngineFor(windowOwner, {
      runtime,
      platform: 'win32',
      loadMode: 'replace',
      pidFile: 'C:\\tmp\\mpv-pids.json',
      engineId: 'engine-fs',
      readaheadStore: stubReadaheadStore,
      onUi: (ev) => uiEvents.push(ev),
    });

    expect(uiEvents).toEqual([
      { type: 'presenter', kind: 'canvas', coversArea: false },
      { type: 'fullscreen-changed', fullscreen: true },
    ]);

    fullScreen = false;
    for (const l of listeners.get('leave-full-screen') ?? []) l();
    fullScreen = true;
    for (const l of listeners.get('enter-full-screen') ?? []) l();
    expect(uiEvents.slice(2)).toEqual([
      { type: 'fullscreen-changed', fullscreen: false },
      { type: 'fullscreen-changed', fullscreen: true },
    ]);

    engine.release();
    expect(listeners.get('enter-full-screen')?.size).toBe(0);
    expect(listeners.get('leave-full-screen')?.size).toBe(0);
  });

  it('forwards sandbox-safe vodCacheRoot and getMultiViewTileCount to createMpvEngine (#350)', async () => {
    const getMultiViewTileCount = () => 3;
    await createEngineFor(fakeOwner, {
      runtime,
      platform: 'win32',
      loadMode: 'replace',
      pidFile: 'C:\\tmp\\mpv-pids.json',
      vodCacheRoot: 'C:\\Users\\demo\\AppData\\Local\\Cache\\elv-vod-cache',
      getMultiViewTileCount,
      readaheadStore: stubReadaheadStore,
      onUi: () => undefined,
    });
    expect(mocks.engineDeps[0]?.vodCacheRoot).toBe(
      'C:\\Users\\demo\\AppData\\Local\\Cache\\elv-vod-cache',
    );
    expect(mocks.engineDeps[0]?.getMultiViewTileCount).toBe(getMultiViewTileCount);
  });

  it('rebinds fullscreen listeners and delegates to presenter.retargetWindow on retargetWindow (Wave P3)', async () => {
    const makeOwner = (initialFs: boolean) => {
      const listeners = new Map<string, Set<() => void>>();
      let fs = initialFs;
      const win = {
        isFullScreen: () => fs,
        isDestroyed: () => false,
        on: vi.fn((event: string, listener: () => void) => {
          const set = listeners.get(event) ?? new Set();
          set.add(listener);
          listeners.set(event, set);
        }),
        removeListener: vi.fn((event: string, listener: () => void) => {
          listeners.get(event)?.delete(listener);
        }),
      } as unknown as BrowserWindow;
      return {
        win,
        listeners,
        emit(event: string) {
          if (event === 'enter-full-screen') fs = true;
          if (event === 'leave-full-screen') fs = false;
          for (const l of [...(listeners.get(event) ?? [])]) l();
        },
      };
    };

    const ownerA = makeOwner(true);
    const ownerB = makeOwner(false);
    const uiEvents: PlayerUiEvent[] = [];

    const engine = await createEngineFor(ownerA.win, {
      runtime,
      platform: 'win32',
      loadMode: 'replace',
      pidFile: 'C:\\tmp\\mpv-pids.json',
      engineId: 'engine-retarget',
      readaheadStore: stubReadaheadStore,
      onUi: (ev) => uiEvents.push(ev),
    });

    expect(typeof engine.retargetWindow).toBe('function');
    expect(engine.retargetWindow?.(ownerB.win)).toBe(true);
    expect(mocks.retargetCalls).toEqual([ownerB.win]);

    // Listeners detached from ownerA and attached to ownerB
    expect(ownerA.listeners.get('enter-full-screen')?.size).toBe(0);
    expect(ownerA.listeners.get('leave-full-screen')?.size).toBe(0);
    expect(ownerB.listeners.get('enter-full-screen')?.size).toBe(1);
    expect(ownerB.listeners.get('leave-full-screen')?.size).toBe(1);

    // Emits new ownerB fullscreen state and responds to ownerB fullscreen events
    expect(uiEvents.at(-1)).toEqual({ type: 'fullscreen-changed', fullscreen: false });
    ownerB.emit('enter-full-screen');
    expect(uiEvents.at(-1)).toEqual({ type: 'fullscreen-changed', fullscreen: true });

    // Release cleans up ownerB listeners
    engine.release();
    expect(ownerB.listeners.get('enter-full-screen')?.size).toBe(0);
    expect(ownerB.listeners.get('leave-full-screen')?.size).toBe(0);
  });
});
