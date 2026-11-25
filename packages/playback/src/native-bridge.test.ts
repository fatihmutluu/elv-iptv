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
    setScrubbing: vi.fn(),
    setSpeed: vi.fn(),
    selectAudioTrack: vi.fn(),
    selectSubtitleTrack: vi.fn(),
    selectSecondarySubtitleTrack: vi.fn(),
    setAudioDelay: vi.fn(),
    setSubtitleDelay: vi.fn(),
    selectVideoQuality: vi.fn(),
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
      options: {
        softwareAudio: true,
        preferHevcOverDolbyVision: true,
        allowLegacyTls: true,
        bufferPreset: 'large',
        decoderMode: 'hardware',
        audioTrackId: '1:0',
        subtitleTrackId: null,
      },
    });
    engine.retry(4);
    engine.play(4);
    engine.pause(4);
    engine.seek(5, 12_000);
    engine.setScrubbing?.(5, true);
    engine.setScrubbing?.(5, false);
    engine.setSpeed?.(5, 1.5);
    engine.selectAudioTrack?.(5, '1:1');
    engine.selectSubtitleTrack?.(5, '2:0');
    engine.selectSubtitleTrack?.(6, null);
    engine.stop(6);
    engine.recreate(7);
    expect(handle.load).toHaveBeenCalledWith({
      attempt: 3,
      url: 'http://sim/live/demo/demo/1001.ts',
      headers: { 'User-Agent': 'ua' },
      kind: 'live',
      startMs: 5_000,
      softwareAudio: true,
      preferHevcOverDolbyVision: true,
      allowLegacyTls: true,
      bufferPreset: 'large',
      decoderMode: 'hardware',
      audioTrackId: '1:0',
      subtitleTrackId: null,
    });
    expect(handle.retry).toHaveBeenCalledWith(4);
    expect(handle.play).toHaveBeenCalledWith(4);
    expect(handle.pause).toHaveBeenCalledWith(4);
    expect(handle.seek).toHaveBeenCalledWith(5, 12_000);
    expect(handle.setScrubbing).toHaveBeenNthCalledWith(1, 5, true);
    expect(handle.setScrubbing).toHaveBeenNthCalledWith(2, 5, false);
    expect(handle.setSpeed).toHaveBeenCalledWith(5, 1.5);
    expect(handle.selectAudioTrack).toHaveBeenCalledWith(5, '1:1');
    expect(handle.selectSubtitleTrack).toHaveBeenNthCalledWith(1, 5, '2:0');
    expect(handle.selectSubtitleTrack).toHaveBeenNthCalledWith(2, 6, null);
    expect(handle.stop).toHaveBeenCalledWith(6);
    expect(handle.recreate).toHaveBeenCalledWith(7);
  });

  it('omits track selection, speed, and setScrubbing methods when absent on the native handle', () => {
    const {
      setSpeed: _sp,
      selectAudioTrack: _a,
      selectSubtitleTrack: _s,
      selectSecondarySubtitleTrack: _ss,
      setAudioDelay: _ad,
      setSubtitleDelay: _sd,
      selectVideoQuality: _vq,
      setScrubbing: _sc,
      ...minimal
    } = fakeHandle().handle;
    const engine = bridgeNativeEngine(minimal, {
      capabilities: CAPABILITIES,
      uptimeMs: () => 0,
      now: () => 0,
    });
    expect(engine.setSpeed).toBeUndefined();
    expect(engine.selectAudioTrack).toBeUndefined();
    expect(engine.selectSubtitleTrack).toBeUndefined();
    expect(engine.selectSecondarySubtitleTrack).toBeUndefined();
    expect(engine.setAudioDelay).toBeUndefined();
    expect(engine.setSubtitleDelay).toBeUndefined();
    expect(engine.selectVideoQuality).toBeUndefined();
    expect(engine.setScrubbing).toBeUndefined();
  });

  it('forwards setScrubbing with activeAttempt without disturbing attempt matching (#222)', () => {
    const { handle, emit, engine } = fakeHandle();
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));

    engine.load({ attempt: 3, url: 'http://sim/movie/1.mp4', headers: {}, kind: 'vod' });
    engine.setScrubbing?.(99, true);
    emit({ attempt: 3, type: 'state', state: 'playing' });
    engine.setScrubbing?.(3, false);

    expect(handle.setScrubbing).toHaveBeenNthCalledWith(1, 3, true);
    expect(handle.setScrubbing).toHaveBeenNthCalledWith(2, 3, false);
    expect(events).toEqual([{ attempt: 3, type: 'state', state: 'playing' }]);

    engine.release();
    engine.setScrubbing?.(3, true);
    expect(handle.setScrubbing).toHaveBeenCalledTimes(2);
  });

  it('adopts the attempt token on setSpeed and turns post-release calls into no-ops (#442)', () => {
    const { handle, emit, engine } = fakeHandle();
    const received: EngineEvent[] = [];
    engine.subscribe((event) => received.push(event));

    engine.load({ attempt: 1, url: 'http://sim/movie/a/a/1.mp4', headers: {}, kind: 'vod' });
    engine.setSpeed?.(2, 1.75);
    emit({ attempt: 1, type: 'state', state: 'playing' });
    emit({ attempt: 2, type: 'clock', anchor: { positionMs: 500, atMs: 0, rate: 1.75 } });

    expect(handle.setSpeed).toHaveBeenCalledWith(2, 1.75);
    expect(received).toEqual([
      { attempt: 2, type: 'clock', anchor: { positionMs: 500, atMs: 0, rate: 1.75 } },
    ]);

    engine.release();
    engine.setSpeed?.(3, 2);
    expect(handle.setSpeed).toHaveBeenCalledTimes(1);
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
    emit({ attempt: 2, type: 'progress', bytesReceived: 4096, atMs: 8_850 });
    emit({
      attempt: 2,
      type: 'clock',
      anchor: { positionMs: 1_500, atMs: 8_750, rate: 1, durationMs: 60_000 },
    });
    expect(events).toEqual([
      { attempt: 2, type: 'firstFrame', atMs: 49_960 },
      { attempt: 2, type: 'stall', phase: 'start', atMs: 49_900 },
      { attempt: 2, type: 'progress', bytesReceived: 4096, atMs: 49_850 },
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
      { attempt: 1, type: 'externalPlayback', active: true },
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

  it('isolates subscriber exceptions so throwing listeners never block peers (#224)', () => {
    const { emit, engine } = fakeHandle();
    const received: EngineEvent[] = [];
    engine.subscribe(() => {
      throw new Error('listener boom');
    });
    engine.subscribe((event) => received.push(event));
    expect(() => emit({ attempt: 1, type: 'state', state: 'playing' })).not.toThrow();
    expect(received).toEqual([{ attempt: 1, type: 'state', state: 'playing' }]);
  });

  it('drops stale in-flight native media events after a newer load, pause, or stop while preserving surface events', () => {
    const { emit, engine } = fakeHandle();
    const received: EngineEvent[] = [];
    engine.subscribe((event) => received.push(event));

    engine.load({ attempt: 1, url: 'http://sim/live/a/a/1.ts', headers: {}, kind: 'live' });
    engine.load({ attempt: 2, url: 'http://sim/live/a/a/2.ts', headers: {}, kind: 'live' });
    emit({ attempt: 1, type: 'state', state: 'opening' });
    emit({ attempt: 1, type: 'surface', change: 'created' });
    emit({ attempt: 2, type: 'state', state: 'opening' });

    engine.pause(3);
    emit({ attempt: 2, type: 'clock', anchor: { positionMs: 100, atMs: 10, rate: 1 } });
    emit({ attempt: 3, type: 'state', state: 'paused' });

    engine.stop(4);
    emit({ attempt: 3, type: 'clock', anchor: { positionMs: 200, atMs: 20, rate: 0 } });
    emit({ attempt: 4, type: 'state', state: 'paused' });
    emit({ attempt: 4, type: 'surface', change: 'destroyed' });

    engine.load({ attempt: 5, url: 'http://sim/live/a/a/3.ts', headers: {}, kind: 'live' });
    emit({ attempt: 4, type: 'state', state: 'opening' });
    emit({ attempt: 5, type: 'state', state: 'opening' });

    expect(received).toEqual([
      { attempt: 1, type: 'surface', change: 'created' },
      { attempt: 2, type: 'state', state: 'opening' },
      { attempt: 3, type: 'state', state: 'paused' },
      { attempt: 4, type: 'surface', change: 'destroyed' },
      { attempt: 5, type: 'state', state: 'opening' },
    ]);
  });

  it('forwards delay, video quality, and secondary subtitle commands and normalizes tracks payloads (#59, #239)', () => {
    const { handle, emit, engine } = fakeHandle();
    const received: EngineEvent[] = [];
    engine.subscribe((event) => received.push(event));

    engine.load({ attempt: 1, url: 'http://sim/live/a/a/1.m3u8', headers: {}, kind: 'live' });
    engine.setAudioDelay?.(1, 250);
    engine.setSubtitleDelay?.(1, -150);
    engine.selectVideoQuality?.(1, 'v:1080');
    engine.selectVideoQuality?.(1, null);
    engine.selectSecondarySubtitleTrack?.(1, 's:2');
    engine.selectSecondarySubtitleTrack?.(1, null);

    expect(handle.setAudioDelay).toHaveBeenCalledWith(1, 250);
    expect(handle.setSubtitleDelay).toHaveBeenCalledWith(1, -150);
    expect(handle.selectVideoQuality).toHaveBeenNthCalledWith(1, 1, 'v:1080');
    expect(handle.selectVideoQuality).toHaveBeenNthCalledWith(2, 1, null);
    expect(handle.selectSecondarySubtitleTrack).toHaveBeenNthCalledWith(1, 1, 's:2');
    expect(handle.selectSecondarySubtitleTrack).toHaveBeenNthCalledWith(2, 1, null);

    emit({
      attempt: 1,
      type: 'tracks',
      tracks: {
        audio: [{ id: 'a:1', language: 'en' }],
        subtitles: [{ id: 's:1', language: 'en' }],
        selectedAudioId: 'a:1',
        selectedSubtitleId: 's:1',
        selectedSecondarySubtitleId: '   ',
        selectedVideoQualityId: '',
        videoQualities: [
          {
            id: 'v:1080',
            label: '1080p',
            width: 1920,
            height: 1080,
            bitrateBps: 5_000_000,
            fps: 50,
          },
          { id: '', label: 'invalid' },
          { id: 'v:720', label: '720p', width: -1, height: Number.NaN, bitrateBps: 0, fps: 30 },
        ],
      },
    });

    expect(received).toEqual([
      {
        attempt: 1,
        type: 'tracks',
        tracks: {
          audio: [{ id: 'a:1', language: 'en' }],
          subtitles: [{ id: 's:1', language: 'en' }],
          selectedAudioId: 'a:1',
          selectedSubtitleId: 's:1',
          selectedSecondarySubtitleId: null,
          selectedVideoQualityId: null,
          videoQualities: [
            {
              id: 'v:1080',
              label: '1080p',
              width: 1920,
              height: 1080,
              bitrateBps: 5_000_000,
              fps: 50,
            },
            { id: 'v:720', label: '720p', fps: 30 },
          ],
        },
      },
    ]);
  });

  it('sanitizes incoming clock anchor bufferHealth and drops invalid or NaN fields (#350)', () => {
    const { clock, emit, engine } = fakeHandle();
    clock.now = 20_000;
    clock.uptime = 5_000;
    const received: EngineEvent[] = [];
    engine.subscribe((event) => received.push(event));

    engine.load({ attempt: 1, url: 'http://sim/movie/1.mp4', headers: {}, kind: 'vod' });

    // Valid complete payload
    emit({
      attempt: 1,
      type: 'clock',
      anchor: {
        positionMs: 10_000,
        atMs: 4_900,
        rate: 1,
        durationMs: 120_000,
        bufferHealth: {
          bufferedAheadMs: 45_000,
          bufferedBehindMs: 12_000,
          diskCacheBytes: 16_777_216,
          throttled: true,
        },
      },
    });

    // Valid required fields with invalid optional fields -> drops optional fields cleanly
    emit({
      attempt: 1,
      type: 'clock',
      anchor: {
        positionMs: 11_000,
        atMs: 4_950,
        rate: 1,
        bufferHealth: {
          bufferedAheadMs: 0,
          bufferedBehindMs: 5_000,
          diskCacheBytes: -50,
          throttled: 'yes' as unknown as boolean,
        },
      },
    });

    // Invalid required fields (NaN / negative) -> drops bufferHealth entirely
    emit({
      attempt: 1,
      type: 'clock',
      anchor: {
        positionMs: 12_000,
        atMs: 5_000,
        rate: 1,
        bufferHealth: {
          bufferedAheadMs: Number.NaN,
          bufferedBehindMs: 5_000,
        },
      },
    });
    emit({
      attempt: 1,
      type: 'clock',
      anchor: {
        positionMs: 13_000,
        atMs: 5_000,
        rate: 1,
        bufferHealth: {
          bufferedAheadMs: 10_000,
          bufferedBehindMs: -1,
        },
      },
    });

    expect(received).toEqual([
      {
        attempt: 1,
        type: 'clock',
        anchor: {
          positionMs: 10_000,
          atMs: 19_900,
          rate: 1,
          durationMs: 120_000,
          bufferHealth: {
            bufferedAheadMs: 45_000,
            bufferedBehindMs: 12_000,
            diskCacheBytes: 16_777_216,
            throttled: true,
          },
        },
      },
      {
        attempt: 1,
        type: 'clock',
        anchor: {
          positionMs: 11_000,
          atMs: 19_950,
          rate: 1,
          bufferHealth: {
            bufferedAheadMs: 0,
            bufferedBehindMs: 5_000,
          },
        },
      },
      {
        attempt: 1,
        type: 'clock',
        anchor: {
          positionMs: 12_000,
          atMs: 20_000,
          rate: 1,
        },
      },
      {
        attempt: 1,
        type: 'clock',
        anchor: {
          positionMs: 13_000,
          atMs: 20_000,
          rate: 1,
        },
      },
    ]);
  });
});
