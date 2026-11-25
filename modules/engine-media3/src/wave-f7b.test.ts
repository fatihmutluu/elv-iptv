import type { EngineEvent } from '@elv/playback';
import { afterEach, describe, expect, it, vi } from 'vitest';

const requireOptionalNativeModule = vi.fn();
const requireNativeViewManager = vi.fn();
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule, requireNativeViewManager }));

async function load() {
  vi.resetModules();
  return import('./index');
}

function fakeWaveF7BNative() {
  let listener: ((event: EngineEvent) => void) | null = null;
  const engine = {
    load: vi.fn(),
    retry: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    stop: vi.fn(),
    recreate: vi.fn(),
    release: vi.fn(),
    selectProgram: vi.fn(),
    addListener: vi.fn((name: string, fn: (event: EngineEvent) => void) => {
      if (name === 'onEngineEvent') listener = fn;
      return { remove: vi.fn() };
    }),
  };
  const Engine = vi.fn(function construct() {
    return engine;
  });
  const uptimeMs = vi.fn(() => 0);
  const launchExternalPlayer = vi.fn();
  requireOptionalNativeModule.mockReturnValue({
    Engine,
    uptimeMs,
    launchExternalPlayer,
  });
  return {
    engine,
    Engine,
    launchExternalPlayer,
    emit: (event: EngineEvent) => listener?.(event),
  };
}

afterEach(() => {
  requireOptionalNativeModule.mockReset();
  requireNativeViewManager.mockReset();
  vi.restoreAllMocks();
});

describe('Wave F7B Media3 bindings (#304, #406)', () => {
  it('exposes programSelection capability, forwards selectProgram and load programId, and preserves tracks.programs (#304)', async () => {
    const native = fakeWaveF7BNative();
    const mod = await load();
    const engine = mod.createMedia3Engine();
    if (engine === null) throw new Error('engine expected');

    expect(engine.capabilities.programSelection).toBe(true);

    const events: EngineEvent[] = [];
    engine.subscribe((event) => events.push(event));

    engine.load({
      attempt: 1,
      url: 'https://cdn.example.test/live/mpts.ts',
      headers: {},
      kind: 'live',
      options: { programId: '102' },
    });

    expect(native.engine.load).toHaveBeenCalledWith({
      attempt: 1,
      url: 'https://cdn.example.test/live/mpts.ts',
      headers: {},
      kind: 'live',
      programId: '102',
    });

    engine.selectProgram?.(2, '101');
    expect(native.engine.selectProgram).toHaveBeenCalledWith(2, '101');

    native.emit({
      attempt: 2,
      type: 'tracks',
      tracks: {
        audio: [
          { id: '1:0', language: 'en', programId: '101' },
          { id: '2:0', language: 'tr', programId: '102' },
        ],
        subtitles: [],
        selectedAudioId: '1:0',
        selectedSubtitleId: null,
        programs: [
          { id: '101', label: 'Program 101', programNumber: 101 },
          { id: '102', label: 'Program 102', programNumber: 102 },
        ],
        selectedProgramId: '101',
      },
    });

    expect(events).toHaveLength(1);
    const tracksEvent = events[0];
    if (tracksEvent?.type !== 'tracks') throw new Error('tracks event expected');
    expect(tracksEvent.tracks.programs).toEqual([
      { id: '101', label: 'Program 101', programNumber: 101 },
      { id: '102', label: 'Program 102', programNumber: 102 },
    ]);
    expect(tracksEvent.tracks.selectedProgramId).toBe('101');

    engine.release();
    engine.selectProgram?.(3, '102');
    expect(native.engine.selectProgram).toHaveBeenCalledTimes(1);
  });

  it('launches external video player with sanitized inputs and normalizes returned playback position (#406)', async () => {
    const native = fakeWaveF7BNative();
    const mod = await load();

    expect(mod.isExternalPlayerSupported()).toBe(true);

    native.launchExternalPlayer.mockResolvedValueOnce({
      launched: true,
      positionMs: 125_000,
      durationMs: 300_000,
      completed: false,
    });

    const result = await mod.launchExternalPlayer({
      url: 'https://cdn.example.test/vod/movie.mkv',
      mimeType: 'video/x-matroska',
      title: 'Test Movie',
      startPositionMs: 42_500.7,
      headers: {
        'User-Agent': 'ELV/1.0',
        'Bad\r\nKey': 'drop',
      },
      chooserTitle: 'Open with',
    });

    expect(native.launchExternalPlayer).toHaveBeenCalledWith({
      url: 'https://cdn.example.test/vod/movie.mkv',
      mimeType: 'video/x-matroska',
      title: 'Test Movie',
      startPositionMs: 42_501,
      headers: { 'User-Agent': 'ELV/1.0' },
      chooserTitle: 'Open with',
    });
    expect(result).toEqual({
      launched: true,
      positionMs: 125_000,
      durationMs: 300_000,
      completed: false,
    });

    // Clamps positionMs > durationMs and treats negative/non-positive values safely
    native.launchExternalPlayer.mockResolvedValueOnce({
      launched: true,
      positionMs: 999_999,
      durationMs: 120_000,
      completed: true,
    });
    expect(
      await mod.launchExternalPlayer({
        url: 'https://cdn.example.test/vod/movie.mkv',
      }),
    ).toEqual({
      launched: true,
      positionMs: 120_000,
      durationMs: 120_000,
      completed: true,
    });

    native.launchExternalPlayer.mockResolvedValueOnce({
      launched: true,
      positionMs: -1,
      durationMs: 0,
      completed: false,
    });
    expect(
      await mod.launchExternalPlayer({
        url: 'https://cdn.example.test/vod/movie.mkv',
      }),
    ).toEqual({
      launched: true,
      positionMs: null,
      durationMs: null,
      completed: false,
    });

    // Rejects disallowed URL schemes without invoking native module
    expect(
      await mod.launchExternalPlayer({
        url: 'file:///etc/passwd',
      }),
    ).toBeNull();
    expect(
      await mod.launchExternalPlayer({
        url: 'javascript:alert(1)',
      }),
    ).toBeNull();
    expect(native.launchExternalPlayer).toHaveBeenCalledTimes(3);
  });

  it('returns false and null cleanly when native module or launchExternalPlayer is absent (#406)', async () => {
    requireOptionalNativeModule.mockReturnValue(null);
    const absent = await load();
    expect(absent.isExternalPlayerSupported()).toBe(false);
    expect(
      await absent.launchExternalPlayer({
        url: 'https://cdn.example.test/vod/movie.mp4',
      }),
    ).toBeNull();

    requireOptionalNativeModule.mockReturnValue({
      Engine: vi.fn(),
      uptimeMs: vi.fn(() => 0),
    });
    const withoutLauncher = await load();
    expect(withoutLauncher.isExternalPlayerSupported()).toBe(false);
    expect(
      await withoutLauncher.launchExternalPlayer({
        url: 'https://cdn.example.test/vod/movie.mp4',
      }),
    ).toBeNull();
  });
});
