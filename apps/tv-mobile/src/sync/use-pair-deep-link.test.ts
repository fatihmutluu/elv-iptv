import { base64UrlEncode, encodeBidirectionalPairingQr, generateX25519KeyPair } from '@elv/sync';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Linking: {
    getInitialURL: vi.fn(async () => null),
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
}));

import { parseIncomingPairDeepLink } from './use-pair-deep-link';

function detRandom(seed: number) {
  return (len: number): Uint8Array => {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) out[i] = (seed + i * 29) & 0xff;
    return out;
  };
}

describe('use-pair-deep-link (#510)', () => {
  const pk = base64UrlEncode(generateX25519KeyPair(detRandom(11)).publicKey);
  const schemeUri = encodeBidirectionalPairingQr({ code: '12345678', hostPublicKeyB64Url: pk });
  const universalUri = encodeBidirectionalPairingQr({
    code: '87654321',
    hostPublicKeyB64Url: pk,
    origin: 'https://sync.example.test',
  });

  it('accepts valid elviptv://pair and https:///pair deep links and ignores play/external/malicious URLs', () => {
    expect(parseIncomingPairDeepLink(schemeUri)).toBe(schemeUri);
    expect(parseIncomingPairDeepLink(universalUri)).toBe(universalUri);
    expect(parseIncomingPairDeepLink('elviptv://play?key=x:1:live:1')).toBeNull();
    expect(parseIncomingPairDeepLink('elviptv://external-return')).toBeNull();
    expect(
      parseIncomingPairDeepLink(`http://evil.example.test/pair?c=12345678&pk=${pk}`),
    ).toBeNull();
    expect(parseIncomingPairDeepLink('12345678')).toBeNull();
    expect(parseIncomingPairDeepLink(null)).toBeNull();
  });
});
