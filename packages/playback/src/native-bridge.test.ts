import { describe, expect, it, vi } from 'vitest';
import type { EngineCapabilities, EngineEvent } from './engine';
import { bridgeNativeEngine, type NativeEngineHandle } from './native-bridge';

const CAPABILITIES: EngineCapabilities = Object.freeze({
  mpegTsOverHttp: true,
  hls: true,
  liveSeek: false,
  softwareAudioFallback: true,
  recreate: true,
  audioTrackSelection: false,
  subtitleTrackSelection: false,
});

function fakeHandle() {
  const clock = { uptime: 0, now: 0 };
  const listeners = new Set<(event: EngineEvent) => void>();
  const remove = vi.fn();
  const handle: NativeEngineHandle = {
    load: vi.fn(),
    retry: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    stop: vi.fn(),
    recreate: vi.fn(),
    release: vi.fn(),
    addListener: vi.fn((_name: 'onEngineEvent', listener: (event: EngineEvent) => void) => {
      listeners.add(listener);
      return {
        remove: () => {
          remove();
          listeners.delete(listener);
        },
      };
    }),
  };
  const uptimeMs = vi.fn(() => clock.uptime);
  const now = vi.fn(() => clock.now);
  const emit = (event: EngineEvent) => {
    for (const listener of [...listeners]) listener(event);
  };
  const engine = bridgeNativeEngine(handle, { capabilities: CAPABILITIES, uptimeMs, now });
  return { clock, handle, uptimeMs, now, remove, emit, engine };
}

describe('bridgeNativeEngine', () => {
  it('exposes the given capabilities', () => {
    const { engine } = fakeHandle();
    expect(engine.capabilities).toBe(CAPABILITIES);
  });

  it('forwards every command with its token and flattens LoadCommand', () => {
    const { handle, engine } = fakeHandle();
    engine.load({
      attempt: 3,
      url: 'http://sim/live/demo/demo/1001.ts',
      headers: { 'User-Agent': 'ua' },
      kind: 'live',
      startMs: 5_000,
      options: { softwareAudio: true },
    });
    engine.retry(4);
    engine.play(4);
    engine.pause(4);
    engine.seek(5, 12_000);
    engine.stop(6);
    engine.recreate(7);
    expect(handle.load).toHaveBeenCalledWith({
      attempt: 3,
      url: 'http://sim/live/demo/demo/1001.ts',
      headers: { 'User-Agent': 'ua' },
      kind: 'live',
      startMs: 5_000,
      softwareAudio: true,
    });
    expect(handle.retry).toHaveBeenCalledWith(4);
    expect(handle.play).toHaveBeenCalledWith(4);
    expect(handle.pause).toHaveBeenCalledWith(4);
    expect(handle.seek).toHaveBeenCalledWith(5, 12_000);
    expect(handle.stop).toHaveBeenCalledWith(6);
    expect(handle.recreate).toHaveBeenCalledWith(7);
  });

  it('sends no optional load fields the command does not have', () => {
    const { handle, engine } = fakeHandle();
    engine.load({ attempt: 1, url: 'http://sim/movie/demo/demo/5.mp4', headers: {}, kind: 'vod' });
    expect(handle.load).toHaveBeenCalledWith({
      attempt: 1,
      url: 'http://sim/movie/demo/demo/5.mp4',
      headers: {},
      kind: 'vod',
    });
  });

  it('maps native event times to now() through uptimeMs()', () => {
    const { clock, emit, engine } = fakeHandle();
    clock.now = 50_000;
    clock.uptime = 9_000;
    const events: EngineEvent[] = [];
    engine.subscribe((event) => events.push(event));
    emit({ attempt: 2, type: 'firstFrame', atMs: 8_960 });
    emit({ attempt: 2, type: 'stall', phase: 'start', atMs: 8_900 });
    emit({
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

  it('never places a stamp after the moment of receipt', () => {
    const { clock, emit, engine } = fakeHandle();
    clock.uptime = 10_000;
    clock.now = 500;
    const events: EngineEvent[] = [];
    engine.subscribe((event) => events.push(event));
    emit({ attempt: 1, type: 'firstFrame', atMs: 10_050 });
    expect(events).toEqual([{ attempt: 1, type: 'firstFrame', atMs: 500 }]);
  });

  it('passes state, error and surface events on unchanged without reading clocks', () => {
    const { uptimeMs, now, emit, engine } = fakeHandle();
    const events: EngineEvent[] = [];
    engine.subscribe((event) => events.push(event));
    const unchanged: EngineEvent[] = [
      { attempt: 1, type: 'state', state: 'playing' },
      { attempt: 1, type: 'error', error: { code: 'http-509', httpStatus: 509, detail: 'x' } },
      { attempt: 1, type: 'surface', change: 'destroyed' },
    ];
    for (const event of unchanged) emit(event);
    expect(events).toEqual(unchanged);
    expect(uptimeMs).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });

  it('delivers a listener snapshot to every subscriber until it unsubscribes', () => {
    const { emit, engine } = fakeHandle();
    const first: EngineEvent[] = [];
    const second: EngineEvent[] = [];
    const unsubscribe = engine.subscribe((event) => first.push(event));
    engine.subscribe((event) => second.push(event));
    emit({ attempt: 1, type: 'state', state: 'opening' });
    unsubscribe();
    unsubscribe();
    emit({ attempt: 1, type: 'state', state: 'buffering' });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
  });

  it('ignores native events while nobody subscribes', () => {
    const { uptimeMs, emit } = fakeHandle();
    emit({ attempt: 1, type: 'firstFrame', atMs: 100 });
    expect(uptimeMs).not.toHaveBeenCalled();
  });

  it('release frees the native engine once and turns later calls into no-ops', () => {
    const { handle, remove, emit, engine } = fakeHandle();
    const events: EngineEvent[] = [];
    engine.subscribe((event) => events.push(event));
    engine.release();
    engine.release();
    engine.play(1);
    engine.load({ attempt: 2, url: 'http://sim/live/demo/demo/1.ts', headers: {}, kind: 'live' });
    engine.subscribe((event) => events.push(event))();
    emit({ attempt: 1, type: 'state', state: 'playing' });
    expect(handle.release).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(handle.play).not.toHaveBeenCalled();
    expect(handle.load).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});
