import { base64UrlEncode, encodeBidirectionalPairingQr, generateX25519KeyPair } from '@elv/sync';
import { describe, expect, it, vi } from 'vitest';
import {
  createPendingPairDeepLinkQueue,
  extractPairDeepLinkFromArgv,
  isValidPairDeepLinkUrl,
} from './pair-deep-link.ts';

function makeRandomBytes(seed: number) {
  return (len: number): Uint8Array => {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) out[i] = (seed + i * 17) & 0xff;
    return out;
  };
}

describe('pair-deep-link (#510)', () => {
  const kp = generateX25519KeyPair(makeRandomBytes(7));
  const pk = base64UrlEncode(kp.publicKey);
  const schemeUri = encodeBidirectionalPairingQr({ code: '12345678', hostPublicKeyB64Url: pk });
  const httpsUri = encodeBidirectionalPairingQr({
    code: '87654321',
    hostPublicKeyB64Url: pk,
    origin: 'https://pair.example.test',
  });

  it('accepts valid elviptv://pair and https:///pair URIs and rejects invalid/malicious URLs', () => {
    expect(isValidPairDeepLinkUrl(schemeUri)).toBe(true);
    expect(isValidPairDeepLinkUrl(httpsUri)).toBe(true);
    expect(isValidPairDeepLinkUrl('elviptv://play?key=x:1:live:1')).toBe(false);
    expect(isValidPairDeepLinkUrl('http://insecure.example.test/pair?c=12345678&pk=' + pk)).toBe(
      false,
    );
    expect(isValidPairDeepLinkUrl('javascript:alert(1)')).toBe(false);
    expect(isValidPairDeepLinkUrl('12345678')).toBe(false);
  });

  it('extracts the first valid pairing deep link from argv arrays', () => {
    expect(extractPairDeepLinkFromArgv(['--flag', 'foo.m3u', schemeUri])).toBe(schemeUri);
    expect(extractPairDeepLinkFromArgv(['--flag', 'foo.m3u'])).toBeNull();
  });

  it('queues deep links until consumed and delivers immediately when subscribed', () => {
    const queue = createPendingPairDeepLinkQueue();
    queue.enqueue('invalid://ignored');
    expect(queue.consume()).toBeNull();

    queue.enqueue(schemeUri);
    expect(queue.consume()).toBe(schemeUri);
    expect(queue.consume()).toBeNull();

    const received: string[] = [];
    const listener = vi.fn((uri: string) => received.push(uri));
    const unsub = queue.subscribe(listener);
    queue.enqueue(httpsUri);
    expect(received).toEqual([httpsUri]);
    expect(queue.consume()).toBeNull();
    unsub();
  });
});
