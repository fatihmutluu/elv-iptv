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

function fakeNative(version = '7.66.1') {
  const clock = { uptime: 0 };
  const listeners = new Set<NativeListener>();
  const remove = vi.fn();
  const engine = {
    load: vi.fn(),
    retry: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
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
  requireOptionalNativeModule.mockReturnValue({ Engine, uptimeMs, engineVersion });
  const emit = (event: EngineEvent) => {
    for (const listener of [...listeners]) listener(event);
  };
  return { clock, engine, Engine, uptimeMs, engineVersion, remove, emit };
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
    const element = AetherSurface({ engine, style, resizeMode: 'fill', testID: 'apple-video' });
    expect(requireNativeViewManager).toHaveBeenCalledWith('ElvEngineAether', 'AetherSurfaceView');
    expect(element?.type).toBe(SurfaceView);
    expect(element?.props).toEqual({
      engine: native.engine,
      style,
      resizeMode: 'fill',
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
});
