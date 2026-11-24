import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LanPairingSubmissionEvent } from './index';

const platformState = { OS: 'android' as string };
const requireOptionalNativeModule = vi.fn();

vi.mock('expo-modules-core', () => ({
  get Platform() {
    return platformState;
  },
  requireOptionalNativeModule,
}));

async function loadModule() {
  vi.resetModules();
  return import('./index');
}

const SAMPLE_TOKEN = 'a'.repeat(48);

function fakeNative() {
  const listeners = new Map<string, (event: unknown) => void>();
  const remove = vi.fn();
  const addListener = vi.fn((name: string, listener: (event: unknown) => void) => {
    listeners.set(name, listener);
    return { remove };
  });
  const generateToken = vi.fn(() => SAMPLE_TOKEN);
  const startServer = vi.fn(async () => ({
    host: '192.168.1.42',
    port: 49152,
    url: `http://192.168.1.42:49152/pair/${SAMPLE_TOKEN}`,
    expiresAtMs: 1_900_000_000_000,
  }));
  const stopServer = vi.fn(async () => {});

  requireOptionalNativeModule.mockReturnValue({
    addListener,
    generateToken,
    startServer,
    stopServer,
  });

  return {
    addListener,
    generateToken,
    remove,
    startServer,
    stopServer,
    emitSubmission: (payload: unknown) => listeners.get('onSubmission')?.(payload),
  };
}

afterEach(() => {
  platformState.OS = 'android';
  requireOptionalNativeModule.mockReset();
});

describe('@elv/lan-pairing JS bridge', () => {
  it('reports unavailable and behaves as safe no-op on web', async () => {
    platformState.OS = 'web';
    fakeNative();
    const mod = await loadModule();

    expect(mod.isLanPairingNativeAvailable()).toBe(false);
    expect(mod.generateLanPairingToken()).toBeNull();
    await expect(mod.stopLanPairingServer()).resolves.toBeUndefined();
    const sub = mod.addLanPairingSubmissionListener(() => {});
    expect(() => sub.remove()).not.toThrow();
    await expect(
      mod.startLanPairingServer({
        token: SAMPLE_TOKEN,
        html: '<html></html>',
        ttlMs: 300_000,
      }),
    ).rejects.toThrow(/unavailable/i);
    expect(requireOptionalNativeModule).not.toHaveBeenCalled();
  });

  it('reports unavailable and behaves as safe no-op when native module is absent', async () => {
    requireOptionalNativeModule.mockReturnValue(null);
    const mod = await loadModule();

    expect(mod.isLanPairingNativeAvailable()).toBe(false);
    expect(mod.generateLanPairingToken()).toBeNull();
    expect(requireOptionalNativeModule).toHaveBeenCalledWith('ElvLanPairing');
    await expect(mod.stopLanPairingServer()).resolves.toBeUndefined();
    const sub = mod.addLanPairingSubmissionListener(() => {});
    expect(() => sub.remove()).not.toThrow();
    await expect(
      mod.startLanPairingServer({
        token: SAMPLE_TOKEN,
        html: '<html></html>',
        ttlMs: 300_000,
      }),
    ).rejects.toThrow(/unavailable/i);
  });

  it('forwards startLanPairingServer with default caps and stopLanPairingServer to native', async () => {
    const native = fakeNative();
    const mod = await loadModule();

    expect(mod.isLanPairingNativeAvailable()).toBe(true);
    expect(mod.generateLanPairingToken()).toBe(SAMPLE_TOKEN);
    expect(native.generateToken).toHaveBeenCalledTimes(1);
    const info = await mod.startLanPairingServer({
      token: SAMPLE_TOKEN,
      html: '<!DOCTYPE html>',
      ttlMs: 300_000,
    });

    expect(native.startServer).toHaveBeenCalledWith({
      token: SAMPLE_TOKEN,
      html: '<!DOCTYPE html>',
      ttlMs: 300_000,
      maxBodyBytes: 16_384,
      maxFailedAttempts: 5,
    });
    expect(info).toEqual({
      host: '192.168.1.42',
      port: 49152,
      url: `http://192.168.1.42:49152/pair/${SAMPLE_TOKEN}`,
      expiresAtMs: 1_900_000_000_000,
    });

    await mod.startLanPairingServer({
      token: SAMPLE_TOKEN,
      html: '<!DOCTYPE html>',
      ttlMs: 60_000,
      maxBodyBytes: 8_192,
      maxFailedAttempts: 3,
    });
    expect(native.startServer).toHaveBeenLastCalledWith({
      token: SAMPLE_TOKEN,
      html: '<!DOCTYPE html>',
      ttlMs: 60_000,
      maxBodyBytes: 8_192,
      maxFailedAttempts: 3,
    });

    await mod.stopLanPairingServer();
    expect(native.stopServer).toHaveBeenCalledTimes(1);
  });

  it('subscribes to onSubmission, validates events, and removes listeners cleanly', async () => {
    const native = fakeNative();
    const mod = await loadModule();
    const received: LanPairingSubmissionEvent[] = [];

    const sub = mod.addLanPairingSubmissionListener((event) => {
      received.push(event);
    });
    expect(native.addListener).toHaveBeenCalledWith('onSubmission', expect.any(Function));

    native.emitSubmission({
      body: '{"kind":"m3u","url":"https://example.com/a.m3u"}',
      contentType: 'application/json',
    });
    native.emitSubmission({
      body: 'kind=m3u&url=https%3A%2F%2Fexample.com%2Fb.m3u',
    });
    // Ignore malformed payloads safely.
    native.emitSubmission(null);
    native.emitSubmission({ body: 123 });

    expect(received).toEqual([
      {
        body: '{"kind":"m3u","url":"https://example.com/a.m3u"}',
        contentType: 'application/json',
      },
      {
        body: 'kind=m3u&url=https%3A%2F%2Fexample.com%2Fb.m3u',
      },
    ]);

    sub.remove();
    expect(native.remove).toHaveBeenCalledTimes(1);
  });
});
