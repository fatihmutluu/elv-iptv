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

type NativeListener = (event: EngineEvent) => void;
type ModuleEventName = 'onSafeAreaInsetsChanged' | 'onHardwareKey';
type ModuleListener = (payload: unknown) => void;

function fakeNative(version = '7.66.1', model?: string) {
  const clock = { uptime: 0 };
  const listeners = new Set<NativeListener>();
  const moduleListeners = new Map<ModuleEventName, Set<ModuleListener>>();
  const remove = vi.fn();
  const moduleRemove = vi.fn();
  const engine = {
    load: vi.fn(),
    retry: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    setSpeed: vi.fn(),
    setMuted: vi.fn(),
    setVolume: vi.fn(),
    selectAudioTrack: vi.fn(),
    selectSubtitleTrack: vi.fn(),
    stop: vi.fn(),
    recreate: vi.fn(),
    release: vi.fn(),
    addListener: vi.fn((_name: string, listener: NativeListener) => {
      listeners.add(listener);
      return {
        remove: () => {
          remove();
          listeners.delete(listener);
        },
      };
    }),
  };
  const Engine = vi.fn(function construct() {
    return engine;
  });
  const uptimeMs = vi.fn(() => clock.uptime);
  const engineVersion = vi.fn(() => version);
  const deviceModel = model === undefined ? undefined : vi.fn(() => model);
  const readPersistentValue = vi.fn<(key: string) => string | null>(() => null);
  const writePersistentValue = vi.fn<(key: string, value: string) => boolean>(() => true);
  const writeLocalPersistentValue = vi.fn<(key: string, value: string) => boolean>(() => true);
  const persistentStorageBudgetBytes = vi.fn<() => number>(() => 393_216);
  const getSafeAreaInsets = vi.fn<
    () => { top?: unknown; right?: unknown; bottom?: unknown; left?: unknown }
  >(() => ({ top: 0, right: 0, bottom: 0, left: 0 }));
  const readClipboardText = vi.fn<() => Promise<string | null>>(
    async () => 'https://apple.example/list.m3u',
  );
  const pickPlaylistFile = vi.fn<() => Promise<{ name?: unknown; base64?: unknown } | null>>(
    async () => ({ name: 'apple.m3u', base64: 'I0VYVE0zVQ==' }),
  );
  const addModuleListener = vi.fn((name: ModuleEventName, listener: ModuleListener) => {
    let bucket = moduleListeners.get(name);
    if (bucket === undefined) {
      bucket = new Set();
      moduleListeners.set(name, bucket);
    }
    bucket.add(listener);
    return {
      remove: () => {
        moduleRemove();
        bucket?.delete(listener);
      },
    };
  });
  requireOptionalNativeModule.mockReturnValue({
    Engine,
    uptimeMs,
    engineVersion,
    ...(deviceModel === undefined ? {} : { deviceModel }),
    readPersistentValue,
    writePersistentValue,
    writeLocalPersistentValue,
    persistentStorageBudgetBytes,
    getSafeAreaInsets,
    readClipboardText,
    pickPlaylistFile,
    addListener: addModuleListener,
  });
  const emit = (event: EngineEvent) => {
    for (const listener of [...listeners]) listener(event);
  };
  const emitModule = (name: ModuleEventName, payload: unknown) => {
    for (const listener of [...(moduleListeners.get(name) ?? [])]) listener(payload);
  };
  return {
    clock,
    engine,
    Engine,
    uptimeMs,
    engineVersion,
    deviceModel,
    readPersistentValue,
    writePersistentValue,
    writeLocalPersistentValue,
    persistentStorageBudgetBytes,
    getSafeAreaInsets,
    readClipboardText,
    pickPlaylistFile,
    addModuleListener,
    remove,
    moduleRemove,
    emit,
    emitModule,
  };
}

afterEach(() => {
  requireOptionalNativeModule.mockReset();
  requireNativeViewManager.mockReset();
  vi.restoreAllMocks();
});

describe('aetherEngineVersion', () => {
  it('returns null when the native module is absent', async () => {
    requireOptionalNativeModule.mockReturnValue(null);
    const { aetherEngineVersion } = await load();
    expect(aetherEngineVersion()).toBeNull();
    expect(requireOptionalNativeModule).toHaveBeenCalledWith('ElvEngineAether');
  });

  it('returns the native engine version string when present', async () => {
    fakeNative('7.66.1');
    const { aetherEngineVersion } = await load();
    expect(aetherEngineVersion()).toBe('7.66.1');
  });
});

describe('createAetherEngine', () => {
  it('is null when the native module is absent', async () => {
    requireOptionalNativeModule.mockReturnValue(null);
    const { createAetherEngine } = await load();
    expect(createAetherEngine()).toBeNull();
    expect(requireOptionalNativeModule).toHaveBeenCalledWith('ElvEngineAether');
  });

  it('creates one native Engine per call with the Apple capabilities and bridges events', async () => {
    const native = fakeNative();
    vi.spyOn(performance, 'now').mockReturnValue(20_000);
    const { createAetherEngine } = await load();
    const first = createAetherEngine();
    const second = createAetherEngine();
    expect(native.Engine).toHaveBeenCalledTimes(2);
    expect(first).not.toBe(second);
    expect(first?.capabilities).toEqual({
      mpegTsOverHttp: true,
      hls: true,
      liveSeek: false,
      softwareAudioFallback: true,
      recreate: true,
      audioTrackSelection: true,
      subtitleTrackSelection: true,
    });
    const events: EngineEvent[] = [];
    first?.subscribe((e) => events.push(e));
    native.clock.uptime = 5_000;
    native.emit({ attempt: 1, type: 'firstFrame', atMs: 4_900 });
    expect(events).toEqual([{ attempt: 1, type: 'firstFrame', atMs: 19_900 }]);
  });

  it('forwards track load options, track selection commands, and tracks events', async () => {
    const native = fakeNative();
    const { createAetherEngine } = await load();
    const engine = createAetherEngine();
    if (engine === null) throw new Error('engine expected');

    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));

    engine.load({
      attempt: 1,
      url: 'http://127.0.0.1:7878/movie/demo/demo/200011.mkv',
      headers: {},
      kind: 'vod',
      startMs: 12_000,
      options: { audioTrackId: 'a:2', subtitleTrackId: null },
    });
    expect(native.engine.load).toHaveBeenCalledWith({
      attempt: 1,
      url: 'http://127.0.0.1:7878/movie/demo/demo/200011.mkv',
      headers: {},
      kind: 'vod',
      startMs: 12_000,
      audioTrackId: 'a:2',
      subtitleTrackId: null,
    });

    engine.selectAudioTrack?.(2, 'a:2');
    expect(native.engine.selectAudioTrack).toHaveBeenCalledWith(2, 'a:2');

    engine.selectSubtitleTrack?.(3, 's:4');
    expect(native.engine.selectSubtitleTrack).toHaveBeenCalledWith(3, 's:4');

    engine.selectSubtitleTrack?.(4, null);
    expect(native.engine.selectSubtitleTrack).toHaveBeenCalledWith(4, null);

    const tracksEvent: EngineEvent = {
      attempt: 4,
      type: 'tracks',
      tracks: {
        audio: [
          {
            id: 'a:1',
            language: 'tur',
            label: 'Turkish',
            codec: 'aac',
            channels: 2,
            isDefault: true,
          },
          { id: 'a:2', language: 'eng', label: 'English', codec: 'aac', channels: 2 },
        ],
        subtitles: [
          { id: 's:3', language: 'tur', label: 'Turkish', codec: 'subrip' },
          { id: 's:4', language: 'eng', label: 'English', codec: 'subrip' },
        ],
        selectedAudioId: 'a:2',
        selectedSubtitleId: null,
      },
    };
    native.emit(tracksEvent);
    expect(events).toEqual([tracksEvent]);

    const mediaInfoEvent: EngineEvent = {
      attempt: 4,
      type: 'mediaInfo',
      info: { width: 3840, height: 2160, fps: 60, codec: 'hevc', hdr: 'dv' },
    };
    native.emit(mediaInfoEvent);
    expect(events).toEqual([tracksEvent, mediaInfoEvent]);

    engine.setSpeed?.(5, 1.5);
    expect(native.engine.setSpeed).toHaveBeenCalledWith(5, 1.5);
  });

  it('omits setSpeed when the native engine object does not expose it (#442)', async () => {
    const native = fakeNative();
    const { setSpeed: _omitted, ...withoutSpeed } = native.engine;
    native.Engine.mockImplementation(function constructWithoutSpeed() {
      return withoutSpeed as typeof native.engine;
    });
    const { createAetherEngine } = await load();
    const engine = createAetherEngine();
    expect(engine?.setSpeed).toBeUndefined();
  });
});

function SurfaceView() {
  return null;
}

describe('AetherSurface', () => {
  const foreign = { release() {} } as unknown as PlayerEngine;

  async function engineWithView() {
    const native = fakeNative();
    requireNativeViewManager.mockReturnValue(SurfaceView);
    const { createAetherEngine, AetherSurface } = await load();
    const engine = createAetherEngine();
    if (engine === null) throw new Error('engine expected');
    return { native, engine, AetherSurface };
  }

  it('renders the native AetherSurfaceView bound to the native Engine shared object', async () => {
    const { native, engine, AetherSurface } = await engineWithView();
    const style = { flex: 1 };
    const element = AetherSurface({
      engine,
      style,
      resizeMode: 'fill',
      subtitleBottomInsetPx: 84,
      testID: 'apple-video',
    });
    expect(requireNativeViewManager).toHaveBeenCalledWith('ElvEngineAether', 'AetherSurfaceView');
    expect(element?.type).toBe(SurfaceView);
    expect(element?.props).toEqual({
      engine: native.engine,
      style,
      resizeMode: 'fill',
      subtitleBottomInsetPx: 84,
      testID: 'apple-video',
    });
  });

  it('renders nothing without the native module or for a foreign or released engine', async () => {
    requireOptionalNativeModule.mockReturnValue(null);
    const absent = await load();
    expect(absent.AetherSurface({ engine: foreign })).toBeNull();
    expect(requireNativeViewManager).not.toHaveBeenCalled();

    const { engine, AetherSurface } = await engineWithView();
    expect(AetherSurface({ engine: foreign })).toBeNull();
    engine.release();
    expect(AetherSurface({ engine })).toBeNull();
  });

  it('forwards osdVisible when defined and omits it when undefined (#442)', async () => {
    const { native, engine, AetherSurface } = await engineWithView();
    const hidden = AetherSurface({ engine, osdVisible: false });
    expect(hidden?.props).toEqual({
      engine: native.engine,
      style: undefined,
      resizeMode: undefined,
      subtitleBottomInsetPx: undefined,
      osdVisible: false,
      testID: undefined,
    });

    const visible = AetherSurface({ engine, osdVisible: true });
    expect(visible?.props).toEqual({
      engine: native.engine,
      style: undefined,
      resizeMode: undefined,
      subtitleBottomInsetPx: undefined,
      osdVisible: true,
      testID: undefined,
    });
  });
});

describe('Apple hardware tiering (#186)', () => {
  it('classifies AppleTV5,* (2 GB) and AppleTV6,* (3 GB) as mid-power and newer/other models as standard', async () => {
    const { resolveAppleHardwareTier } = await load();
    expect(resolveAppleHardwareTier('AppleTV5,3')).toBe('mid-power');
    expect(resolveAppleHardwareTier('AppleTV6,2')).toBe('mid-power');
    expect(resolveAppleHardwareTier('  AppleTV6,2  ')).toBe('mid-power');
    expect(resolveAppleHardwareTier('AppleTV11,1')).toBe('standard');
    expect(resolveAppleHardwareTier('AppleTV14,1')).toBe('standard');
    expect(resolveAppleHardwareTier('iPhone16,1')).toBe('standard');
    expect(resolveAppleHardwareTier('iPad14,1')).toBe('standard');
    expect(resolveAppleHardwareTier('')).toBe('standard');
    expect(resolveAppleHardwareTier(null)).toBe('standard');
    expect(resolveAppleHardwareTier(undefined)).toBe('standard');
  });

  it('reads deviceModel safely from the native module when available', async () => {
    requireOptionalNativeModule.mockReturnValue(null);
    expect((await load()).getAppleDeviceModel()).toBeNull();

    fakeNative('7.66.1');
    expect((await load()).getAppleDeviceModel()).toBeNull();

    fakeNative('7.66.1', '   ');
    expect((await load()).getAppleDeviceModel()).toBeNull();

    fakeNative('7.66.1', 'AppleTV6,2');
    expect((await load()).getAppleDeviceModel()).toBe('AppleTV6,2');
  });
});

describe('Apple persistent KV bridge (#79)', () => {
  it('returns null/false safely when the native module is absent or throws', async () => {
    requireOptionalNativeModule.mockReturnValue(null);
    const absent = await load();
    expect(absent.readApplePersistentValue('elv.catalog.userstate.v1')).toBeNull();
    expect(absent.writeApplePersistentValue('elv.catalog.userstate.v1', '{"v":1}')).toBe(false);
    expect(absent.writeAppleLocalPersistentValue('elv.catalog.userstate.v1', '{"v":1}')).toBe(
      false,
    );
    expect(absent.getApplePersistentBudgetBytes()).toBeNull();

    const native = fakeNative();
    native.readPersistentValue.mockImplementation(() => {
      throw new Error('bridge error');
    });
    native.writePersistentValue.mockImplementation(() => {
      throw new Error('bridge error');
    });
    native.writeLocalPersistentValue.mockImplementation(() => {
      throw new Error('bridge error');
    });
    native.persistentStorageBudgetBytes.mockImplementation(() => {
      throw new Error('bridge error');
    });
    const mod = await load();
    expect(mod.readApplePersistentValue('k')).toBeNull();
    expect(mod.writeApplePersistentValue('k', 'v')).toBe(false);
    expect(mod.writeAppleLocalPersistentValue('k', 'v')).toBe(false);
    expect(mod.getApplePersistentBudgetBytes()).toBeNull();
  });

  it('forwards persistent read, write, local mirror write, and budget queries with empty-key and empty-value guards', async () => {
    const native = fakeNative();
    native.readPersistentValue.mockReturnValueOnce('{"v":1}').mockReturnValueOnce('');
    native.writePersistentValue.mockReturnValueOnce(true).mockReturnValueOnce(false);
    native.writeLocalPersistentValue.mockReturnValueOnce(true).mockReturnValueOnce(false);
    native.persistentStorageBudgetBytes
      .mockReturnValueOnce(921_600)
      .mockReturnValueOnce(Number.NaN);

    const mod = await load();
    expect(mod.readApplePersistentValue('')).toBeNull();
    expect(native.readPersistentValue).not.toHaveBeenCalled();

    expect(mod.readApplePersistentValue('elv.catalog.userstate.v1')).toBe('{"v":1}');
    expect(mod.readApplePersistentValue('elv.catalog.userstate.v1')).toBeNull();

    expect(mod.writeApplePersistentValue('', '{"v":1}')).toBe(false);
    expect(native.writePersistentValue).not.toHaveBeenCalled();
    expect(mod.writeApplePersistentValue('elv.catalog.userstate.v1', '{"v":1}')).toBe(true);
    expect(mod.writeApplePersistentValue('elv.catalog.userstate.v1', 'oversized')).toBe(false);

    expect(mod.writeAppleLocalPersistentValue('', '{"v":1}')).toBe(false);
    expect(native.writeLocalPersistentValue).not.toHaveBeenCalled();
    expect(mod.writeAppleLocalPersistentValue('elv.catalog.userstate.v1', '{"v":1}')).toBe(true);
    expect(mod.writeAppleLocalPersistentValue('elv.catalog.userstate.v1', 'oversized')).toBe(false);

    expect(mod.getApplePersistentBudgetBytes()).toBe(921_600);
    expect(mod.getApplePersistentBudgetBytes()).toBeNull();
  });
});

describe('Apple mute/volume, safe-area insets, and hardware keys (#415)', () => {
  it('forwards setAppleEngineMuted and clamped setAppleEngineVolume only for live owned engines', async () => {
    const native = fakeNative();
    const mod = await load();
    const engine = mod.createAetherEngine();
    if (engine === null) throw new Error('engine expected');

    mod.setAppleEngineMuted(engine, true);
    mod.setAppleEngineMuted(engine, false);
    expect(native.engine.setMuted).toHaveBeenNthCalledWith(1, true);
    expect(native.engine.setMuted).toHaveBeenNthCalledWith(2, false);

    mod.setAppleEngineVolume(engine, 75);
    mod.setAppleEngineVolume(engine, -15);
    mod.setAppleEngineVolume(engine, 140);
    mod.setAppleEngineVolume(engine, Number.NaN);
    mod.setAppleEngineVolume(engine, Number.POSITIVE_INFINITY);
    expect(native.engine.setVolume).toHaveBeenCalledTimes(3);
    expect(native.engine.setVolume).toHaveBeenNthCalledWith(1, 75);
    expect(native.engine.setVolume).toHaveBeenNthCalledWith(2, 0);
    expect(native.engine.setVolume).toHaveBeenNthCalledWith(3, 100);

    // Foreign and released engines are ignored cleanly.
    const foreign = { release() {} } as unknown as PlayerEngine;
    mod.setAppleEngineMuted(foreign, true);
    mod.setAppleEngineVolume(foreign, 50);
    engine.release();
    mod.setAppleEngineMuted(engine, true);
    mod.setAppleEngineVolume(engine, 50);
    expect(native.engine.setMuted).toHaveBeenCalledTimes(2);
    expect(native.engine.setVolume).toHaveBeenCalledTimes(3);
  });

  it('normalizes safe-area insets and subscribes/unsubscribes cleanly', async () => {
    requireOptionalNativeModule.mockReturnValue(null);
    const absent = await load();
    expect(absent.getAppleSafeAreaInsets()).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    const noopUnsub = absent.subscribeAppleSafeAreaInsets(vi.fn());
    expect(() => noopUnsub()).not.toThrow();

    const native = fakeNative();
    native.getSafeAreaInsets.mockReturnValue({
      top: 59,
      right: -4,
      bottom: 34,
      left: Number.NaN,
    });
    const mod = await load();
    expect(mod.getAppleSafeAreaInsets()).toEqual({ top: 59, right: 0, bottom: 34, left: 0 });

    const seen: unknown[] = [];
    const unsubscribe = mod.subscribeAppleSafeAreaInsets((insets) => seen.push(insets));
    expect(native.addModuleListener).toHaveBeenCalledWith(
      'onSafeAreaInsetsChanged',
      expect.any(Function),
    );
    native.emitModule('onSafeAreaInsetsChanged', { top: 0, right: 59, bottom: 21, left: 59 });
    native.emitModule('onSafeAreaInsetsChanged', null);
    expect(seen).toEqual([
      { top: 0, right: 59, bottom: 21, left: 59 },
      { top: 0, right: 0, bottom: 0, left: 0 },
    ]);

    unsubscribe();
    expect(native.moduleRemove).toHaveBeenCalledTimes(1);
    native.emitModule('onSafeAreaInsetsChanged', { top: 10, right: 10, bottom: 10, left: 10 });
    expect(seen).toHaveLength(2);
  });

  it('validates and forwards Apple hardware keyboard actions and cleans up subscriptions', async () => {
    requireOptionalNativeModule.mockReturnValue(null);
    const absent = await load();
    const noopUnsub = absent.subscribeAppleHardwareKeys(vi.fn());
    expect(() => noopUnsub()).not.toThrow();

    const native = fakeNative();
    const mod = await load();
    const keys: string[] = [];
    const unsubscribe = mod.subscribeAppleHardwareKeys((key) => keys.push(key));
    expect(native.addModuleListener).toHaveBeenCalledWith('onHardwareKey', expect.any(Function));

    for (const valid of [
      'play-pause',
      'seek-back',
      'seek-forward',
      'channel-up',
      'channel-down',
      'volume-up',
      'volume-down',
      'mute',
      'aspect',
      'back',
    ]) {
      native.emitModule('onHardwareKey', { key: valid });
    }
    native.emitModule('onHardwareKey', 'play-pause');
    native.emitModule('onHardwareKey', { key: 'unknown-key' });
    native.emitModule('onHardwareKey', { key: 123 });
    native.emitModule('onHardwareKey', null);

    expect(keys).toEqual([
      'play-pause',
      'seek-back',
      'seek-forward',
      'channel-up',
      'channel-down',
      'volume-up',
      'volume-down',
      'mute',
      'aspect',
      'back',
      'play-pause',
    ]);

    unsubscribe();
    expect(native.moduleRemove).toHaveBeenCalledTimes(1);
    native.emitModule('onHardwareKey', { key: 'mute' });
    expect(keys).toHaveLength(11);
  });

  it('forwards allowLegacyTls through load and exposes clipboard + document picker helpers (#51, #182)', async () => {
    const native = fakeNative();
    const mod = await load();
    const engine = mod.createAetherEngine();
    engine?.load({
      attempt: 2,
      url: 'https://legacy-apple.example/live.ts',
      headers: {},
      kind: 'live',
      options: { allowLegacyTls: true },
    });
    expect(native.engine.load).toHaveBeenCalledWith({
      attempt: 2,
      url: 'https://legacy-apple.example/live.ts',
      headers: {},
      kind: 'live',
      allowLegacyTls: true,
    });

    expect(await mod.readAppleClipboardText()).toBe('https://apple.example/list.m3u');
    const picked = await mod.pickApplePlaylistFile();
    expect(picked?.name).toBe('apple.m3u');
    expect(Array.from(picked?.bytes ?? [])).toEqual([35, 69, 88, 84, 77, 51, 85]);

    native.pickPlaylistFile.mockResolvedValueOnce(null);
    expect(await mod.pickApplePlaylistFile()).toBeNull();

    native.readClipboardText.mockResolvedValueOnce('');
    expect(await mod.readAppleClipboardText()).toBeNull();

    requireOptionalNativeModule.mockReturnValue(null);
    const absent = await load();
    expect(await absent.readAppleClipboardText()).toBeNull();
    expect(await absent.pickApplePlaylistFile()).toBeNull();
  });
});
