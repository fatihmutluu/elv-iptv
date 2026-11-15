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
  requireOptionalNativeModule.mockReturnValue({ Engine, uptimeMs });
  const emit = (event: EngineEvent) => {
    for (const listener of [...listeners]) listener(event);
  };
  return { clock, engine, Engine, uptimeMs, remove, emit };
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

  it('forwards track options and track selection commands through bridgeNativeEngine', async () => {
    const native = fakeNative();
    const engine = await create();
    engine?.load({
      attempt: 3,
      url: 'http://sim/live/demo/demo/1001.ts',
      headers: { 'User-Agent': 'ua' },
      kind: 'live',
      startMs: 5_000,
      options: { softwareAudio: true, audioTrackId: '1:0', subtitleTrackId: null },
    });
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
      audioTrackId: '1:0',
      subtitleTrackId: null,
    });
    expect(native.engine.selectAudioTrack).toHaveBeenCalledWith(5, '1:1');
    expect(native.engine.selectSubtitleTrack).toHaveBeenNthCalledWith(1, 5, '2:0');
    expect(native.engine.selectSubtitleTrack).toHaveBeenNthCalledWith(2, 6, null);
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

  it('passes the resize mode to the native view and leaves the default to native', async () => {
    const { native, engine, Media3Surface } = await engineWithView();
    expect(Media3Surface({ engine, resizeMode: 'fill' })?.props).toEqual({
      engine: native.engine,
      resizeMode: 'fill',
    });
    expect(Media3Surface({ engine })?.props).toEqual({ engine: native.engine });
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
});
