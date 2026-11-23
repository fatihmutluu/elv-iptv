import type { EngineEvent, PlayerEngine } from '@elv/playback';
import { afterEach, describe, expect, it, vi } from 'vitest';

declare const performance: { now(): number };

const requireOptionalNativeModule = vi.fn();
const requireNativeViewManager = vi.fn();
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule, requireNativeViewManager }));

async function load() {
  vi.resetModules();
  return import('./index');
}

async function create(): Promise<PlayerEngine | null> {
  return (await load()).createMedia3Engine();
}

type NativeListener = (event: EngineEvent) => void;

function fakeNative() {
  const clock = { uptime: 0 };
  const listeners = new Set<NativeListener>();
  const remoteActionListeners = new Set<(payload: unknown) => void>();
  const moduleListeners = new Map<string, Set<(payload: unknown) => void>>();
  const remove = vi.fn();
  const remoteActionRemove = vi.fn();
  const moduleRemove = vi.fn();
  const engine = {
    load: vi.fn(),
    retry: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    setScrubbing: vi.fn(),
    setSpeed: vi.fn(),
    setPitchLock: vi.fn(),
    setMediaMetadata: vi.fn(),
    setBackgroundAudioEnabled: vi.fn(),
    selectAudioTrack: vi.fn(),
    selectSubtitleTrack: vi.fn(),
    stop: vi.fn(),
    recreate: vi.fn(),
    release: vi.fn(),
    addListener: vi.fn((name: string, listener: (payload: unknown) => void) => {
      if (name === 'onRemoteMediaAction') {
        remoteActionListeners.add(listener);
        return {
          remove: () => {
            remoteActionRemove();
            remoteActionListeners.delete(listener);
          },
        };
      }
      const typed = listener as NativeListener;
      listeners.add(typed);
      return {
        remove: () => {
          remove();
          listeners.delete(typed);
        },
      };
    }),
  };
  const Engine = vi.fn(function construct() {
    return engine;
  });
  const uptimeMs = vi.fn(() => clock.uptime);
  const setOrientationLocked = vi.fn();
  const requestTemporaryOrientation = vi.fn();
  const applyShortEdgesCutoutMode = vi.fn();
  const getSafeAreaInsets = vi.fn(() => ({ top: 32, right: 0, bottom: 16, left: 0 }));
  const enterPictureInPicture = vi.fn(() => true);
  const readClipboardText = vi.fn(async () => 'https://example.test/list.m3u');
  const pickPlaylistFile = vi.fn(async () => ({
    name: 'channels.m3u',
    base64: 'I0VYVE0zVQ==',
  }));
  const addListener = vi.fn((eventName: string, listener: (payload: unknown) => void) => {
    let set = moduleListeners.get(eventName);
    if (set === undefined) {
      set = new Set();
      moduleListeners.set(eventName, set);
    }
    set.add(listener);
    return {
      remove: () => {
        moduleRemove(eventName);
        set.delete(listener);
      },
    };
  });
  requireOptionalNativeModule.mockReturnValue({
    Engine,
    uptimeMs,
    setOrientationLocked,
    requestTemporaryOrientation,
    applyShortEdgesCutoutMode,
    getSafeAreaInsets,
    enterPictureInPicture,
    readClipboardText,
    pickPlaylistFile,
    addListener,
  });
  const emit = (event: EngineEvent) => {
    for (const listener of [...listeners]) listener(event);
  };
  const emitRemoteAction = (payload: unknown) => {
    for (const listener of [...remoteActionListeners]) listener(payload);
  };
  const emitModule = (eventName: string, payload: unknown) => {
    for (const listener of [...(moduleListeners.get(eventName) ?? [])]) listener(payload);
  };
  return {
    clock,
    engine,
    Engine,
    uptimeMs,
    setOrientationLocked,
    requestTemporaryOrientation,
    applyShortEdgesCutoutMode,
    getSafeAreaInsets,
    enterPictureInPicture,
    readClipboardText,
    pickPlaylistFile,
    addListener,
    remove,
    remoteActionRemove,
    moduleRemove,
    emit,
    emitRemoteAction,
    emitModule,
  };
}

afterEach(() => {
  requireOptionalNativeModule.mockReset();
  requireNativeViewManager.mockReset();
  vi.restoreAllMocks();
});

describe('createMedia3Engine', () => {
  it('is null when the native module is absent', async () => {
    requireOptionalNativeModule.mockReturnValue(null);
    expect(await create()).toBeNull();
    expect(requireOptionalNativeModule).toHaveBeenCalledWith('ElvEngineMedia3');
  });

  it('creates one native engine, reports capabilities and bridges clocks via uptimeMs()', async () => {
    const native = fakeNative();
    vi.spyOn(performance, 'now').mockReturnValue(50_000);
    const engine = await create();
    expect(native.Engine).toHaveBeenCalledTimes(1);
    expect(engine?.capabilities).toEqual({
      mpegTsOverHttp: true,
      hls: true,
      liveSeek: false,
      softwareAudioFallback: true,
      recreate: true,
      audioTrackSelection: true,
      subtitleTrackSelection: true,
    });
    const events: EngineEvent[] = [];
    engine?.subscribe((event) => events.push(event));
    native.clock.uptime = 9_000;
    native.emit({ attempt: 2, type: 'firstFrame', atMs: 8_960 });
    expect(events).toEqual([{ attempt: 2, type: 'firstFrame', atMs: 49_960 }]);
  });

  it('forwards track options, bufferPreset, scrubbing, and track selection commands through bridgeNativeEngine', async () => {
    const native = fakeNative();
    const engine = await create();
    engine?.load({
      attempt: 3,
      url: 'http://sim/live/demo/demo/1001.ts',
      headers: { 'User-Agent': 'ua' },
      kind: 'live',
      startMs: 5_000,
      options: {
        softwareAudio: true,
        bufferPreset: 'balanced',
        audioTrackId: '1:0',
        subtitleTrackId: null,
      },
    });
    engine?.setScrubbing?.(3, true);
    engine?.setScrubbing?.(3, false);
    engine?.selectAudioTrack?.(5, '1:1');
    engine?.selectSubtitleTrack?.(5, '2:0');
    engine?.selectSubtitleTrack?.(6, null);
    expect(native.engine.load).toHaveBeenCalledWith({
      attempt: 3,
      url: 'http://sim/live/demo/demo/1001.ts',
      headers: { 'User-Agent': 'ua' },
      kind: 'live',
      startMs: 5_000,
      softwareAudio: true,
      bufferPreset: 'balanced',
      audioTrackId: '1:0',
      subtitleTrackId: null,
    });
    expect(native.engine.setScrubbing).toHaveBeenNthCalledWith(1, 3, true);
    expect(native.engine.setScrubbing).toHaveBeenNthCalledWith(2, 3, false);
    expect(native.engine.selectAudioTrack).toHaveBeenCalledWith(5, '1:1');
    expect(native.engine.selectSubtitleTrack).toHaveBeenNthCalledWith(1, 5, '2:0');
    expect(native.engine.selectSubtitleTrack).toHaveBeenNthCalledWith(2, 6, null);

    const events: EngineEvent[] = [];
    engine?.subscribe((event) => events.push(event));
    const mediaInfo: EngineEvent = {
      attempt: 6,
      type: 'mediaInfo',
      info: { width: 3840, height: 2160, fps: 59.94, codec: 'hevc', hdr: 'hdr10' },
    };
    native.emit(mediaInfo);
    expect(events).toEqual([mediaInfo]);
  });

  it('forwards setSpeed, setPitchLock, setMediaMetadata, setBackgroundAudioEnabled, and onRemoteMediaAction (#264, #412)', async () => {
    const native = fakeNative();
    const mod = await load();
    const engine = mod.createMedia3Engine();
    if (engine === null) throw new Error('engine expected');

    engine.setSpeed?.(4, 1.5);
    engine.setPitchLock?.(4, false);
    mod.setMedia3PitchLock(engine, true);
    mod.setMedia3MediaMetadata(engine, {
      title: 'Channel One',
      subtitle: 'News',
      artworkUrl: 'https://cdn.example.com/ch1.png',
      kind: 'live',
      canStepTrack: true,
    });
    mod.setMedia3MediaMetadata(engine, null);
    mod.setMedia3BackgroundAudioEnabled(engine, true);
    mod.setMedia3BackgroundAudioEnabled(engine, false);

    expect(native.engine.setSpeed).toHaveBeenCalledWith(4, 1.5);
    expect(native.engine.setPitchLock).toHaveBeenNthCalledWith(1, false);
    expect(native.engine.setPitchLock).toHaveBeenNthCalledWith(2, true);
    expect(native.engine.setMediaMetadata).toHaveBeenNthCalledWith(1, {
      title: 'Channel One',
      subtitle: 'News',
      artworkUrl: 'https://cdn.example.com/ch1.png',
      kind: 'live',
      canStepTrack: true,
    });
    expect(native.engine.setMediaMetadata).toHaveBeenNthCalledWith(2, null);
    expect(native.engine.setBackgroundAudioEnabled).toHaveBeenNthCalledWith(1, true);
    expect(native.engine.setBackgroundAudioEnabled).toHaveBeenNthCalledWith(2, false);

    const actions: string[] = [];
    const off = mod.subscribeMedia3RemoteMediaAction(engine, (action) => actions.push(action));
    native.emitRemoteAction({ engineId: 1, action: 'next' });
    native.emitRemoteAction({ engineId: 1, action: 'previous' });
    native.emitRemoteAction({ engineId: 1, action: 'stop' });
    native.emitRemoteAction({ engineId: 1, action: 'invalid' });
    native.emitRemoteAction('next');
    native.emitRemoteAction('stop');
    native.emitRemoteAction(null);
    off();
    native.emitRemoteAction({ engineId: 1, action: 'previous' });
    expect(actions).toEqual(['next', 'previous', 'stop', 'next', 'stop']);
    expect(native.remoteActionRemove).toHaveBeenCalledTimes(1);

    // Released engine ignores all calls cleanly
    engine.release();
    engine.setSpeed?.(5, 2.0);
    engine.setPitchLock?.(5, false);
    mod.setMedia3PitchLock(engine, false);
    mod.setMedia3MediaMetadata(engine, { title: 'After release' });
    mod.setMedia3BackgroundAudioEnabled(engine, true);
    expect(() => mod.subscribeMedia3RemoteMediaAction(engine, () => {})()).not.toThrow();
    expect(native.engine.setSpeed).toHaveBeenCalledTimes(1);
    expect(native.engine.setPitchLock).toHaveBeenCalledTimes(2);
    expect(native.engine.setMediaMetadata).toHaveBeenCalledTimes(2);
    expect(native.engine.setBackgroundAudioEnabled).toHaveBeenCalledTimes(2);
  });
});

function SurfaceView() {
  return null;
}

describe('Media3Surface', () => {
  const foreign = { release() {} } as unknown as PlayerEngine;

  async function engineWithView() {
    const native = fakeNative();
    requireNativeViewManager.mockReturnValue(SurfaceView);
    const { createMedia3Engine, Media3Surface } = await load();
    const engine = createMedia3Engine();
    if (engine === null) throw new Error('engine expected');
    return { native, engine, Media3Surface };
  }

  it('renders the native surface view bound to the native engine object', async () => {
    const { native, engine, Media3Surface } = await engineWithView();
    const style = { flex: 1 };
    const element = Media3Surface({ engine, style, testID: 'video' });
    expect(requireNativeViewManager).toHaveBeenCalledWith('ElvEngineMedia3', 'Media3SurfaceView');
    expect(element?.type).toBe(SurfaceView);
    const props = element?.props as { engine: unknown } | undefined;
    expect(props).toEqual({ engine: native.engine, style, testID: 'video' });
    expect(props?.engine).toBe(native.engine);
  });

  it('passes the resize mode and subtitle bottom inset to the native view and leaves defaults to native', async () => {
    const { native, engine, Media3Surface } = await engineWithView();
    expect(
      Media3Surface({
        engine,
        resizeMode: 'fill',
        subtitleBottomInsetPx: 96,
        subtitleFontFamily: 'atkinson',
        surfaceRecreationToken: 2,
        useTextureView: true,
      })?.props,
    ).toEqual({
      engine: native.engine,
      resizeMode: 'fill',
      subtitleBottomInsetPx: 96,
      subtitleFontFamily: 'atkinson',
      surfaceRecreationToken: 2,
      useTextureView: true,
    });
    expect(Media3Surface({ engine, subtitleFontFamily: 'opendyslexic' })?.props).toEqual({
      engine: native.engine,
      subtitleFontFamily: 'opendyslexic',
    });
    expect(Media3Surface({ engine, subtitleFontFamily: 'system' })?.props).toEqual({
      engine: native.engine,
      subtitleFontFamily: 'system',
    });
    expect(Media3Surface({ engine })?.props).toEqual({ engine: native.engine });
  });

  it('forwards Android standby, cutout, safe-area, PiP, and orientation helpers and no-ops when absent (#143, #255, #266)', async () => {
    const native = fakeNative();
    const mod = await load();

    const standbySeen: boolean[] = [];
    const offStandby = mod.subscribeAndroidStandby((s) => standbySeen.push(s));
    native.emitModule('onStandbyChanged', { standby: true });
    native.emitModule('onStandbyChanged', { standby: false });
    offStandby();
    native.emitModule('onStandbyChanged', { standby: true });
    expect(standbySeen).toEqual([true, false]);
    expect(native.moduleRemove).toHaveBeenCalledWith('onStandbyChanged');

    mod.applyAndroidShortEdgesCutoutMode();
    expect(native.applyShortEdgesCutoutMode).toHaveBeenCalledTimes(1);

    expect(mod.getAndroidSafeAreaInsets()).toEqual({ top: 32, right: 0, bottom: 16, left: 0 });
    const insetsSeen: unknown[] = [];
    const offInsets = mod.subscribeAndroidSafeAreaInsets((i) => insetsSeen.push(i));
    native.emitModule('onSafeAreaInsetsChanged', {
      top: 44,
      right: -5,
      bottom: 24,
      left: Number.NaN,
    });
    offInsets();
    expect(insetsSeen).toEqual([{ top: 44, right: 0, bottom: 24, left: 0 }]);

    expect(mod.enterAndroidPictureInPicture(16, 9)).toBe(true);
    expect(native.enterPictureInPicture).toHaveBeenCalledWith(16, 9);

    const pipSeen: boolean[] = [];
    const offPip = mod.subscribeAndroidPictureInPicture((inPip) => pipSeen.push(inPip));
    native.emitModule('onPictureInPictureChanged', { inPip: true });
    native.emitModule('onPictureInPictureChanged', { inPip: false });
    offPip();
    expect(pipSeen).toEqual([true, false]);

    mod.requestTemporaryOrientation(true);
    expect(native.requestTemporaryOrientation).toHaveBeenCalledWith(true);

    // Absent native module: every helper safely no-ops / returns defaults
    requireOptionalNativeModule.mockReturnValue(null);
    const absent = await load();
    expect(() => absent.subscribeAndroidStandby(() => {})()).not.toThrow();
    expect(() => absent.applyAndroidShortEdgesCutoutMode()).not.toThrow();
    expect(absent.getAndroidSafeAreaInsets()).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(() => absent.subscribeAndroidSafeAreaInsets(() => {})()).not.toThrow();
    expect(absent.enterAndroidPictureInPicture(16, 9)).toBe(false);
    expect(() => absent.subscribeAndroidPictureInPicture(() => {})()).not.toThrow();
    expect(() => absent.requestTemporaryOrientation(false)).not.toThrow();
  });

  it('forwards setOrientationLocked to the native module and no-ops when absent (#440)', async () => {
    const native = fakeNative();
    const { setOrientationLocked } = await load();
    setOrientationLocked(true);
    setOrientationLocked(false);
    expect(native.setOrientationLocked).toHaveBeenNthCalledWith(1, true);
    expect(native.setOrientationLocked).toHaveBeenNthCalledWith(2, false);

    requireOptionalNativeModule.mockReturnValue(null);
    const absent = await load();
    expect(() => absent.setOrientationLocked(true)).not.toThrow();
  });

  it('keeps one native component type across renders', async () => {
    const { engine, Media3Surface } = await engineWithView();
    expect(Media3Surface({ engine })?.type).toBe(Media3Surface({ engine })?.type);
    expect(requireNativeViewManager).toHaveBeenCalledTimes(1);
  });

  it('renders nothing where the native module is absent', async () => {
    requireOptionalNativeModule.mockReturnValue(null);
    const { Media3Surface } = await load();
    expect(Media3Surface({ engine: foreign })).toBeNull();
    expect(requireNativeViewManager).not.toHaveBeenCalled();
  });

  it('renders nothing for an engine it did not create or one already released', async () => {
    const { engine, Media3Surface } = await engineWithView();
    expect(Media3Surface({ engine: foreign })).toBeNull();
    engine.release();
    expect(Media3Surface({ engine })).toBeNull();
  });

  it('forwards allowLegacyTls through load and exposes clipboard + SAF playlist file helpers (#51, #182)', async () => {
    const native = fakeNative();
    const mod = await load();
    const engine = mod.createMedia3Engine();
    engine?.load({
      attempt: 1,
      url: 'https://legacy.example/live.ts',
      headers: {},
      kind: 'live',
      options: { allowLegacyTls: true },
    });
    expect(native.engine.load).toHaveBeenCalledWith({
      attempt: 1,
      url: 'https://legacy.example/live.ts',
      headers: {},
      kind: 'live',
      allowLegacyTls: true,
    });

    expect(await mod.readAndroidClipboardText()).toBe('https://example.test/list.m3u');
    const picked = await mod.pickAndroidPlaylistFile();
    expect(picked?.name).toBe('channels.m3u');
    expect(Array.from(picked?.bytes ?? [])).toEqual([35, 69, 88, 84, 77, 51, 85]);

    native.pickPlaylistFile.mockResolvedValueOnce(null as never);
    expect(await mod.pickAndroidPlaylistFile()).toBeNull();

    native.readClipboardText.mockResolvedValueOnce('' as never);
    expect(await mod.readAndroidClipboardText()).toBeNull();

    requireOptionalNativeModule.mockReturnValue(null);
    const absent = await load();
    expect(await absent.readAndroidClipboardText()).toBeNull();
    expect(await absent.pickAndroidPlaylistFile()).toBeNull();
  });
});
