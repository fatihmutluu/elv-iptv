import type { EngineEvent, LoadCommand } from '@elv/playback';
import { describe, expect, it, vi } from 'vitest';
import { PLAYER_CHANNELS, type PresenterKind } from '../../shared/player-ipc.ts';
import type { TrustedSenderEventLike } from '../trusted-sender.ts';
import type { MpvEngine } from './engine.ts';
import {
  type IpcMainLike,
  type PlayerIpcDeps,
  registerPlayerIpc,
  type WebContentsLike,
} from './ipc.ts';
import {
  createPlayerPowerBlockerController,
  DEFAULT_BUFFERING_RELEASE_MS,
  DEFAULT_FROZEN_CLOCK_RELEASE_MS,
} from './ipc-power-blocker.ts';
import { createPowerBlocker } from './power-blocker.ts';

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
    handlers,
    listeners,
    invoke: (channel: string, sender: WebContentsLike, ...args: unknown[]) =>
      Promise.resolve(handlers.get(channel)?.(trustedEvent(sender), ...args)),
    emit: (channel: string, sender: WebContentsLike, ...args: unknown[]) =>
      void listeners.get(channel)?.(trustedEvent(sender), ...args),
  };
}

function fakeContents(id: number) {
  let destroyed = false;
  const onDestroyed: Array<() => void> = [];
  const onNavigate: Array<(d: { isMainFrame: boolean; isSameDocument: boolean }) => void> = [];
  const onCrash: Array<() => void> = [];
  const wc: WebContentsLike = {
    id,
    isDestroyed: () => destroyed,
    send: () => undefined,
    once: (_event, listener) => void onDestroyed.push(listener),
    on(event: string, listener: unknown) {
      if (event === 'did-start-navigation') {
        onNavigate.push(listener as (d: { isMainFrame: boolean; isSameDocument: boolean }) => void);
      } else {
        onCrash.push(listener as () => void);
      }
    },
  };
  return {
    wc,
    destroy() {
      destroyed = true;
      for (const l of onDestroyed) l();
    },
  };
}

function fakePowerBlocker() {
  let nextId = 0;
  const active = new Set<number>();
  const starts: string[] = [];
  const stops: number[] = [];
  const blocker = createPowerBlocker({
    start(type) {
      const id = ++nextId;
      starts.push(type);
      active.add(id);
      return id;
    },
    stop(id) {
      stops.push(id);
      return active.delete(id);
    },
  });
  return { blocker, active, starts, stops };
}

function stubEngine(presenterKind: PresenterKind = 'canvas') {
  const listeners = new Set<(e: EngineEvent) => void>();
  const calls: unknown[][] = [];
  let released = 0;
  const engine = {
    calls,
    get released() {
      return released;
    },
    capabilities: {},
    spawns: 1,
    maxHoldMs: 0,
    loadMode: 'replace' as const,
    presenterKind,
    lastArea: undefined,
    start: vi.fn(),
    load: (cmd: LoadCommand) => calls.push(['load', cmd]),
    retry: (a: number) => calls.push(['retry', a]),
    play: (a: number) => calls.push(['play', a]),
    pause: (a: number) => calls.push(['pause', a]),
    seek: (a: number, ms: number) => calls.push(['seek', a, ms]),
    setScrubbing: vi.fn((attempt: number, scrubbing: boolean) => {
      calls.push(['setScrubbing', attempt, scrubbing]);
    }),
    stop: (a: number) => calls.push(['stop', a]),
    recreate: (a: number) => calls.push(['recreate', a]),
    release: () => {
      released += 1;
    },
    setArea: (area: unknown) => calls.push(['setArea', area]),
    toggleFullscreen: () => calls.push(['fullscreen']),
    toggleMute: () => calls.push(['mute']),
    retargetWindow: presenterKind === 'canvas' ? vi.fn(() => true) : undefined,
    subscribe(l: (ev: EngineEvent) => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    emit(ev: EngineEvent) {
      for (const l of [...listeners]) l(ev);
    },
  };
  return engine;
}

describe('createPlayerPowerBlockerController (60s frozen clock + minimize release)', () => {
  it('exports default 30s buffering and 60s frozen-clock release constants', () => {
    expect(DEFAULT_BUFFERING_RELEASE_MS).toBe(30_000);
    expect(DEFAULT_FROZEN_CLOCK_RELEASE_MS).toBe(60_000);
  });

  it('releases powerBlocker after 60s frozen clock and re-acquires when positionMs resumes advancing', () => {
    vi.useFakeTimers();
    try {
      const pb = fakePowerBlocker();
      const ctl = createPlayerPowerBlockerController<WebContentsLike>({
        powerBlocker: pb.blocker,
        timers: {
          setTimeout: (fn, ms) => setTimeout(fn, ms),
          clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        },
      });
      const owner = fakeContents(1).wc;
      ctl.registerEngine('e1', owner);

      ctl.onState('e1', 'playing');
      expect(pb.active.size).toBe(1);

      // Healthy advancing clocks reset the 60s watchdog continuously
      ctl.onClock('e1', 1_000);
      vi.advanceTimersByTime(40_000);
      ctl.onClock('e1', 41_000);
      vi.advanceTimersByTime(40_000);
      expect(pb.active.size).toBe(1);

      // Stream freezes silently: identical or sub-1ms clocks do NOT reset the watchdog
      ctl.onClock('e1', 41_000);
      vi.advanceTimersByTime(19_999);
      ctl.onClock('e1', 41_000.5);
      expect(pb.active.size).toBe(1);

      // At 60s since last real advancement (40_000 + 19_999 + 1), blocker releases cleanly
      vi.advanceTimersByTime(1);
      expect(pb.active.size).toBe(0);
      expect(pb.blocker.activeCount).toBe(0);

      // Stale clock still does not re-acquire
      ctl.onClock('e1', 41_000.9);
      expect(pb.active.size).toBe(0);

      // Clock resumes advancing (>= 1 ms): re-acquires and rearms 60s timer
      ctl.onClock('e1', 41_002);
      expect(pb.active.size).toBe(1);
      vi.advanceTimersByTime(59_999);
      expect(pb.active.size).toBe(1);
      vi.advanceTimersByTime(1);
      expect(pb.active.size).toBe(0);

      ctl.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases powerBlocker immediately when owning window is minimized and re-acquires on restore', () => {
    vi.useFakeTimers();
    try {
      const pb = fakePowerBlocker();
      let minimized = false;
      const visibilityListeners = new Map<number, (m: boolean) => void>();
      const unsubs = new Map<number, ReturnType<typeof vi.fn>>();

      const ctl = createPlayerPowerBlockerController<WebContentsLike>({
        powerBlocker: pb.blocker,
        frozenClockReleaseMs: 10_000,
        timers: {
          setTimeout: (fn, ms) => setTimeout(fn, ms),
          clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        },
        isWindowMinimized: () => minimized,
        onWindowVisibilityChange: (owner, listener) => {
          visibilityListeners.set(owner.id, listener);
          const unsub = vi.fn(() => {
            visibilityListeners.delete(owner.id);
          });
          unsubs.set(owner.id, unsub);
          return unsub;
        },
      });

      const owner = fakeContents(1).wc;
      ctl.registerEngine('e1', owner);
      ctl.onState('e1', 'playing');
      expect(pb.active.size).toBe(1);

      // Minimize releases immediately
      minimized = true;
      visibilityListeners.get(1)?.(true);
      expect(pb.active.size).toBe(0);

      // Clock events while minimized do NOT re-acquire
      ctl.onClock('e1', 5_000);
      expect(pb.active.size).toBe(0);

      // Restore while still playing & not frozen re-acquires immediately
      minimized = false;
      visibilityListeners.get(1)?.(false);
      expect(pb.active.size).toBe(1);

      // Frozen clock while visible -> releases; restore event does NOT re-acquire a frozen engine
      vi.advanceTimersByTime(10_000);
      expect(pb.active.size).toBe(0);
      visibilityListeners.get(1)?.(false);
      expect(pb.active.size).toBe(0);

      // Owner destroyed cleans up visibility subscription
      ctl.unwatchOwner(1);
      expect(unsubs.get(1)).toHaveBeenCalledTimes(1);
      ctl.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not acquire on playing if owning window starts already minimized', () => {
    vi.useFakeTimers();
    try {
      const pb = fakePowerBlocker();
      const ctl = createPlayerPowerBlockerController<WebContentsLike>({
        powerBlocker: pb.blocker,
        isWindowMinimized: () => true,
        timers: {
          setTimeout: (fn, ms) => setTimeout(fn, ms),
          clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        },
      });
      ctl.registerEngine('e1', fakeContents(1).wc);
      ctl.onState('e1', 'playing');
      expect(pb.active.size).toBe(0);
      ctl.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases powerBlocker on non-playing/non-buffering states such as ready or idle', () => {
    vi.useFakeTimers();
    try {
      const pb = fakePowerBlocker();
      const ctl = createPlayerPowerBlockerController<WebContentsLike>({
        powerBlocker: pb.blocker,
        timers: {
          setTimeout: (fn, ms) => setTimeout(fn, ms),
          clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        },
      });
      ctl.registerEngine('e1', fakeContents(1).wc);
      ctl.onState('e1', 'playing');
      expect(pb.active.size).toBe(1);

      ctl.onState('e1', 'ready');
      expect(pb.active.size).toBe(0);
      expect(pb.blocker.activeCount).toBe(0);

      ctl.onState('e1', 'playing');
      expect(pb.active.size).toBe(1);
      ctl.onState('e1', 'idle');
      expect(pb.active.size).toBe(0);

      ctl.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('registerPlayerIpc frozen-clock, minimize/popout PowerBlocker, and setScrubbing IPC', () => {
  it('supports injectable frozenClockReleaseMs and preserves Popout powerBlocker when main window minimizes', async () => {
    vi.useFakeTimers();
    try {
      const ipc = fakeIpcMain();
      const pb = fakePowerBlocker();
      const engines: Array<ReturnType<typeof stubEngine>> = [];
      const minimizedByOwner = new Map<number, boolean>();
      const visListeners = new Map<number, Set<(m: boolean) => void>>();

      const setMinimized = (ownerId: number, value: boolean) => {
        minimizedByOwner.set(ownerId, value);
        for (const fn of visListeners.get(ownerId) ?? []) fn(value);
      };

      const deps: PlayerIpcDeps = {
        ipcMain: ipc.ipcMain,
        now: () => 1_000,
        log: () => undefined,
        powerBlocker: pb.blocker,
        bufferingReleaseMs: 30_000,
        frozenClockReleaseMs: 5_000,
        isWindowMinimized: (owner) => minimizedByOwner.get(owner.id) ?? false,
        onWindowVisibilityChange: (owner, listener) => {
          let set = visListeners.get(owner.id);
          if (!set) {
            set = new Set();
            visListeners.set(owner.id, set);
          }
          set.add(listener);
          return () => set.delete(listener);
        },
        retargetOwner: () => true,
        createEngine: async () => {
          const eng = stubEngine('canvas');
          engines.push(eng);
          return eng as unknown as MpvEngine;
        },
      };
      const dispose = registerPlayerIpc(deps);

      const mainWin = fakeContents(1);
      const popoutWin = fakeContents(2);
      const { engineId } = (await ipc.invoke(PLAYER_CHANNELS.open, mainWin.wc)) as {
        engineId: string;
      };
      const eng = engines[0];
      if (!eng) throw new Error('expected engine');

      eng.emit({ attempt: 1, type: 'state', state: 'playing' });
      expect(pb.active.size).toBe(1);

      // 5s with no clock advancement releases powerBlocker
      vi.advanceTimersByTime(5_000);
      expect(pb.active.size).toBe(0);

      // Clock advancing re-acquires
      eng.emit({
        attempt: 1,
        type: 'clock',
        anchor: { positionMs: 2_000, atMs: 1_000, rate: 1 },
      });
      expect(pb.active.size).toBe(1);

      // Park from mainWin and adopt into visible popoutWin
      expect(await ipc.invoke(PLAYER_CHANNELS.park, mainWin.wc, engineId)).toBe(true);
      expect(await ipc.invoke(PLAYER_CHANNELS.adopt, popoutWin.wc, engineId)).not.toBeNull();
      expect(pb.active.size).toBe(1);

      // Minimizing mainWin MUST NOT release powerBlocker while attached to visible popoutWin!
      setMinimized(1, true);
      expect(pb.active.size).toBe(1);

      // Minimizing popoutWin itself DOES release powerBlocker; restoring popoutWin re-acquires!
      setMinimized(2, true);
      expect(pb.active.size).toBe(0);

      setMinimized(2, false);
      expect(pb.active.size).toBe(1);

      dispose();
      expect(pb.active.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('registers player:set-scrubbing handler with strict validation, owner check, and dispose cleanup', async () => {
    const ipc = fakeIpcMain();
    const engines: Array<ReturnType<typeof stubEngine>> = [];
    const logs: string[] = [];
    let mediaCommandHandler: ((cmd: { type: 'play' }) => void) | undefined;
    const dispose = registerPlayerIpc({
      ipcMain: ipc.ipcMain,
      now: () => 500,
      log: (line) => logs.push(line),
      mediaBridge: {
        updateState: () => undefined,
        onCommand: (handler) => {
          mediaCommandHandler = handler as (cmd: { type: 'play' }) => void;
          return () => undefined;
        },
        dispose: () => undefined,
      },
      createEngine: async () => {
        const eng = stubEngine('canvas');
        engines.push(eng);
        return eng as unknown as MpvEngine;
      },
    });

    const a = fakeContents(1);
    const b = fakeContents(2);
    const { engineId } = (await ipc.invoke(PLAYER_CHANNELS.open, a.wc)) as { engineId: string };
    const eng = engines[0];
    if (!eng) throw new Error('expected engine');

    expect(ipc.handlers.has(PLAYER_CHANNELS.setScrubbing)).toBe(true);

    // Valid request from owning window invokes engine.setScrubbing
    await ipc.invoke(PLAYER_CHANNELS.setScrubbing, a.wc, {
      engineId,
      attempt: 3,
      scrubbing: true,
    });
    await ipc.invoke(PLAYER_CHANNELS.setScrubbing, a.wc, {
      engineId,
      attempt: 3,
      scrubbing: false,
    });
    expect(eng.calls).toEqual([
      ['setScrubbing', 3, true],
      ['setScrubbing', 3, false],
    ]);

    // Wrong sender is rejected and logged without leaking payload
    await ipc.invoke(PLAYER_CHANNELS.setScrubbing, b.wc, {
      engineId,
      attempt: 4,
      scrubbing: true,
    });
    expect(eng.calls).toHaveLength(2);

    // Invalid payloads are dropped and logged without leaking secret payload contents
    await ipc.invoke(PLAYER_CHANNELS.setScrubbing, a.wc, {
      engineId,
      attempt: -1,
      scrubbing: 'http://secret:pass@host/stream.ts',
    });
    await ipc.invoke(PLAYER_CHANNELS.setScrubbing, a.wc, null);
    expect(eng.calls).toHaveLength(2);
    expect(logs.length).toBe(3);
    for (const line of logs) expect(line).not.toContain('secret');

    // Throwing engine.setScrubbing does not escape the handler
    eng.setScrubbing.mockImplementationOnce(() => {
      throw new Error('scrub boom');
    });
    await expect(
      ipc.invoke(PLAYER_CHANNELS.setScrubbing, a.wc, {
        engineId,
        attempt: 5,
        scrubbing: true,
      }),
    ).resolves.toBeUndefined();

    // Stale attempt in setScrubbing must NOT move entry.attempt backwards
    await ipc.invoke(PLAYER_CHANNELS.setScrubbing, a.wc, {
      engineId,
      attempt: 1,
      scrubbing: false,
    });
    mediaCommandHandler?.({ type: 'play' });
    expect(eng.calls.at(-1)).toEqual(['play', 5]);

    dispose();
    expect(ipc.handlers.has(PLAYER_CHANNELS.setScrubbing)).toBe(false);
  });
});
