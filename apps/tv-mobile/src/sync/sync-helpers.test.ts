import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateLanPairingToken: vi.fn<() => string | null>(() => null),
}));

vi.mock('@elv/lan-pairing', () => ({
  generateLanPairingToken: () => mocks.generateLanPairingToken(),
}));

import {
  defaultCsprngBytes,
  extractSafeMobileErrorSignature,
  redactDiagnosticsLine,
} from './sync-helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.generateLanPairingToken.mockReset().mockReturnValue(null);
});

describe('defaultCsprngBytes (CRITICAL #2)', () => {
  it('uses globalThis.crypto.getRandomValues when available', () => {
    const getRandomValues = vi.fn((arr: Uint8Array) => {
      for (let i = 0; i < arr.length; i += 1) arr[i] = (i + 7) & 0xff;
      return arr;
    });
    vi.stubGlobal('crypto', { getRandomValues });

    const out = defaultCsprngBytes(16);
    expect(out).toHaveLength(16);
    expect(out[0]).toBe(7);
    expect(out[15]).toBe(22);
    expect(getRandomValues).toHaveBeenCalledTimes(1);
    expect(mocks.generateLanPairingToken).not.toHaveBeenCalled();
  });

  it('falls back cleanly to @elv/lan-pairing native CSPRNG when globalThis.crypto is undefined (Hermes)', () => {
    vi.stubGlobal('crypto', undefined);
    const chunk1 = '000102030405060708090a0b0c0d0e0f1011121314151617';
    const chunk2 = '18191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f';
    mocks.generateLanPairingToken.mockReturnValueOnce(chunk1).mockReturnValueOnce(chunk2);

    const out = defaultCsprngBytes(32);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out).toHaveLength(32);
    expect(mocks.generateLanPairingToken).toHaveBeenCalledTimes(2);
    expect([...out]).toEqual(Array.from({ length: 32 }, (_, i) => i));
  });

  it('returns empty bytes for length 0 without invoking CSPRNG', () => {
    vi.stubGlobal('crypto', undefined);
    const out = defaultCsprngBytes(0);
    expect(out).toHaveLength(0);
    expect(mocks.generateLanPairingToken).not.toHaveBeenCalled();
  });

  it('throws fail-closed when neither crypto.getRandomValues nor native @elv/lan-pairing CSPRNG is available', () => {
    vi.stubGlobal('crypto', undefined);
    mocks.generateLanPairingToken.mockReturnValue(null);
    expect(() => defaultCsprngBytes(32)).toThrow(/CSPRNG unavailable/i);

    mocks.generateLanPairingToken.mockReturnValue('not-valid-hex');
    expect(() => defaultCsprngBytes(12)).toThrow(/CSPRNG unavailable/i);
  });
});

describe('redactDiagnosticsLine (HIGH #8)', () => {
  it('strips all URI schemes, file: refs, IPv4/IPv6, OS paths, and credentials before redactText()', () => {
    const samples = [
      'stream failed rtsp://user:pass@iptv.provider.example:554/live/1.ts?token=abc',
      'rtmp://cdn.provider.example/app/key123',
      'udp://239.0.0.1:1234',
      'file:///storage/emulated/0/Download/my-playlist.m3u',
      'file:/etc/secret.conf',
      'loaded /storage/emulated/0/Android/data/list.m3u8',
      'cache /tmp/elv-cache/item.ts /var/log/app.log',
      'profile /home/alice/.config/iptv /Users/bob/Desktop/list.m3u',
      'win C:\\Users\\Alice\\Playlists\\tv.m3u and \\\\nas01\\media\\list.m3u',
      'peer 192.168.1.50:8080 -> 10.0.0.42',
      'ipv6 [2001:db8::1]:8080 fe80::1%eth0 ::ffff:192.168.1.9 ::1',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig password=supersecret',
    ];

    for (const sample of samples) {
      const cleaned = redactDiagnosticsLine(sample);
      expect(cleaned).not.toMatch(/[a-z][a-z0-9+.-]*:\/\//i);
      expect(cleaned).not.toMatch(/file:\S/i);
      expect(cleaned).not.toContain('iptv.provider.example');
      expect(cleaned).not.toContain('cdn.provider.example');
      expect(cleaned).not.toContain('192.168.1.50');
      expect(cleaned).not.toContain('10.0.0.42');
      expect(cleaned).not.toContain('239.0.0.1');
      expect(cleaned).not.toContain('2001:db8::1');
      expect(cleaned).not.toContain('fe80::1');
      expect(cleaned).not.toContain('/storage/');
      expect(cleaned).not.toContain('/tmp/');
      expect(cleaned).not.toContain('/var/');
      expect(cleaned).not.toContain('/home/');
      expect(cleaned).not.toContain('/Users/');
      expect(cleaned).not.toContain('C:\\Users');
      expect(cleaned).not.toContain('\\\\nas01\\');
      expect(cleaned).not.toContain('supersecret');
      expect(cleaned).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    }
  });
});

describe('extractSafeMobileErrorSignature (P1-6)', () => {
  it('redacts provider URLs BEFORE frame extraction so host:port and stream paths never leak into stackSig', () => {
    const err = Object.assign(
      new Error('Failed loading https://user:pass@myprovider.de:8080/live/u/p/123.ts'),
      {
        stack: [
          'Error: Failed loading https://user:pass@myprovider.de:8080/live/u/p/123.ts',
          '    at fetchStream (https://myprovider.de:8080/live/user/pass/123.ts:1:1)',
          '    at parse (myprovider.de:8080/playlist.m3u:4:2)',
          '    at render (index.android.bundle:512:4)',
        ].join('\n'),
      },
    );
    const sig = extractSafeMobileErrorSignature(err);
    expect(sig.errorName).toBe('Error');
    expect(sig.stackSig).not.toContain('myprovider');
    expect(sig.stackSig).not.toContain('8080');
    expect(sig.stackSig).not.toContain('123.ts');
    expect(sig.stackSig).not.toContain('playlist.m3u');
    expect(sig.stackSig).toBe('index.android.bundle:512');
  });

  it('extracts legitimate mobile bundle and TypeScript frames cleanly', () => {
    const tsErr = Object.assign(new TypeError('null ref'), {
      stack: 'TypeError: null ref\n    at Player (PlayerScreen.tsx:88:12)',
    });
    expect(extractSafeMobileErrorSignature(tsErr)).toEqual({
      errorName: 'TypeError',
      stackSig: 'PlayerScreen.tsx:88',
    });
    const hbcErr = Object.assign(new RangeError('bounds'), {
      stack: 'RangeError: bounds\n    at eval (app.hbc:14:2)',
    });
    expect(extractSafeMobileErrorSignature(hbcErr)).toEqual({
      errorName: 'RangeError',
      stackSig: 'app.hbc:14',
    });
  });
});
