import type { EngineEvent } from '@elv/playback';
import { afterEach, describe, expect, it, vi } from 'vitest';

const requireOptionalNativeModule = vi.fn();
const requireNativeViewManager = vi.fn();
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule, requireNativeViewManager }));

async function loadModule() {
  vi.resetModules();
  return import('./index');
}

function mockNativeEngine() {
  const listeners = new Set<(event: EngineEvent) => void>();
  const nativeEngine = {
    load: vi.fn(),
    retry: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    stop: vi.fn(),
    recreate: vi.fn(),
    release: vi.fn(),
    addListener: vi.fn((eventName: string, listener: (event: EngineEvent) => void) => {
      if (eventName === 'onEngineEvent') {
        listeners.add(listener);
      }
      return {
        remove: () => {
          listeners.delete(listener);
        },
      };
    }),
  };
  requireOptionalNativeModule.mockReturnValue({
    Engine: vi.fn(function construct() {
      return nativeEngine;
    }),
    uptimeMs: vi.fn(() => 10_000),
    engineVersion: vi.fn(() => '7.66.1'),
  });
  return {
    nativeEngine,
    emit(event: EngineEvent) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

afterEach(() => {
  requireOptionalNativeModule.mockReset();
  requireNativeViewManager.mockReset();
  vi.restoreAllMocks();
});

describe('AetherEngine VOD read-ahead bufferPreset forwarding (#350)', () => {
  it('forwards bufferPreset on VOD loads through createDisplaySyncBridgeAdapter', async () => {
    const { nativeEngine } = mockNativeEngine();
    const { createAetherEngine } = await loadModule();
    const engine = createAetherEngine();
    if (engine === null) throw new Error('engine expected');

    engine.load({
      attempt: 1,
      url: 'https://cdn.example/movie/101.mp4',
      headers: {},
      kind: 'vod',
      options: { bufferPreset: 'large' },
    });

    expect(nativeEngine.load).toHaveBeenLastCalledWith({
      attempt: 1,
      url: 'https://cdn.example/movie/101.mp4',
      headers: {},
      kind: 'vod',
      bufferPreset: 'large',
    });

    engine.load({
      attempt: 2,
      url: 'https://cdn.example/movie/102.mp4',
      headers: {},
      kind: 'vod',
      options: {
        bufferPreset: 'balanced',
        displaySync: { autoFrameRate: 'seamless', autoDynamicRange: true },
      },
    });

    expect(nativeEngine.load).toHaveBeenLastCalledWith({
      attempt: 2,
      url: 'https://cdn.example/movie/102.mp4',
      headers: {},
      kind: 'vod',
      bufferPreset: 'balanced',
      autoFrameRate: 'seamless',
      autoDynamicRange: true,
    });

    engine.release();
  });
});
