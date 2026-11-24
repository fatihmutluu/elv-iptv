import type { EngineEvent, ExternalSubtitleTrack } from '@elv/playback';
import { afterEach, describe, expect, it, vi } from 'vitest';

const requireOptionalNativeModule = vi.fn();
const requireNativeViewManager = vi.fn();
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule, requireNativeViewManager }));

async function load() {
  vi.resetModules();
  return import('./index');
}

type NativeListener = (event: EngineEvent) => void;

function fakeSubtitleNative() {
  const listeners = new Set<NativeListener>();
  const engine = {
    load: vi.fn(),
    retry: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    selectAudioTrack: vi.fn(),
    selectSubtitleTrack: vi.fn(),
    selectSecondarySubtitleTrack: vi.fn(),
    addExternalSubtitle: vi.fn(),
    setSubtitleStyle: vi.fn(),
    stop: vi.fn(),
    recreate: vi.fn(),
    release: vi.fn(),
    addListener: vi.fn((name: string, listener: NativeListener) => {
      if (name === 'onEngineEvent') listeners.add(listener);
      return {
        remove: () => {
          listeners.delete(listener);
        },
      };
    }),
  };
  const Engine = vi.fn(function construct() {
    return engine;
  });
  requireOptionalNativeModule.mockReturnValue({
    Engine,
    uptimeMs: vi.fn(() => 1_000),
    engineVersion: vi.fn(() => '7.66.1'),
  });
  const emit = (event: EngineEvent) => {
    for (const listener of [...listeners]) listener(event);
  };
  return { engine, Engine, emit };
}

function SurfaceView() {
  return null;
}

afterEach(() => {
  requireOptionalNativeModule.mockReset();
  requireNativeViewManager.mockReset();
  vi.restoreAllMocks();
});

describe('AetherEngine Wave F4 subtitles suite (#285, #308, #32, #402)', () => {
  it('advertises externalSubtitles, subtitleStyling, and dualSubtitles capabilities', async () => {
    fakeSubtitleNative();
    const { createAetherEngine } = await load();
    const engine = createAetherEngine();
    expect(engine?.capabilities.externalSubtitles).toBe(true);
    expect(engine?.capabilities.subtitleStyling).toBe(true);
    expect(engine?.capabilities.dualSubtitles).toBe(true);
  });

  it('forwards externalSubtitles, secondarySubtitleTrackId, and subtitleStyle through load (#32, #308, #402)', async () => {
    const native = fakeSubtitleNative();
    const { createAetherEngine } = await load();
    const engine = createAetherEngine();
    if (engine === null) throw new Error('engine expected');

    const extTrack: ExternalSubtitleTrack = {
      id: 'ext:ar',
      uri: 'https://subs.example/ar.vtt',
      label: 'Arabic',
      language: 'ar',
      mimeType: 'text/vtt',
      headers: { 'X-Sub-Token': 'scoped-only' },
    };
    const style = {
      fontSize: 'large' as const,
      textColor: 'yellow' as const,
      backgroundColor: 'translucent' as const,
      edgeStyle: 'outline' as const,
      verticalPosition: 'raised' as const,
    };

    engine.load({
      attempt: 1,
      url: 'https://stream.example/movie.m3u8',
      headers: { Authorization: 'Bearer stream-secret' },
      kind: 'vod',
      options: {
        subtitleTrackId: 's:3',
        secondarySubtitleTrackId: 'ext:ar',
        externalSubtitles: [extTrack],
        subtitleStyle: style,
      },
    });

    expect(native.engine.load).toHaveBeenCalledWith({
      attempt: 1,
      url: 'https://stream.example/movie.m3u8',
      headers: { Authorization: 'Bearer stream-secret' },
      kind: 'vod',
      subtitleTrackId: 's:3',
      secondarySubtitleTrackId: 'ext:ar',
      externalSubtitles: [extTrack],
      subtitleStyle: style,
    });
  });

  it('forwards addExternalSubtitle, setSubtitleStyle, and selectSecondarySubtitleTrack until release', async () => {
    const native = fakeSubtitleNative();
    const { createAetherEngine } = await load();
    const engine = createAetherEngine();
    if (engine === null) throw new Error('engine expected');

    const extTrack: ExternalSubtitleTrack = {
      id: 'ext:fr',
      uri: 'https://subs.example/fr.srt',
      label: 'French',
      language: 'fr',
      mimeType: 'application/x-subrip',
    };
    const style = {
      fontSize: 'extraLarge' as const,
      textColor: 'cyan' as const,
      backgroundColor: 'opaque' as const,
      edgeStyle: 'dropShadow' as const,
      verticalPosition: 'top' as const,
    };

    engine.addExternalSubtitle?.(2, extTrack);
    engine.setSubtitleStyle?.(style);
    engine.selectSecondarySubtitleTrack?.(3, 'ext:fr');
    engine.selectSecondarySubtitleTrack?.(4, null);

    expect(native.engine.addExternalSubtitle).toHaveBeenCalledWith(2, extTrack);
    expect(native.engine.setSubtitleStyle).toHaveBeenCalledWith(style);
    expect(native.engine.selectSecondarySubtitleTrack).toHaveBeenNthCalledWith(1, 3, 'ext:fr');
    expect(native.engine.selectSecondarySubtitleTrack).toHaveBeenNthCalledWith(2, 4, null);

    // Dual-subtitle tracks event normalizes and forwards selectedSecondarySubtitleId & external flag.
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    native.emit({
      attempt: 4,
      type: 'tracks',
      tracks: {
        audio: [],
        subtitles: [
          { id: 's:3', language: 'en', label: 'English' },
          { id: 'ext:fr', language: 'fr', label: 'French', external: true },
        ],
        selectedAudioId: null,
        selectedSubtitleId: 's:3',
        selectedSecondarySubtitleId: 'ext:fr',
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('tracks');
    if (events[0]?.type === 'tracks') {
      expect(events[0].tracks.selectedSecondarySubtitleId).toBe('ext:fr');
      expect(events[0].tracks.subtitles[1]?.external).toBe(true);
    }

    engine.release();
    engine.addExternalSubtitle?.(5, extTrack);
    engine.setSubtitleStyle?.(style);
    engine.selectSecondarySubtitleTrack?.(6, 'ext:fr');
    expect(native.engine.addExternalSubtitle).toHaveBeenCalledTimes(1);
    expect(native.engine.setSubtitleStyle).toHaveBeenCalledTimes(1);
    expect(native.engine.selectSecondarySubtitleTrack).toHaveBeenCalledTimes(2);
  });

  it('forwards subtitleStyle prop on AetherSurface when defined and omits it when undefined (#32)', async () => {
    const native = fakeSubtitleNative();
    requireNativeViewManager.mockReturnValue(SurfaceView);
    const { createAetherEngine, AetherSurface } = await load();
    const engine = createAetherEngine();
    if (engine === null) throw new Error('engine expected');

    const subtitleStyle = {
      fontSize: 'small' as const,
      textColor: 'green' as const,
      backgroundColor: 'none' as const,
      edgeStyle: 'none' as const,
      verticalPosition: 'bottom' as const,
    };

    const withStyle = AetherSurface({ engine, subtitleStyle });
    expect(withStyle?.props).toEqual({
      engine: native.engine,
      style: undefined,
      resizeMode: undefined,
      subtitleBottomInsetPx: undefined,
      subtitleStyle,
      testID: undefined,
    });

    const withoutStyle = AetherSurface({ engine });
    expect(withoutStyle?.props).not.toHaveProperty('subtitleStyle');
  });
});
