import type { PlayerEngine } from '@elv/playback';
import { afterEach, describe, expect, it, vi } from 'vitest';

const requireOptionalNativeModule = vi.fn();
const requireNativeViewManager = vi.fn();
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule, requireNativeViewManager }));

async function loadModule() {
  vi.resetModules();
  return import('./index');
}

function mockNativeEngine() {
  const nativeEngine = {
    load: vi.fn(),
    retry: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    stop: vi.fn(),
    recreate: vi.fn(),
    release: vi.fn(),
    addListener: vi.fn(() => ({ remove: vi.fn() })),
  };
  requireOptionalNativeModule.mockReturnValue({
    Engine: vi.fn(function construct() {
      return nativeEngine;
    }),
    uptimeMs: vi.fn(() => 0),
    engineVersion: vi.fn(() => '7.66.1'),
  });
  return nativeEngine;
}

afterEach(() => {
  requireOptionalNativeModule.mockReset();
  requireNativeViewManager.mockReset();
  vi.restoreAllMocks();
});

describe('AetherEngine network load options (#172)', () => {
  it('forwards dnsFamily and trimmed hostOverride when present and omits invalid/empty values', async () => {
    const native = mockNativeEngine();
    const { createAetherEngine } = await loadModule();
    const engine = createAetherEngine();
    if (engine === null) throw new Error('engine expected');

    const loadWithNetwork = (attempt: number, options?: Record<string, unknown>) => {
      engine.load({
        attempt,
        url: 'https://edge.example/live/101.ts',
        headers: {},
        kind: 'live',
        ...(options === undefined
          ? {}
          : { options: options as NonNullable<Parameters<PlayerEngine['load']>[0]['options']> }),
      });
    };

    loadWithNetwork(1, { dnsFamily: 'ipv4', hostOverride: '  192.0.2.10  ' });
    expect(native.load).toHaveBeenLastCalledWith({
      attempt: 1,
      url: 'https://edge.example/live/101.ts',
      headers: {},
      kind: 'live',
      dnsFamily: 'ipv4',
      hostOverride: '192.0.2.10',
    });

    loadWithNetwork(2, { dnsFamily: 'ipv6', hostOverride: '2001:db8::1' });
    expect(native.load).toHaveBeenLastCalledWith({
      attempt: 2,
      url: 'https://edge.example/live/101.ts',
      headers: {},
      kind: 'live',
      dnsFamily: 'ipv6',
      hostOverride: '2001:db8::1',
    });

    loadWithNetwork(3, { dnsFamily: 'system', hostOverride: '   ' });
    expect(native.load).toHaveBeenLastCalledWith({
      attempt: 3,
      url: 'https://edge.example/live/101.ts',
      headers: {},
      kind: 'live',
      dnsFamily: 'system',
    });

    loadWithNetwork(4, { dnsFamily: 'invalid-family', hostOverride: '' });
    expect(native.load).toHaveBeenLastCalledWith({
      attempt: 4,
      url: 'https://edge.example/live/101.ts',
      headers: {},
      kind: 'live',
    });

    loadWithNetwork(5);
    expect(native.load).toHaveBeenLastCalledWith({
      attempt: 5,
      url: 'https://edge.example/live/101.ts',
      headers: {},
      kind: 'live',
    });

    engine.release();
    loadWithNetwork(6, { dnsFamily: 'ipv4', hostOverride: '192.0.2.10' });
    expect(native.load).toHaveBeenCalledTimes(5);
  });
});
