import { DEFAULT_PREFERENCES } from '@elv/domain';
import type { LoadCommand, PlayerEngine } from '@elv/playback';
import { describe, expect, it, vi } from 'vitest';
import type { OpenVideoEngine } from '../ports/video-host';
import {
  applyDesktopAudioOutputToEngine,
  applyDisplaySyncToEngine,
  applyNightModeDrcToEngine,
  buildWaveF7aLoadOptions,
  resolveTargetEffectiveAudioDelay,
  wrapEngineWithWaveF7aLoadOptions,
} from './usePlayerDisplayAndAudioSync';

function makeMinimalEngine(overrides: Partial<PlayerEngine> = {}): {
  engine: PlayerEngine;
  loads: LoadCommand[];
} {
  const loads: LoadCommand[] = [];
  const engine: PlayerEngine = {
    capabilities: {
      mpegTsOverHttp: true,
      hls: true,
      liveSeek: false,
      softwareAudioFallback: false,
      recreate: true,
      audioTrackSelection: true,
      subtitleTrackSelection: true,
      audioDelay: true,
    },
    load(cmd) {
      loads.push(cmd);
    },
    retry() {},
    play() {},
    pause() {},
    seek() {},
    stop() {},
    recreate() {},
    release() {},
    subscribe() {
      return () => undefined;
    },
    ...overrides,
  };
  return { engine, loads };
}

describe('usePlayerDisplayAndAudioSync pure helpers (#115, #116, #188, #199, #213, #214)', () => {
  it('builds normalized Wave F7A LoadOptions with defaults and deduplicated codecs', () => {
    const defaults = buildWaveF7aLoadOptions({});
    expect(defaults).toEqual({
      displaySync: {
        autoFrameRate: DEFAULT_PREFERENCES.autoFrameRate,
        autoDynamicRange: DEFAULT_PREFERENCES.autoDynamicRange,
      },
      nightModeDrc: DEFAULT_PREFERENCES.nightModeDrc,
      desktopAudioOutput: {
        passthrough: false,
        codecs: ['ac3', 'eac3', 'dts'],
        exclusive: false,
        ac3Encode: false,
        channelLayout: 'auto',
      },
    });

    const custom = buildWaveF7aLoadOptions({
      autoFrameRate: 'always',
      autoDynamicRange: false,
      nightModeDrc: 'night',
      audioPassthrough: true,
      audioPassthroughCodecs: ['dts', 'truehd', 'dts'],
      audioExclusive: true,
      audioAc3Encode: true,
      audioChannelLayout: '7.1',
    });
    expect(custom).toEqual({
      displaySync: { autoFrameRate: 'always', autoDynamicRange: false },
      nightModeDrc: 'night',
      desktopAudioOutput: {
        passthrough: true,
        codecs: ['dts', 'truehd'],
        exclusive: true,
        ac3Encode: true,
        channelLayout: '7.1',
      },
    });
  });

  it('wraps PlayerEngine.load to inject Wave F7A LoadOptions while preserving explicit overrides and capabilities', () => {
    const { engine, loads } = makeMinimalEngine();
    let current = buildWaveF7aLoadOptions({
      autoFrameRate: 'always',
      autoDynamicRange: true,
      nightModeDrc: 'light',
      audioPassthrough: true,
      audioPassthroughCodecs: ['ac3', 'truehd'],
      audioExclusive: true,
      audioAc3Encode: false,
      audioChannelLayout: '5.1',
    });

    const wrapped = wrapEngineWithWaveF7aLoadOptions(engine, () => current);
    expect(wrapped.capabilities).toBe(engine.capabilities);
    expect(wrapped.setAudioDelay).toBeUndefined();

    wrapped.load({
      attempt: 1,
      url: 'http://example.invalid/stream.ts',
      headers: {},
      kind: 'live',
      options: { bufferPreset: 'large' },
    });

    expect(loads).toHaveLength(1);
    expect(loads[0]?.options).toEqual({
      bufferPreset: 'large',
      displaySync: { autoFrameRate: 'always', autoDynamicRange: true },
      nightModeDrc: 'light',
      desktopAudioOutput: {
        passthrough: true,
        codecs: ['ac3', 'truehd'],
        exclusive: true,
        ac3Encode: false,
        channelLayout: '5.1',
      },
    });

    // Explicit command options take precedence and subsequent updates reflect live ref changes
    current = buildWaveF7aLoadOptions({ nightModeDrc: 'night' });
    wrapped.load({
      attempt: 2,
      url: 'http://example.invalid/stream2.ts',
      headers: {},
      kind: 'vod',
      options: { nightModeDrc: 'off' },
    });
    expect(loads[1]?.options?.nightModeDrc).toBe('off');
    expect(loads[1]?.options?.displaySync).toEqual({
      autoFrameRate: 'seamless',
      autoDynamicRange: true,
    });
  });

  it('forwards live displaySync, nightModeDrc, and desktopAudioOutput to OpenVideoEngine or fallback PlayerEngine', () => {
    const engineDisplaySync = vi.fn();
    const engineDrc = vi.fn();
    const engineDesktopAudio = vi.fn();
    const { engine } = makeMinimalEngine({
      setDisplaySync: engineDisplaySync,
      setNightModeDrc: engineDrc,
      setDesktopAudioOutput: engineDesktopAudio,
    });

    const hostDisplaySync = vi.fn();
    const hostDrc = vi.fn();
    const hostDesktopAudio = vi.fn();
    const openedWithHost: OpenVideoEngine = {
      engine,
      renderSurface: () => null,
      setDisplaySync: hostDisplaySync,
      setNightModeDrc: hostDrc,
      setDesktopAudioOutput: hostDesktopAudio,
    };

    const opts = buildWaveF7aLoadOptions({
      autoFrameRate: 'always',
      autoDynamicRange: false,
      nightModeDrc: 'night',
      audioPassthrough: true,
    });
    applyDisplaySyncToEngine(openedWithHost, opts.displaySync);
    applyNightModeDrcToEngine(openedWithHost, opts.nightModeDrc);
    applyDesktopAudioOutputToEngine(openedWithHost, opts.desktopAudioOutput);

    expect(hostDisplaySync).toHaveBeenCalledWith(opts.displaySync);
    expect(hostDrc).toHaveBeenCalledWith('night');
    expect(hostDesktopAudio).toHaveBeenCalledWith(opts.desktopAudioOutput);
    expect(engineDisplaySync).not.toHaveBeenCalled();
    expect(engineDrc).not.toHaveBeenCalled();
    expect(engineDesktopAudio).not.toHaveBeenCalled();

    const openedFallback: OpenVideoEngine = {
      engine,
      renderSurface: () => null,
    };
    applyDisplaySyncToEngine(openedFallback, opts.displaySync);
    applyNightModeDrcToEngine(openedFallback, opts.nightModeDrc);
    applyDesktopAudioOutputToEngine(openedFallback, opts.desktopAudioOutput);

    expect(engineDisplaySync).toHaveBeenCalledWith(opts.displaySync);
    expect(engineDrc).toHaveBeenCalledWith('night');
    expect(engineDesktopAudio).toHaveBeenCalledWith(opts.desktopAudioOutput);
  });

  it('resolves per-refresh-rate effective A/V delay without clobbering manual baseline or repeating no-ops', () => {
    const map = { '23.976': -75, '50': 50 } as const;

    // Already matching -> null (no-op)
    expect(
      resolveTargetEffectiveAudioDelay({
        manualAudioDelayMs: 0,
        fps: 60,
        audioDelayByRefreshRateMs: map,
        currentServiceDelayMs: 0,
      }),
    ).toBeNull();

    // 23.976 fps applies -75 ms offset on top of 0 manual baseline
    expect(
      resolveTargetEffectiveAudioDelay({
        manualAudioDelayMs: 0,
        fps: 23.975,
        audioDelayByRefreshRateMs: map,
        currentServiceDelayMs: 0,
      }),
    ).toBe(-75);

    // Same effective delay already applied -> null (no feedback loop!)
    expect(
      resolveTargetEffectiveAudioDelay({
        manualAudioDelayMs: 0,
        fps: 23.976,
        audioDelayByRefreshRateMs: map,
        currentServiceDelayMs: -75,
      }),
    ).toBeNull();

    // Manual baseline +100 combined with 23.976 (-75) -> +25 ms
    expect(
      resolveTargetEffectiveAudioDelay({
        manualAudioDelayMs: 100,
        fps: 23.976,
        audioDelayByRefreshRateMs: map,
        currentServiceDelayMs: -75,
      }),
    ).toBe(25);

    // FPS changes to 50 (+50) -> manual +100 + 50 = +150 ms
    expect(
      resolveTargetEffectiveAudioDelay({
        manualAudioDelayMs: 100,
        fps: 50,
        audioDelayByRefreshRateMs: map,
        currentServiceDelayMs: 25,
      }),
    ).toBe(150);

    // FPS changes to unmapped 60 -> returns to manual baseline (+100 ms)
    expect(
      resolveTargetEffectiveAudioDelay({
        manualAudioDelayMs: 100,
        fps: 60,
        audioDelayByRefreshRateMs: map,
        currentServiceDelayMs: 150,
      }),
    ).toBe(100);
  });
});
