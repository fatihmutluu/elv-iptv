import type { EngineEvent, PlayerEngine } from '@elv/playback';
import { afterEach, describe, expect, it, vi } from 'vitest';

declare const performance: { now(): number };

const requireOptionalNativeModule = vi.fn();
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule }));

async function create(): Promise<PlayerEngine | null> {
  vi.resetModules();
  return (await import('./index')).createMedia3Engine();
}

type NativeListener = (event: Record<string, unknown>) => void;

/** A native module double: `uptimeMs()` reads `clock.uptime`, `emit` delivers one native `onEngineEvent` payload. */
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
  const Engine = vi.fn(function Engine() {
    return engine;
  });
  const uptimeMs = vi.fn(() => clock.uptime);
  requireOptionalNativeModule.mockReturnValue({ Engine, uptimeMs });
  const emit = (event: Record<string, unknown>) => {
    for (const listener of [...listeners]) listener(event);
  };
  return { clock, engine, Engine, uptimeMs, remove, emit };
}

afterEach(() => {
  requireOptionalNativeModule.mockReset();
  vi.restoreAllMocks();
});

describe('createMedia3Engine', () => {
  it('is null when the native module is absent', async () => {
    requireOptionalNativeModule.mockReturnValue(null);
    expect(await create()).toBeNull();
    expect(requireOptionalNativeModule).toHaveBeenCalledWith('ElvEngineMedia3');
  });

  it('creates one native engine and reports its capabilities', async () => {
    const native = fakeNative();
    const engine = await create();
    expect(native.Engine).toHaveBeenCalledTimes(1);
    expect(engine?.capabilities).toEqual({
      mpegTsOverHttp: true,
      hls: true,
      liveSeek: false,
      softwareAudioFallback: true,
      recreate: true,
      audioTrackSelection: false,
      subtitleTrackSelection: false,
    });
  });

  it('forwards every command with its token', async () => {
    const native = fakeNative();
    const engine = await create();
    engine?.load({
      attempt: 3,
      url: 'http://sim/live/demo/demo/1001.ts',
      headers: { 'User-Agent': 'ua' },
      kind: 'live',
      startMs: 5_000,
      options: { softwareAudio: true },
    });
    engine?.retry(4);
    engine?.play(4);
    engine?.pause(4);
    engine?.seek(5, 12_000);
    engine?.stop(6);
    engine?.recreate(7);
    expect(native.engine.load).toHaveBeenCalledWith({
      attempt: 3,
      url: 'http://sim/live/demo/demo/1001.ts',
      headers: { 'User-Agent': 'ua' },
      kind: 'live',
      startMs: 5_000,
      softwareAudio: true,
    });
    expect(native.engine.retry).toHaveBeenCalledWith(4);
    expect(native.engine.play).toHaveBeenCalledWith(4);
    expect(native.engine.pause).toHaveBeenCalledWith(4);
    expect(native.engine.seek).toHaveBeenCalledWith(5, 12_000);
    expect(native.engine.stop).toHaveBeenCalledWith(6);
    expect(native.engine.recreate).toHaveBeenCalledWith(7);
  });

  it('sends no optional load fields the command does not have', async () => {
    const native = fakeNative();
    const engine = await create();
    engine?.load({ attempt: 1, url: 'http://sim/movie/demo/demo/5.mp4', headers: {}, kind: 'vod' });
    expect(native.engine.load).toHaveBeenCalledWith({
      attempt: 1,
      url: 'http://sim/movie/demo/demo/5.mp4',
      headers: {},
      kind: 'vod',
    });
  });

  it('maps native event times to the JS clock through uptimeMs()', async () => {
    const native = fakeNative();
    vi.spyOn(performance, 'now').mockReturnValue(50_000);
    const engine = await create();
    const events: EngineEvent[] = [];
    engine?.subscribe((event) => events.push(event));
    native.clock.uptime = 9_000;
    native.emit({ attempt: 2, type: 'firstFrame', atMs: 8_960 });
    native.emit({ attempt: 2, type: 'stall', phase: 'start', atMs: 8_900 });
    native.emit({
      attempt: 2,
      type: 'clock',
      anchor: { positionMs: 1_500, atMs: 8_750, rate: 1, durationMs: 60_000 },
    });
    expect(events).toEqual([
      { attempt: 2, type: 'firstFrame', atMs: 49_960 },
      { attempt: 2, type: 'stall', phase: 'start', atMs: 49_900 },
      {
        attempt: 2,
        type: 'clock',
        anchor: { positionMs: 1_500, atMs: 49_750, rate: 1, durationMs: 60_000 },
      },
    ]);
  });

  it('never maps a native time into the future', async () => {
    const native = fakeNative();
    vi.spyOn(performance, 'now').mockReturnValue(1_000);
    const engine = await create();
    const events: EngineEvent[] = [];
    engine?.subscribe((event) => events.push(event));
    native.clock.uptime = 500;
    native.emit({ attempt: 1, type: 'firstFrame', atMs: 505 });
    expect(events).toEqual([{ attempt: 1, type: 'firstFrame', atMs: 1_000 }]);
  });

  it('passes state, error and surface events on unchanged without reading the clock', async () => {
    const native = fakeNative();
    const engine = await create();
    const events: EngineEvent[] = [];
    engine?.subscribe((event) => events.push(event));
    const unchanged = [
      { attempt: 1, type: 'state', state: 'playing' },
      { attempt: 1, type: 'error', error: { code: 'http-509', httpStatus: 509, detail: 'x' } },
      { attempt: 1, type: 'surface', change: 'destroyed' },
    ];
    for (const event of unchanged) native.emit(event);
    expect(events).toEqual(unchanged);
    expect(native.uptimeMs).not.toHaveBeenCalled();
  });

  it('delivers to every subscriber until it unsubscribes', async () => {
    const native = fakeNative();
    const engine = await create();
    const first: EngineEvent[] = [];
    const second: EngineEvent[] = [];
    const unsubscribe = engine?.subscribe((event) => first.push(event));
    engine?.subscribe((event) => second.push(event));
    native.emit({ attempt: 1, type: 'state', state: 'opening' });
    unsubscribe?.();
    unsubscribe?.();
    native.emit({ attempt: 1, type: 'state', state: 'buffering' });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
  });

  it('release frees the native engine once and turns later calls into no-ops', async () => {
    const native = fakeNative();
    const engine = await create();
    const events: EngineEvent[] = [];
    engine?.subscribe((event) => events.push(event));
    engine?.release();
    engine?.release();
    engine?.play(1);
    engine?.load({ attempt: 2, url: 'http://sim/live/demo/demo/1.ts', headers: {}, kind: 'live' });
    engine?.subscribe((event) => events.push(event))();
    native.emit({ attempt: 1, type: 'state', state: 'playing' });
    expect(native.engine.release).toHaveBeenCalledTimes(1);
    expect(native.remove).toHaveBeenCalledTimes(1);
    expect(native.engine.play).not.toHaveBeenCalled();
    expect(native.engine.load).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});
