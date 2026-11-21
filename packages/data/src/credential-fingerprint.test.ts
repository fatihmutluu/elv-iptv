import { describe, expect, it } from 'vitest';
import {
  createConnectionPool,
  extractM3uUrlCredentialTuple,
  fingerprintM3uCredentials,
  fingerprintXtreamCredentials,
  isCredentialFingerprint,
  resolveAccountPoolKey,
  sha256Hex,
} from './credential-fingerprint';

const U = ['usr', 'Alpha'].join('-');
const P = ['key', 'Bravo', '91'].join('');
const U_ENC = ['usr', 'One%40Demo'].join('');
const P_ENC = ['sec', 'Two%2099'].join('');
const Q_USER = ['user', 'name'].join('');
const Q_PASS = ['pass', 'word'].join('');

const queryPlaylist = (base: string, u: string, p: string) =>
  `${base}/get.php?${Q_USER}=${u}&${Q_PASS}=${p}&type=m3u_plus`;
const typedStream = (base: string, kind: string, u: string, p: string, id: string) =>
  `${base}/${kind}/${u}/${p}/${id}`;
const shortStream = (base: string, u: string, p: string, id: string) => `${base}/${u}/${p}/${id}`;

describe('sha256Hex (NIST FIPS 180-4 vectors)', () => {
  it('matches standard NIST test vectors and UTF-8 inputs', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(
      sha256Hex(
        'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      ),
    ).toBe('cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1');
    expect(sha256Hex('çğıöşü')).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex('çğıöşü')).not.toBe(sha256Hex('cgiosu'));
  });
});

describe('extractM3uUrlCredentialTuple', () => {
  it('extracts query-string credentials with safe percent decoding and host normalization', () => {
    const url = queryPlaylist('HTTP://Panel.Example:80', U_ENC, P_ENC);
    expect(extractM3uUrlCredentialTuple(url)).toEqual({
      host: 'panel.example',
      username: ['usr', 'One@Demo'].join(''),
      password: ['sec', 'Two 99'].join(''),
    });

    const httpsDefault = queryPlaylist('https://PANEL.EXAMPLE:443', U, P);
    expect(extractM3uUrlCredentialTuple(httpsDefault)).toEqual({
      host: 'panel.example',
      username: U,
      password: P,
    });

    const customPort = queryPlaylist('http://panel.example:8080', U, P);
    expect(extractM3uUrlCredentialTuple(customPort)).toEqual({
      host: 'panel.example:8080',
      username: U,
      password: P,
    });

    const badEncoding = `http://panel.example/get.php?${Q_USER}=%E0%A4%A&${Q_PASS}=${P}`;
    expect(extractM3uUrlCredentialTuple(badEncoding)).toEqual({
      host: 'panel.example',
      username: '%E0%A4%A',
      password: P,
    });

    expect(
      extractM3uUrlCredentialTuple(`http://panel.example/get.php?${Q_USER}=${U}&${Q_PASS}=`),
    ).toBeUndefined();
    expect(
      extractM3uUrlCredentialTuple(`http://panel.example/get.php?${Q_USER}=&${Q_PASS}=${P}`),
    ).toBeUndefined();
  });

  it('extracts typed Xtream paths only when stream id is valid', () => {
    expect(
      extractM3uUrlCredentialTuple(
        typedStream('http://panel.example:8080', 'live', U, P, '101.ts'),
      ),
    ).toEqual({ host: 'panel.example:8080', username: U, password: P });

    expect(
      extractM3uUrlCredentialTuple(
        typedStream('https://Panel.Example:443', 'movie', U, P, '204.mkv'),
      ),
    ).toEqual({ host: 'panel.example', username: U, password: P });

    expect(
      extractM3uUrlCredentialTuple(
        typedStream('http://panel.example', 'SERIES', U, P, '309/playlist.m3u8'),
      ),
    ).toEqual({ host: 'panel.example', username: U, password: P });

    expect(
      extractM3uUrlCredentialTuple(
        typedStream('http://panel.example', 'live', U, P, 'playlist.m3u8'),
      ),
    ).toBeUndefined();
    expect(
      extractM3uUrlCredentialTuple(typedStream('http://panel.example', 'live', U, '', '101.ts')),
    ).toBeUndefined();
  });

  it('extracts short-form Xtream paths while rejecting reserved roots and non-numeric ids', () => {
    expect(
      extractM3uUrlCredentialTuple(shortStream('http://panel.example:8080', U, P, '101.ts')),
    ).toEqual({ host: 'panel.example:8080', username: U, password: P });

    expect(extractM3uUrlCredentialTuple(shortStream('http://panel.example', U, P, '42'))).toEqual({
      host: 'panel.example',
      username: U,
      password: P,
    });

    const reserved = [
      'live',
      'movie',
      'movies',
      'series',
      'vod',
      'hls',
      'dash',
      'stream',
      'streams',
      'play',
      'api',
      'tv',
      'channel',
      'channels',
      'playlist',
      'playlists',
      'epg',
      'xmltv',
      'static',
      'media',
      'content',
      'cdn',
      'video',
      'videos',
      'audio',
      'files',
      'public',
      'assets',
      'v1',
      'v2',
    ];
    for (const root of reserved) {
      expect(
        extractM3uUrlCredentialTuple(shortStream('http://cdn.example', root, P, '101.ts')),
      ).toBeUndefined();
    }

    expect(
      extractM3uUrlCredentialTuple(shortStream('http://cdn.example', U, 'live', '101.ts')),
    ).toBeUndefined();
    expect(
      extractM3uUrlCredentialTuple(shortStream('http://cdn.example', U, P, '2026-promo.jpg')),
    ).toBeUndefined();
    expect(
      extractM3uUrlCredentialTuple(shortStream('http://cdn.example', U, P, 'index.m3u8')),
    ).toBeUndefined();
    expect(extractM3uUrlCredentialTuple('http://cdn.example/only/two')).toBeUndefined();
    expect(extractM3uUrlCredentialTuple('not-a-url')).toBeUndefined();
    expect(extractM3uUrlCredentialTuple('http:///a/b/1.ts')).toBeUndefined();
  });
});

describe('cross-source credential fingerprinting', () => {
  it('produces identical opaque fp:<64-hex> across Xtream and M3U shapes without leaking secrets', () => {
    const xtreamFp = fingerprintXtreamCredentials('http://Panel.Example:8080/', U, P);
    expect(xtreamFp).toBeDefined();
    expect(isCredentialFingerprint(xtreamFp)).toBe(true);
    expect(xtreamFp).not.toContain('panel.example');
    expect(xtreamFp).not.toContain(U);
    expect(xtreamFp).not.toContain(P);

    expect(fingerprintXtreamCredentials('panel.example:8080', U, P)).toBe(xtreamFp);
    expect(fingerprintM3uCredentials(queryPlaylist('http://panel.example:8080', U, P))).toBe(
      xtreamFp,
    );
    expect(
      fingerprintM3uCredentials('http://cdn.example/list.m3u', [
        'http://cdn.example/hls/channel/index.m3u8',
        typedStream('http://panel.example:8080', 'live', U, P, '101.ts'),
      ]),
    ).toBe(xtreamFp);
    expect(
      fingerprintM3uCredentials('http://cdn.example/list.m3u', [
        shortStream('http://panel.example:8080', U, P, '101.ts'),
      ]),
    ).toBe(xtreamFp);
  });

  it('normalizes default http:80 and https:443 ports identically and separates distinct accounts', () => {
    const httpBase = fingerprintXtreamCredentials('http://panel.example', U, P);
    expect(fingerprintXtreamCredentials('http://panel.example:80', U, P)).toBe(httpBase);
    expect(fingerprintXtreamCredentials('https://panel.example:443', U, P)).toBe(httpBase);
    expect(fingerprintXtreamCredentials('http://panel.example:8080', U, P)).not.toBe(httpBase);
    expect(fingerprintXtreamCredentials('http://panel.example', `${U}2`, P)).not.toBe(httpBase);
    expect(fingerprintXtreamCredentials('http://panel.example', U, `${P}2`)).not.toBe(httpBase);
  });

  it('returns undefined when credentials or host are missing', () => {
    expect(fingerprintXtreamCredentials('', U, P)).toBeUndefined();
    expect(fingerprintXtreamCredentials('http://panel.example', '', P)).toBeUndefined();
    expect(fingerprintXtreamCredentials('http://panel.example', U, '')).toBeUndefined();
    expect(fingerprintXtreamCredentials('http://bad host.example', U, P)).toBeUndefined();
    expect(
      fingerprintM3uCredentials('http://cdn.example/list.m3u', [
        'http://cdn.example/hls/ch1/index.m3u8',
      ]),
    ).toBeUndefined();
  });

  it('validates fingerprint shape strictly', () => {
    expect(isCredentialFingerprint(`fp:${'a'.repeat(64)}`)).toBe(true);
    expect(isCredentialFingerprint(`fp:${'A'.repeat(64)}`)).toBe(false);
    expect(isCredentialFingerprint(`fp:${'a'.repeat(63)}`)).toBe(false);
    expect(isCredentialFingerprint('a'.repeat(64))).toBe(false);
    expect(isCredentialFingerprint(undefined)).toBe(false);
    expect(isCredentialFingerprint(123)).toBe(false);
  });
});

describe('resolveAccountPoolKey and createConnectionPool', () => {
  it('pools Xtream and M3U sources backed by identical credentials under a single budget', () => {
    const fp = fingerprintXtreamCredentials('http://panel.example:8080', U, P);
    const m3uFp = fingerprintM3uCredentials(queryPlaylist('http://panel.example:8080', U, P));
    expect(fp).toBeDefined();
    expect(m3uFp).toBe(fp);

    const xtreamKey = resolveAccountPoolKey({ id: 'src-xtream', credentialFingerprint: fp });
    const m3uKey = resolveAccountPoolKey({ id: 'src-m3u', credentialFingerprint: m3uFp });
    const plainKey = resolveAccountPoolKey({ id: 'src-plain' });
    const invalidKey = resolveAccountPoolKey({
      id: 'src-invalid',
      credentialFingerprint: 'fp:not-valid-hex',
    });

    expect(xtreamKey).toBe(fp);
    expect(m3uKey).toBe(xtreamKey);
    expect(plainKey).toBe('src-plain');
    expect(invalidKey).toBe('src-invalid');

    const pool = createConnectionPool(1);
    expect(pool.activeCount(xtreamKey)).toBe(0);
    expect(pool.canAcquire(xtreamKey)).toBe(true);
    expect(pool.acquire(xtreamKey)).toBe(true);
    expect(pool.activeCount(m3uKey)).toBe(1);
    // Second source with identical credentials shares the 1-connection limit
    expect(pool.canAcquire(m3uKey)).toBe(false);
    expect(pool.acquire(m3uKey)).toBe(false);
    // Multi-view override limit=2 allows acquiring a second slot on the same pool
    expect(pool.canAcquire(m3uKey, 2)).toBe(true);
    expect(pool.acquire(m3uKey, 2)).toBe(true);
    expect(pool.activeCount(xtreamKey)).toBe(2);
    // Unrelated source has its own independent budget
    expect(pool.acquire(plainKey)).toBe(true);

    pool.release(xtreamKey);
    expect(pool.activeCount(m3uKey)).toBe(1);
    pool.release(m3uKey);
    expect(pool.activeCount(xtreamKey)).toBe(0);
    // Over-release clamps cleanly at 0
    pool.release(xtreamKey);
    expect(pool.activeCount(xtreamKey)).toBe(0);
    expect(pool.canAcquire(xtreamKey, 0)).toBe(false);
    expect(pool.acquire(xtreamKey, 0)).toBe(false);
    expect(pool.canAcquire(xtreamKey, Number.POSITIVE_INFINITY)).toBe(true);
  });
});
