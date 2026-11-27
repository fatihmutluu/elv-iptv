import { randomBytes } from 'node:crypto';
import { ok } from '@elv/domain';
import { base64UrlEncode, type QrPairingPayload, type SyncHttpPort } from '@elv/sync';
import { describe, expect, it, vi } from 'vitest';
import { createBidirectionalPairingController } from './bidirectional-pairing.ts';

interface MockPairRecord {
  pairingId: string;
  code: string;
  pollToken: string;
  responderToken?: string;
  hostPublicKey: string;
  hostAuthState: 'signed_in' | 'signed_out';
  hostMaskedEmail: string | null;
  hostEmailHash: string | null;
  responderPublicKey?: string;
  responderAuthState?: 'signed_in' | 'signed_out';
  responderMaskedEmail?: string | null;
  responderEmailHash?: string | null;
  direction?: string;
  hostApprovedAt: number | null;
  encryptedPayload: string | null;
  iv: string | null;
  returnEncryptedPayload: string | null;
  returnIv: string | null;
  status:
    | 'pending'
    | 'responder_joined'
    | 'responder_transferred'
    | 'approved'
    | 'completed'
    | 'rejected';
  expiresAt: number;
}

/**
 * Mirrors `apps/sync-server/src/pair-routes.ts` strict 2-phase SAS contract byte-for-byte:
 * - `POST /v1/pair/respond` rejects any non-null `encryptedPayload`/`iv` with `400 pre_sas_payload_forbidden`
 * - `POST /v1/pair/transfer` (header `X-Pair-Responder-Token`) accepts single-shot post-SAS responder transfer
 * - `POST /v1/pair/approve` (header `X-Pair-Poll-Token`) sets `hostApprovedAt` and handles all directions
 * - `POST /v1/pair/cancel` accepts either token in any non-terminal state (including `pending`) and wipes all payloads
 * - `GET /v1/pair/poll/:id` enforces `hostApproved === true` before atomic burn-after-read
 */
function makeStrictPairV2Server(nowMs: () => number) {
  const byId = new Map<string, MockPairRecord>();
  const byCode = new Map<string, MockPairRecord>();
  const requests: Array<{
    method: string;
    path: string;
    headers: Readonly<Record<string, string>>;
    body: Record<string, unknown>;
  }> = [];
  let seq = 0;

  const http: SyncHttpPort = {
    async request(req) {
      const url = new URL(req.url);
      const body = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {};
      requests.push({
        method: req.method,
        path: url.pathname,
        headers: req.headers ?? {},
        body,
      });

      if (req.method === 'POST' && url.pathname === '/v1/pair/create') {
        seq += 1;
        const code = String(10_000_000 + seq);
        const rec: MockPairRecord = {
          pairingId: `pair-${seq}`,
          code,
          pollToken: `poll-${seq}`,
          hostPublicKey: String(body.hostPublicKey),
          hostAuthState: body.hostAuthState as 'signed_in' | 'signed_out',
          hostMaskedEmail: (body.hostMaskedEmail as string | null) ?? null,
          hostEmailHash: (body.hostEmailHash as string | null) ?? null,
          hostApprovedAt: null,
          encryptedPayload: null,
          iv: null,
          returnEncryptedPayload: null,
          returnIv: null,
          status: 'pending',
          expiresAt: nowMs() + 300_000,
        };
        byId.set(rec.pairingId, rec);
        byCode.set(code, rec);
        return {
          status: 201,
          bodyText: JSON.stringify({
            pairingId: rec.pairingId,
            code: rec.code,
            pollToken: rec.pollToken,
            expiresAt: rec.expiresAt,
          }),
        };
      }

      if (req.method === 'POST' && url.pathname === '/v1/pair/lookup') {
        const rec = byCode.get(String(body.code));
        if (!rec) return { status: 404, bodyText: JSON.stringify({ error: 'pair_not_found' }) };
        return {
          status: 200,
          bodyText: JSON.stringify({
            pairingId: rec.pairingId,
            hostPublicKey: rec.hostPublicKey,
            hostAuthState: rec.hostAuthState,
            hostMaskedEmail: rec.hostMaskedEmail,
            hostEmailHash: rec.hostEmailHash,
            status: rec.status,
            expiresAt: rec.expiresAt,
          }),
        };
      }

      if (req.method === 'POST' && url.pathname === '/v1/pair/respond') {
        if (body.encryptedPayload !== undefined && body.encryptedPayload !== null) {
          return { status: 400, bodyText: JSON.stringify({ error: 'pre_sas_payload_forbidden' }) };
        }
        if (body.iv !== undefined && body.iv !== null) {
          return { status: 400, bodyText: JSON.stringify({ error: 'pre_sas_payload_forbidden' }) };
        }
        const rec = byCode.get(String(body.code));
        if (!rec) return { status: 404, bodyText: JSON.stringify({ error: 'pair_not_found' }) };
        if (rec.status !== 'pending') {
          return { status: 409, bodyText: JSON.stringify({ error: 'pair_already_responded' }) };
        }
        rec.responderPublicKey = String(body.responderPublicKey);
        rec.responderAuthState = body.responderAuthState as 'signed_in' | 'signed_out';
        rec.responderMaskedEmail = (body.responderMaskedEmail as string | null) ?? null;
        rec.responderEmailHash = (body.responderEmailHash as string | null) ?? null;
        rec.direction = String(body.direction);
        rec.responderToken = `resp-${++seq}`;
        rec.status = 'responder_joined';
        return {
          status: 200,
          bodyText: JSON.stringify({
            pairingId: rec.pairingId,
            responderToken: rec.responderToken,
            status: rec.status,
            direction: rec.direction,
          }),
        };
      }

      if (req.method === 'POST' && url.pathname === '/v1/pair/transfer') {
        const rec = byId.get(String(body.pairingId));
        if (!rec) return { status: 404, bodyText: JSON.stringify({ error: 'pair_not_found' }) };
        if (!rec.responderToken || req.headers?.['X-Pair-Responder-Token'] !== rec.responderToken) {
          return { status: 401, bodyText: JSON.stringify({ error: 'invalid_responder_token' }) };
        }
        if (rec.encryptedPayload !== null || rec.status === 'responder_transferred') {
          return { status: 409, bodyText: JSON.stringify({ error: 'pair_already_transferred' }) };
        }
        if (
          rec.status !== 'responder_joined' &&
          !(
            rec.status === 'approved' &&
            rec.direction === 'responder_to_host' &&
            rec.returnEncryptedPayload === null
          )
        ) {
          return { status: 409, bodyText: JSON.stringify({ error: 'pair_invalid_state' }) };
        }
        rec.encryptedPayload = String(body.encryptedPayload);
        rec.iv = String(body.iv);
        rec.direction = String(body.direction);
        rec.status = rec.hostApprovedAt !== null ? 'completed' : 'responder_transferred';
        return {
          status: 200,
          bodyText: JSON.stringify({
            pairingId: rec.pairingId,
            status: rec.status,
            direction: rec.direction,
          }),
        };
      }

      if (req.method === 'POST' && url.pathname === '/v1/pair/approve') {
        const rec = byId.get(String(body.pairingId));
        if (!rec || req.headers?.['X-Pair-Poll-Token'] !== rec.pollToken) {
          return { status: 401, bodyText: JSON.stringify({ error: 'invalid_poll_token' }) };
        }
        if (body.reject === true) {
          rec.status = 'rejected';
          rec.hostApprovedAt = null;
          rec.encryptedPayload = null;
          rec.iv = null;
          rec.returnEncryptedPayload = null;
          rec.returnIv = null;
        } else {
          rec.hostApprovedAt = nowMs();
          rec.direction = String(body.direction);
          if (body.direction === 'host_to_responder') {
            if (typeof body.encryptedPayload !== 'string' || typeof body.iv !== 'string') {
              return {
                status: 400,
                bodyText: JSON.stringify({ error: 'missing_encrypted_payload' }),
              };
            }
            rec.returnEncryptedPayload = body.encryptedPayload;
            rec.returnIv = body.iv;
            rec.encryptedPayload = null;
            rec.iv = null;
            rec.status = 'approved';
          } else if (body.direction === 'responder_to_host') {
            if (body.encryptedPayload !== undefined || body.iv !== undefined) {
              return {
                status: 400,
                bodyText: JSON.stringify({ error: 'unexpected_encrypted_payload' }),
              };
            }
            rec.status = rec.encryptedPayload !== null ? 'completed' : 'approved';
          } else {
            rec.status = 'approved';
          }
        }
        return {
          status: 200,
          bodyText: JSON.stringify({
            pairingId: rec.pairingId,
            status: rec.status,
            direction: rec.direction,
          }),
        };
      }

      if (req.method === 'POST' && url.pathname === '/v1/pair/cancel') {
        const rec = byId.get(String(body.pairingId));
        if (!rec) return { status: 404, bodyText: JSON.stringify({ error: 'pair_not_found' }) };
        const pollTok = req.headers?.['X-Pair-Poll-Token'];
        const respTok = req.headers?.['X-Pair-Responder-Token'];
        if (pollTok && respTok) {
          return { status: 400, bodyText: JSON.stringify({ error: 'ambiguous_pair_token' }) };
        }
        if (!pollTok && !respTok) {
          return { status: 401, bodyText: JSON.stringify({ error: 'missing_pair_token' }) };
        }
        if (pollTok && pollTok !== rec.pollToken) {
          return { status: 401, bodyText: JSON.stringify({ error: 'invalid_poll_token' }) };
        }
        if (respTok && respTok !== rec.responderToken) {
          return { status: 401, bodyText: JSON.stringify({ error: 'invalid_responder_token' }) };
        }
        rec.status = 'rejected';
        rec.hostApprovedAt = null;
        rec.encryptedPayload = null;
        rec.iv = null;
        rec.returnEncryptedPayload = null;
        rec.returnIv = null;
        return {
          status: 200,
          bodyText: JSON.stringify({ pairingId: rec.pairingId, status: 'rejected' }),
        };
      }

      if (req.method === 'GET' && url.pathname.startsWith('/v1/pair/poll/')) {
        const id = url.pathname.slice('/v1/pair/poll/'.length);
        const rec = byId.get(id);
        if (!rec) return { status: 404, bodyText: JSON.stringify({ error: 'pair_not_found' }) };
        if (nowMs() >= rec.expiresAt) {
          return { status: 410, bodyText: JSON.stringify({ error: 'pair_expired' }) };
        }
        const pollTok = req.headers?.['X-Pair-Poll-Token'];
        const respTok = req.headers?.['X-Pair-Responder-Token'];
        const hostApproved = rec.hostApprovedAt !== null;
        if (pollTok === rec.pollToken) {
          if (
            hostApproved &&
            (rec.status === 'approved' ||
              rec.status === 'responder_transferred' ||
              rec.status === 'completed') &&
            rec.encryptedPayload !== null &&
            rec.iv !== null
          ) {
            const encryptedPayload = rec.encryptedPayload;
            const iv = rec.iv;
            rec.encryptedPayload = null;
            rec.iv = null;
            rec.status = 'completed';
            return {
              status: 200,
              bodyText: JSON.stringify({
                status: 'completed',
                hostApproved: true,
                responderPublicKey: rec.responderPublicKey,
                responderAuthState: rec.responderAuthState,
                responderMaskedEmail: rec.responderMaskedEmail,
                responderEmailHash: rec.responderEmailHash,
                direction: rec.direction,
                encryptedPayload,
                iv,
                expiresAt: rec.expiresAt,
              }),
            };
          }
          return {
            status: 200,
            bodyText: JSON.stringify({
              status: rec.status,
              hostApproved,
              responderPublicKey: rec.responderPublicKey ?? null,
              responderAuthState: rec.responderAuthState ?? null,
              responderMaskedEmail: rec.responderMaskedEmail ?? null,
              responderEmailHash: rec.responderEmailHash ?? null,
              direction: rec.direction ?? null,
              expiresAt: rec.expiresAt,
            }),
          };
        }
        if (respTok && respTok === rec.responderToken) {
          if (
            hostApproved &&
            rec.status === 'approved' &&
            rec.returnEncryptedPayload !== null &&
            rec.returnIv !== null
          ) {
            const encryptedPayload = rec.returnEncryptedPayload;
            const iv = rec.returnIv;
            rec.returnEncryptedPayload = null;
            rec.returnIv = null;
            rec.status = 'completed';
            return {
              status: 200,
              bodyText: JSON.stringify({
                status: 'completed',
                hostApproved: true,
                direction: rec.direction,
                encryptedPayload,
                iv,
                expiresAt: rec.expiresAt,
              }),
            };
          }
          return {
            status: 200,
            bodyText: JSON.stringify({
              status: rec.status,
              hostApproved,
              direction: rec.direction ?? null,
              expiresAt: rec.expiresAt,
            }),
          };
        }
        return { status: 401, bodyText: JSON.stringify({ error: 'unauthorized' }) };
      }

      return { status: 404, bodyText: '{}' };
    },
  };
  return { http, byId, requests };
}

function makeDevice(
  http: SyncHttpPort,
  initialEmail: string | null,
  nowMs: () => number,
  onRandomBytes?: (buf: Uint8Array) => void,
) {
  let email = initialEmail;
  const adopted: QrPairingPayload[] = [];
  const syncCount = { value: 0 };
  const mintCount = { value: 0 };
  const vaultKey = new Uint8Array(32).fill(initialEmail ? initialEmail.charCodeAt(0) : 9);
  const controller = createBidirectionalPairingController({
    getBaseUrl: () => 'https://sync.example.test',
    http,
    randomBytes: (len) => {
      const buf = new Uint8Array(randomBytes(len));
      onRandomBytes?.(buf);
      return buf;
    },
    clock: { now: nowMs },
    getLocalAuth: () => ({ signedIn: email !== null, email }),
    mintPairTransferPayload: async () => {
      mintCount.value += 1;
      return ok({
        email: email ?? '',
        refreshToken: `pair-ref-${email}`,
        vaultKeyB64: base64UrlEncode(vaultKey),
      });
    },
    adoptPairedSession: async (_baseUrl, payload) => {
      adopted.push(payload);
      email = payload.email;
      return ok(undefined);
    },
    triggerImmediateSync: async () => {
      syncCount.value += 1;
    },
  });
  return { controller, adopted, syncCount, mintCount, getEmail: () => email };
}

describe('createBidirectionalPairingController (strict 2-phase SAS-gated pairing, #510)', () => {
  it('enforces zero pre-SAS payload on /respond, blocks responder adoption prior to confirm, and completes all 5 cases in both confirmation orders', async () => {
    const now = 1_700_000_000_000;
    const server = makeStrictPairV2Server(() => now);

    // Case 1: neither_signed_in stays awaiting_sas (NOT completed) so UI stays visible for pair-case-neither
    {
      const host = makeDevice(server.http, null, () => now);
      const resp = makeDevice(server.http, null, () => now);
      const started = await host.controller.startBidirectionalPairing();
      const joined = await resp.controller.joinBidirectionalPairing(started.code);
      expect(joined.direction).toBe('neither_signed_in');
      expect(joined.status).toBe('awaiting_sas');
      expect(joined.errorCode).toBe('neither_signed_in');
      const polled = await host.controller.pollBidirectionalPairing(started.pairingId);
      expect(polled.direction).toBe('neither_signed_in');
      expect(polled.status).toBe('awaiting_sas');
      expect(polled.errorCode).toBe('neither_signed_in');
      // Subsequent polls keep awaiting_sas without expiring
      expect((await resp.controller.pollBidirectionalPairing(joined.pairingId)).status).toBe(
        'awaiting_sas',
      );
      expect((await host.controller.pollBidirectionalPairing(started.pairingId)).status).toBe(
        'awaiting_sas',
      );
      expect(host.adopted).toHaveLength(0);
      expect(resp.adopted).toHaveLength(0);
    }

    // Case 2A: responder_to_host (Signed-out Host waits on SAS -> signed-in Responder confirms SAS -> Host auto-adopts on poll)
    {
      const host = makeDevice(server.http, null, () => now);
      const resp = makeDevice(server.http, 'alice@example.test', () => now);
      const started = await host.controller.startBidirectionalPairing();
      const joined = await resp.controller.joinBidirectionalPairing(started.qrUri ?? started.code);

      // P0-1: Phase 1 returns awaiting_sas on signed-in Responder, sends ZERO payload/iv on /respond, mints ZERO tokens!
      expect(joined.status).toBe('awaiting_sas');
      expect(joined.direction).toBe('responder_to_host');
      expect(joined.sas).toMatch(/^\d{4}$/);
      expect(resp.mintCount.value).toBe(0);
      const respondReq = server.requests.filter((r) => r.path === '/v1/pair/respond').at(-1);
      expect(respondReq?.body.encryptedPayload).toBeUndefined();
      expect(respondReq?.body.iv).toBeUndefined();

      // Signed-out Host displays matching 4-digit SAS in waiting_approval (no confirm button needed on signed-out receiver)
      const hostPolled = await host.controller.pollBidirectionalPairing(started.pairingId);
      expect(hostPolled.status).toBe('waiting_approval');
      expect(hostPolled.sas).toBe(joined.sas);
      expect(hostPolled.peerMaskedEmail).toBe('a***@example.test');
      expect(host.adopted).toHaveLength(0);

      // Signed-in Responder confirms SAS -> mints refreshToken and calls POST /v1/pair/transfer
      expect(await resp.controller.confirmBidirectionalPairing(joined.pairingId)).toEqual({
        ok: true,
      });
      expect(resp.mintCount.value).toBe(1);
      expect(
        server.requests.filter((r) => r.path === '/v1/pair/transfer').at(-1)?.headers[
          'X-Pair-Responder-Token'
        ],
      ).toBeTruthy();

      // Signed-out Host polls after Responder confirmed -> auto-approves, burns, decrypts, and adopts cleanly!
      const hostAdopted = await host.controller.pollBidirectionalPairing(started.pairingId);
      expect(hostAdopted.status).toBe('completed');
      expect(host.getEmail()).toBe('alice@example.test');
      expect(host.syncCount.value).toBe(1);

      const respDone = await resp.controller.pollBidirectionalPairing(joined.pairingId);
      expect(respDone.status).toBe('completed');
    }

    // Case 2B: responder_to_host (Host confirms FIRST -> waiting_approval -> Responder confirms -> Host poll adopts)
    {
      const host = makeDevice(server.http, null, () => now);
      const resp = makeDevice(server.http, 'alice2@example.test', () => now);
      const started = await host.controller.startBidirectionalPairing();
      const joined = await resp.controller.joinBidirectionalPairing(started.code);
      await host.controller.pollBidirectionalPairing(started.pairingId);

      // Host confirms before Responder transfers -> stays waiting_approval
      expect(await host.controller.confirmBidirectionalPairing(started.pairingId)).toEqual({
        ok: true,
      });
      expect(host.adopted).toHaveLength(0);
      expect((await host.controller.pollBidirectionalPairing(started.pairingId)).status).toBe(
        'waiting_approval',
      );

      // Responder confirms -> server sees host already approved -> returns completed
      expect(await resp.controller.confirmBidirectionalPairing(joined.pairingId)).toEqual({
        ok: true,
      });
      const hostDone = await host.controller.pollBidirectionalPairing(started.pairingId);
      expect(hostDone.status).toBe('completed');
      expect(host.getEmail()).toBe('alice2@example.test');
    }

    // Case 3: host_to_responder (Signed-in Host confirms SAS -> Signed-out Responder shows 4-digit SAS waiting & auto-adopts on poll!)
    {
      const host = makeDevice(server.http, 'bob@example.test', () => now);
      const resp = makeDevice(server.http, null, () => now);
      const started = await host.controller.startBidirectionalPairing();
      const joined = await resp.controller.joinBidirectionalPairing(started.code);
      expect(joined.status).toBe('waiting_approval');
      expect(joined.direction).toBe('host_to_responder');
      expect(joined.sas).toMatch(/^\d{4}$/);
      const hostPolled = await host.controller.pollBidirectionalPairing(started.pairingId);
      expect(hostPolled.status).toBe('awaiting_sas');
      expect(hostPolled.sas).toBe(joined.sas);

      // Before Host confirms SAS, Responder stays waiting_approval with zero adoption
      const respBeforeHost = await resp.controller.pollBidirectionalPairing(joined.pairingId);
      expect(respBeforeHost.status).toBe('waiting_approval');
      expect(resp.adopted).toHaveLength(0);

      // Signed-in Host verifies SAS matches Responder and clicks Confirm -> uploads encrypted payload
      expect(await host.controller.confirmBidirectionalPairing(started.pairingId)).toEqual({
        ok: true,
      });

      // Signed-out Responder polls -> auto-decrypts & adopts without redundant second confirm click!
      const respAdopted = await resp.controller.pollBidirectionalPairing(joined.pairingId);
      expect(respAdopted.status).toBe('completed');
      expect(resp.getEmail()).toBe('bob@example.test');
      expect(resp.syncCount.value).toBe(1);
    }

    // Case 4: same_account -> triggers immediate sync on both devices
    {
      const host = makeDevice(server.http, 'carol@example.test', () => now);
      const resp = makeDevice(server.http, 'CAROL@EXAMPLE.TEST', () => now);
      const started = await host.controller.startBidirectionalPairing();
      const joined = await resp.controller.joinBidirectionalPairing(started.code);
      expect(joined.direction).toBe('same_account');
      expect(joined.status).toBe('completed');
      const hostPolled = await host.controller.pollBidirectionalPairing(started.pairingId);
      expect(hostPolled.direction).toBe('same_account');
      expect(hostPolled.status).toBe('completed');
      expect(host.syncCount.value).toBe(1);
      expect(resp.syncCount.value).toBe(1);
    }

    // Case 5: different_accounts -> requires explicit chosenDirection on BOTH devices
    {
      const host = makeDevice(server.http, 'host@example.test', () => now);
      const resp = makeDevice(server.http, 'resp@example.test', () => now);
      const started = await host.controller.startBidirectionalPairing();
      const joined = await resp.controller.joinBidirectionalPairing(started.qrUri ?? started.code);
      expect(joined.direction).toBe('different_accounts');
      expect(joined.status).toBe('awaiting_sas');
      const hostPolled = await host.controller.pollBidirectionalPairing(started.pairingId);
      expect(hostPolled.direction).toBe('different_accounts');
      expect(hostPolled.sas).toBe(joined.sas);

      // Missing direction choice rejected on both sides
      expect(await host.controller.confirmBidirectionalPairing(started.pairingId)).toEqual({
        ok: false,
        errorCode: 'direction_choice_required',
      });
      expect(await resp.controller.confirmBidirectionalPairing(joined.pairingId)).toEqual({
        ok: false,
        errorCode: 'direction_choice_required',
      });

      // Responder confirms host_to_responder first -> waiting_approval; Host confirms -> Responder adopts on poll
      expect(
        await resp.controller.confirmBidirectionalPairing(joined.pairingId, 'host_to_responder'),
      ).toEqual({ ok: true });
      expect(
        await host.controller.confirmBidirectionalPairing(started.pairingId, 'host_to_responder'),
      ).toEqual({ ok: true });
      const respDone = await resp.controller.pollBidirectionalPairing(joined.pairingId);
      expect(respDone.status).toBe('completed');
      expect(resp.getEmail()).toBe('host@example.test');
    }

    // Case 5B: different_accounts choosing responder_to_host
    {
      const host = makeDevice(server.http, 'host2@example.test', () => now);
      const resp = makeDevice(server.http, 'resp2@example.test', () => now);
      const started = await host.controller.startBidirectionalPairing();
      const joined = await resp.controller.joinBidirectionalPairing(started.code);
      await host.controller.pollBidirectionalPairing(started.pairingId);

      expect(
        await resp.controller.confirmBidirectionalPairing(joined.pairingId, 'responder_to_host'),
      ).toEqual({ ok: true });
      expect(
        await host.controller.confirmBidirectionalPairing(started.pairingId, 'responder_to_host'),
      ).toEqual({ ok: true });
      expect(host.getEmail()).toBe('resp2@example.test');
    }
  });

  it('P2-4 & P1-8: calls POST /v1/pair/cancel from pending host OR responder, discards buffered ciphertext on cancel, and zeroes privateKey on cancel and network errors', async () => {
    const now = 1_700_000_000_000;
    const server = makeStrictPairV2Server(() => now);

    // 1. Host cancels while still in 'pending' -> POST /v1/pair/cancel + privateKey zeroed!
    const hostPendingRandoms: Uint8Array[] = [];
    const hostPending = makeDevice(
      server.http,
      null,
      () => now,
      (buf) => {
        hostPendingRandoms.push(buf);
      },
    );
    const pendingSession = await hostPending.controller.startBidirectionalPairing();
    expect(hostPendingRandoms[0]?.some((b) => b !== 0)).toBe(true);
    await hostPending.controller.cancelBidirectionalPairing(pendingSession.pairingId);
    expect(server.byId.get(pendingSession.pairingId)?.status).toBe('rejected');
    expect(
      server.requests.filter((r) => r.path === '/v1/pair/cancel').at(-1)?.headers[
        'X-Pair-Poll-Token'
      ],
    ).toBeTruthy();
    expect(hostPendingRandoms[0]?.every((b) => b === 0)).toBe(true);

    // 2. different_accounts Responder buffers early host payload pre-SAS, then cancels -> POST /v1/pair/cancel, never adopts!
    const host2 = makeDevice(server.http, 'dan@example.test', () => now);
    const resp2 = makeDevice(server.http, 'other@example.test', () => now);
    const s2 = await host2.controller.startBidirectionalPairing();
    const j2 = await resp2.controller.joinBidirectionalPairing(s2.code);
    await host2.controller.pollBidirectionalPairing(s2.pairingId);
    await host2.controller.confirmBidirectionalPairing(s2.pairingId, 'host_to_responder');
    expect((await resp2.controller.pollBidirectionalPairing(j2.pairingId)).status).toBe(
      'awaiting_sas',
    );
    await resp2.controller.cancelBidirectionalPairing(j2.pairingId);
    expect(resp2.adopted).toHaveLength(0);
    expect(
      server.requests.filter((r) => r.path === '/v1/pair/cancel').at(-1)?.headers[
        'X-Pair-Responder-Token'
      ],
    ).toBeTruthy();

    // 3. Thrown network error during startBidirectionalPairing zeroes privateKey immediately!
    const throwingHttp: SyncHttpPort = {
      async request() {
        throw new Error('ECONNRESET');
      },
    };
    const errorRandoms: Uint8Array[] = [];
    const flakyHost = makeDevice(
      throwingHttp,
      null,
      () => now,
      (buf) => {
        errorRandoms.push(buf);
      },
    );
    await expect(flakyHost.controller.startBidirectionalPairing()).rejects.toThrow('ECONNRESET');
    expect(errorRandoms[0]?.every((b) => b === 0)).toBe(true);

    // 4. Thrown network error during pollBidirectionalPairing zeroes host privateKey & rejects cleanly!
    let failPoll = false;
    const flakyPollHttp: SyncHttpPort = {
      async request(req) {
        if (failPoll && req.url.includes('/v1/pair/poll/')) throw new Error('ETIMEDOUT');
        return server.http.request(req);
      },
    };
    const pollRandoms: Uint8Array[] = [];
    const flakyPollHost = makeDevice(
      flakyPollHttp,
      null,
      () => now,
      (buf) => {
        pollRandoms.push(buf);
      },
    );
    const s3 = await flakyPollHost.controller.startBidirectionalPairing();
    failPoll = true;
    const pollErrSnap = await flakyPollHost.controller.pollBidirectionalPairing(s3.pairingId);
    expect(pollErrSnap.status).toBe('rejected');
    expect(pollErrSnap.errorCode).toBe('network_error');
    expect(pollRandoms[0]?.every((b) => b === 0)).toBe(true);

    vi.restoreAllMocks();
  });
});
