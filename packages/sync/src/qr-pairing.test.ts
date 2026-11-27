import { describe, expect, it, vi } from 'vitest';
import { base64UrlEncode, utf8ByteLength } from './encoding';
import type { SyncHttpPort, SyncHttpRequest, SyncHttpResponse } from './ports';
import { createPureJsVaultCryptoPort } from './pure-crypto';
import {
  buildPairingQrUri,
  createQrPairingClient,
  decryptPairingTransfer,
  derivePairingSessionKeys,
  encodeBidirectionalPairingQr,
  encryptPairingTransfer,
  hashPairingEmail,
  MAX_SYNC_QR_BYTES,
  maskEmail,
  normalizePairingCode,
  PAIR_CODE_RE,
  parsePairingQrOrCode,
  parsePairingQrUri,
  resolvePairingDirection,
} from './qr-pairing';
import { generateX25519KeyPair, x25519 } from './x25519';

function seededRandom(seed = 77): (len: number) => Uint8Array {
  let state = seed >>> 0;
  return (len: number) => {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      out[i] = (state >>> 24) & 0xff;
    }
    return out;
  };
}

describe('qr-pairing universal E2EE flow', () => {
  it('builds and parses compact QR URIs strictly <= 213 UTF-8 bytes', () => {
    const keyB64 = base64UrlEncode(new Uint8Array(16).fill(0xab));
    const uri = buildPairingQrUri({ code: 'ABCD1234EFGH', keyB64 });
    expect(utf8ByteLength(uri)).toBeLessThanOrEqual(MAX_SYNC_QR_BYTES);
    expect(uri).toBe(`elviptv://pair?c=ABCD1234EFGH&k=${keyB64}`);
    expect(parsePairingQrUri(uri)).toEqual({
      ok: true,
      value: { code: 'ABCD1234EFGH', keyB64 },
    });

    const withServer = buildPairingQrUri({
      code: 'ABCD1234EFGH',
      keyB64,
      serverUrl: 'https://sync.example.com/',
    });
    expect(utf8ByteLength(withServer)).toBeLessThanOrEqual(MAX_SYNC_QR_BYTES);
    expect(parsePairingQrUri(withServer)).toEqual({
      ok: true,
      value: { code: 'ABCD1234EFGH', keyB64, serverUrl: 'https://sync.example.com' },
    });

    // Reject oversized server URLs exceeding 213 UTF-8 bytes
    expect(() =>
      buildPairingQrUri({
        code: 'ABCD1234EFGH',
        keyB64,
        serverUrl: `https://${'a'.repeat(180)}.example.com`,
      }),
    ).toThrow(/213/);

    // Reject malformed inputs
    expect(() => buildPairingQrUri({ code: 'bad!', keyB64 })).toThrow();
    expect(() => buildPairingQrUri({ code: 'ABCD1234EFGH', keyB64: 'short' })).toThrow();
    expect(() =>
      buildPairingQrUri({
        code: 'ABCD1234EFGH',
        keyB64,
        serverUrl: 'http://insecure.example.com',
      }),
    ).toThrow();

    expect(parsePairingQrUri('').ok).toBe(false);
    expect(parsePairingQrUri('https://example.com').ok).toBe(false);
    expect(parsePairingQrUri('elviptv://pair?c=ABCD1234EFGH').ok).toBe(false);
    expect(
      parsePairingQrUri(`elviptv://pair?c=ABCD1234EFGH&k=${keyB64}&s=http://evil.test`).ok,
    ).toBe(false);
  });

  it('encrypts handoff payload end-to-end under ephemeral key k (server never sees plaintext or k)', async () => {
    const targetCrypto = createPureJsVaultCryptoPort(seededRandom(101));
    const scannerCrypto = createPureJsVaultCryptoPort(seededRandom(202));

    const serverState: {
      stored: { code: string; encryptedPayload?: string; iv?: string; expired?: boolean } | null;
    } = { stored: null };
    let createRequestBody = '';

    const http: SyncHttpPort = {
      async request(req): Promise<SyncHttpResponse> {
        if (req.method === 'POST' && req.url.endsWith('/v1/pair/create')) {
          createRequestBody = req.body ?? '';
          serverState.stored = { code: 'PAIR9876XYZW' };
          return {
            status: 201,
            bodyText: JSON.stringify({
              pairingId: 'pair_1',
              code: 'PAIR9876XYZW',
              pollToken: 'poll_secret_1',
              expiresAt: new Date(1_700_000_300_000).toISOString(),
            }),
          };
        }
        if (req.method === 'POST' && req.url.endsWith('/v1/pair/claim')) {
          const body = JSON.parse(req.body ?? '{}') as {
            code: string;
            encryptedPayload: string;
            iv: string;
          };
          if (serverState.stored?.code !== body.code) {
            return { status: 404, bodyText: '{}' };
          }
          serverState.stored = {
            ...serverState.stored,
            encryptedPayload: body.encryptedPayload,
            iv: body.iv,
          };
          return { status: 200, bodyText: JSON.stringify({ claimed: true }) };
        }
        if (req.method === 'GET' && req.url.includes('/v1/pair/poll/pair_1')) {
          if (serverState.stored?.expired) return { status: 410, bodyText: '{}' };
          if (!serverState.stored?.encryptedPayload) {
            return { status: 200, bodyText: JSON.stringify({ status: 'pending' }) };
          }
          const payload = {
            status: 'claimed',
            encryptedPayload: serverState.stored.encryptedPayload,
            iv: serverState.stored.iv,
          };
          // Single-use atomic consumption
          serverState.stored = { code: serverState.stored.code, expired: true };
          return { status: 200, bodyText: JSON.stringify(payload) };
        }
        return { status: 404, bodyText: '{}' };
      },
    };

    const targetClient = createQrPairingClient({
      baseUrl: 'https://sync.example.test',
      http,
      crypto: targetCrypto,
    });
    const scannerClient = createQrPairingClient({
      baseUrl: 'https://sync.example.test',
      http,
      crypto: scannerCrypto,
    });

    // 1. Target creates pairing session (k never sent to server)
    const created = await targetClient.createSession({ includeServerUrl: true });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(createRequestBody).not.toContain(created.value.keyB64);
    expect(utf8ByteLength(created.value.qrUri)).toBeLessThanOrEqual(MAX_SYNC_QR_BYTES);

    // 2. Poll before claim -> pending
    expect(await targetClient.pollSession(created.value)).toEqual({
      ok: true,
      value: { status: 'pending' },
    });

    // 3. Scanner scans QR and claims with E2EE payload
    const handoffPayload = {
      email: 'alice@example.test',
      refreshToken: 'ref_super_secret_token',
      vaultKeyB64: base64UrlEncode(new Uint8Array(32).fill(0x33)),
    };
    const claimed = await scannerClient.claimSession({
      accessToken: 'acc_scanner',
      qrUriOrParams: created.value.qrUri,
      payload: handoffPayload,
    });
    expect(claimed).toEqual({ ok: true, value: { claimed: true } });

    // Server MUST NOT see plaintext refreshToken, email, or vaultKeyB64
    expect(serverState.stored?.encryptedPayload).not.toContain('ref_super_secret_token');
    expect(serverState.stored?.encryptedPayload).not.toContain('alice@example.test');
    expect(serverState.stored?.encryptedPayload).not.toContain(handoffPayload.vaultKeyB64);

    // 4. Target polls and decrypts payload locally using ephemeral key k
    const polled = await targetClient.pollSession(created.value);
    expect(polled).toEqual({
      ok: true,
      value: { status: 'claimed', payload: handoffPayload },
    });

    // 5. Subsequent poll after single-use consumption returns expired (410)
    expect(await targetClient.pollSession(created.value)).toEqual({
      ok: true,
      value: { status: 'expired' },
    });
  });

  it('rejects cross-origin or mismatched-path QR serverUrl in claimSession with ZERO HTTP requests', async () => {
    const requests: SyncHttpRequest[] = [];
    const http: SyncHttpPort = {
      async request(req) {
        requests.push(req);
        return { status: 200, bodyText: JSON.stringify({ claimed: true }) };
      },
    };
    const crypto = createPureJsVaultCryptoPort(seededRandom(303));
    const keyB64 = base64UrlEncode(new Uint8Array(16).fill(0x5a));
    const handoffPayload = {
      email: 'alice@example.test',
      refreshToken: 'pair_ref_1',
      vaultKeyB64: base64UrlEncode(new Uint8Array(32).fill(0x11)),
    };

    const client = createQrPairingClient({
      baseUrl: 'https://sync.example.test/elv/',
      http,
      crypto,
    });

    const evilUri = buildPairingQrUri({
      code: 'ABCD1234EFGH',
      keyB64,
      serverUrl: 'https://attacker.example.test/elv',
    });
    const resDifferentHost = await client.claimSession({
      accessToken: 'secret_victim_jwt',
      qrUriOrParams: evilUri,
      payload: handoffPayload,
    });
    expect(resDifferentHost).toEqual({
      ok: false,
      error: { category: 'auth', code: 'server_origin_mismatch' },
    });
    expect(requests).toHaveLength(0);

    const resDifferentPort = await client.claimSession({
      accessToken: 'secret_victim_jwt',
      qrUriOrParams: {
        code: 'ABCD1234EFGH',
        keyB64,
        serverUrl: 'https://sync.example.test:8443/elv',
      },
      payload: handoffPayload,
    });
    expect(resDifferentPort).toEqual({
      ok: false,
      error: { category: 'auth', code: 'server_origin_mismatch' },
    });
    expect(requests).toHaveLength(0);

    const resDifferentPath = await client.claimSession({
      accessToken: 'secret_victim_jwt',
      qrUriOrParams: {
        code: 'ABCD1234EFGH',
        keyB64,
        serverUrl: 'https://sync.example.test/other',
      },
      payload: handoffPayload,
    });
    expect(resDifferentPath).toEqual({
      ok: false,
      error: { category: 'auth', code: 'server_origin_mismatch' },
    });
    expect(requests).toHaveLength(0);

    // Normalized matching origin + path (uppercase host, default port, trailing slash) succeeds
    const resMatching = await client.claimSession({
      accessToken: 'secret_victim_jwt',
      qrUriOrParams: {
        code: 'ABCD1234EFGH',
        keyB64,
        serverUrl: 'HTTPS://SYNC.EXAMPLE.TEST:443/elv',
      },
      payload: handoffPayload,
    });
    expect(resMatching).toEqual({ ok: true, value: { claimed: true } });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://sync.example.test/elv/v1/pair/claim');
  });

  it('validates 12-byte IV before decryptAesGcm in pollSession and normalizes pairingAad case', async () => {
    const targetCrypto = createPureJsVaultCryptoPort(seededRandom(404));
    const scannerCrypto = createPureJsVaultCryptoPort(seededRandom(505));
    const decryptSpy = vi.spyOn(targetCrypto, 'decryptAesGcm');

    const storedBox: {
      current: { code: string; encryptedPayload: string; iv: string } | null;
    } = { current: null };
    const http: SyncHttpPort = {
      async request(req) {
        if (req.method === 'POST' && req.url.endsWith('/v1/pair/claim')) {
          storedBox.current = JSON.parse(req.body ?? '{}') as {
            code: string;
            encryptedPayload: string;
            iv: string;
          };
          return { status: 200, bodyText: JSON.stringify({ claimed: true }) };
        }
        if (req.method === 'GET' && req.url.includes('/v1/pair/poll/')) {
          return {
            status: 200,
            bodyText: JSON.stringify({
              status: 'claimed',
              encryptedPayload: storedBox.current?.encryptedPayload ?? '',
              iv: storedBox.current?.iv ?? '',
            }),
          };
        }
        return { status: 404, bodyText: '{}' };
      },
    };

    const ephemeralKey = new Uint8Array(16).fill(0x7c);
    const keyB64 = base64UrlEncode(ephemeralKey);
    const scannerClient = createQrPairingClient({
      baseUrl: 'https://sync.example.test',
      http,
      crypto: scannerCrypto,
    });
    const targetClient = createQrPairingClient({
      baseUrl: 'https://sync.example.test',
      http,
      crypto: targetCrypto,
    });

    // Claim with lowercase code and poll with uppercase code (server uppercases code)
    const handoffPayload = {
      email: 'case@example.test',
      refreshToken: 'pair_ref_case',
      vaultKeyB64: base64UrlEncode(new Uint8Array(32).fill(0x99)),
    };
    const claimRes = await scannerClient.claimSession({
      accessToken: 'acc_case',
      qrUriOrParams: { code: 'pair9876xyzw', keyB64 },
      payload: handoffPayload,
    });
    expect(claimRes).toEqual({ ok: true, value: { claimed: true } });
    expect(storedBox.current?.code).toBe('PAIR9876XYZW');

    const pollRes = await targetClient.pollSession({
      pairingId: 'pair_case',
      code: '  PAIR9876XYZW  ',
      pollToken: 'poll_1',
      ephemeralKey,
    });
    expect(pollRes).toEqual({ ok: true, value: { status: 'claimed', payload: handoffPayload } });
    expect(decryptSpy).toHaveBeenCalledTimes(1);

    // Invalid IV length (8 bytes and 16 bytes) must fail BEFORE calling decryptAesGcm
    decryptSpy.mockClear();
    for (const badIvLen of [0, 8, 16]) {
      storedBox.current = {
        code: 'PAIR9876XYZW',
        encryptedPayload: base64UrlEncode(new Uint8Array(32).fill(0xaa)),
        iv: base64UrlEncode(new Uint8Array(badIvLen).fill(0xbb)),
      };
      const badPoll = await targetClient.pollSession({
        pairingId: 'pair_bad_iv',
        code: 'PAIR9876XYZW',
        pollToken: 'poll_1',
        ephemeralKey,
      });
      expect(badPoll).toEqual({
        ok: false,
        error: { category: 'auth', code: 'pair-decrypt-failed' },
      });
    }
    expect(decryptSpy).not.toHaveBeenCalled();
  });
});

describe('qr-pairing bidirectional v2 (8-digit code, X25519 SAS, dual-direction AES-256-GCM)', () => {
  it('validates 8-digit numeric codes, masks emails safely, and hashes normalized emails', () => {
    expect(PAIR_CODE_RE.test('12345678')).toBe(true);
    expect(PAIR_CODE_RE.test('00000000')).toBe(true);
    expect(PAIR_CODE_RE.test('1234567')).toBe(false);
    expect(PAIR_CODE_RE.test('123456789')).toBe(false);
    expect(PAIR_CODE_RE.test('1234ABCD')).toBe(false);

    expect(normalizePairingCode('1234 5678')).toBe('12345678');
    expect(normalizePairingCode(' 1234-5678 ')).toBe('12345678');
    expect(normalizePairingCode('0012 0034')).toBe('00120034');
    expect(normalizePairingCode('1234567')).toBeNull();
    expect(normalizePairingCode('1234abcd')).toBeNull();
    expect(normalizePairingCode('')).toBeNull();

    expect(maskEmail('fatih@example.com')).toBe('f***@example.com');
    expect(maskEmail('  Fatih.Mutlu@Example.COM ')).toBe('f***@example.com');
    expect(maskEmail('a@b.co')).toBe('*@b.co');
    expect(maskEmail('ab@b.co')).toBe('a***@b.co');
    expect(maskEmail('not-an-email')).toBe('***');
    expect(maskEmail('@example.com')).toBe('***');

    const h1 = hashPairingEmail('  Alice@Example.COM ');
    const h2 = hashPairingEmail('alice@example.com');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('encodes and parses elviptv://, https:// Universal Link, and raw 8-digit pairing inputs', () => {
    const rng = seededRandom(808);
    const hostKp = generateX25519KeyPair(rng);
    const pkB64 = base64UrlEncode(hostKp.publicKey);

    const schemeUri = encodeBidirectionalPairingQr({
      code: '1234 5678',
      hostPublicKeyB64Url: pkB64,
    });
    expect(schemeUri).toBe(`elviptv://pair?c=12345678&pk=${pkB64}`);
    expect(utf8ByteLength(schemeUri)).toBeLessThanOrEqual(MAX_SYNC_QR_BYTES);
    expect(parsePairingQrOrCode(schemeUri)).toEqual({
      ok: true,
      value: { kind: 'qr', code: '12345678', hostPublicKeyB64Url: pkB64 },
    });

    const httpsUri = encodeBidirectionalPairingQr({
      code: '87654321',
      hostPublicKeyB64Url: pkB64,
      origin: 'https://Sync.ElvIptv.com/',
    });
    expect(httpsUri).toBe(`https://sync.elviptv.com/pair?c=87654321&pk=${pkB64}`);
    expect(utf8ByteLength(httpsUri)).toBeLessThanOrEqual(MAX_SYNC_QR_BYTES);
    expect(parsePairingQrOrCode(httpsUri)).toEqual({
      ok: true,
      value: {
        kind: 'qr',
        code: '87654321',
        hostPublicKeyB64Url: pkB64,
        origin: 'https://sync.elviptv.com',
      },
    });

    // Raw 8-digit code with spaces or hyphens
    expect(parsePairingQrOrCode('1234 5678')).toEqual({
      ok: true,
      value: { kind: 'code', code: '12345678' },
    });
    expect(parsePairingQrOrCode('9876-5432')).toEqual({
      ok: true,
      value: { kind: 'code', code: '98765432' },
    });

    // Reject insecure origins, oversized URIs, all-zero pubkeys, bad paths, bad codes
    const zeroPk = base64UrlEncode(new Uint8Array(32));
    expect(() =>
      encodeBidirectionalPairingQr({ code: '12345678', hostPublicKeyB64Url: zeroPk }),
    ).toThrow(/zero|public key/i);
    expect(() =>
      encodeBidirectionalPairingQr({
        code: '12345678',
        hostPublicKeyB64Url: pkB64,
        origin: 'http://sync.example.com',
      }),
    ).toThrow(/https/i);
    expect(() =>
      encodeBidirectionalPairingQr({
        code: '12345678',
        hostPublicKeyB64Url: pkB64,
        origin: `https://${'a'.repeat(180)}.example.com`,
      }),
    ).toThrow(/213/);

    expect(parsePairingQrOrCode(`http://sync.elviptv.com/pair?c=12345678&pk=${pkB64}`).ok).toBe(
      false,
    );
    expect(parsePairingQrOrCode(`https://sync.elviptv.com/other?c=12345678&pk=${pkB64}`).ok).toBe(
      false,
    );
    expect(parsePairingQrOrCode(`elviptv://pair?c=12345678&pk=${zeroPk}`).ok).toBe(false);
    expect(parsePairingQrOrCode(`elviptv://pair?c=1234ABCD&pk=${pkB64}`).ok).toBe(false);
    expect(parsePairingQrOrCode('javascript:alert(1)').ok).toBe(false);
    expect(parsePairingQrOrCode('').ok).toBe(false);
  });

  it('derives transcript-bound 4-digit SAS + distinct directional AES-256-GCM keys and authenticates transfers', () => {
    const rng = seededRandom(909);
    const hostKp = generateX25519KeyPair(rng);
    const responderKp = generateX25519KeyPair(rng);

    const sharedHost = x25519(hostKp.privateKey, responderKp.publicKey);
    const sharedResponder = x25519(responderKp.privateKey, hostKp.publicKey);
    expect(sharedHost).toEqual(sharedResponder);

    const transcript = {
      code: '48291037',
      hostPublicKey: hostKp.publicKey,
      responderPublicKey: responderKp.publicKey,
    };
    const hostKeys = derivePairingSessionKeys(sharedHost, transcript);
    const responderKeys = derivePairingSessionKeys(sharedResponder, transcript);

    expect(hostKeys.sas).toMatch(/^\d{4}$/);
    expect(hostKeys.sas).toBe(responderKeys.sas);
    expect(hostKeys.hostToResponderKey).toEqual(responderKeys.hostToResponderKey);
    expect(hostKeys.responderToHostKey).toEqual(responderKeys.responderToHostKey);
    expect(hostKeys.hostToResponderKey).toHaveLength(32);
    expect(hostKeys.responderToHostKey).toHaveLength(32);
    expect(hostKeys.hostToResponderKey).not.toEqual(hostKeys.responderToHostKey);

    // Changing any transcript field rotates SAS & directional keys
    const differentCodeKeys = derivePairingSessionKeys(sharedHost, {
      ...transcript,
      code: '48291038',
    });
    expect(differentCodeKeys.hostToResponderKey).not.toEqual(hostKeys.hostToResponderKey);

    // Bidirectional transfer encryption + authentication
    const payload = {
      email: 'alice@example.test',
      refreshToken: 'ref_bidirectional_secret',
      vaultKeyB64: base64UrlEncode(new Uint8Array(32).fill(0x44)),
    };
    const encryptedH2R = encryptPairingTransfer(
      hostKeys.hostToResponderKey,
      hostKeys.aad,
      payload,
      { randomBytes: rng },
    );
    expect(encryptedH2R.ciphertext).not.toContain('ref_bidirectional_secret');
    expect(encryptedH2R.ciphertext).not.toContain('alice@example.test');

    const decryptedH2R = decryptPairingTransfer(
      responderKeys.hostToResponderKey,
      responderKeys.aad,
      encryptedH2R.ciphertext,
      encryptedH2R.iv,
    );
    expect(decryptedH2R).toEqual(payload);

    // Reflection attack (wrong directional key) MUST fail!
    expect(() =>
      decryptPairingTransfer(
        responderKeys.responderToHostKey,
        responderKeys.aad,
        encryptedH2R.ciphertext,
        encryptedH2R.iv,
      ),
    ).toThrow();

    // Tampered transcript AAD MUST fail!
    expect(() =>
      decryptPairingTransfer(
        responderKeys.hostToResponderKey,
        differentCodeKeys.aad,
        encryptedH2R.ciphertext,
        encryptedH2R.iv,
      ),
    ).toThrow();

    // All-zero shared secret rejected
    expect(() => derivePairingSessionKeys(new Uint8Array(32), transcript)).toThrow();
  });

  it('resolves all 5 pairing direction cases deterministically via normalized email hashes', () => {
    const aliceHash = hashPairingEmail('alice@example.com');
    const aliceHashUpper = aliceHash.toUpperCase();
    const bobHash = hashPairingEmail('bob@example.com');

    expect(resolvePairingDirection({ signedIn: false }, { signedIn: false })).toBe(
      'neither_signed_in',
    );
    expect(
      resolvePairingDirection({ signedIn: false }, { signedIn: true, emailHash: aliceHash }),
    ).toBe('responder_to_host');
    expect(
      resolvePairingDirection({ signedIn: true, emailHash: aliceHash }, { signedIn: false }),
    ).toBe('host_to_responder');
    expect(
      resolvePairingDirection(
        { signedIn: true, emailHash: aliceHash },
        { signedIn: true, emailHash: aliceHashUpper },
      ),
    ).toBe('same_account');
    expect(
      resolvePairingDirection(
        { signedIn: true, emailHash: aliceHash },
        { signedIn: true, emailHash: bobHash },
      ),
    ).toBe('different_accounts');
    // Missing/malformed hash when both signed in fails safe to different_accounts
    expect(
      resolvePairingDirection({ signedIn: true, emailHash: 'not-a-hash' }, { signedIn: true }),
    ).toBe('different_accounts');
  });
});
