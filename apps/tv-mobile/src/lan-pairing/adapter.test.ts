import {
  isValidPairingToken,
  LAN_PAIRING_MAX_BODY_BYTES,
  LAN_PAIRING_MAX_FAILED_ATTEMPTS,
  LAN_PAIRING_TTL_MS,
} from '@elv/sources';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  nativeAvailable: true,
  generateToken: vi.fn<() => string | null>(),
  startServer: vi.fn(),
  stopServer: vi.fn(),
  submissionListeners: new Set<(event: { body: string; contentType?: string }) => void>(),
  addSubmissionListener: vi.fn(),
}));

vi.mock('@elv/lan-pairing', () => ({
  isLanPairingNativeAvailable: () => mocks.nativeAvailable,
  generateLanPairingToken: () => mocks.generateToken(),
  startLanPairingServer: (...args: unknown[]) => mocks.startServer(...args),
  stopLanPairingServer: (...args: unknown[]) => mocks.stopServer(...args),
  addLanPairingSubmissionListener: (
    listener: (event: { body: string; contentType?: string }) => void,
  ) => mocks.addSubmissionListener(listener),
}));

import { createMobileLanPairingPort } from './adapter';

const NATIVE_TOKEN = 'b'.repeat(48);

beforeEach(() => {
  mocks.nativeAvailable = true;
  mocks.generateToken.mockReset().mockReturnValue(NATIVE_TOKEN);
  mocks.submissionListeners.clear();
  mocks.startServer
    .mockReset()
    .mockImplementation(async (opts: { token: string; ttlMs: number }) => ({
      host: '192.168.1.42',
      port: 49152,
      url: `http://192.168.1.42:49152/pair/${opts.token}`,
      expiresAtMs: 1_700_000_000_000 + opts.ttlMs,
    }));
  mocks.stopServer.mockReset().mockResolvedValue(undefined);
  mocks.addSubmissionListener
    .mockReset()
    .mockImplementation((listener: (event: { body: string; contentType?: string }) => void) => {
      mocks.submissionListeners.add(listener);
      return {
        remove: () => {
          mocks.submissionListeners.delete(listener);
        },
      };
    });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('createMobileLanPairingPort', () => {
  it('mirrors native availability via isSupported()', () => {
    const port = createMobileLanPairingPort();
    mocks.nativeAvailable = true;
    expect(port.isSupported()).toBe(true);
    mocks.nativeAvailable = false;
    expect(port.isSupported()).toBe(false);
  });

  it('rejects startSession cleanly when native module is unavailable', async () => {
    mocks.nativeAvailable = false;
    const port = createMobileLanPairingPort();
    await expect(port.startSession()).rejects.toThrow(/unavailable|not supported/i);
    expect(mocks.startServer).not.toHaveBeenCalled();
    expect(mocks.addSubmissionListener).not.toHaveBeenCalled();
  });

  it('prefers the native CSPRNG token generator even when globalThis.crypto is absent', async () => {
    vi.stubGlobal('crypto', undefined);

    const port = createMobileLanPairingPort();
    const session = await port.startSession({ locale: 'en' });

    expect(mocks.generateToken).toHaveBeenCalledTimes(1);
    expect(session.token).toBe(NATIVE_TOKEN);
    expect(session.token).toHaveLength(48);
    expect(isValidPairingToken(session.token)).toBe(true);
    expect(session.host).toBe('192.168.1.42');
    expect(session.port).toBe(49152);
    expect(session.url).toBe(`http://192.168.1.42:49152/pair/${NATIVE_TOKEN}`);
    expect(session.expiresAtMs).toBe(1_700_000_000_000 + LAN_PAIRING_TTL_MS);

    expect(mocks.startServer).toHaveBeenCalledWith({
      token: NATIVE_TOKEN,
      html: expect.stringContaining(`/pair/${NATIVE_TOKEN}`),
      ttlMs: LAN_PAIRING_TTL_MS,
      maxBodyBytes: LAN_PAIRING_MAX_BODY_BYTES,
      maxFailedAttempts: LAN_PAIRING_MAX_FAILED_ATTEMPTS,
    });
    const firstCallArg = mocks.startServer.mock.calls[0]?.[0] as { html?: string } | undefined;
    expect(firstCallArg?.html).toContain('Send Source to TV');
  });

  it('uses globalThis.crypto.getRandomValues when native generateToken returns null', async () => {
    mocks.generateToken.mockReturnValue(null);
    const getRandomValues = vi.fn((arr: Uint8Array) => {
      for (let i = 0; i < arr.length; i += 1) {
        arr[i] = i + 1;
      }
      return arr;
    });
    vi.stubGlobal('crypto', { getRandomValues });

    const port = createMobileLanPairingPort();
    const session = await port.startSession({ locale: 'en' });

    expect(getRandomValues).toHaveBeenCalledTimes(1);
    const expectedToken = '0102030405060708090a0b0c0d0e0f101112131415161718';
    expect(session.token).toBe(expectedToken);
    expect(session.token).toHaveLength(48);
    expect(isValidPairingToken(session.token)).toBe(true);
  });

  it('renders localized Turkish HTML when locale is tr', async () => {
    const port = createMobileLanPairingPort();
    await port.startSession({ locale: 'tr' });
    const firstCallArg = mocks.startServer.mock.calls[0]?.[0] as { html?: string } | undefined;
    expect(firstCallArg?.html).toContain('TV’ye Kaynak Gönder');
  });

  it('fails closed when neither native CSPRNG nor globalThis.crypto is available', async () => {
    mocks.generateToken.mockReturnValue(null);
    vi.stubGlobal('crypto', undefined);
    const port = createMobileLanPairingPort();
    await expect(port.startSession()).rejects.toThrow(/secure random/i);
    expect(mocks.startServer).not.toHaveBeenCalled();
    expect(mocks.addSubmissionListener).not.toHaveBeenCalled();
  });

  it('parses valid M3U submissions, delivers to listeners, and enforces single-use teardown', async () => {
    const port = createMobileLanPairingPort();
    const received: unknown[] = [];
    const unsubscribe = port.onPayloadReceived((payload) => {
      received.push(payload);
    });

    await port.startSession();
    expect(mocks.submissionListeners.size).toBe(1);

    const payloadBody = JSON.stringify({
      kind: 'm3u',
      name: 'Living Room',
      url: 'https://example.test/playlist.m3u',
      guideUrl: 'https://example.test/epg.xml',
    });
    for (const listener of [...mocks.submissionListeners]) {
      listener({ body: payloadBody, contentType: 'application/json' });
    }

    expect(received).toEqual([
      {
        kind: 'm3u',
        name: 'Living Room',
        url: 'https://example.test/playlist.m3u',
        guideUrl: 'https://example.test/epg.xml',
      },
    ]);
    // Single-use teardown detaches native listener and stops server defensively.
    expect(mocks.submissionListeners.size).toBe(0);
    expect(mocks.stopServer).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('parses valid Xtream form submissions without ever logging raw bodies or credentials', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const port = createMobileLanPairingPort();
    const received: unknown[] = [];
    port.onPayloadReceived((payload) => {
      received.push(payload);
    });

    await port.startSession();
    const body = new URLSearchParams({
      kind: 'xtream',
      name: 'My Provider',
      server: 'http://provider.example:8080',
      username: 'synthetic_user',
      password: 'synthetic_secret_pass',
    }).toString();
    for (const listener of [...mocks.submissionListeners]) {
      listener({ body, contentType: 'application/x-www-form-urlencoded' });
    }

    expect(received).toEqual([
      {
        kind: 'xtream',
        name: 'My Provider',
        server: 'http://provider.example:8080',
        username: 'synthetic_user',
        password: 'synthetic_secret_pass',
      },
    ]);
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('silently ignores malformed submissions without logging and keeps listening for a valid one', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const port = createMobileLanPairingPort();
    const received: unknown[] = [];
    port.onPayloadReceived((payload) => {
      received.push(payload);
    });

    await port.startSession();
    for (const listener of [...mocks.submissionListeners]) {
      listener({
        body: '{"kind":"xtream","password":"secret_invalid"}',
        contentType: 'application/json',
      });
      listener({ body: 'not valid json', contentType: 'application/json' });
    }

    expect(received).toEqual([]);
    expect(mocks.submissionListeners.size).toBe(1);
    expect(mocks.stopServer).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    for (const listener of [...mocks.submissionListeners]) {
      listener({
        body: JSON.stringify({ kind: 'm3u', url: 'https://example.test/ok.m3u' }),
        contentType: 'application/json',
      });
    }
    expect(received).toEqual([
      { kind: 'm3u', name: 'example.test', url: 'https://example.test/ok.m3u' },
    ]);
  });

  it('isolates throwing payload listeners and honors unsubscribe', async () => {
    const port = createMobileLanPairingPort();
    const first = vi.fn(() => {
      throw new Error('listener boom');
    });
    const second = vi.fn();
    const third = vi.fn();

    port.onPayloadReceived(first);
    port.onPayloadReceived(second);
    const unsubThird = port.onPayloadReceived(third);
    unsubThird();

    await port.startSession();
    for (const listener of [...mocks.submissionListeners]) {
      listener({
        body: JSON.stringify({ kind: 'm3u', url: 'https://example.test/a.m3u' }),
        contentType: 'application/json',
      });
    }

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(third).not.toHaveBeenCalled();
  });

  it('cleans up native listener on stopSession and on startServer failure', async () => {
    const port = createMobileLanPairingPort();
    await port.startSession();
    expect(mocks.submissionListeners.size).toBe(1);

    await port.stopSession();
    expect(mocks.submissionListeners.size).toBe(0);
    expect(mocks.stopServer).toHaveBeenCalledTimes(1);

    mocks.startServer.mockRejectedValueOnce(new Error('No LAN IPv4 address'));
    await expect(port.startSession()).rejects.toThrow('No LAN IPv4 address');
    expect(mocks.submissionListeners.size).toBe(0);
  });

  it('cancels an in-flight startSession if stopSession is called before native resolves', async () => {
    let resolveStart: ((info: unknown) => void) | undefined;
    mocks.startServer.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
    );

    const port = createMobileLanPairingPort();
    const pending = port.startSession();
    await port.stopSession();

    resolveStart?.({
      host: '192.168.1.42',
      port: 50000,
      url: 'http://192.168.1.42:50000/pair/abcd',
      expiresAtMs: Date.now() + 300_000,
    });

    await expect(pending).rejects.toThrow(/cancelled/i);
    expect(mocks.submissionListeners.size).toBe(0);
    expect(mocks.stopServer).toHaveBeenCalledTimes(2);
  });
});
