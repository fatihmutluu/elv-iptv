import { request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createSyncApp, type SyncAppConfig } from './app.ts';
import { sha256Base64Url, signAccessToken, verifyAccessToken } from './crypto.ts';
import type { TelemetryDigestReport } from './digest.ts';
import { startNodeSyncServer } from './node-server.ts';
import { createSlidingWindowRateLimiter } from './rate-limit.ts';
import { createMemoryStorage } from './storage-memory.ts';

const TEST_JWT_SECRET = 'jwt-security-secret-0123456789abcdef';
const TEST_ADMIN_TOKEN = 'admin-security-token-0123456789';

const VALID_REGISTER_BODY = {
  email: 'sec@example.com',
  authVerifier: 'verifier_base64url_string_0123456789abcdef',
  kdfSalt: 'salt_base64url_0123456789',
  kdfIterations: 210_000,
  wrappedVaultKey: 'wrapped_vault_key_ciphertext_0123456789',
  recoveryWrappedVaultKey: 'recovery_wrapped_key_ciphertext_0123456789',
};

function makeApp(overrides: Partial<SyncAppConfig> = {}) {
  let currentMs = Date.parse('2026-11-25T12:00:00.000Z');
  const storage = overrides.storage ?? createMemoryStorage();
  const app = createSyncApp({
    storage,
    jwtSecret: TEST_JWT_SECRET,
    adminToken: TEST_ADMIN_TOKEN,
    verifierHashIterations: 1_000,
    now: () => currentMs,
    ...overrides,
  });
  return {
    app,
    storage,
    advanceMs(delta: number) {
      currentMs += delta;
    },
    getNowMs: () => currentMs,
  };
}

function jsonReq(
  path: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Request {
  const init: RequestInit = {
    method,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return new Request(`https://sync.example.test${path}`, init);
}

function sendRawTcp(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(payload);
    });
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      data += chunk;
    });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

function sendChunkedPost(
  port: number,
  path: string,
  chunks: readonly Buffer[],
): Promise<{ readonly statusCode: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked',
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          body += d;
        });
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', () => {
      // Server closes socket after flushing 413 response; ignore client-side EPIPE/ECONNRESET
    });
    for (const chunk of chunks) {
      if (req.destroyed) break;
      req.write(chunk);
    }
    if (!req.destroyed) req.end();
    setTimeout(() => reject(new Error('Chunked POST timed out')), 5_000).unref();
  });
}

describe('ELV Sync Server security & hardening regressions', () => {
  it('#1: POST /v1/auth/pair-token mints an independent refresh family without kicking out scanner', async () => {
    const { app, storage } = makeApp();

    // Unauthenticated rejected
    expect((await app.fetch(jsonReq('/v1/auth/pair-token', 'POST'))).status).toBe(401);

    const regRes = await app.fetch(jsonReq('/v1/auth/register', 'POST', VALID_REGISTER_BODY));
    expect(regRes.status).toBe(201);
    const scanner = (await regRes.json()) as {
      user: { id: string };
      accessToken: string;
      refreshToken: string;
    };

    // Mint independent pair refresh token
    const pairTokenRes = await app.fetch(
      jsonReq('/v1/auth/pair-token', 'POST', undefined, {
        authorization: `Bearer ${scanner.accessToken}`,
      }),
    );
    expect(pairTokenRes.status).toBe(201);
    const { refreshToken: pairedRefresh } = (await pairTokenRes.json()) as { refreshToken: string };
    expect(pairedRefresh).not.toBe(scanner.refreshToken);

    const scannerRec = await storage.findRefreshTokenByHash(
      await sha256Base64Url(scanner.refreshToken),
    );
    const pairedRec = await storage.findRefreshTokenByHash(await sha256Base64Url(pairedRefresh));
    expect(scannerRec?.familyId).toBeTruthy();
    expect(pairedRec?.familyId).toBeTruthy();
    expect(pairedRec?.familyId).not.toBe(scannerRec?.familyId);

    // Paired device rotates its token; scanner's original token STILL refreshes cleanly
    const pairedRot = await app.fetch(
      jsonReq('/v1/auth/refresh', 'POST', { refreshToken: pairedRefresh }),
    );
    expect(pairedRot.status).toBe(200);

    const scannerRot = await app.fetch(
      jsonReq('/v1/auth/refresh', 'POST', { refreshToken: scanner.refreshToken }),
    );
    expect(scannerRot.status).toBe(200);
    const scannerRotBody = (await scannerRot.json()) as { refreshToken: string };

    // Reuse attack on paired family ONLY revokes paired family, NOT scanner's family
    const pairedReuse = await app.fetch(
      jsonReq('/v1/auth/refresh', 'POST', { refreshToken: pairedRefresh }),
    );
    expect(pairedReuse.status).toBe(401);

    const scannerStillAlive = await app.fetch(
      jsonReq('/v1/auth/refresh', 'POST', { refreshToken: scannerRotBody.refreshToken }),
    );
    expect(scannerStillAlive.status).toBe(200);
  });

  it('#5: enforces explicit proxy trust, vault/admin rate limits, and bounded LRU rate limiter', async () => {
    // Default trustProxy === 'none' ignores spoofed cf-connecting-ip, x-forwarded-for, x-real-ip
    const { app } = makeApp({
      rateLimits: {
        auth: { windowMs: 60_000, maxRequests: 2 },
        vault: { windowMs: 60_000, maxRequests: 2 },
        admin: { windowMs: 60_000, maxRequests: 1 },
      },
    });

    const a1 = await app.fetch(
      jsonReq('/v1/auth/login', 'POST', {}, { 'cf-connecting-ip': '1.1.1.1' }),
      { clientIp: '10.0.0.5' },
    );
    const a2 = await app.fetch(
      jsonReq('/v1/auth/login', 'POST', {}, { 'x-forwarded-for': '2.2.2.2' }),
      { clientIp: '10.0.0.5' },
    );
    const a3 = await app.fetch(jsonReq('/v1/auth/login', 'POST', {}, { 'x-real-ip': '3.3.3.3' }), {
      clientIp: '10.0.0.5',
    });
    expect(a1.status).toBe(401);
    expect(a2.status).toBe(401);
    expect(a3.status).toBe(429);

    // Different direct clientIp is isolated
    const regRes = await app.fetch(jsonReq('/v1/auth/register', 'POST', VALID_REGISTER_BODY), {
      clientIp: '10.0.0.6',
    });
    expect(regRes.status).toBe(201);
    const { accessToken } = (await regRes.json()) as { accessToken: string };
    const authHdr = { authorization: `Bearer ${accessToken}` };

    // GET/PUT /v1/vault are rate-limited
    const v1 = await app.fetch(
      new Request('https://sync.example.test/v1/vault', { headers: authHdr }),
      { clientIp: '10.0.0.6' },
    );
    const v2 = await app.fetch(
      jsonReq(
        '/v1/vault',
        'PUT',
        { expectedRevision: 0, ciphertext: 'vault_cipher_0123456789', iv: 'iv_0123456789ab' },
        authHdr,
      ),
      { clientIp: '10.0.0.6' },
    );
    const v3 = await app.fetch(
      new Request('https://sync.example.test/v1/vault', { headers: authHdr }),
      { clientIp: '10.0.0.6' },
    );
    expect(v1.status).toBe(200);
    expect(v2.status).toBe(200);
    expect(v3.status).toBe(429);

    // GET /v1/admin/digest is rate-limited
    const d1 = await app.fetch(
      new Request('https://sync.example.test/v1/admin/digest', {
        headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      }),
      { clientIp: '10.0.0.6' },
    );
    const d2 = await app.fetch(
      new Request('https://sync.example.test/v1/admin/digest', {
        headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      }),
      { clientIp: '10.0.0.6' },
    );
    expect(d1.status).toBe(200);
    expect(d2.status).toBe(429);

    // Cloudflare mode honors cf-connecting-ip and ignores x-forwarded-for / x-real-ip
    const cfApp = makeApp({
      trustProxy: 'cloudflare',
      rateLimits: { auth: { windowMs: 60_000, maxRequests: 1 } },
    }).app;
    expect(
      (
        await cfApp.fetch(
          jsonReq(
            '/v1/auth/login',
            'POST',
            {},
            { 'cf-connecting-ip': '203.0.113.1', 'x-forwarded-for': '198.51.100.1' },
          ),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await cfApp.fetch(
          jsonReq(
            '/v1/auth/login',
            'POST',
            {},
            { 'cf-connecting-ip': '203.0.113.1', 'x-forwarded-for': '198.51.100.2' },
          ),
        )
      ).status,
    ).toBe(429);

    // SlidingWindowRateLimiter evicts cleanly at capacity without breaking active tracking
    let fakeNow = 1_000;
    const limiter = createSlidingWindowRateLimiter(() => fakeNow, 3);
    const rule = { windowMs: 10_000, maxRequests: 1 };
    expect(limiter.check('auth', 'ip-1', rule).allowed).toBe(true);
    expect(limiter.check('auth', 'ip-2', rule).allowed).toBe(true);
    expect(limiter.check('auth', 'ip-3', rule).allowed).toBe(true);
    expect(limiter.check('auth', 'ip-4', rule).allowed).toBe(true); // evicts ip-1
    expect(limiter.check('auth', 'ip-4', rule).allowed).toBe(false);
    fakeNow += 40_000;
    expect(limiter.check('auth', 'ip-5', rule).allowed).toBe(true); // triggers expiry sweep
  });

  it('#6: persists validated POST /account-deletion requests with hashed email and surfaces count in digest', async () => {
    const { app, storage } = makeApp();

    // Invalid email rejected with 400 (not persisted)
    const badJson = await app.fetch(
      new Request('https://sync.example.test/account-deletion', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ email: 'not-an-email' }),
      }),
    );
    expect(badJson.status).toBe(400);

    const badForm = await app.fetch(
      new Request('https://sync.example.test/account-deletion', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'email=invalid',
      }),
    );
    expect(badForm.status).toBe(400);
    expect(await storage.countAccountDeletionRequests()).toBe(0);

    // Oversized body (> 16 KiB) rejected with 413
    const huge = await app.fetch(
      new Request('https://sync.example.test/account-deletion', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ email: 'a@b.co', note: 'x'.repeat(20 * 1024) }),
      }),
    );
    expect(huge.status).toBe(413);

    // Valid URL-encoded submission with long note (clamped to <= 500 chars)
    const longNote = 'n'.repeat(800);
    const formOk = await app.fetch(
      new Request('https://sync.example.test/account-deletion', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `email=Alice%40Example.com&note=${longNote}`,
      }),
    );
    expect(formOk.status).toBe(200);

    // Valid JSON submission for non-existent user returns identical non-enumerating 200
    const jsonOk = await app.fetch(
      new Request('https://sync.example.test/account-deletion', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ email: 'ghost@example.com', note: 'delete me' }),
      }),
    );
    expect(jsonOk.status).toBe(200);
    expect(await storage.countAccountDeletionRequests()).toBe(2);

    // Surfaced in GET /v1/admin/digest
    const digestRes = await app.fetch(
      new Request('https://sync.example.test/v1/admin/digest', {
        headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      }),
    );
    expect(digestRes.status).toBe(200);
    const digest = (await digestRes.json()) as TelemetryDigestReport;
    expect(digest.pendingAccountDeletionRequests).toBe(2);
  });

  it('#7: rejects still-valid 15m JWT immediately after account deletion on all authenticated routes', async () => {
    const { app, storage } = makeApp();
    const reg = await app.fetch(jsonReq('/v1/auth/register', 'POST', VALID_REGISTER_BODY));
    const { user, accessToken } = (await reg.json()) as {
      user: { id: string };
      accessToken: string;
    };
    const authHdr = { authorization: `Bearer ${accessToken}` };

    const pairRes = await app.fetch(jsonReq('/v1/pair/create', 'POST'));
    const pair = (await pairRes.json()) as { code: string };

    // Delete account
    const delRes = await app.fetch(
      jsonReq(
        '/v1/auth/account',
        'DELETE',
        { authVerifier: VALID_REGISTER_BODY.authVerifier },
        authHdr,
      ),
    );
    expect(delRes.status).toBe(200);

    // Still-unexpired JWT MUST get 401 on vault GET/PUT, pair claim, pair-token, and delete
    expect(
      (await app.fetch(new Request('https://sync.example.test/v1/vault', { headers: authHdr })))
        .status,
    ).toBe(401);
    expect(
      (
        await app.fetch(
          jsonReq(
            '/v1/vault',
            'PUT',
            { expectedRevision: 0, ciphertext: 'resurrect_attempt_123456', iv: 'iv_0123456789ab' },
            authHdr,
          ),
        )
      ).status,
    ).toBe(401);
    expect(await storage.getVault(user.id)).toBeNull();
    expect(
      (
        await app.fetch(
          jsonReq(
            '/v1/pair/claim',
            'POST',
            {
              code: pair.code,
              encryptedPayload: 'ciphertext_payload_12345',
              iv: 'iv_0123456789ab',
            },
            authHdr,
          ),
        )
      ).status,
    ).toBe(401);
    expect(
      (await app.fetch(jsonReq('/v1/auth/pair-token', 'POST', undefined, authHdr))).status,
    ).toBe(401);
  });

  it('#8: expands diagnostics sensitive bans and scrubs URLs/IPs/paths/credentials from feedback.message', async () => {
    const { app } = makeApp({
      rateLimits: { feedback: { windowMs: 60_000, maxRequests: 100 } },
    });

    const blockedDiagValues = [
      'rtsp://stream.local/live/1',
      'rtmp://live.host/app/stream',
      'udp://239.0.0.1:1234',
      'rtp://239.0.0.2:5004',
      'tcp://10.0.0.9:9000',
      'file:/etc/hosts',
      'file:<redacted>',
      '2001:db8::1',
      'fe80::1',
      '::1',
      '192.168.1.42',
      '/storage/emulated/0/playlist.m3u',
      '/tmp/stream.ts',
      '/var/log/app.log',
      '/home/alice/list.m3u',
      '/Users/alice/list.m3u',
      'D:\\IPTV\\channels.m3u',
    ];
    for (const val of blockedDiagValues) {
      const res = await app.fetch(
        jsonReq('/v1/feedback', 'POST', {
          category: 'playback_issue',
          message: 'Buffering issue',
          diagnostics: { detail: val },
        }),
      );
      expect(res.status, `Expected 400 for sensitive diagnostic: ${val}`).toBe(400);
    }

    // Feedback message with embedded URLs, IPs, paths, credentials is accepted & scrubbed server-side
    const fbRes = await app.fetch(
      jsonReq('/v1/feedback', 'POST', {
        category: 'playback_issue',
        message:
          'Fails on https://iptv.secret.example:8080/live/u/p/1.ts rtsp://10.0.0.1/a rtmp://b/c udp://239.1.1.1:1234 rtp://239.1.1.2:5004 tcp://10.0.0.2:80 file:/tmp/a.m3u user:pass@host.net Bearer secret_token_123456 /storage/emulated/0/x.m3u /var/log/y /home/u/z /Users/u/q C:\\Users\\u\\a.m3u [2001:db8::1]:8080 fe80::1 198.51.100.9:8080',
        appVersion: '1.3.0',
        platform: 'android-tv',
      }),
    );
    expect(fbRes.status).toBe(201);

    const digestRes = await app.fetch(
      new Request('https://sync.example.test/v1/admin/digest', {
        headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      }),
    );
    const digest = (await digestRes.json()) as TelemetryDigestReport;
    const saved = digest.recentFeedback[0]?.message ?? '';
    expect(saved).toContain('[redacted]');
    for (const forbidden of [
      'iptv.secret.example',
      'rtsp://',
      'rtmp://',
      'udp://',
      'rtp://',
      'tcp://',
      'file:',
      'user:pass@',
      'secret_token_123456',
      '/storage/',
      '/var/',
      '/home/',
      '/Users/',
      'C:\\Users',
      '2001:db8',
      'fe80::1',
      '198.51.100.9',
    ]) {
      expect(saved).not.toContain(forbidden);
    }
  });

  it('#11: rejects weak/empty JWT_SECRET and malformed/padded base64url JWT segments', async () => {
    const storage = createMemoryStorage();
    expect(() => createSyncApp({ storage, jwtSecret: '' })).toThrow(/JWT_SECRET/);
    expect(() => createSyncApp({ storage, jwtSecret: '   short   ' })).toThrow(/JWT_SECRET/);
    expect(() => createSyncApp({ storage, jwtSecret: '123456789012345' })).toThrow(/JWT_SECRET/);
    await expect(startNodeSyncServer({ port: 0, jwtSecret: '' })).rejects.toThrow(/JWT_SECRET/);
    await expect(startNodeSyncServer({ port: 0, jwtSecret: 'too-short' })).rejects.toThrow(
      /JWT_SECRET/,
    );

    const nowSec = 1_764_072_000;
    const validJwt = await signAccessToken({ sub: 'u1', email: 'a@b.co' }, TEST_JWT_SECRET, nowSec);
    expect(await verifyAccessToken(validJwt, TEST_JWT_SECRET, nowSec)).not.toBeNull();

    const [h, p, s] = validJwt.split('.');
    // Reject '=' padding on signature or payload
    expect(await verifyAccessToken(`${h}.${p}.${s}=`, TEST_JWT_SECRET, nowSec)).toBeNull();
    expect(await verifyAccessToken(`${h}.${p}=.${s}`, TEST_JWT_SECRET, nowSec)).toBeNull();
    // Reject len % 4 === 1 segment and odd-length padded 'AA='
    expect(await verifyAccessToken(`${h}.${p}.A`, TEST_JWT_SECRET, nowSec)).toBeNull();
    expect(await verifyAccessToken(`${h}.${p}.AA=`, TEST_JWT_SECRET, nowSec)).toBeNull();
  });

  it('#12: caps in-memory telemetry/feedback FIFO and prunes expired pair sessions & refresh tokens', async () => {
    const storage = createMemoryStorage();

    // Telemetry FIFO cap at 5000
    const batch = Array.from({ length: 5_050 }, (_, i) => ({
      id: `t-${i}`,
      receivedAt: '2026-11-25T12:00:00.000Z',
      eventTs: '2026-11-25T12:00:00.000Z',
      sessionId: 'sess-cap',
      kind: 'startup',
      appVersion: '1.0.0',
      platform: 'windows',
      osVersion: null,
      formFactor: null,
      payloadJson: '{"durationMs":100}',
      deviceProfileJson: null,
    }));
    await storage.insertTelemetryEvents(batch);
    const storedTel = await storage.listTelemetryEvents(null);
    expect(storedTel).toHaveLength(5_000);
    expect(storedTel[0]?.id).toBe('t-50');
    expect(storedTel.at(-1)?.id).toBe('t-5049');

    // Feedback FIFO cap at 500
    for (let i = 0; i < 510; i += 1) {
      await storage.insertFeedbackSubmission({
        id: `fb-${i}`,
        receivedAt: `2026-11-25T12:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
        category: 'other',
        message: `msg-${i}`,
        appVersion: '1.0.0',
        platform: 'windows',
        locale: 'en',
        diagnosticsJson: null,
      });
    }
    expect(await storage.listFeedbackSubmissions(null)).toHaveLength(500);

    // Expired pair sessions & refresh tokens pruned when new ones are inserted
    const emptyV2Fields = {
      attempts: 0,
      hostPublicKey: null,
      responderPublicKey: null,
      hostAuthState: 'signed_out' as const,
      hostMaskedEmail: null,
      hostEmailHash: null,
      responderAuthState: null,
      responderMaskedEmail: null,
      responderEmailHash: null,
      responderTokenHash: null,
      direction: null,
      hostApprovedAt: null,
      returnEncryptedPayload: null,
      returnIv: null,
    };
    await storage.createPairSession({
      id: 'p-old',
      code: 'OLDPAIR12345',
      pollTokenHash: 'h-old',
      status: 'pending',
      claimedByUserId: null,
      encryptedPayload: null,
      iv: null,
      ...emptyV2Fields,
      expiresAt: '2026-11-25T12:05:00.000Z',
      createdAt: '2026-11-25T12:00:00.000Z',
    });
    await storage.createPairSession({
      id: 'p-new',
      code: 'NEWPAIR12345',
      pollTokenHash: 'h-new',
      status: 'pending',
      claimedByUserId: null,
      encryptedPayload: null,
      iv: null,
      ...emptyV2Fields,
      expiresAt: '2026-11-25T12:15:00.000Z',
      createdAt: '2026-11-25T12:10:00.000Z',
    });
    expect(await storage.findPairSessionById('p-old')).toBeNull();
    expect(await storage.findPairSessionById('p-new')).not.toBeNull();

    await storage.insertRefreshToken({
      id: 'rt-old',
      userId: 'u1',
      familyId: 'f1',
      tokenHash: 'hash-old',
      replacedById: null,
      revokedAt: null,
      expiresAt: '2026-11-25T12:05:00.000Z',
      createdAt: '2026-11-25T12:00:00.000Z',
    });
    await storage.insertRefreshToken({
      id: 'rt-new',
      userId: 'u1',
      familyId: 'f2',
      tokenHash: 'hash-new',
      replacedById: null,
      revokedAt: null,
      expiresAt: '2026-12-25T12:10:00.000Z',
      createdAt: '2026-11-25T12:10:00.000Z',
    });
    expect(await storage.findRefreshTokenByHash('hash-old')).toBeNull();
    expect(await storage.findRefreshTokenByHash('hash-new')).not.toBeNull();
  });

  it('#12 & #13 & #5 (Node HTTP): enforces per-route 413 body caps, 400 on malformed Host/ts/URI, and peer-IP rate limits', async () => {
    const { app } = makeApp();

    // Out-of-range numeric ts -> 400 (never 500 RangeError)
    const badTs = await app.fetch(
      jsonReq('/v1/telemetry', 'POST', {
        sessionId: 'sess-ts',
        appVersion: '1.0.0',
        platform: 'windows',
        events: [{ kind: 'startup', ts: 1e20, durationMs: 100 }],
      }),
    );
    expect(badTs.status).toBe(400);

    // Malformed percent encoding in /v1/pair/poll/:id -> 400 (never 500 URIError)
    const badPoll = await app.fetch(new Request('https://sync.example.test/v1/pair/poll/%E0%A4%A'));
    expect(badPoll.status).toBe(400);

    const running = await startNodeSyncServer({
      port: 0,
      host: '127.0.0.1',
      jwtSecret: TEST_JWT_SECRET,
      adminToken: TEST_ADMIN_TOKEN,
      verifierHashIterations: 1_000,
      rateLimits: { auth: { windowMs: 60_000, maxRequests: 2 } },
    });
    try {
      // Malformed Host header over raw TCP -> 400 (never 500 TypeError)
      const rawHostResp = await sendRawTcp(
        running.port,
        'GET /health HTTP/1.1\r\nHost: bad host:123\r\nConnection: close\r\n\r\n',
      );
      expect(rawHostResp).toContain('HTTP/1.1 400');

      // Oversized Content-Length (> 64 KiB on /v1/auth/login) -> clean 413
      const bigLogin = await fetch(`${running.url}/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(70 * 1024),
      });
      expect(bigLogin.status).toBe(413);

      // Oversized chunked stream (no Content-Length) -> clean 413 without destroying socket before writeHead
      const chunkedRes = await sendChunkedPost(running.port, '/v1/auth/login', [
        Buffer.alloc(40 * 1024, 0x61),
        Buffer.alloc(40 * 1024, 0x62),
      ]);
      expect(chunkedRes.statusCode).toBe(413);
      expect(JSON.parse(chunkedRes.body)).toMatchObject({ error: 'payload_too_large' });

      // Spoofing proxy headers cannot bypass Node socket peer-IP rate limit
      const r1 = await fetch(`${running.url}/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4' },
        body: '{}',
      });
      const r2 = await fetch(`${running.url}/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '5.6.7.8' },
        body: '{}',
      });
      const r3 = await fetch(`${running.url}/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-real-ip': '9.10.11.12' },
        body: '{}',
      });
      expect(r1.status).toBe(401);
      expect(r2.status).toBe(401);
      expect(r3.status).toBe(429);
    } finally {
      await running.close();
    }
  });

  it('#14 (Wave P9): blocks raw pairing code storage at rest and direction-tampering lockout', async () => {
    const { app, storage } = makeApp();
    const hostPk = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE';
    const responderPk = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAI';

    const createdRes = await app.fetch(
      jsonReq('/v1/pair/create', 'POST', {
        hostPublicKey: hostPk,
        hostAuthState: 'signed_out',
      }),
    );
    expect(createdRes.status).toBe(201);
    const created = (await createdRes.json()) as {
      pairingId: string;
      code: string;
      pollToken: string;
    };

    // Stored record MUST hash code and pollToken (never plaintext at rest!)
    const stored = await storage.findPairSessionById(created.pairingId);
    expect(stored?.code).not.toBe(created.code);
    expect(stored?.code).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.pollTokenHash).not.toBe(created.pollToken);

    // Tampered direction inconsistent with auth states increments attempts & locks at 3
    for (let i = 0; i < 2; i += 1) {
      const bad = await app.fetch(
        jsonReq('/v1/pair/respond', 'POST', {
          code: created.code,
          responderPublicKey: responderPk,
          responderAuthState: 'signed_out',
          direction: 'host_to_responder',
        }),
      );
      expect(bad.status).toBe(400);
    }
    const third = await app.fetch(
      jsonReq('/v1/pair/respond', 'POST', {
        code: created.code,
        responderPublicKey: responderPk,
        responderAuthState: 'signed_out',
        direction: 'host_to_responder',
      }),
    );
    expect(third.status).toBe(423);
  });
});
