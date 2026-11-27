import { webcrypto } from 'node:crypto';
import { ok, type SecretStore } from '@elv/domain';
import {
  base64UrlEncode,
  createEmptyVaultSnapshot,
  createWebCryptoVaultPort,
  type QrPairingPayload,
  type SyncHttpPort,
  type VaultCryptoPort,
  type VaultSnapshot,
} from '@elv/sync';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@elv/lan-pairing', () => ({
  generateLanPairingToken: () => null,
}));

import { createMobileBidirectionalPairingController } from './bidirectional-pairing';
import { VAULT_BASELINE_SECRET_KEY } from './sync-helpers';
import { createTvMobileSyncPorts, type SyncFetchFn } from './sync-runtime';

function makeMemorySecretStore(): { store: SecretStore; data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    store: {
      async get(k) {
        return data.get(k);
      },
      async set(k, v) {
        data.set(k, v);
      },
      async delete(k) {
        data.delete(k);
      },
    },
  };
}

function detRandom(seed: number) {
  let s = seed >>> 0;
  return (len: number): Uint8Array => {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      out[i] = (s >>> 24) & 0xff;
    }
    return out;
  };
}

function makeTestCrypto(seed = 1): VaultCryptoPort {
  const random = detRandom(seed);
  return createWebCryptoVaultPort(webcrypto.subtle as unknown as SubtleCrypto, (arr) => {
    arr.set(random(arr.length));
    return arr;
  });
}

interface StrictPairRec {
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

/** Faithful strict 2-phase mirror of `apps/sync-server/src/pair-routes.ts` (P0-1, P2-4). */
function makeStrictPairServer(nowMs: () => number) {
  const byId = new Map<string, StrictPairRec>();
  const byCode = new Map<string, StrictPairRec>();
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
      requests.push({ method: req.method, path: url.pathname, headers: req.headers ?? {}, body });

      if (req.method === 'POST' && url.pathname === '/v1/pair/create') {
        seq += 1;
        const rec: StrictPairRec = {
          pairingId: `mp-${seq}`,
          code: String(20_000_000 + seq),
          pollToken: `mpt-${seq}`,
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
        byCode.set(rec.code, rec);
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
        if (
          (body.encryptedPayload !== undefined && body.encryptedPayload !== null) ||
          (body.iv !== undefined && body.iv !== null)
        ) {
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
        rec.responderToken = `mrt-${++seq}`;
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
        if (
          !rec ||
          !rec.responderToken ||
          req.headers?.['X-Pair-Responder-Token'] !== rec.responderToken
        ) {
          return { status: 401, bodyText: JSON.stringify({ error: 'invalid_responder_token' }) };
        }
        if (rec.encryptedPayload !== null) {
          return { status: 409, bodyText: JSON.stringify({ error: 'pair_already_transferred' }) };
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
        rec.hostApprovedAt = nowMs();
        rec.direction = String(body.direction);
        if (body.direction === 'host_to_responder') {
          rec.returnEncryptedPayload = String(body.encryptedPayload);
          rec.returnIv = String(body.iv);
          rec.status = 'approved';
        } else if (body.direction === 'responder_to_host') {
          rec.status = rec.encryptedPayload !== null ? 'completed' : 'approved';
        } else {
          rec.status = 'approved';
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
        const p = req.headers?.['X-Pair-Poll-Token'];
        const r = req.headers?.['X-Pair-Responder-Token'];
        if ((!p && !r) || (p && p !== rec.pollToken) || (r && r !== rec.responderToken)) {
          return { status: 401, bodyText: JSON.stringify({ error: 'invalid_token' }) };
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
        const rec = byId.get(url.pathname.slice('/v1/pair/poll/'.length));
        if (!rec) return { status: 410, bodyText: JSON.stringify({ error: 'pair_expired' }) };
        const isHost = req.headers?.['X-Pair-Poll-Token'] === rec.pollToken;
        const isResp =
          rec.responderToken !== undefined &&
          req.headers?.['X-Pair-Responder-Token'] === rec.responderToken;
        if (!isHost && !isResp) {
          return { status: 401, bodyText: JSON.stringify({ error: 'invalid_token' }) };
        }
        let encryptedPayload: string | null = null;
        let iv: string | null = null;
        let returnStatus = rec.status;
        if (isHost && rec.hostApprovedAt !== null && rec.encryptedPayload && rec.iv) {
          encryptedPayload = rec.encryptedPayload;
          iv = rec.iv;
          rec.encryptedPayload = null;
          rec.iv = null;
          rec.status = 'completed';
          returnStatus = 'completed';
        }
        if (isResp && rec.hostApprovedAt !== null && rec.returnEncryptedPayload && rec.returnIv) {
          encryptedPayload = rec.returnEncryptedPayload;
          iv = rec.returnIv;
          rec.returnEncryptedPayload = null;
          rec.returnIv = null;
          rec.status = 'completed';
          returnStatus = 'completed';
        }
        return {
          status: 200,
          bodyText: JSON.stringify({
            pairingId: rec.pairingId,
            status: returnStatus,
            direction: rec.direction ?? null,
            hostApproved: rec.hostApprovedAt !== null,
            responderPublicKey: rec.responderPublicKey ?? null,
            responderAuthState: rec.responderAuthState ?? null,
            responderMaskedEmail: rec.responderMaskedEmail ?? null,
            responderEmailHash: rec.responderEmailHash ?? null,
            encryptedPayload,
            iv,
            expiresAt: rec.expiresAt,
          }),
        };
      }
      return { status: 404, bodyText: JSON.stringify({ error: 'not_found' }) };
    },
  };
  return { http, byId, requests };
}

describe('Mobile Wave P9 auto-sync, bidirectional X25519 pairing, and 13-kind telemetry (#509, #510)', () => {
  it('records all 13 telemetry event kinds with sanitized DeviceTechnicalProfile and flushes on background', async () => {
    const batches: Array<Record<string, unknown>> = [];
    let appStateCb: ((next: string) => void) | undefined;
    const fetchFn: SyncFetchFn = async (url, init) => {
      if (new URL(url).pathname === '/v1/telemetry' && init?.body) {
        batches.push(JSON.parse(init.body) as Record<string, unknown>);
        return { status: 200, text: async () => '{"ok":true}' };
      }
      return { status: 404, text: async () => '{}' };
    };

    const ports = createTvMobileSyncPorts({
      secretStore: makeMemorySecretStore().store,
      fetchFn,
      randomBytes: detRandom(5),
      clock: { now: () => 1_700_000_000_000 },
      getServerUrl: () => 'https://sync.example.test',
      getPreferences: () => ({ telemetryOptIn: true, syncServerUrl: '' }),
      getDeviceMeta: () => ({
        platform: 'android-tv',
        appVersion: '2.0.0',
        locale: 'en-US',
        osVersion: 'Android 14',
        formFactor: 'tv',
        arch: 'arm64',
        ramBucket: '4gb',
        resolution: '1920x1080',
      }),
      subscribeAppState: (listener) => {
        appStateCb = listener;
        return () => {
          appStateCb = undefined;
        };
      },
      flushIntervalMs: 0,
    });

    ports.telemetry.recordStartup?.(410, true);
    ports.telemetry.recordScreenTransition('home', 18);
    ports.telemetry.recordFrameJank?.({ screen: 'guide', droppedFrames: 5, maxFrameMs: 70 });
    ports.telemetry.recordJsStall?.({ screen: 'guide', durationMs: 220 });
    ports.telemetry.recordMemoryPressure?.({ level: 'moderate', usedMb: 380 });
    ports.telemetry.recordPlaybackStart?.({
      engine: 'media3',
      ttffMs: 320,
      isLive: true,
      container: 'ts',
    });
    ports.telemetry.recordPlaybackRebuffer?.({ engine: 'media3', durationMs: 650, isLive: true });
    ports.telemetry.recordPlaybackError({ engine: 'media3', errorCode: 'http-503', isLive: true });
    ports.telemetry.recordMediaDecodeFailure({
      engine: 'media3',
      container: 'mkv',
      videoCodec: 'hevc',
      audioCodec: 'eac3',
      errorCode: 'decoder',
      isLive: false,
    });
    ports.telemetry.recordSqliteSlowOp?.({ op: 'SELECT', durationMs: 290 });
    ports.telemetry.recordAppCrash?.({
      errorName: 'TypeError',
      stackSig: 'App.tsx:22',
      fatal: true,
      uptimeMs: 9_000,
    });
    ports.telemetry.recordUnhandledError?.({
      errorName: 'Error',
      stackSig: 'Home.tsx:10',
      source: 'js',
    });
    ports.telemetry.recordCatalogImport?.({
      sourceKind: 'xtream',
      stage: 'catalog',
      durationMs: 1200,
      itemCount: 3000,
      success: true,
    });

    expect(ports.telemetry.queuedCount()).toBe(13);
    appStateCb?.('background');
    await vi.waitFor(() => expect(batches).toHaveLength(1));
    expect(batches[0]?.events).toHaveLength(13);
    expect(batches[0]?.deviceProfile).toMatchObject({
      formFactor: 'tv',
      arch: 'arm64',
      ramBucket: '4gb',
      resolution: '1920x1080',
      locale: 'en-US',
    });
    expect(ports.syncAccount.getState().autoSyncState).toBe('idle');
    expect(typeof ports.syncAccount.startBidirectionalPairing).toBe('function');
    expect(typeof ports.flushBeforeBackground).toBe('function');
    expect(typeof ports.notifyStartup).toBe('function');
    ports.dispose();
  });

  it('enforces strict 2-phase SAS-gated bidirectional pairing across all 5 cases, cancel, and key zeroing (P0-1, P1-8, P2-4)', async () => {
    const now = 1_700_000_000_000;
    const srv = makeStrictPairServer(() => now);
    const makeDevice = (email: string | null, seed: number) => {
      let currentEmail = email;
      const adopted: QrPairingPayload[] = [];
      const minted = vi.fn(async () =>
        ok<QrPairingPayload>({
          email: currentEmail ?? 'none@example.test',
          refreshToken: `ref-${currentEmail}-${seed}`,
          vaultKeyB64: base64UrlEncode(new Uint8Array(32).fill(seed)),
        }),
      );
      const synced = vi.fn(async () => undefined);
      const ctrl = createMobileBidirectionalPairingController({
        http: srv.http,
        randomBytes: detRandom(seed),
        clock: { now: () => now },
        getBaseUrl: () => 'https://sync.example.test',
        getLocalAuth: () => ({ signedIn: currentEmail !== null, email: currentEmail }),
        mintPairTransferPayload: minted,
        adoptPairedSession: async (_baseUrl: string, payload: QrPairingPayload) => {
          adopted.push(payload);
          currentEmail = payload.email;
          return ok(undefined);
        },
        triggerImmediateSync: synced,
      });
      return { ctrl, adopted, minted, synced };
    };

    // Case 1: responder_to_host — signed-in phone confirms SAS; signed-out TV waits on SAS & auto-adopts on poll
    const tv1 = makeDevice(null, 11);
    const phone1 = makeDevice('alice@example.test', 22);
    const start1 = await tv1.ctrl.startBidirectionalPairing();
    const join1 = await phone1.ctrl.joinBidirectionalPairing(start1.qrUri ?? start1.code);
    expect(join1.status).toBe('awaiting_sas');
    expect(join1.direction).toBe('responder_to_host');
    expect(phone1.minted).not.toHaveBeenCalled();
    const respondReq = srv.requests.find((r) => r.path === '/v1/pair/respond');
    expect(respondReq?.body.encryptedPayload).toBeUndefined();
    expect(respondReq?.body.iv).toBeUndefined();

    const poll1 = await tv1.ctrl.pollBidirectionalPairing(start1.pairingId);
    expect(poll1.status).toBe('waiting_approval');
    expect(poll1.sas).toBe(join1.sas);
    expect(tv1.adopted).toHaveLength(0);

    expect(await phone1.ctrl.confirmBidirectionalPairing(join1.pairingId)).toEqual({ ok: true });
    expect(phone1.minted).toHaveBeenCalledTimes(1);
    const adoptedTv1 = await tv1.ctrl.pollBidirectionalPairing(start1.pairingId);
    expect(adoptedTv1.status).toBe('completed');
    expect(tv1.adopted).toHaveLength(1);
    expect(tv1.adopted[0]?.email).toBe('alice@example.test');

    // Case 2: host_to_responder — signed-in Host confirms SAS; signed-out Responder waits on SAS & auto-adopts on poll!
    const host2 = makeDevice('bob@example.test', 33);
    const resp2 = makeDevice(null, 44);
    const start2 = await host2.ctrl.startBidirectionalPairing();
    const join2 = await resp2.ctrl.joinBidirectionalPairing(start2.code);
    expect(join2.status).toBe('waiting_approval');
    expect(join2.sas).toMatch(/^\d{4}$/);
    expect((await host2.ctrl.pollBidirectionalPairing(start2.pairingId)).sas).toBe(join2.sas);
    // Before Host approves, Responder stays waiting_approval
    expect((await resp2.ctrl.pollBidirectionalPairing(join2.pairingId)).status).toBe(
      'waiting_approval',
    );
    expect(resp2.adopted).toHaveLength(0);
    // Host confirms SAS -> Responder adopts automatically on poll
    expect(await host2.ctrl.confirmBidirectionalPairing(start2.pairingId)).toEqual({ ok: true });
    const adoptedResp2 = await resp2.ctrl.pollBidirectionalPairing(join2.pairingId);
    expect(adoptedResp2.status).toBe('completed');
    expect(resp2.adopted).toHaveLength(1);
    expect(resp2.adopted[0]?.email).toBe('bob@example.test');

    // Case 3: different_accounts — both choose responder_to_host
    const host3 = makeDevice('host@example.test', 55);
    const resp3 = makeDevice('resp@example.test', 66);
    const start3 = await host3.ctrl.startBidirectionalPairing();
    const join3 = await resp3.ctrl.joinBidirectionalPairing(start3.code);
    expect(join3.direction).toBe('different_accounts');
    expect((await host3.ctrl.pollBidirectionalPairing(start3.pairingId)).sas).toBe(join3.sas);
    expect(
      await host3.ctrl.confirmBidirectionalPairing(start3.pairingId, 'responder_to_host'),
    ).toEqual({ ok: true });
    expect(
      await resp3.ctrl.confirmBidirectionalPairing(join3.pairingId, 'responder_to_host'),
    ).toEqual({ ok: true });
    expect((await host3.ctrl.pollBidirectionalPairing(start3.pairingId)).status).toBe('completed');
    expect(host3.adopted[0]?.email).toBe('resp@example.test');

    // Case 4: same_account -> triggers immediate sync and returns completed
    const host4 = makeDevice('same@example.test', 77);
    const resp4 = makeDevice('same@example.test', 88);
    const start4 = await host4.ctrl.startBidirectionalPairing();
    const join4 = await resp4.ctrl.joinBidirectionalPairing(start4.code);
    expect(join4.direction).toBe('same_account');
    expect(join4.status).toBe('completed');
    expect(resp4.synced).toHaveBeenCalledTimes(1);

    // Case 5: neither_signed_in -> stays awaiting_sas (NOT completed!) with errorCode
    const host5 = makeDevice(null, 91);
    const resp5 = makeDevice(null, 92);
    const start5 = await host5.ctrl.startBidirectionalPairing();
    const join5 = await resp5.ctrl.joinBidirectionalPairing(start5.code);
    expect(join5.direction).toBe('neither_signed_in');
    expect(join5.status).toBe('awaiting_sas');
    expect(join5.errorCode).toBe('neither_signed_in');

    // P2-4: Cancel from pending (host) calls POST /v1/pair/cancel with X-Pair-Poll-Token
    const host6 = makeDevice('cancel@example.test', 93);
    const start6 = await host6.ctrl.startBidirectionalPairing();
    await host6.ctrl.cancelBidirectionalPairing(start6.pairingId);
    expect(srv.byId.get(start6.pairingId)?.status).toBe('rejected');
    expect(
      srv.requests.some(
        (r) => r.path === '/v1/pair/cancel' && r.headers['X-Pair-Poll-Token'] !== undefined,
      ),
    ).toBe(true);

    // P1-8: Network error during start/join zeroes ephemeral key buffer without leaking
    const generatedBuffers: Uint8Array[] = [];
    const failingCtrl = createMobileBidirectionalPairingController({
      http: {
        async request() {
          throw new Error('offline');
        },
      },
      randomBytes: (len: number) => {
        const buf = detRandom(99)(len);
        generatedBuffers.push(buf);
        return buf;
      },
      clock: { now: () => now },
      getBaseUrl: () => 'https://sync.example.test',
      getLocalAuth: () => ({ signedIn: false, email: null }),
      mintPairTransferPayload: async () => ok({ email: '', refreshToken: '', vaultKeyB64: '' }),
      adoptPairedSession: async () => ok(undefined),
      triggerImmediateSync: async () => undefined,
    });
    await expect(failingCtrl.startBidirectionalPairing()).rejects.toThrow('offline');
    expect(generatedBuffers.length).toBeGreaterThan(0);
    expect(generatedBuffers.every((b) => b.every((byte) => byte === 0))).toBe(true);
  });

  it('persists encrypted baseline for offline deletions, wires markSyncDirty, clears state on signOut, and falls back to baked server URL (P1-3, P1-4, P1-8, P1-10)', async () => {
    const secrets = makeMemorySecretStore();
    let nowMs = 1_700_000_000_000;
    let offline = false;
    let vaultRevision = 0;
    let vaultCiphertext: string | null = null;
    let vaultIv: string | null = null;
    let seq = 0;
    const seenUrls: string[] = [];

    const fetchFn: SyncFetchFn = async (url, init) => {
      seenUrls.push(url);
      if (offline) throw new Error('offline');
      const method = init?.method ?? 'GET';
      const parsed = new URL(url);
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      if (method === 'POST' && parsed.pathname === '/v1/auth/register') {
        seq += 1;
        return {
          status: 201,
          text: async () =>
            JSON.stringify({
              user: { id: 'mu-1', email: String(body.email) },
              accessToken: 'acc-mu-1',
              refreshToken: `mref-${seq}`,
            }),
        };
      }
      if (method === 'POST' && parsed.pathname === '/v1/auth/refresh') {
        seq += 1;
        return {
          status: 200,
          text: async () =>
            JSON.stringify({
              user: { id: 'mu-1', email: 'mob@example.test' },
              accessToken: 'acc-mu-1',
              refreshToken: `mref-${seq}`,
            }),
        };
      }
      if (method === 'POST' && parsed.pathname === '/v1/auth/logout') {
        return { status: 200, text: async () => JSON.stringify({ ok: true }) };
      }
      if (method === 'GET' && parsed.pathname === '/v1/vault') {
        return {
          status: 200,
          text: async () =>
            JSON.stringify({
              revision: vaultRevision,
              ciphertext: vaultCiphertext,
              iv: vaultIv,
              updatedAt: nowMs,
            }),
        };
      }
      if (method === 'PUT' && parsed.pathname === '/v1/vault') {
        vaultRevision += 1;
        vaultCiphertext = String(body.ciphertext);
        vaultIv = String(body.iv);
        return {
          status: 200,
          text: async () => JSON.stringify({ revision: vaultRevision, updatedAt: nowMs }),
        };
      }
      if (method === 'POST' && parsed.pathname === '/v1/pair/create') {
        return {
          status: 201,
          text: async () =>
            JSON.stringify({
              pairingId: 'mp-so-1',
              code: '87654321',
              pollToken: 'mpt-so-1',
              expiresAt: nowMs + 300_000,
            }),
        };
      }
      return { status: 404, text: async () => JSON.stringify({ error: 'not_found' }) };
    };

    let localSnap: VaultSnapshot = {
      ...createEmptyVaultSnapshot(nowMs),
      sources: [
        {
          id: 'msrc_1',
          kind: 'm3u',
          name: 'Mobile Feed',
          url: 'https://mob.example.test/a.m3u',
          updatedAt: nowMs,
        },
      ],
      favorites: [{ key: 'x:msrc_1:live:1', updatedAt: nowMs }],
    };

    const makePorts = (seed: number) =>
      createTvMobileSyncPorts({
        secretStore: secrets.store,
        fetchFn,
        crypto: makeTestCrypto(seed),
        randomBytes: detRandom(seed),
        clock: { now: () => nowMs },
        kdfIterations: 100_000,
        flushIntervalMs: 0,
        // P1-10: invalid legacy syncServerUrl preference MUST fall back to baked getServerUrl()!
        getServerUrl: () => 'https://baked-sync.example.test',
        getPreferences: () => ({ syncServerUrl: 'not-a-valid-url' }),
        getDeviceMeta: () => ({ platform: 'android-tv', appVersion: '2.0.0' }),
        getLocalSnapshot: () => localSnap,
        applyMergedSnapshot: (snap) => {
          localSnap = snap;
        },
      });

    const p1 = makePorts(1);
    expect(
      (await p1.syncAccount.register('mob@example.test', 'StrongPass123!', 'StrongPass123!')).ok,
    ).toBe(true);
    expect(seenUrls[0]).toBe('https://baked-sync.example.test/v1/auth/register');
    expect((await p1.syncAccount.syncNow()).ok).toBe(true);
    const baselineRaw = secrets.data.get(VAULT_BASELINE_SECRET_KEY);
    expect(baselineRaw).toBeTruthy();
    expect(baselineRaw).not.toContain('msrc_1');
    expect(baselineRaw).not.toContain('x:msrc_1:live:1');
    p1.dispose();

    // Go offline, delete favorite & source locally, restart app (hydrate from SecretStore)
    offline = true;
    nowMs += 10_000;
    localSnap = createEmptyVaultSnapshot(nowMs);

    const p2 = makePorts(2);
    await p2.hydrate();

    // Reconnect and sync -> offline deletions survive restart without resurrection!
    offline = false;
    nowMs += 5_000;
    expect((await p2.syncAccount.syncNow()).ok).toBe(true);
    expect(localSnap.favorites.find((f) => f.key === 'x:msrc_1:live:1')?.deleted).toBe(true);
    expect(localSnap.sources.find((s) => s.id === 'msrc_1')?.deleted).toBe(true);

    // P1-3 markSyncDirty flushes on background
    const revBefore = vaultRevision;
    p2.syncAccount.markSyncDirty?.();
    await p2.flushBeforeBackground(2_000);
    expect(vaultRevision).toBeGreaterThan(revBefore);

    // P1-8 signOut clears baseline, disposes pairing, resets autoSyncState
    const started = await p2.syncAccount.startBidirectionalPairing?.();
    expect(started?.pairingId).toBe('mp-so-1');
    await p2.syncAccount.signOut();
    expect(secrets.data.has(VAULT_BASELINE_SECRET_KEY)).toBe(false);
    expect(p2.syncAccount.getState().autoSyncState).toBe('idle');
    expect((await p2.syncAccount.pollBidirectionalPairing?.('mp-so-1'))?.status).toBe('expired');
    p2.dispose();

    // Corrupt baseline falls back safely on hydrate
    const p3 = makePorts(3);
    expect(
      (await p3.syncAccount.register('mob2@example.test', 'StrongPass123!', 'StrongPass123!')).ok,
    ).toBe(true);
    secrets.data.set(VAULT_BASELINE_SECRET_KEY, 'corrupt-baseline-blob');
    p3.dispose();

    const p4 = makePorts(4);
    await expect(p4.hydrate()).resolves.toBeUndefined();
    expect(p4.syncAccount.getState().status).toBe('signed_in');
    p4.dispose();
  });
});
