import { describe, expect, it } from 'vitest';
import { createSyncApp, type SyncAppConfig } from './app.ts';
import { randomPairingCode, sha256Hex, timingSafeEqualHex } from './crypto.ts';
import { createMemoryStorage } from './storage-memory.ts';

const TEST_JWT_SECRET = 'test-jwt-secret-'.padEnd(36, 'a');
const TEST_ADMIN_TOKEN = 'test-admin-token-'.padEnd(36, 'b');

// Valid 32-byte unpadded base64url X25519 public keys (non-zero)
const HOST_PK = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE';
const RESPONDER_PK = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAI';
const ATTACKER_PK = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM';
const ALL_ZERO_PK = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const HASH_ALICE = 'a'.repeat(64);
const HASH_BOB = 'b'.repeat(64);

function makeApp(overrides: Partial<SyncAppConfig> = {}) {
  let currentMs = Date.parse('2026-11-27T12:00:00.000Z');
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

describe('Wave P9: Bidirectional 8-Digit X25519 Pairing & Expanded Telemetry', () => {
  it('generates 8-digit CSPRNG numeric codes and supports sha256Hex + timingSafeEqualHex', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const code = randomPairingCode();
      expect(code).toMatch(/^\d{8}$/);
      seen.add(code);
    }
    expect(seen.size).toBeGreaterThan(95);

    const h1 = await sha256Hex('12345678');
    const h2 = await sha256Hex('12345678');
    const h3 = await sha256Hex('87654321');
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(timingSafeEqualHex(h1, h2)).toBe(true);
    expect(timingSafeEqualHex(h1, h3)).toBe(false);
    expect(timingSafeEqualHex(h1, `${h1}00`)).toBe(false);
    expect(timingSafeEqualHex('', '')).toBe(false);
  });

  it('rejects all-zero X25519 public keys, malformed inputs, and exposes X-Pair-Responder-Token in CORS', async () => {
    const { app } = makeApp();

    const preflight = await app.fetch(
      new Request('https://sync.example.test/v1/pair/poll/test', { method: 'OPTIONS' }),
    );
    expect(preflight.headers.get('access-control-allow-headers')).toContain(
      'X-Pair-Responder-Token',
    );

    const zeroKey = await app.fetch(
      jsonReq('/v1/pair/create', 'POST', {
        hostPublicKey: ALL_ZERO_PK,
        hostAuthState: 'signed_out',
      }),
    );
    expect(zeroKey.status).toBe(400);

    const shortKey = await app.fetch(
      jsonReq('/v1/pair/create', 'POST', {
        hostPublicKey: 'AAAA',
        hostAuthState: 'signed_out',
      }),
    );
    expect(shortKey.status).toBe(400);

    const badMaskedEmail = await app.fetch(
      jsonReq('/v1/pair/create', 'POST', {
        hostPublicKey: HOST_PK,
        hostAuthState: 'signed_in',
        hostMaskedEmail: 'alice@example.com',
        hostEmailHash: HASH_ALICE,
      }),
    );
    expect(badMaskedEmail.status).toBe(400);

    const badEmailHash = await app.fetch(
      jsonReq('/v1/pair/create', 'POST', {
        hostPublicKey: HOST_PK,
        hostAuthState: 'signed_in',
        hostMaskedEmail: 'a***@example.com',
        hostEmailHash: 'not-a-sha256-hex',
      }),
    );
    expect(badEmailHash.status).toBe(400);

    const badLookupCode = await app.fetch(jsonReq('/v1/pair/lookup', 'POST', { code: 'ABCD1234' }));
    expect(badLookupCode.status).toBe(400);
  });

  it('enforces 3-attempt global lockout (423), single-responder anti-hijack (409), wrong tokens (401), and 5m expiry (410/404)', async () => {
    const { app, advanceMs } = makeApp();

    // 1. 3-attempt lockout via invalid payloads on /respond
    const create1 = await app.fetch(
      jsonReq('/v1/pair/create', 'POST', {
        hostPublicKey: HOST_PK,
        hostAuthState: 'signed_out',
      }),
    );
    expect(create1.status).toBe(201);
    const s1 = (await create1.json()) as {
      pairingId: string;
      code: string;
      pollToken: string;
      expiresAt: string;
    };
    expect(s1.code).toMatch(/^\d{8}$/);

    // Attempt 1 & 2 with all-zero key -> 400
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const badResp = await app.fetch(
        jsonReq('/v1/pair/respond', 'POST', {
          code: s1.code,
          responderPublicKey: ALL_ZERO_PK,
          responderAuthState: 'signed_in',
          direction: 'responder_to_host',
        }),
      );
      expect(badResp.status).toBe(400);
    }
    // Attempt 3 -> 423 Locked!
    const lockResp = await app.fetch(
      jsonReq('/v1/pair/respond', 'POST', {
        code: s1.code,
        responderPublicKey: ALL_ZERO_PK,
        responderAuthState: 'signed_in',
        direction: 'responder_to_host',
      }),
    );
    expect(lockResp.status).toBe(423);

    // Subsequent lookup, valid respond, and host poll all return 423
    expect((await app.fetch(jsonReq('/v1/pair/lookup', 'POST', { code: s1.code }))).status).toBe(
      423,
    );
    expect(
      (
        await app.fetch(
          jsonReq('/v1/pair/respond', 'POST', {
            code: s1.code,
            responderPublicKey: RESPONDER_PK,
            responderAuthState: 'signed_out',
            direction: 'neither_signed_in',
          }),
        )
      ).status,
    ).toBe(423);
    expect(
      (
        await app.fetch(
          new Request(`https://sync.example.test/v1/pair/poll/${s1.pairingId}`, {
            headers: { 'x-pair-poll-token': s1.pollToken },
          }),
        )
      ).status,
    ).toBe(423);

    // 2. Single-responder atomic claim (409 on second attacker) + wrong token (401)
    const create2 = await app.fetch(
      jsonReq('/v1/pair/create', 'POST', {
        hostPublicKey: HOST_PK,
        hostAuthState: 'signed_in',
        hostMaskedEmail: 'a***@example.com',
        hostEmailHash: HASH_ALICE,
      }),
    );
    const s2 = (await create2.json()) as {
      pairingId: string;
      code: string;
      pollToken: string;
    };

    const respondOk = await app.fetch(
      jsonReq('/v1/pair/respond', 'POST', {
        code: s2.code,
        responderPublicKey: RESPONDER_PK,
        responderAuthState: 'signed_out',
        direction: 'host_to_responder',
      }),
    );
    expect(respondOk.status).toBe(200);
    const r2 = (await respondOk.json()) as { responderToken: string };

    // Second attacker cannot hijack -> 409
    const hijack = await app.fetch(
      jsonReq('/v1/pair/respond', 'POST', {
        code: s2.code,
        responderPublicKey: ATTACKER_PK,
        responderAuthState: 'signed_out',
        direction: 'host_to_responder',
      }),
    );
    expect(hijack.status).toBe(409);

    // Wrong poll token & wrong responder token -> 401
    expect(
      (
        await app.fetch(
          new Request(`https://sync.example.test/v1/pair/poll/${s2.pairingId}`, {
            headers: { 'x-pair-poll-token': 'wrong-host-token' },
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await app.fetch(
          new Request(`https://sync.example.test/v1/pair/poll/${s2.pairingId}`, {
            headers: { 'x-pair-responder-token': 'wrong-responder-token' },
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await app.fetch(
          jsonReq(
            '/v1/pair/approve',
            'POST',
            { pairingId: s2.pairingId, direction: 'host_to_responder' },
            { 'x-pair-poll-token': 'wrong-host-token' },
          ),
        )
      ).status,
    ).toBe(401);

    // Legitimate responder token still works & host sees legitimate responder PK
    const hostPoll = await app.fetch(
      new Request(`https://sync.example.test/v1/pair/poll/${s2.pairingId}`, {
        headers: { 'x-pair-poll-token': s2.pollToken },
      }),
    );
    expect(hostPoll.status).toBe(200);
    expect(await hostPoll.json()).toMatchObject({
      status: 'responder_joined',
      hostApproved: false,
      responderPublicKey: RESPONDER_PK,
    });
    const respPoll = await app.fetch(
      new Request(`https://sync.example.test/v1/pair/poll/${s2.pairingId}`, {
        headers: { 'x-pair-responder-token': r2.responderToken },
      }),
    );
    expect(respPoll.status).toBe(200);

    // 3. Expiry (5m TTL): lookup returns generic 404; poll/respond/approve return 410
    const createExp1 = await app.fetch(
      jsonReq('/v1/pair/create', 'POST', {
        hostPublicKey: HOST_PK,
        hostAuthState: 'signed_out',
      }),
    );
    const exp1 = (await createExp1.json()) as {
      pairingId: string;
      code: string;
      pollToken: string;
    };
    const createExp2 = await app.fetch(
      jsonReq('/v1/pair/create', 'POST', {
        hostPublicKey: HOST_PK,
        hostAuthState: 'signed_out',
      }),
    );
    const exp2 = (await createExp2.json()) as {
      pairingId: string;
      code: string;
      pollToken: string;
    };

    advanceMs(300_001);

    // Generic 404 on expired lookup (non-enumerating)
    expect((await app.fetch(jsonReq('/v1/pair/lookup', 'POST', { code: exp1.code }))).status).toBe(
      404,
    );
    // 410 on expired poll
    expect(
      (
        await app.fetch(
          new Request(`https://sync.example.test/v1/pair/poll/${exp2.pairingId}`, {
            headers: { 'x-pair-poll-token': exp2.pollToken },
          }),
        )
      ).status,
    ).toBe(410);
  });

  it('completes all 5 bidirectional pairing cases with one-time burn-after-read and reject wipe', async () => {
    const { app } = makeApp();

    // Case 1: neither_signed_in
    const c1 = (await (
      await app.fetch(
        jsonReq('/v1/pair/create', 'POST', {
          hostPublicKey: HOST_PK,
          hostAuthState: 'signed_out',
        }),
      )
    ).json()) as { pairingId: string; code: string; pollToken: string };
    const l1 = await app.fetch(jsonReq('/v1/pair/lookup', 'POST', { code: c1.code }));
    expect(l1.status).toBe(200);
    expect(await l1.json()).toMatchObject({
      pairingId: c1.pairingId,
      hostPublicKey: HOST_PK,
      hostAuthState: 'signed_out',
      hostMaskedEmail: null,
      hostEmailHash: null,
      status: 'pending',
    });
    const r1 = await app.fetch(
      jsonReq('/v1/pair/respond', 'POST', {
        code: c1.code,
        responderPublicKey: RESPONDER_PK,
        responderAuthState: 'signed_out',
        direction: 'neither_signed_in',
      }),
    );
    expect(r1.status).toBe(200);
    const r1Body = (await r1.json()) as { responderToken: string; direction: string };
    expect(r1Body.direction).toBe('neither_signed_in');
    const a1 = await app.fetch(
      jsonReq(
        '/v1/pair/approve',
        'POST',
        { pairingId: c1.pairingId, direction: 'neither_signed_in' },
        { 'x-pair-poll-token': c1.pollToken },
      ),
    );
    expect(a1.status).toBe(200);
    const p1 = await app.fetch(
      new Request(`https://sync.example.test/v1/pair/poll/${c1.pairingId}`, {
        headers: { 'x-pair-responder-token': r1Body.responderToken },
      }),
    );
    expect(await p1.json()).toMatchObject({ status: 'approved', direction: 'neither_signed_in' });

    // Case 2: responder_to_host (strict 2-phase: respond -> transfer post-SAS -> approve -> burn-after-read)
    const c2 = (await (
      await app.fetch(
        jsonReq('/v1/pair/create', 'POST', {
          hostPublicKey: HOST_PK,
          hostAuthState: 'signed_out',
        }),
      )
    ).json()) as { pairingId: string; code: string; pollToken: string };
    const r2Res = await app.fetch(
      jsonReq('/v1/pair/respond', 'POST', {
        code: c2.code,
        responderPublicKey: RESPONDER_PK,
        responderAuthState: 'signed_in',
        responderMaskedEmail: 'b***@example.com',
        responderEmailHash: HASH_BOB,
        direction: 'responder_to_host',
      }),
    );
    expect(r2Res.status).toBe(200);
    const r2 = (await r2Res.json()) as { responderToken: string; status: string };
    expect(r2.status).toBe('responder_joined');

    // Responder confirms SAS locally and uploads ciphertext via Phase 2 /v1/pair/transfer
    const t2Res = await app.fetch(
      jsonReq(
        '/v1/pair/transfer',
        'POST',
        {
          pairingId: c2.pairingId,
          direction: 'responder_to_host',
          encryptedPayload: 'responder_ciphertext_payload_0123456',
          iv: 'iv_responder_123456',
        },
        { 'x-pair-responder-token': r2.responderToken },
      ),
    );
    expect(t2Res.status).toBe(200);
    expect(await t2Res.json()).toMatchObject({
      pairingId: c2.pairingId,
      status: 'responder_transferred',
      direction: 'responder_to_host',
    });

    // Before host approval, host sees responder metadata without consuming payload
    const preApproveHostPoll = (await (
      await app.fetch(
        new Request(`https://sync.example.test/v1/pair/poll/${c2.pairingId}`, {
          headers: { 'x-pair-poll-token': c2.pollToken },
        }),
      )
    ).json()) as Record<string, unknown>;
    expect(preApproveHostPoll).toMatchObject({
      status: 'responder_transferred',
      hostApproved: false,
      responderPublicKey: RESPONDER_PK,
      responderMaskedEmail: 'b***@example.com',
      responderEmailHash: HASH_BOB,
      direction: 'responder_to_host',
    });
    expect(preApproveHostPoll.encryptedPayload).toBeUndefined();

    // Host approves -> status becomes completed, first poll delivers payload & burns it atomically
    const a2Res = await app.fetch(
      jsonReq(
        '/v1/pair/approve',
        'POST',
        { pairingId: c2.pairingId, direction: 'responder_to_host' },
        { 'x-pair-poll-token': c2.pollToken },
      ),
    );
    expect(a2Res.status).toBe(200);
    expect(await a2Res.json()).toMatchObject({
      pairingId: c2.pairingId,
      status: 'completed',
      direction: 'responder_to_host',
    });

    const firstHostPoll = await app.fetch(
      new Request(`https://sync.example.test/v1/pair/poll/${c2.pairingId}`, {
        headers: { 'x-pair-poll-token': c2.pollToken },
      }),
    );
    expect(firstHostPoll.status).toBe(200);
    expect(await firstHostPoll.json()).toMatchObject({
      status: 'completed',
      hostApproved: true,
      direction: 'responder_to_host',
      encryptedPayload: 'responder_ciphertext_payload_0123456',
      iv: 'iv_responder_123456',
    });

    // Second host poll MUST NOT return encryptedPayload again (burn-after-read!)
    const secondHostPoll = (await (
      await app.fetch(
        new Request(`https://sync.example.test/v1/pair/poll/${c2.pairingId}`, {
          headers: { 'x-pair-poll-token': c2.pollToken },
        }),
      )
    ).json()) as Record<string, unknown>;
    expect(secondHostPoll.status).toBe('completed');
    expect(secondHostPoll.encryptedPayload).toBeUndefined();
    expect(secondHostPoll.iv).toBeUndefined();

    // Responder sees completed status
    const r2Poll = await app.fetch(
      new Request(`https://sync.example.test/v1/pair/poll/${c2.pairingId}`, {
        headers: { 'x-pair-responder-token': r2.responderToken },
      }),
    );
    expect(await r2Poll.json()).toMatchObject({
      status: 'completed',
      direction: 'responder_to_host',
    });

    // Case 3: host_to_responder (burn-after-read on responder poll)
    const c3 = (await (
      await app.fetch(
        jsonReq('/v1/pair/create', 'POST', {
          hostPublicKey: HOST_PK,
          hostAuthState: 'signed_in',
          hostMaskedEmail: 'a***@example.com',
          hostEmailHash: HASH_ALICE,
        }),
      )
    ).json()) as { pairingId: string; code: string; pollToken: string };
    const r3 = (await (
      await app.fetch(
        jsonReq('/v1/pair/respond', 'POST', {
          code: c3.code,
          responderPublicKey: RESPONDER_PK,
          responderAuthState: 'signed_out',
          direction: 'host_to_responder',
        }),
      )
    ).json()) as { responderToken: string };
    expect(
      (
        await app.fetch(
          jsonReq(
            '/v1/pair/approve',
            'POST',
            {
              pairingId: c3.pairingId,
              direction: 'host_to_responder',
              encryptedPayload: 'host_return_ciphertext_payload_0123',
              iv: 'iv_host_return_1234',
            },
            { 'x-pair-poll-token': c3.pollToken },
          ),
        )
      ).status,
    ).toBe(200);

    const firstRespPoll = await app.fetch(
      new Request(`https://sync.example.test/v1/pair/poll/${c3.pairingId}`, {
        headers: { 'x-pair-responder-token': r3.responderToken },
      }),
    );
    expect(await firstRespPoll.json()).toMatchObject({
      status: 'completed',
      direction: 'host_to_responder',
      encryptedPayload: 'host_return_ciphertext_payload_0123',
      iv: 'iv_host_return_1234',
    });

    const secondRespPoll = (await (
      await app.fetch(
        new Request(`https://sync.example.test/v1/pair/poll/${c3.pairingId}`, {
          headers: { 'x-pair-responder-token': r3.responderToken },
        }),
      )
    ).json()) as Record<string, unknown>;
    expect(secondRespPoll.status).toBe('completed');
    expect(secondRespPoll.encryptedPayload).toBeUndefined();
    expect(secondRespPoll.iv).toBeUndefined();

    // Case 4: same_account
    const c4 = (await (
      await app.fetch(
        jsonReq('/v1/pair/create', 'POST', {
          hostPublicKey: HOST_PK,
          hostAuthState: 'signed_in',
          hostMaskedEmail: 'a***@example.com',
          hostEmailHash: HASH_ALICE,
        }),
      )
    ).json()) as { pairingId: string; code: string; pollToken: string };
    const r4 = (await (
      await app.fetch(
        jsonReq('/v1/pair/respond', 'POST', {
          code: c4.code,
          responderPublicKey: RESPONDER_PK,
          responderAuthState: 'signed_in',
          responderMaskedEmail: 'a***@example.com',
          responderEmailHash: HASH_ALICE,
          direction: 'same_account',
        }),
      )
    ).json()) as { responderToken: string };
    expect(
      (
        await app.fetch(
          jsonReq(
            '/v1/pair/approve',
            'POST',
            { pairingId: c4.pairingId, direction: 'same_account' },
            { 'x-pair-poll-token': c4.pollToken },
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      await (
        await app.fetch(
          new Request(`https://sync.example.test/v1/pair/poll/${c4.pairingId}`, {
            headers: { 'x-pair-responder-token': r4.responderToken },
          }),
        )
      ).json(),
    ).toMatchObject({ status: 'approved', direction: 'same_account' });

    // Case 5: different_accounts (host wins -> host_to_responder + reject case wipes payloads)
    const c5 = (await (
      await app.fetch(
        jsonReq('/v1/pair/create', 'POST', {
          hostPublicKey: HOST_PK,
          hostAuthState: 'signed_in',
          hostMaskedEmail: 'a***@example.com',
          hostEmailHash: HASH_ALICE,
        }),
      )
    ).json()) as { pairingId: string; code: string; pollToken: string };
    const r5 = (await (
      await app.fetch(
        jsonReq('/v1/pair/respond', 'POST', {
          code: c5.code,
          responderPublicKey: RESPONDER_PK,
          responderAuthState: 'signed_in',
          responderMaskedEmail: 'b***@example.com',
          responderEmailHash: HASH_BOB,
          direction: 'different_accounts',
        }),
      )
    ).json()) as { responderToken: string };
    // Host chooses its own account to overwrite responder
    expect(
      (
        await app.fetch(
          jsonReq(
            '/v1/pair/approve',
            'POST',
            {
              pairingId: c5.pairingId,
              direction: 'host_to_responder',
              encryptedPayload: 'alice_winner_ciphertext_payload_123',
              iv: 'iv_alice_12345678',
            },
            { 'x-pair-poll-token': c5.pollToken },
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      await (
        await app.fetch(
          new Request(`https://sync.example.test/v1/pair/poll/${c5.pairingId}`, {
            headers: { 'x-pair-responder-token': r5.responderToken },
          }),
        )
      ).json(),
    ).toMatchObject({
      status: 'completed',
      hostApproved: true,
      direction: 'host_to_responder',
      encryptedPayload: 'alice_winner_ciphertext_payload_123',
      iv: 'iv_alice_12345678',
    });

    // Reject path wipes transferred payload and notifies responder
    const cRej = (await (
      await app.fetch(
        jsonReq('/v1/pair/create', 'POST', {
          hostPublicKey: HOST_PK,
          hostAuthState: 'signed_out',
        }),
      )
    ).json()) as { pairingId: string; code: string; pollToken: string };
    const rRej = (await (
      await app.fetch(
        jsonReq('/v1/pair/respond', 'POST', {
          code: cRej.code,
          responderPublicKey: RESPONDER_PK,
          responderAuthState: 'signed_in',
          responderMaskedEmail: 'b***@example.com',
          responderEmailHash: HASH_BOB,
          direction: 'responder_to_host',
        }),
      )
    ).json()) as { responderToken: string };
    expect(
      (
        await app.fetch(
          jsonReq(
            '/v1/pair/transfer',
            'POST',
            {
              pairingId: cRej.pairingId,
              direction: 'responder_to_host',
              encryptedPayload: 'wiped_on_reject_payload_0123456789',
              iv: 'iv_wiped_12345678',
            },
            { 'x-pair-responder-token': rRej.responderToken },
          ),
        )
      ).status,
    ).toBe(200);
    const rejRes = await app.fetch(
      jsonReq(
        '/v1/pair/approve',
        'POST',
        { pairingId: cRej.pairingId, direction: 'responder_to_host', reject: true },
        { 'x-pair-poll-token': cRej.pollToken },
      ),
    );
    expect(rejRes.status).toBe(200);
    const rejPoll = (await (
      await app.fetch(
        new Request(`https://sync.example.test/v1/pair/poll/${cRej.pairingId}`, {
          headers: { 'x-pair-responder-token': rRej.responderToken },
        }),
      )
    ).json()) as Record<string, unknown>;
    expect(rejPoll.status).toBe('rejected');
    expect(rejPoll.hostApproved).toBe(false);
    expect(rejPoll.encryptedPayload).toBeUndefined();
  });
});
