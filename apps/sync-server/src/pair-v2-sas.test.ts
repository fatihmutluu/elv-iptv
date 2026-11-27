import { describe, expect, it } from 'vitest';
import { createSyncApp, type SyncAppConfig } from './app.ts';
import type { SyncServerStorage } from './storage.ts';
import { createMemoryStorage } from './storage-memory.ts';

const TEST_JWT_SECRET = 'jwt-p9-sas-test-secret-0123456789abcdef';
const HOST_PK = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE';
const RESPONDER_PK = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAI';
const HASH_ALICE = 'a'.repeat(64);
const HASH_BOB = 'b'.repeat(64);

const VALID_REGISTER_BODY = {
  email: 'legacy@example.com',
  authVerifier: 'verifier_base64url_string_0123456789abcdef',
  kdfSalt: 'salt_base64url_0123456789',
  kdfIterations: 210_000,
  wrappedVaultKey: 'wrapped_vault_key_ciphertext_0123456789',
  recoveryWrappedVaultKey: 'recovery_wrapped_key_ciphertext_0123456789',
};

function makeApp(overrides: Partial<SyncAppConfig> = {}) {
  let currentMs = Date.parse('2026-11-27T12:00:00.000Z');
  const storage = overrides.storage ?? createMemoryStorage();
  const app = createSyncApp({
    storage,
    jwtSecret: TEST_JWT_SECRET,
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

describe('Wave P9 Fix Pass: Strict 2-Phase SAS Pairing, Cancel, Legacy Guard & Retry', () => {
  it('P0-1: rejects any pre-SAS encryptedPayload/iv on POST /v1/pair/respond with 400 pre_sas_payload_forbidden', async () => {
    const { app } = makeApp();
    const c = (await (
      await app.fetch(
        jsonReq('/v1/pair/create', 'POST', {
          hostPublicKey: HOST_PK,
          hostAuthState: 'signed_out',
        }),
      )
    ).json()) as { pairingId: string; code: string; pollToken: string };

    // Attempt 1 with encryptedPayload + iv -> 400 pre_sas_payload_forbidden
    const bad1 = await app.fetch(
      jsonReq('/v1/pair/respond', 'POST', {
        code: c.code,
        responderPublicKey: RESPONDER_PK,
        responderAuthState: 'signed_in',
        responderMaskedEmail: 'b***@example.com',
        responderEmailHash: HASH_BOB,
        direction: 'responder_to_host',
        encryptedPayload: 'pre_sas_stolen_payload_0123456789',
        iv: 'iv_pre_sas_12345',
      }),
    );
    expect(bad1.status).toBe(400);
    expect(await bad1.json()).toEqual({ error: 'pre_sas_payload_forbidden' });

    // Attempt 2 with iv only -> 400 pre_sas_payload_forbidden
    const bad2 = await app.fetch(
      jsonReq('/v1/pair/respond', 'POST', {
        code: c.code,
        responderPublicKey: RESPONDER_PK,
        responderAuthState: 'signed_in',
        direction: 'responder_to_host',
        iv: 'iv_pre_sas_12345',
      }),
    );
    expect(bad2.status).toBe(400);
    expect(await bad2.json()).toEqual({ error: 'pre_sas_payload_forbidden' });

    // Attempt 3 -> 423 locked
    const bad3 = await app.fetch(
      jsonReq('/v1/pair/respond', 'POST', {
        code: c.code,
        responderPublicKey: RESPONDER_PK,
        responderAuthState: 'signed_in',
        direction: 'responder_to_host',
        encryptedPayload: 'pre_sas_stolen_payload_0123456789',
      }),
    );
    expect(bad3.status).toBe(423);
  });

  it('P0-1: enforces auth, state, and single-shot guards on POST /v1/pair/transfer and /v1/pair/approve', async () => {
    const { app, advanceMs } = makeApp();

    // Create host_to_responder session: responder cannot transfer
    const cH2R = (await (
      await app.fetch(
        jsonReq('/v1/pair/create', 'POST', {
          hostPublicKey: HOST_PK,
          hostAuthState: 'signed_in',
          hostMaskedEmail: 'a***@example.com',
          hostEmailHash: HASH_ALICE,
        }),
      )
    ).json()) as { pairingId: string; code: string; pollToken: string };
    const rH2R = (await (
      await app.fetch(
        jsonReq('/v1/pair/respond', 'POST', {
          code: cH2R.code,
          responderPublicKey: RESPONDER_PK,
          responderAuthState: 'signed_out',
          direction: 'host_to_responder',
        }),
      )
    ).json()) as { responderToken: string };

    // Missing / wrong responder token on /transfer -> 401
    expect(
      (
        await app.fetch(
          jsonReq('/v1/pair/transfer', 'POST', {
            pairingId: cH2R.pairingId,
            direction: 'responder_to_host',
            encryptedPayload: 'payload_0123456789abcdef',
            iv: 'iv_0123456789ab',
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await app.fetch(
          jsonReq(
            '/v1/pair/transfer',
            'POST',
            {
              pairingId: cH2R.pairingId,
              direction: 'responder_to_host',
              encryptedPayload: 'payload_0123456789abcdef',
              iv: 'iv_0123456789ab',
            },
            { 'x-pair-responder-token': 'wrong-token' },
          ),
        )
      ).status,
    ).toBe(401);

    // Signed-out responder cannot transfer -> 400 direction_auth_mismatch
    const signedOutTransfer = await app.fetch(
      jsonReq(
        '/v1/pair/transfer',
        'POST',
        {
          pairingId: cH2R.pairingId,
          direction: 'responder_to_host',
          encryptedPayload: 'payload_0123456789abcdef',
          iv: 'iv_0123456789ab',
        },
        { 'x-pair-responder-token': rH2R.responderToken },
      ),
    );
    expect(signedOutTransfer.status).toBe(400);

    // Invalid transfer direction ('host_to_responder') -> 400
    expect(
      (
        await app.fetch(
          jsonReq(
            '/v1/pair/transfer',
            'POST',
            {
              pairingId: cH2R.pairingId,
              direction: 'host_to_responder',
              encryptedPayload: 'payload_0123456789abcdef',
              iv: 'iv_0123456789ab',
            },
            { 'x-pair-responder-token': rH2R.responderToken },
          ),
        )
      ).status,
    ).toBe(400);

    // Host approve with host_to_responder missing payload -> 400 missing_encrypted_payload
    const missingPayloadApprove = await app.fetch(
      jsonReq(
        '/v1/pair/approve',
        'POST',
        { pairingId: cH2R.pairingId, direction: 'host_to_responder' },
        { 'x-pair-poll-token': cH2R.pollToken },
      ),
    );
    expect(missingPayloadApprove.status).toBe(400);
    expect(await missingPayloadApprove.json()).toEqual({ error: 'missing_encrypted_payload' });

    // Create responder_to_host session: verify double transfer -> 409 and post-completion -> 409
    const cR2H = (await (
      await app.fetch(
        jsonReq('/v1/pair/create', 'POST', {
          hostPublicKey: HOST_PK,
          hostAuthState: 'signed_out',
        }),
      )
    ).json()) as { pairingId: string; code: string; pollToken: string };
    const rR2H = (await (
      await app.fetch(
        jsonReq('/v1/pair/respond', 'POST', {
          code: cR2H.code,
          responderPublicKey: RESPONDER_PK,
          responderAuthState: 'signed_in',
          responderMaskedEmail: 'b***@example.com',
          responderEmailHash: HASH_BOB,
          direction: 'responder_to_host',
        }),
      )
    ).json()) as { responderToken: string };

    // First transfer succeeds -> responder_transferred
    expect(
      (
        await app.fetch(
          jsonReq(
            '/v1/pair/transfer',
            'POST',
            {
              pairingId: cR2H.pairingId,
              direction: 'responder_to_host',
              encryptedPayload: 'first_transfer_ciphertext_012345',
              iv: 'iv_first_123456',
            },
            { 'x-pair-responder-token': rR2H.responderToken },
          ),
        )
      ).status,
    ).toBe(200);

    // Second transfer rejected -> 409 pair_already_transferred
    const dupTransfer = await app.fetch(
      jsonReq(
        '/v1/pair/transfer',
        'POST',
        {
          pairingId: cR2H.pairingId,
          direction: 'responder_to_host',
          encryptedPayload: 'second_transfer_ciphertext_01234',
          iv: 'iv_second_12345',
        },
        { 'x-pair-responder-token': rR2H.responderToken },
      ),
    );
    expect(dupTransfer.status).toBe(409);
    expect(await dupTransfer.json()).toEqual({ error: 'pair_already_transferred' });

    // Expired transfer -> 410
    const cExp = (await (
      await app.fetch(
        jsonReq('/v1/pair/create', 'POST', {
          hostPublicKey: HOST_PK,
          hostAuthState: 'signed_out',
        }),
      )
    ).json()) as { pairingId: string; code: string; pollToken: string };
    const rExp = (await (
      await app.fetch(
        jsonReq('/v1/pair/respond', 'POST', {
          code: cExp.code,
          responderPublicKey: RESPONDER_PK,
          responderAuthState: 'signed_in',
          responderMaskedEmail: 'b***@example.com',
          responderEmailHash: HASH_BOB,
          direction: 'responder_to_host',
        }),
      )
    ).json()) as { responderToken: string };
    advanceMs(300_001);
    expect(
      (
        await app.fetch(
          jsonReq(
            '/v1/pair/transfer',
            'POST',
            {
              pairingId: cExp.pairingId,
              direction: 'responder_to_host',
              encryptedPayload: 'expired_transfer_ciphertext_0123',
              iv: 'iv_expired_1234',
            },
            { 'x-pair-responder-token': rExp.responderToken },
          ),
        )
      ).status,
    ).toBe(410);
  });

  it('P2-4: allows reject in pending/responder_joined/approved/responder_transferred and supports POST /v1/pair/cancel from either side', async () => {
    const { app, storage } = makeApp();

    // 1. Host rejects while still 'pending' (direction optional on reject)
    const cPending = (await (
      await app.fetch(
        jsonReq('/v1/pair/create', 'POST', {
          hostPublicKey: HOST_PK,
          hostAuthState: 'signed_out',
        }),
      )
    ).json()) as { pairingId: string; code: string; pollToken: string };
    const rejPending = await app.fetch(
      jsonReq(
        '/v1/pair/approve',
        'POST',
        { pairingId: cPending.pairingId, reject: true },
        { 'x-pair-poll-token': cPending.pollToken },
      ),
    );
    expect(rejPending.status).toBe(200);
    expect((await storage.findPairSessionById(cPending.pairingId))?.status).toBe('rejected');

    // 2. Host rejects after 'approved' (host_to_responder) -> wipes returnEncryptedPayload!
    const cApproved = (await (
      await app.fetch(
        jsonReq('/v1/pair/create', 'POST', {
          hostPublicKey: HOST_PK,
          hostAuthState: 'signed_in',
          hostMaskedEmail: 'a***@example.com',
          hostEmailHash: HASH_ALICE,
        }),
      )
    ).json()) as { pairingId: string; code: string; pollToken: string };
    const rApproved = (await (
      await app.fetch(
        jsonReq('/v1/pair/respond', 'POST', {
          code: cApproved.code,
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
              pairingId: cApproved.pairingId,
              direction: 'host_to_responder',
              encryptedPayload: 'return_secret_to_wipe_0123456789',
              iv: 'iv_return_12345',
            },
            { 'x-pair-poll-token': cApproved.pollToken },
          ),
        )
      ).status,
    ).toBe(200);
    const rejApproved = await app.fetch(
      jsonReq(
        '/v1/pair/approve',
        'POST',
        { pairingId: cApproved.pairingId, direction: 'host_to_responder', reject: true },
        { 'x-pair-poll-token': cApproved.pollToken },
      ),
    );
    expect(rejApproved.status).toBe(200);
    const storedAfterRej = await storage.findPairSessionById(cApproved.pairingId);
    expect(storedAfterRej?.status).toBe('rejected');
    expect(storedAfterRej?.returnEncryptedPayload).toBeNull();
    expect(storedAfterRej?.returnIv).toBeNull();
    expect(storedAfterRej?.hostApprovedAt).toBeNull();
    expect(
      await (
        await app.fetch(
          new Request(`https://sync.example.test/v1/pair/poll/${cApproved.pairingId}`, {
            headers: { 'x-pair-responder-token': rApproved.responderToken },
          }),
        )
      ).json(),
    ).toMatchObject({ status: 'rejected', hostApproved: false });

    // 3. POST /v1/pair/cancel from responder wipes payload & notifies host
    const cCancelR = (await (
      await app.fetch(
        jsonReq('/v1/pair/create', 'POST', {
          hostPublicKey: HOST_PK,
          hostAuthState: 'signed_out',
        }),
      )
    ).json()) as { pairingId: string; code: string; pollToken: string };
    const rCancelR = (await (
      await app.fetch(
        jsonReq('/v1/pair/respond', 'POST', {
          code: cCancelR.code,
          responderPublicKey: RESPONDER_PK,
          responderAuthState: 'signed_in',
          responderMaskedEmail: 'b***@example.com',
          responderEmailHash: HASH_BOB,
          direction: 'responder_to_host',
        }),
      )
    ).json()) as { responderToken: string };
    await app.fetch(
      jsonReq(
        '/v1/pair/transfer',
        'POST',
        {
          pairingId: cCancelR.pairingId,
          direction: 'responder_to_host',
          encryptedPayload: 'cancel_wiped_payload_01234567890',
          iv: 'iv_cancel_12345',
        },
        { 'x-pair-responder-token': rCancelR.responderToken },
      ),
    );

    // Missing token -> 401; both tokens -> 400
    expect(
      (await app.fetch(jsonReq('/v1/pair/cancel', 'POST', { pairingId: cCancelR.pairingId })))
        .status,
    ).toBe(401);
    expect(
      (
        await app.fetch(
          jsonReq(
            '/v1/pair/cancel',
            'POST',
            { pairingId: cCancelR.pairingId },
            {
              'x-pair-poll-token': cCancelR.pollToken,
              'x-pair-responder-token': rCancelR.responderToken,
            },
          ),
        )
      ).status,
    ).toBe(400);

    // Responder cancels -> 200 rejected & payload wiped
    const cancelRes = await app.fetch(
      jsonReq(
        '/v1/pair/cancel',
        'POST',
        { pairingId: cCancelR.pairingId },
        { 'x-pair-responder-token': rCancelR.responderToken },
      ),
    );
    expect(cancelRes.status).toBe(200);
    expect(await cancelRes.json()).toEqual({ pairingId: cCancelR.pairingId, status: 'rejected' });
    const wiped = await storage.findPairSessionById(cCancelR.pairingId);
    expect(wiped?.status).toBe('rejected');
    expect(wiped?.encryptedPayload).toBeNull();
    expect(wiped?.iv).toBeNull();

    // Host polls and sees rejected (and cancel by host is idempotent)
    expect(
      await (
        await app.fetch(
          new Request(`https://sync.example.test/v1/pair/poll/${cCancelR.pairingId}`, {
            headers: { 'x-pair-poll-token': cCancelR.pollToken },
          }),
        )
      ).json(),
    ).toMatchObject({ status: 'rejected', hostApproved: false });
    expect(
      (
        await app.fetch(
          jsonReq(
            '/v1/pair/cancel',
            'POST',
            { pairingId: cCancelR.pairingId },
            { 'x-pair-poll-token': cCancelR.pollToken },
          ),
        )
      ).status,
    ).toBe(200);
  });

  it('P1-7: prevents legacy POST /v1/pair/claim from hijacking a v2 session and retries UNIQUE code collisions up to 3 times', async () => {
    const { app, storage } = makeApp();
    const reg = await app.fetch(jsonReq('/v1/auth/register', 'POST', VALID_REGISTER_BODY));
    const { accessToken } = (await reg.json()) as { accessToken: string };

    // Create v2 session
    const cV2 = (await (
      await app.fetch(
        jsonReq('/v1/pair/create', 'POST', {
          hostPublicKey: HOST_PK,
          hostAuthState: 'signed_out',
        }),
      )
    ).json()) as { pairingId: string; code: string; pollToken: string };

    // Legacy /v1/pair/claim MUST NOT hijack v2 session -> 404 pair_not_found
    const legacyClaim = await app.fetch(
      jsonReq(
        '/v1/pair/claim',
        'POST',
        {
          code: cV2.code,
          encryptedPayload: 'hijack_attempt_payload_012345678',
          iv: 'iv_hijack_12345',
        },
        { authorization: `Bearer ${accessToken}` },
      ),
    );
    expect(legacyClaim.status).toBe(404);
    const untouched = await storage.findPairSessionById(cV2.pairingId);
    expect(untouched?.status).toBe('pending');
    expect(untouched?.encryptedPayload).toBeNull();

    // UNIQUE(code) collision retry up to 3 times
    const inner = createMemoryStorage();
    let createCalls = 0;
    const collidingStorage: SyncServerStorage = {
      ...inner,
      async createPairSession(session) {
        createCalls += 1;
        if (createCalls <= 3) {
          throw new Error('UNIQUE constraint failed: pair_sessions.code');
        }
        return inner.createPairSession(session);
      },
    };
    const retryApp = makeApp({ storage: collidingStorage }).app;
    const okRetry = await retryApp.fetch(
      jsonReq('/v1/pair/create', 'POST', {
        hostPublicKey: HOST_PK,
        hostAuthState: 'signed_out',
      }),
    );
    expect(okRetry.status).toBe(201);
    expect(createCalls).toBe(4);

    // Exhausting all 4 attempts propagates 500
    let alwaysFailCalls = 0;
    const alwaysColliding: SyncServerStorage = {
      ...inner,
      async createPairSession() {
        alwaysFailCalls += 1;
        throw new Error('UNIQUE constraint failed: pair_sessions.code');
      },
    };
    const failApp = makeApp({ storage: alwaysColliding }).app;
    const failed = await failApp.fetch(
      jsonReq('/v1/pair/create', 'POST', {
        hostPublicKey: HOST_PK,
        hostAuthState: 'signed_out',
      }),
    );
    expect(failed.status).toBe(500);
    expect(alwaysFailCalls).toBe(4);
  });

  it('enforces pairLookup IP rate limiting, ambiguous-token rejection, and different_accounts host-first responder-wins flow', async () => {
    const { app } = makeApp({
      rateLimits: { pairLookup: { windowMs: 60_000, maxRequests: 4 } },
    });

    const created = (await (
      await app.fetch(
        jsonReq('/v1/pair/create', 'POST', {
          hostPublicKey: HOST_PK,
          hostAuthState: 'signed_in',
          hostMaskedEmail: 'a***@example.com',
          hostEmailHash: HASH_ALICE,
        }),
      )
    ).json()) as { pairingId: string; code: string; pollToken: string };

    // Approve before responder joins -> 409 pair_not_responded
    expect(
      (
        await app.fetch(
          jsonReq(
            '/v1/pair/approve',
            'POST',
            { pairingId: created.pairingId, direction: 'responder_to_host' },
            { 'x-pair-poll-token': created.pollToken },
          ),
        )
      ).status,
    ).toBe(409);

    // Phase 1: Responder joins with key-exchange metadata only (no payload pre-SAS)
    const respRes = await app.fetch(
      jsonReq('/v1/pair/respond', 'POST', {
        code: created.code,
        responderPublicKey: RESPONDER_PK,
        responderAuthState: 'signed_in',
        responderMaskedEmail: 'b***@example.com',
        responderEmailHash: HASH_BOB,
        direction: 'different_accounts',
      }),
      { clientIp: '10.1.1.1' },
    );
    expect(respRes.status).toBe(200);
    const { responderToken } = (await respRes.json()) as { responderToken: string };

    // Ambiguous dual-token poll header -> 400
    expect(
      (
        await app.fetch(
          new Request(`https://sync.example.test/v1/pair/poll/${created.pairingId}`, {
            headers: {
              'x-pair-poll-token': created.pollToken,
              'x-pair-responder-token': responderToken,
            },
          }),
        )
      ).status,
    ).toBe(400);

    // Host chooses responder's account -> approves with direction responder_to_host (status = approved)
    const hostApprove = await app.fetch(
      jsonReq(
        '/v1/pair/approve',
        'POST',
        { pairingId: created.pairingId, direction: 'responder_to_host' },
        { 'x-pair-poll-token': created.pollToken },
      ),
    );
    expect(hostApprove.status).toBe(200);
    expect(await hostApprove.json()).toMatchObject({
      pairingId: created.pairingId,
      status: 'approved',
      direction: 'responder_to_host',
    });

    // Responder polls, sees hostApproved: true + direction responder_to_host, then transfers post-SAS
    const respSeeApprove = await app.fetch(
      new Request(`https://sync.example.test/v1/pair/poll/${created.pairingId}`, {
        headers: { 'x-pair-responder-token': responderToken },
      }),
    );
    expect(await respSeeApprove.json()).toMatchObject({
      status: 'approved',
      hostApproved: true,
      direction: 'responder_to_host',
    });

    const transferRes = await app.fetch(
      jsonReq(
        '/v1/pair/transfer',
        'POST',
        {
          pairingId: created.pairingId,
          direction: 'responder_to_host',
          encryptedPayload: 'bob_wins_encrypted_payload_0123456',
          iv: 'iv_bob_wins_123456',
        },
        { 'x-pair-responder-token': responderToken },
      ),
    );
    expect(transferRes.status).toBe(200);
    expect(await transferRes.json()).toMatchObject({
      pairingId: created.pairingId,
      status: 'completed',
      direction: 'responder_to_host',
    });

    // Host consumes responder payload once
    const hostConsumed = await app.fetch(
      new Request(`https://sync.example.test/v1/pair/poll/${created.pairingId}`, {
        headers: { 'x-pair-poll-token': created.pollToken },
      }),
    );
    expect(await hostConsumed.json()).toMatchObject({
      status: 'completed',
      hostApproved: true,
      direction: 'responder_to_host',
      encryptedPayload: 'bob_wins_encrypted_payload_0123456',
      iv: 'iv_bob_wins_123456',
    });

    // IP rate limit on /v1/pair/lookup triggers 429 on 5th call from same IP
    for (let i = 0; i < 3; i += 1) {
      await app.fetch(jsonReq('/v1/pair/lookup', 'POST', { code: '00000001' }), {
        clientIp: '10.1.1.1',
      });
    }
    const limitedLookup = await app.fetch(
      jsonReq('/v1/pair/lookup', 'POST', { code: '00000002' }),
      { clientIp: '10.1.1.1' },
    );
    expect(limitedLookup.status).toBe(429);
  });
});
