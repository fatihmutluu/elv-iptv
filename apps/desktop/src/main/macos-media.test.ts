import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMacOsMediaBridge,
  type GlobalShortcutLike,
  loadMacOsMediaAddon,
  type MacOsMediaAddon,
  type MacOsMediaRemoteEvent,
  type MacOsNowPlayingInfo,
  queryMacScreensHaveSeparateSpaces,
} from './macos-media.ts';
import type { DesktopMediaCommand, DesktopMediaStateSnapshot } from './media-bridge.ts';

function fakeNativeAddon(separateSpaces = true) {
  let remoteCb: ((event: MacOsMediaRemoteEvent) => void) | undefined;
  const nowPlayingCalls: Array<MacOsNowPlayingInfo | null> = [];
  const addon: MacOsMediaAddon = {
    screensHaveSeparateSpaces: vi.fn(() => separateSpaces),
    installRemoteCommands: vi.fn((cb) => {
      remoteCb = cb;
    }),
    uninstallRemoteCommands: vi.fn(() => {
      remoteCb = undefined;
    }),
    setNowPlaying: vi.fn((info) => {
      nowPlayingCalls.push(info);
    }),
  };
  return {
    addon,
    nowPlayingCalls,
    trigger: (event: MacOsMediaRemoteEvent) => remoteCb?.(event),
  };
}

function fakeGlobalShortcut() {
  const registered = new Map<string, () => void>();
  const api: GlobalShortcutLike = {
    register: vi.fn((accel, cb) => {
      registered.set(accel, cb);
      return true;
    }),
    unregister: vi.fn((accel) => {
      registered.delete(accel);
    }),
  };
  return {
    api,
    registered,
    press: (accel: string) => registered.get(accel)?.(),
  };
}

const VOD_PLAYING: DesktopMediaStateSnapshot = {
  status: 'Playing',
  isNavigating: false,
  kind: 'vod',
  positionUs: 45_000_000,
  durationUs: 120_000_000,
  rate: 1.25,
  volume: 1,
  metadata: {
    title: 'Feature Film',
    subtitle: '2026',
    kind: 'vod',
    canStepTrack: false,
  },
};

const STOPPED_EMPTY: DesktopMediaStateSnapshot = {
  status: 'Stopped',
  isNavigating: false,
  kind: 'live',
  positionUs: 0,
  durationUs: 0,
  rate: 1,
  volume: 1,
  metadata: null,
};

describe('loadMacOsMediaAddon & queryMacScreensHaveSeparateSpaces', () => {
  it('loads valid N-API exports via injected dlopen and returns undefined on invalid or failing loads', () => {
    const fake = fakeNativeAddon(false);
    const loaded = loadMacOsMediaAddon('/fake/elv-macos-media.node', (mod) => {
      mod.exports = fake.addon;
    });
    expect(loaded).toBeDefined();
    expect(queryMacScreensHaveSeparateSpaces(loaded, 'darwin')).toBe(false);
    expect(queryMacScreensHaveSeparateSpaces(loaded, 'win32')).toBe(true);
    expect(queryMacScreensHaveSeparateSpaces(undefined, 'darwin')).toBe(true);

    expect(
      loadMacOsMediaAddon('/fake/bad.node', (mod) => {
        mod.exports = { screensHaveSeparateSpaces: () => true };
      }),
    ).toBeUndefined();
    expect(
      loadMacOsMediaAddon('/fake/throws.node', () => {
        throw new Error('ENOENT');
      }),
    ).toBeUndefined();
    expect(loadMacOsMediaAddon(undefined)).toBeUndefined();
  });
});

describe('createMacOsMediaBridge (#301)', () => {
  it('is a safe no-op on non-darwin platforms', () => {
    const fake = fakeNativeAddon();
    const bridge = createMacOsMediaBridge({ platform: 'linux', addon: fake.addon });
    bridge.updateState(VOD_PLAYING);
    bridge.notifySeeked?.(50_000_000);
    bridge.dispose();
    expect(fake.addon.installRemoteCommands).not.toHaveBeenCalled();
    expect(fake.addon.setNowPlaying).not.toHaveBeenCalled();
  });

  it('wires native MPRemoteCommandCenter events and MPNowPlayingInfoCenter updates on darwin', () => {
    const fake = fakeNativeAddon(true);
    const bridge = createMacOsMediaBridge({ platform: 'darwin', addon: fake.addon });
    const cmds: DesktopMediaCommand[] = [];
    bridge.onCommand((c) => cmds.push(c));

    expect(fake.addon.installRemoteCommands).toHaveBeenCalledTimes(1);

    bridge.updateState(VOD_PLAYING);
    expect(fake.nowPlayingCalls.at(-1)).toEqual({
      title: 'Feature Film',
      artist: '2026',
      playbackState: 'playing',
      durationSec: 120,
      elapsedSec: 45,
      playbackRate: 1.25,
      canGoNext: false,
      canGoPrevious: false,
      canSeek: true,
    });

    bridge.notifySeeked?.(60_000_000);
    expect(fake.nowPlayingCalls.at(-1)?.elapsedSec).toBe(60);

    fake.trigger({ type: 'play' });
    fake.trigger({ type: 'pause' });
    fake.trigger({ type: 'togglePlayPause' });
    fake.trigger({ type: 'stop' });
    fake.trigger({ type: 'next' });
    fake.trigger({ type: 'previous' });
    fake.trigger({ type: 'seekBy', offsetSec: 10 });
    fake.trigger({ type: 'seekBy', offsetSec: -10 });
    fake.trigger({ type: 'seekTo', positionSec: 90.5 });

    expect(cmds).toEqual([
      { type: 'play' },
      { type: 'pause' },
      { type: 'togglePlayPause' },
      { type: 'stop' },
      { type: 'next' },
      { type: 'previous' },
      { type: 'seekByUs', offsetUs: 10_000_000 },
      { type: 'seekByUs', offsetUs: -10_000_000 },
      { type: 'seekToUs', positionUs: 90_500_000 },
    ]);

    bridge.updateState(STOPPED_EMPTY);
    expect(fake.nowPlayingCalls.at(-1)).toBeNull();

    bridge.dispose();
    expect(fake.addon.uninstallRemoteCommands).toHaveBeenCalledTimes(1);
    expect(fake.nowPlayingCalls.at(-1)).toBeNull();
  });

  it('uses guarded active-playback globalShortcut fallback when native addon is absent and unregisters on Stopped/dispose', () => {
    const gs = fakeGlobalShortcut();
    const bridge = createMacOsMediaBridge({
      platform: 'darwin',
      addon: null,
      globalShortcut: gs.api,
    });
    const cmds: DesktopMediaCommand[] = [];
    bridge.onCommand((c) => cmds.push(c));

    // Not registered while idle
    expect(gs.registered.size).toBe(0);

    // Registers on Playing
    bridge.updateState(VOD_PLAYING);
    expect([...gs.registered.keys()].sort()).toEqual([
      'MediaNextTrack',
      'MediaPlayPause',
      'MediaPreviousTrack',
      'MediaStop',
    ]);

    gs.press('MediaPlayPause');
    gs.press('MediaNextTrack');
    gs.press('MediaPreviousTrack');
    gs.press('MediaStop');
    expect(cmds).toEqual([
      { type: 'togglePlayPause' },
      { type: 'next' },
      { type: 'previous' },
      { type: 'stop' },
    ]);

    // Stays registered while Paused
    bridge.updateState({ ...VOD_PLAYING, status: 'Paused' });
    expect(gs.registered.size).toBe(4);

    // Immediately unregisters on Stopped so other apps are never hijacked!
    bridge.updateState(STOPPED_EMPTY);
    expect(gs.registered.size).toBe(0);

    // Re-registers on Playing, then unregisters on dispose()
    bridge.updateState(VOD_PLAYING);
    expect(gs.registered.size).toBe(4);
    bridge.dispose();
    expect(gs.registered.size).toBe(0);
  });

  it('debounces transient isNavigating Stopped states for 400ms across native addon and globalShortcut fallback (#301)', async () => {
    vi.useFakeTimers();
    const fake = fakeNativeAddon(true);
    const nativeBridge = createMacOsMediaBridge({
      platform: 'darwin',
      addon: fake.addon,
      navigatingDebounceMs: 400,
    });
    const gs = fakeGlobalShortcut();
    const fallbackBridge = createMacOsMediaBridge({
      platform: 'darwin',
      addon: null,
      globalShortcut: gs.api,
      navigatingDebounceMs: 400,
    });

    const liveCh1: DesktopMediaStateSnapshot = {
      status: 'Playing',
      isNavigating: false,
      kind: 'live',
      positionUs: 0,
      durationUs: 0,
      rate: 1,
      volume: 1,
      metadata: { title: 'Ch 1', kind: 'live', canStepTrack: true },
    };
    const zappingToCh2: DesktopMediaStateSnapshot = {
      ...liveCh1,
      status: 'Stopped',
      isNavigating: true,
      metadata: { title: 'Ch 2', kind: 'live', canStepTrack: true },
    };
    const liveCh2: DesktopMediaStateSnapshot = {
      ...liveCh1,
      metadata: { title: 'Ch 2', kind: 'live', canStepTrack: true },
    };

    nativeBridge.updateState(liveCh1);
    fallbackBridge.updateState(liveCh1);
    expect(fake.nowPlayingCalls.at(-1)?.playbackState).toBe('playing');
    expect(gs.registered.size).toBe(4);

    // Zap begins: transient Stopped + isNavigating=true must NOT flash stopped/null or drop shortcuts!
    nativeBridge.updateState(zappingToCh2);
    fallbackBridge.updateState(zappingToCh2);
    await vi.advanceTimersByTimeAsync(250);
    expect(fake.nowPlayingCalls.at(-1)).toMatchObject({ title: 'Ch 2', playbackState: 'playing' });
    expect(gs.registered.size).toBe(4);

    // New channel resumes playing before 400ms -> no Stopped flash
    nativeBridge.updateState(liveCh2);
    fallbackBridge.updateState(liveCh2);
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.nowPlayingCalls.every((entry) => entry !== null)).toBe(true);
    expect(gs.registered.size).toBe(4);

    // Stalled zap > 400ms clears Now Playing (null) and unregisters fallback shortcuts
    nativeBridge.updateState({ ...STOPPED_EMPTY, isNavigating: true });
    fallbackBridge.updateState({ ...STOPPED_EMPTY, isNavigating: true });
    await vi.advanceTimersByTimeAsync(399);
    expect(fake.nowPlayingCalls.at(-1)).not.toBeNull();
    expect(gs.registered.size).toBe(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.nowPlayingCalls.at(-1)).toBeNull();
    expect(gs.registered.size).toBe(0);

    nativeBridge.dispose();
    fallbackBridge.dispose();
  });
});

afterEach(() => vi.useRealTimers());
