import type { PlayerEngine } from '@elv/playback';
import { afterEach, describe, expect, it, vi } from 'vitest';

const requireOptionalNativeModule = vi.fn();
const requireNativeViewManager = vi.fn();
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule, requireNativeViewManager }));

async function loadModule() {
  vi.resetModules();
  return import('./index');
}

function mockNativeEngine(options: { withSetDisplaySync?: boolean } = {}) {
  const withSetDisplaySync = options.withSetDisplaySync ?? true;
  const nativeEngine: Record<string, unknown> = {
    load: vi.fn(),
    retry: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    stop: vi.fn(),
    recreate: vi.fn(),
    release: vi.fn(),
    addListener: vi.fn(() => ({ remove: vi.fn() })),
    ...(withSetDisplaySync ? { setDisplaySync: vi.fn() } : {}),
  };
  requireOptionalNativeModule.mockReturnValue({
    Engine: vi.fn(function construct() {
      return nativeEngine;
    }),
    uptimeMs: vi.fn(() => 0),
    engineVersion: vi.fn(() => '7.66.1'),
  });
  return {
    load: nativeEngine.load as ReturnType<typeof vi.fn>,
    setDisplaySync: nativeEngine.setDisplaySync as ReturnType<typeof vi.fn> | undefined,
  };
}

afterEach(() => {
  requireOptionalNativeModule.mockReset();
  requireNativeViewManager.mockReset();
  vi.restoreAllMocks();
});

describe('Apple AetherEngine displaySync AFR/HDR wiring (#188, #116)', () => {
  it('forwards normalized displaySync fields on load and omits them when absent or malformed', async () => {
    const native = mockNativeEngine();
    const { createAetherEngine } = await loadModule();
    const engine = createAetherEngine();
    if (engine === null) throw new Error('engine expected');

    const loadWithDisplaySync = (attempt: number, displaySync?: unknown) => {
      engine.load({
        attempt,
        url: 'https://tv.example/live/4k.m3u8',
        headers: {},
        kind: 'live',
        ...(displaySync === undefined
          ? {}
          : {
              options: {
                displaySync,
              } as NonNullable<Parameters<PlayerEngine['load']>[0]['options']>,
            }),
      });
    };

    loadWithDisplaySync(1, { autoFrameRate: 'seamless', autoDynamicRange: true });
    expect(native.load).toHaveBeenLastCalledWith({
      attempt: 1,
      url: 'https://tv.example/live/4k.m3u8',
      headers: {},
      kind: 'live',
      autoFrameRate: 'seamless',
      autoDynamicRange: true,
    });

    loadWithDisplaySync(2, { autoFrameRate: 'always', autoDynamicRange: false });
    expect(native.load).toHaveBeenLastCalledWith({
      attempt: 2,
      url: 'https://tv.example/live/4k.m3u8',
      headers: {},
      kind: 'live',
      autoFrameRate: 'always',
      autoDynamicRange: false,
    });

    loadWithDisplaySync(3, { autoFrameRate: 'off', autoDynamicRange: false });
    expect(native.load).toHaveBeenLastCalledWith({
      attempt: 3,
      url: 'https://tv.example/live/4k.m3u8',
      headers: {},
      kind: 'live',
      autoFrameRate: 'off',
      autoDynamicRange: false,
    });

    // Absent displaySync preserves exact existing wire shape
    loadWithDisplaySync(4);
    expect(native.load).toHaveBeenLastCalledWith({
      attempt: 4,
      url: 'https://tv.example/live/4k.m3u8',
      headers: {},
      kind: 'live',
    });

    // Malformed displaySync is ignored cleanly
    loadWithDisplaySync(5, { autoFrameRate: 'invalid', autoDynamicRange: 'yes' });
    expect(native.load).toHaveBeenLastCalledWith({
      attempt: 5,
      url: 'https://tv.example/live/4k.m3u8',
      headers: {},
      kind: 'live',
    });

    engine.release();
  });

  it('exposes live setDisplaySync on the returned PlayerEngine and silences it after release', async () => {
    const native = mockNativeEngine({ withSetDisplaySync: true });
    const { createAetherEngine } = await loadModule();
    const engine = createAetherEngine();
    if (engine === null) throw new Error('engine expected');

    expect(engine.setDisplaySync).toBeTypeOf('function');

    engine.setDisplaySync?.({ autoFrameRate: 'always', autoDynamicRange: true });
    engine.setDisplaySync?.({ autoFrameRate: 'off', autoDynamicRange: false });
    engine.setDisplaySync?.({ autoFrameRate: 'seamless', autoDynamicRange: false });

    expect(native.setDisplaySync).toHaveBeenNthCalledWith(1, 'always', true);
    expect(native.setDisplaySync).toHaveBeenNthCalledWith(2, 'off', false);
    expect(native.setDisplaySync).toHaveBeenNthCalledWith(3, 'seamless', false);

    // Invalid payloads are ignored without calling native
    engine.setDisplaySync?.(null as unknown as { autoFrameRate: 'off'; autoDynamicRange: false });
    expect(native.setDisplaySync).toHaveBeenCalledTimes(3);

    // Commands after release are no-ops
    engine.release();
    engine.setDisplaySync?.({ autoFrameRate: 'seamless', autoDynamicRange: true });
    expect(native.setDisplaySync).toHaveBeenCalledTimes(3);
  });

  it('omits setDisplaySync when the native engine object does not expose it', async () => {
    mockNativeEngine({ withSetDisplaySync: false });
    const { createAetherEngine } = await loadModule();
    const engine = createAetherEngine();
    if (engine === null) throw new Error('engine expected');

    expect(engine.setDisplaySync).toBeUndefined();
    engine.release();
  });
});
