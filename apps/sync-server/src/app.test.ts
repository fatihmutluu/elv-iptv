import { describe, expect, it } from 'vitest';
import { createSyncApp, type SyncAppConfig } from './app.ts';
import {
  DEFAULT_VERIFIER_HASH_ITERATIONS,
  hashAuthVerifier,
  verifyAccessToken,
  verifyAuthVerifier,
} from './crypto.ts';
import type { TelemetryDigestReport } from './digest.ts';
import { startNodeSyncServer } from './node-server.ts';
import { createMemoryStorage } from './storage-memory.ts';

const TEST_JWT_SECRET = 'jwt-test-'.repeat(5);
const TEST_ADMIN_TOKEN = 'admin-test-'.repeat(4);
const WRONG_VERIFIER = 'wrong-verifier-'.repeat(3);

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

const VALID_REGISTER_BODY = {
  email: 'Alice@Example.com',
  authVerifier: 'verifier_base64url_string_0123456789abcdef',
  kdfSalt: 'salt_base64url_0123456789',
  kdfIterations: 210_000,
  wrappedVaultKey: 'wrapped_vault_key_ciphertext_0123456789',
  recoveryWrappedVaultKey: 'recovery_wrapped_key_ciphertext_0123456789',
};

describe('ELV Sync Server (@elv/sync-server)', () => {
  it('serves GET /health, CORS OPTIONS preflight, and 404 for unknown routes', async () => {
    const { app } = makeApp({ publicOrigin: 'https://app.elviptv.test' });

    const health = await app.fetch(new Request('https://sync.example.test/health'));
    expect(health.status).toBe(200);
    expect(health.headers.get('access-control-allow-origin')).toBe('https://app.elviptv.test');
    expect(await health.json()).toEqual({
      ok: true,
      service: 'elv-sync-server',
      version: '1.0.0',
    });

    const preflight = await app.fetch(
      new Request('https://sync.example.test/v1/vault', { method: 'OPTIONS' }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toContain('DELETE');

    const missing = await app.fetch(new Request('https://sync.example.test/v1/nope'));
    expect(missing.status).toBe(404);
  });

  it('serves bilingual EN/TR /account-deletion page with strict security headers and non-enumerating POST', async () => {
    const { app } = makeApp();

    const getRes = await app.fetch(new Request('https://sync.example.test/account-deletion'));
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('content-type')).toContain('text/html');
    expect(getRes.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(getRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(getRes.headers.get('x-frame-options')).toBe('DENY');
    const html = await getRes.text();
    expect(html).toContain('Settings &rarr; Account &rarr; Delete Account');
    expect(html).toContain('Hesabı Kalıcı Olarak Sil');

    const formPost = await app.fetch(
      new Request('https://sync.example.test/account-deletion', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'email=nobody%40example.com&note=delete+please',
      }),
    );
    expect(formPost.status).toBe(200);
    expect(await formPost.text()).toContain('Request received');

    const jsonPost = await app.fetch(
      new Request('https://sync.example.test/account-deletion', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ email: 'nobody@example.com' }),
      }),
    );
    expect(jsonPost.status).toBe(200);
    const jsonBody = (await jsonPost.json()) as { accepted: boolean };
    expect(jsonBody.accepted).toBe(true);
  });

  it('supports default 100,000 PBKDF2 iterations for verifier storage hashing', async () => {
    const hashed = await hashAuthVerifier('verifier-sample-token-1234567890');
    expect(hashed.iterations).toBe(DEFAULT_VERIFIER_HASH_ITERATIONS);
    expect(hashed.iterations).toBe(100_000);
    expect(
      await verifyAuthVerifier(
        'verifier-sample-token-1234567890',
        hashed.salt,
        hashed.iterations,
        hashed.hash,
      ),
    ).toBe(true);
    expect(
      await verifyAuthVerifier(
        'wrong-verifier-token-1234567890',
        hashed.salt,
        hashed.iterations,
        hashed.hash,
      ),
    ).toBe(false);
  });

  it('handles register, duplicate 409, login, refresh rotation, reuse family revocation, logout, and permanent account deletion', async () => {
    const { app, advanceMs, getNowMs } = makeApp();

    // Validation errors
    const badIter = await app.fetch(
      jsonReq('/v1/auth/register', 'POST', { ...VALID_REGISTER_BODY, kdfIterations: 50_000 }),
    );
    expect(badIter.status).toBe(400);

    // Register
    const regRes = await app.fetch(jsonReq('/v1/auth/register', 'POST', VALID_REGISTER_BODY));
    expect(regRes.status).toBe(201);
    const regBody = (await regRes.json()) as {
      user: { id: string; email: string };
      accessToken: string;
      refreshToken: string;
    };
    expect(regBody.user.email).toBe('alice@example.com');
    const claims = await verifyAccessToken(
      regBody.accessToken,
      TEST_JWT_SECRET,
      Math.floor(getNowMs() / 1000),
    );
    expect(claims?.sub).toBe(regBody.user.id);

    // Duplicate email -> 409
    const dupRes = await app.fetch(jsonReq('/v1/auth/register', 'POST', VALID_REGISTER_BODY));
    expect(dupRes.status).toBe(409);

    // Login fails on wrong verifier & unknown email with generic 401
    const badPw = await app.fetch(
      jsonReq('/v1/auth/login', 'POST', {
        email: 'alice@example.com',
        authVerifier: WRONG_VERIFIER,
      }),
    );
    expect(badPw.status).toBe(401);
    const badEmail = await app.fetch(
      jsonReq('/v1/auth/login', 'POST', {
        email: 'unknown@example.com',
        authVerifier: VALID_REGISTER_BODY.authVerifier,
      }),
    );
    expect(badEmail.status).toBe(401);

    // Login succeeds and returns vaultMeta
    const loginRes = await app.fetch(
      jsonReq('/v1/auth/login', 'POST', {
        email: 'ALICE@example.com',
        authVerifier: VALID_REGISTER_BODY.authVerifier,
      }),
    );
    expect(loginRes.status).toBe(200);
    const loginBody = (await loginRes.json()) as {
      accessToken: string;
      refreshToken: string;
      vaultMeta: {
        kdfSalt: string;
        kdfIterations: number;
        wrappedVaultKey: string;
        recoveryWrappedVaultKey: string;
      };
    };
    expect(loginBody.vaultMeta).toEqual({
      kdfSalt: VALID_REGISTER_BODY.kdfSalt,
      kdfIterations: 210_000,
      wrappedVaultKey: VALID_REGISTER_BODY.wrappedVaultKey,
      recoveryWrappedVaultKey: VALID_REGISTER_BODY.recoveryWrappedVaultKey,
    });

    // Refresh rotates token
    const refresh1 = await app.fetch(
      jsonReq('/v1/auth/refresh', 'POST', { refreshToken: loginBody.refreshToken }),
    );
    expect(refresh1.status).toBe(200);
    const refresh1Body = (await refresh1.json()) as { accessToken: string; refreshToken: string };
    expect(refresh1Body.refreshToken).not.toBe(loginBody.refreshToken);

    // Reusing old refresh token revokes the entire family!
    const reuseAttempt = await app.fetch(
      jsonReq('/v1/auth/refresh', 'POST', { refreshToken: loginBody.refreshToken }),
    );
    expect(reuseAttempt.status).toBe(401);
    expect(((await reuseAttempt.json()) as { error: string }).error).toBe('refresh_token_reused');

    // Previously valid rotated sibling token is now also revoked
    const siblingAfterReuse = await app.fetch(
      jsonReq('/v1/auth/refresh', 'POST', { refreshToken: refresh1Body.refreshToken }),
    );
    expect(siblingAfterReuse.status).toBe(401);

    // Logout revokes the registration refresh token
    const logoutRes = await app.fetch(
      jsonReq('/v1/auth/logout', 'POST', { refreshToken: regBody.refreshToken }),
    );
    expect(logoutRes.status).toBe(200);
    const afterLogout = await app.fetch(
      jsonReq('/v1/auth/refresh', 'POST', { refreshToken: regBody.refreshToken }),
    );
    expect(afterLogout.status).toBe(401);

    // Re-login and store vault + delete account
    const login2 = await app.fetch(
      jsonReq('/v1/auth/login', 'POST', {
        email: 'alice@example.com',
        authVerifier: VALID_REGISTER_BODY.authVerifier,
      }),
    );
    const session2 = (await login2.json()) as { accessToken: string; refreshToken: string };

    const putVault = await app.fetch(
      jsonReq(
        '/v1/vault',
        'PUT',
        { expectedRevision: 0, ciphertext: 'opaque-vault-ciphertext-blob', iv: 'iv-123456789012' },
        { authorization: `Bearer ${session2.accessToken}` },
      ),
    );
    expect(putVault.status).toBe(200);

    // Delete account fails with wrong verifier
    const badDel = await app.fetch(
      jsonReq(
        '/v1/auth/account',
        'DELETE',
        { authVerifier: WRONG_VERIFIER },
        { authorization: `Bearer ${session2.accessToken}` },
      ),
    );
    expect(badDel.status).toBe(401);

    // Delete account succeeds with correct verifier
    const delRes = await app.fetch(
      jsonReq(
        '/v1/auth/account',
        'DELETE',
        { authVerifier: VALID_REGISTER_BODY.authVerifier },
        { authorization: `Bearer ${session2.accessToken}` },
      ),
    );
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({ deleted: true });

    // User, refresh token, and login are all gone
    const postDelLogin = await app.fetch(
      jsonReq('/v1/auth/login', 'POST', {
        email: 'alice@example.com',
        authVerifier: VALID_REGISTER_BODY.authVerifier,
      }),
    );
    expect(postDelLogin.status).toBe(401);

    const postDelRefresh = await app.fetch(
      jsonReq('/v1/auth/refresh', 'POST', { refreshToken: session2.refreshToken }),
    );
    expect(postDelRefresh.status).toBe(401);

    // Advance past JWT TTL (15m) -> old access token expires cleanly
    advanceMs(16 * 60 * 1000);
    const expiredVault = await app.fetch(
      new Request('https://sync.example.test/v1/vault', {
        headers: { authorization: `Bearer ${session2.accessToken}` },
      }),
    );
    expect(expiredVault.status).toBe(401);
  });

  it('enforces optimistic concurrency on GET/PUT /v1/vault and body size caps', async () => {
    const { app } = makeApp();
    const reg = await app.fetch(jsonReq('/v1/auth/register', 'POST', VALID_REGISTER_BODY));
    const { accessToken } = (await reg.json()) as { accessToken: string };
    const authHeader = { authorization: `Bearer ${accessToken}` };

    const initial = await app.fetch(
      new Request('https://sync.example.test/v1/vault', { headers: authHeader }),
    );
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({
      revision: 0,
      ciphertext: null,
      iv: null,
      updatedAt: null,
    });

    const put1 = await app.fetch(
      jsonReq(
        '/v1/vault',
        'PUT',
        { expectedRevision: 0, ciphertext: 'encrypted_blob_rev1_abcdef', iv: 'iv_abcdefghijkl' },
        authHeader,
      ),
    );
    expect(put1.status).toBe(200);
    expect(((await put1.json()) as { revision: number }).revision).toBe(1);

    // Stale write returns 409 with currentRevision
    const conflict = await app.fetch(
      jsonReq(
        '/v1/vault',
        'PUT',
        { expectedRevision: 0, ciphertext: 'stale_blob_abcdef123456', iv: 'iv_abcdefghijkl' },
        authHeader,
      ),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 });

    // Update at revision 1 succeeds
    const put2 = await app.fetch(
      jsonReq(
        '/v1/vault',
        'PUT',
        { expectedRevision: 1, ciphertext: 'encrypted_blob_rev2_abcdef', iv: 'iv_mnopqrstuvwx' },
        authHeader,
      ),
    );
    expect(put2.status).toBe(200);
    expect(((await put2.json()) as { revision: number }).revision).toBe(2);

    const fetched = await app.fetch(
      new Request('https://sync.example.test/v1/vault', { headers: authHeader }),
    );
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toMatchObject({
      revision: 2,
      ciphertext: 'encrypted_blob_rev2_abcdef',
      iv: 'iv_mnopqrstuvwx',
    });

    // Oversized auth body (> 64 KiB) returns 413
    const hugeAuth = await app.fetch(jsonReq('/v1/auth/login', 'POST', 'x'.repeat(70 * 1024)));
    expect(hugeAuth.status).toBe(413);
  });

  it('runs universal QR pairing create -> poll pending -> claim -> single-use consume and 410 expiry', async () => {
    const { app, advanceMs } = makeApp();
    const reg = await app.fetch(jsonReq('/v1/auth/register', 'POST', VALID_REGISTER_BODY));
    const { accessToken } = (await reg.json()) as { accessToken: string };

    const created = await app.fetch(jsonReq('/v1/pair/create', 'POST'));
    expect(created.status).toBe(201);
    const pair = (await created.json()) as {
      pairingId: string;
      code: string;
      pollToken: string;
      expiresAt: string;
    };
    expect(pair.code).toMatch(/^[A-Z0-9]{12}$/);

    // Missing & wrong poll token rejected
    expect(
      (await app.fetch(new Request(`https://sync.example.test/v1/pair/poll/${pair.pairingId}`)))
        .status,
    ).toBe(401);
    expect(
      (
        await app.fetch(
          new Request(`https://sync.example.test/v1/pair/poll/${pair.pairingId}`, {
            headers: { 'x-pair-poll-token': 'wrong-token' },
          }),
        )
      ).status,
    ).toBe(403);

    // Pending poll
    const pendingRes = await app.fetch(
      new Request(`https://sync.example.test/v1/pair/poll/${pair.pairingId}`, {
        headers: { 'x-pair-poll-token': pair.pollToken },
      }),
    );
    expect(pendingRes.status).toBe(200);
    expect(((await pendingRes.json()) as { status: string }).status).toBe('pending');

    // Claim requires auth
    expect(
      (
        await app.fetch(
          jsonReq('/v1/pair/claim', 'POST', {
            code: pair.code,
            encryptedPayload: 'ciphertext_payload_abcdef1234',
            iv: 'iv_123456789012',
          }),
        )
      ).status,
    ).toBe(401);

    // Claim succeeds once, second claim returns 409
    const claimRes = await app.fetch(
      jsonReq(
        '/v1/pair/claim',
        'POST',
        {
          code: pair.code.toLowerCase(),
          encryptedPayload: 'ciphertext_payload_abcdef1234',
          iv: 'iv_123456789012',
        },
        { authorization: `Bearer ${accessToken}` },
      ),
    );
    expect(claimRes.status).toBe(200);
    expect(await claimRes.json()).toEqual({ claimed: true });

    const secondClaim = await app.fetch(
      jsonReq(
        '/v1/pair/claim',
        'POST',
        {
          code: pair.code,
          encryptedPayload: 'other_payload_abcdef1234',
          iv: 'iv_123456789012',
        },
        { authorization: `Bearer ${accessToken}` },
      ),
    );
    expect(secondClaim.status).toBe(409);

    // First poll returns payload and atomically deletes session
    const consumedRes = await app.fetch(
      new Request(`https://sync.example.test/v1/pair/poll/${pair.pairingId}`, {
        headers: { 'x-pair-poll-token': pair.pollToken },
      }),
    );
    expect(consumedRes.status).toBe(200);
    expect(await consumedRes.json()).toEqual({
      status: 'claimed',
      encryptedPayload: 'ciphertext_payload_abcdef1234',
      iv: 'iv_123456789012',
    });

    // Second poll after consumption -> 404
    const replayPoll = await app.fetch(
      new Request(`https://sync.example.test/v1/pair/poll/${pair.pairingId}`, {
        headers: { 'x-pair-poll-token': pair.pollToken },
      }),
    );
    expect(replayPoll.status).toBe(404);

    // Expiry returns 410 on poll and claim
    const expPairRes = await app.fetch(jsonReq('/v1/pair/create', 'POST'));
    const expPair = (await expPairRes.json()) as {
      pairingId: string;
      code: string;
      pollToken: string;
    };
    const expPair2Res = await app.fetch(jsonReq('/v1/pair/create', 'POST'));
    const expPair2 = (await expPair2Res.json()) as {
      pairingId: string;
      code: string;
      pollToken: string;
    };

    advanceMs(6 * 60 * 1000);

    const expiredPoll = await app.fetch(
      new Request(`https://sync.example.test/v1/pair/poll/${expPair.pairingId}`, {
        headers: { 'x-pair-poll-token': expPair.pollToken },
      }),
    );
    expect(expiredPoll.status).toBe(410);

    const expiredClaim = await app.fetch(
      jsonReq(
        '/v1/pair/claim',
        'POST',
        {
          code: expPair2.code,
          encryptedPayload: 'ciphertext_payload_abcdef1234',
          iv: 'iv_123456789012',
        },
        { authorization: `Bearer ${accessToken}` },
      ),
    );
    expect(expiredClaim.status).toBe(410);
  });

  it('enforces telemetry kill-switch, strict allowlist, secret/URL/path bans, feedback validation, and admin digest', async () => {
    const disabledApp = makeApp({ telemetryDisabled: true });
    const disabledRes = await disabledApp.app.fetch(
      jsonReq('/v1/telemetry', 'POST', { events: [] }),
    );
    expect(disabledRes.status).toBe(200);
    expect(await disabledRes.json()).toEqual({ accepted: 0, disabled: true });

    const { app, advanceMs } = makeApp();

    // Reject sensitive patterns: URLs, credentials, Authorization, private file paths, IPv4
    const forbiddenPayloads = [
      { kind: 'playback_error', engine: 'media3', errorCode: 'https://provider.example/live/1.ts' },
      { kind: 'playback_error', engine: 'media3', errorCode: 'rtsp://stream.local/chan' },
      { kind: 'playback_error', engine: 'media3', errorCode: 'rtmp://stream.local/chan' },
      { kind: 'playback_error', engine: 'media3', errorCode: 'alice:secretpass@iptv.host' },
      { kind: 'playback_error', engine: 'media3', errorCode: 'Authorization failed' },
      { kind: 'playback_error', engine: 'media3', errorCode: '/Users/alice/playlist.m3u' },
      { kind: 'playback_error', engine: 'media3', errorCode: 'C:\\Users\\alice\\playlist.m3u' },
      { kind: 'playback_error', engine: 'media3', errorCode: 'host 192.168.1.42 refused' },
      { kind: 'unknown_event_kind', engine: 'media3' },
      { kind: 'startup', durationMs: 320, playlistTitle: 'Forbidden extra field' },
    ];
    for (const badEvent of forbiddenPayloads) {
      const res = await app.fetch(
        jsonReq('/v1/telemetry', 'POST', {
          sessionId: 'sess-bad-001',
          appVersion: '1.2.0',
          platform: 'android-tv',
          events: [badEvent],
        }),
      );
      expect(res.status).toBe(400);
    }

    // Submit rich valid telemetry batch
    const batch1 = await app.fetch(
      jsonReq('/v1/telemetry', 'POST', {
        sessionId: 'sess-001',
        appVersion: '1.2.0',
        platform: 'android-tv',
        events: [
          { kind: 'startup', durationMs: 420, coldStart: true },
          { kind: 'screen_transition', screen: 'live-tv', durationMs: 95 },
          { kind: 'screen_transition', screen: 'live-tv', durationMs: 240 },
          { kind: 'screen_transition', screen: 'epg-grid', durationMs: 310 },
          { kind: 'frame_jank', screen: 'epg-grid', droppedFrames: 8, durationMs: 140 },
          { kind: 'js_stall', screen: 'epg-grid', durationMs: 620, maxBlockMs: 620 },
          { kind: 'memory_pressure', level: 'moderate', usedMb: 380 },
          { kind: 'playback_start', engine: 'media3', durationMs: 550, isLive: true },
          { kind: 'playback_rebuffer', engine: 'media3', durationMs: 1200, isLive: true },
          { kind: 'playback_error', engine: 'media3', errorCode: 'HTTP_404', isLive: true },
          { kind: 'sqlite_slow_op', operation: 'fts_search', durationMs: 180, rowCount: 2500 },
          {
            kind: 'media_decode_failure',
            engine: 'media3',
            container: 'mpegts',
            videoCodec: 'hevc',
            audioCodec: 'ac3',
            errorCode: 'DECODER_INIT_FAILED',
            hdrFormat: 'hdr10',
            isLive: true,
          },
          {
            kind: 'media_decode_failure',
            engine: 'media3',
            container: 'mpegts',
            videoCodec: 'hevc',
            audioCodec: 'ac3',
            errorCode: 'DECODER_INIT_FAILED',
            hdrFormat: 'hdr10',
            isLive: true,
          },
        ],
      }),
    );
    expect(batch1.status).toBe(200);
    expect(await batch1.json()).toEqual({ accepted: 13, disabled: false });

    advanceMs(60_000);

    const batch2 = await app.fetch(
      jsonReq('/v1/telemetry', 'POST', {
        sessionId: 'sess-002',
        appVersion: '1.2.0',
        platform: 'windows',
        events: [
          { kind: 'startup', durationMs: 280, coldStart: false },
          {
            kind: 'media_decode_failure',
            engine: 'mpv',
            container: 'mkv',
            videoCodec: 'av1',
            audioCodec: 'eac3',
            errorCode: 'UNSUPPORTED_PROFILE',
            isLive: false,
          },
        ],
      }),
    );
    expect(batch2.status).toBe(200);

    // Feedback validation & submission
    expect(
      (await app.fetch(jsonReq('/v1/feedback', 'POST', { category: 'bogus', message: 'hello' })))
        .status,
    ).toBe(400);
    expect(
      (
        await app.fetch(
          jsonReq('/v1/feedback', 'POST', { category: 'playback_issue', message: '   ' }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await app.fetch(
          jsonReq('/v1/feedback', 'POST', {
            category: 'playback_issue',
            message: 'Audio out of sync',
            diagnostics: { stream: 'http://secret.host/1.ts' },
          }),
        )
      ).status,
    ).toBe(400);

    const fbRes = await app.fetch(
      jsonReq('/v1/feedback', 'POST', {
        category: 'playback_issue',
        message: 'HEVC AC3 live stream dropped audio on Android TV',
        appVersion: '1.2.0',
        platform: 'android-tv',
        locale: 'tr',
        diagnostics: { engine: 'media3', videoCodec: 'hevc', audioCodec: 'ac3' },
      }),
    );
    expect(fbRes.status).toBe(201);
    const fbBody = (await fbRes.json()) as { id: string };
    expect(fbBody.id.length).toBeGreaterThan(8);

    // Admin digest auth checks
    expect((await app.fetch(new Request('https://sync.example.test/v1/admin/digest'))).status).toBe(
      401,
    );
    expect(
      (
        await app.fetch(
          new Request('https://sync.example.test/v1/admin/digest', {
            headers: { authorization: 'Bearer wrong-admin-token' },
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await app.fetch(
          new Request('https://sync.example.test/v1/admin/digest?since=not-a-date', {
            headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
          }),
        )
      ).status,
    ).toBe(400);

    const unconfigured = makeApp({ adminToken: '' });
    expect(
      (
        await unconfigured.app.fetch(
          new Request('https://sync.example.test/v1/admin/digest', {
            headers: { authorization: 'Bearer anything' },
          }),
        )
      ).status,
    ).toBe(503);

    // Valid admin digest
    const digestRes = await app.fetch(
      new Request('https://sync.example.test/v1/admin/digest', {
        headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      }),
    );
    expect(digestRes.status).toBe(200);
    const report = (await digestRes.json()) as TelemetryDigestReport;
    expect(report.totals).toEqual({
      telemetryEvents: 15,
      uniqueSessions: 2,
      feedbackSubmissions: 1,
    });
    expect(report.startupLatency).toEqual({ count: 2, p50Ms: 280, p95Ms: 420, maxMs: 420 });
    expect(report.screenLatencies[0]).toMatchObject({ screen: 'epg-grid', p95Ms: 310 });
    expect(report.stallAndJank.jsStallEvents).toBe(1);
    expect(report.stallAndJank.maxStallMs).toBe(620);
    expect(report.stallAndJank.frameJankEvents).toBe(1);
    expect(report.stallAndJank.slowSqliteOps).toBe(1);
    expect(report.stallAndJank.hotspots[0]?.screen).toBe('epg-grid');
    expect(report.mediaDecodeFailures[0]).toEqual({
      platform: 'android-tv',
      engine: 'media3',
      container: 'mpegts',
      videoCodec: 'hevc',
      audioCodec: 'ac3',
      errorCode: 'DECODER_INIT_FAILED',
      hdrFormat: 'hdr10',
      isLive: true,
      count: 2,
    });
    expect(report.feedbackByCategory.playback_issue).toBe(1);
    expect(report.recentFeedback[0]?.hasDiagnostics).toBe(true);

    // ?since= filters to batch2 + feedback only
    const sinceDigest = await app.fetch(
      new Request('https://sync.example.test/v1/admin/digest?since=2026-11-25T12:00:30.000Z', {
        headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      }),
    );
    expect(sinceDigest.status).toBe(200);
    const sinceReport = (await sinceDigest.json()) as TelemetryDigestReport;
    expect(sinceReport.totals.telemetryEvents).toBe(2);
    expect(sinceReport.totals.feedbackSubmissions).toBe(1);
  });

  it('rate limits abusive clients per IP with 429 and Retry-After', async () => {
    const { app, advanceMs } = makeApp({
      trustProxy: 'cloudflare',
      rateLimits: {
        auth: { windowMs: 10_000, maxRequests: 2 },
      },
    });
    const ipHeaders = { 'cf-connecting-ip': '203.0.113.10' };

    const r1 = await app.fetch(jsonReq('/v1/auth/login', 'POST', {}, ipHeaders));
    const r2 = await app.fetch(jsonReq('/v1/auth/login', 'POST', {}, ipHeaders));
    const r3 = await app.fetch(jsonReq('/v1/auth/login', 'POST', {}, ipHeaders));
    expect(r1.status).toBe(401);
    expect(r2.status).toBe(401);
    expect(r3.status).toBe(429);
    expect(Number(r3.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

    // Different IP is unaffected
    const otherIp = await app.fetch(
      jsonReq('/v1/auth/login', 'POST', {}, { 'cf-connecting-ip': '198.51.100.7' }),
    );
    expect(otherIp.status).toBe(401);

    // Advancing past window restores access
    advanceMs(11_000);
    const r4 = await app.fetch(jsonReq('/v1/auth/login', 'POST', {}, ipHeaders));
    expect(r4.status).toBe(401);
  });

  it('serves live HTTP requests over Node http bridge via startNodeSyncServer()', async () => {
    const running = await startNodeSyncServer({
      port: 0,
      host: '127.0.0.1',
      jwtSecret: TEST_JWT_SECRET,
      adminToken: TEST_ADMIN_TOKEN,
      verifierHashIterations: 1_000,
    });
    try {
      const health = await fetch(`${running.url}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({
        ok: true,
        service: 'elv-sync-server',
        version: '1.0.0',
      });

      const reg = await fetch(`${running.url}/v1/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(VALID_REGISTER_BODY),
      });
      expect(reg.status).toBe(201);
    } finally {
      await running.close();
    }
  });
});
