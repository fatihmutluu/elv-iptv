import type { Result } from '@elv/domain';
import {
  base64UrlDecode,
  base64UrlEncode,
  constantTimeEqual,
  decryptPairingTransfer,
  derivePairingSessionKeys,
  encodeBidirectionalPairingQr,
  encryptPairingTransfer,
  generateX25519KeyPair,
  hashPairingEmail,
  maskEmail,
  type PairingDirection,
  type PairingSessionKeys,
  parsePairingQrOrCode,
  type QrPairingPayload,
  resolvePairingDirection,
  type SyncClockPort,
  type SyncHttpPort,
  utf8Encode,
  x25519,
} from '@elv/sync';
import type {
  BidirectionalPairingSnapshotIpc,
  SyncActionResultIpc,
} from '../../shared/sync-ipc.ts';
import {
  type ActivePairSession,
  approveAndFetchResponderPayload,
  deriveHostKeysIfNeeded,
  expiredUnknownSnapshot,
  type HostSessionState,
  httpErrorCode,
  MAX_COMPLETED_SNAPSHOTS,
  pairAuthHeader,
  parseExpiresAt,
  parseJsonBody,
  postPairJson,
  type ResponderSessionState,
  resolveEffectiveDirection,
  type TransferDirection,
  toSnapshot,
  validHttpsLinkOrigin,
  zeroBytes,
  zeroSessionKeys,
} from './bidirectional-pairing-helpers.ts';
import { errorCodeFrom } from './sync-service-helpers.ts';

/** Dependencies for {@link createBidirectionalPairingController}. */
export interface BidirectionalPairingDeps {
  readonly getBaseUrl: () => string;
  readonly http: SyncHttpPort;
  readonly randomBytes: (length: number) => Uint8Array;
  readonly clock: SyncClockPort;
  readonly getLocalAuth: () => { readonly signedIn: boolean; readonly email: string | null };
  readonly mintPairTransferPayload: (baseUrl: string) => Promise<Result<QrPairingPayload>>;
  readonly adoptPairedSession: (
    baseUrl: string,
    payload: QrPairingPayload,
  ) => Promise<Result<void>>;
  readonly triggerImmediateSync: () => Promise<void>;
  readonly linkOrigin?: string;
}

/** Bidirectional X25519 + 8-digit code pairing controller (`#510`). */
export interface BidirectionalPairingController {
  startBidirectionalPairing(): Promise<BidirectionalPairingSnapshotIpc>;
  joinBidirectionalPairing(codeOrUri: string): Promise<BidirectionalPairingSnapshotIpc>;
  pollBidirectionalPairing(pairingId: string): Promise<BidirectionalPairingSnapshotIpc>;
  confirmBidirectionalPairing(
    pairingId: string,
    chosenDirection?: 'host_to_responder' | 'responder_to_host',
  ): Promise<SyncActionResultIpc>;
  cancelBidirectionalPairing(pairingId: string): Promise<void>;
  dispose(): void;
}

/**
 * Implements Wave P9 strict 2-phase SAS-gated bidirectional single-QR + 8-digit X25519 ECDH pairing
 * across all 5 cases: Phase 1 performs key exchange only (zero credentials/tokens on `/respond`),
 * Phase 2 requires explicit local SAS confirmation on BOTH devices before minting, transferring,
 * or adopting credentials, and ephemeral keys are always zeroed on completion, cancel, or error (`#510`).
 */
export function createBidirectionalPairingController(
  deps: BidirectionalPairingDeps,
): BidirectionalPairingController {
  const sessions = new Map<string, ActivePairSession>();
  const completedSnapshots = new Map<string, BidirectionalPairingSnapshotIpc>();

  const cleanupSession = (pairingId: string): void => {
    const existing = sessions.get(pairingId);
    if (existing !== undefined) {
      zeroSessionKeys(existing);
      sessions.delete(pairingId);
    }
  };

  const recordCompleted = (pairingId: string, snap: BidirectionalPairingSnapshotIpc): void => {
    completedSnapshots.set(pairingId, snap);
    if (completedSnapshots.size > MAX_COMPLETED_SNAPSHOTS) {
      const oldest = completedSnapshots.keys().next().value;
      if (oldest !== undefined) completedSnapshots.delete(oldest);
    }
  };

  const postApprove = (baseUrl: string, pollToken: string, payload: Record<string, unknown>) =>
    postPairJson(deps.http, `${baseUrl}/v1/pair/approve`, payload, {
      'X-Pair-Poll-Token': pollToken,
    });

  const decryptAndAdopt = async (
    baseUrl: string,
    session: ActivePairSession,
    key: Uint8Array,
    aad: Uint8Array,
    ciphertext: string,
    iv: string,
    direction: TransferDirection,
  ): Promise<
    | { readonly ok: true; readonly snap: BidirectionalPairingSnapshotIpc }
    | { readonly ok: false; readonly errorCode: string }
  > => {
    let payload: QrPairingPayload;
    try {
      payload = decryptPairingTransfer(key, aad, ciphertext, iv);
    } catch {
      cleanupSession(session.pairingId);
      return { ok: false, errorCode: 'pair_decrypt_failed' };
    }
    cleanupSession(session.pairingId);
    const adopted = await deps.adoptPairedSession(baseUrl, payload);
    if (!adopted.ok) return { ok: false, errorCode: errorCodeFrom(adopted.error) };
    await deps.triggerImmediateSync().catch(() => undefined);
    const snap = toSnapshot(session, 'completed', {
      sas: null,
      direction,
      localMaskedEmail: maskEmail(payload.email),
    });
    recordCompleted(session.pairingId, snap);
    return { ok: true, snap };
  };

  const approveAndAdoptResponderTransfer = async (
    baseUrl: string,
    session: HostSessionState,
  ): Promise<
    | { readonly ok: true; readonly snap: BidirectionalPairingSnapshotIpc }
    | { readonly ok: false; readonly errorCode: string }
  > => {
    if (session.keys === null) return { ok: false, errorCode: 'pairing_not_ready' };
    const fetched = await approveAndFetchResponderPayload(
      deps.http,
      baseUrl,
      session.pairingId,
      session.pollToken,
    );
    if (fetched.kind === 'error') {
      cleanupSession(session.pairingId);
      return { ok: false, errorCode: fetched.errorCode };
    }
    if (fetched.kind === 'payload') {
      return decryptAndAdopt(
        baseUrl,
        session,
        session.keys.responderToHostKey,
        session.keys.aad,
        fetched.ciphertext,
        fetched.iv,
        'responder_to_host',
      );
    }
    session.localStatus = 'waiting_approval';
    return {
      ok: true,
      snap: toSnapshot(session, 'waiting_approval', { direction: 'responder_to_host' }),
    };
  };

  const handleHostPoll = async (
    baseUrl: string,
    session: HostSessionState,
    body: Record<string, unknown>,
  ): Promise<BidirectionalPairingSnapshotIpc> => {
    const pairingId = session.pairingId;
    if (body.status === 'pending') return toSnapshot(session, 'pending');
    if (session.direction === 'neither_signed_in') {
      return toSnapshot(session, 'awaiting_sas', { sas: null, errorCode: 'neither_signed_in' });
    }

    if (!session.localSasConfirmed) {
      deriveHostKeysIfNeeded(session, body.responderPublicKey);
      session.peerMaskedEmail =
        typeof body.responderMaskedEmail === 'string' ? body.responderMaskedEmail : null;
      session.direction = resolvePairingDirection(
        { signedIn: session.localSignedIn, emailHash: session.localEmailHash },
        {
          signedIn: body.responderAuthState === 'signed_in',
          emailHash: typeof body.responderEmailHash === 'string' ? body.responderEmailHash : null,
        },
      );
      if (session.direction === 'neither_signed_in') {
        zeroSessionKeys(session);
        session.localStatus = 'awaiting_sas';
        await postApprove(baseUrl, session.pollToken, {
          pairingId,
          direction: 'neither_signed_in',
        }).catch(() => undefined);
        return toSnapshot(session, 'awaiting_sas', { sas: null, errorCode: 'neither_signed_in' });
      }
      if (session.direction === 'same_account') {
        const sas = session.keys?.sas ?? null;
        await postApprove(baseUrl, session.pollToken, {
          pairingId,
          direction: 'same_account',
        }).catch(() => undefined);
        cleanupSession(pairingId);
        await deps.triggerImmediateSync().catch(() => undefined);
        const snap = toSnapshot(session, 'completed', { sas });
        recordCompleted(pairingId, snap);
        return snap;
      }
      if (session.direction === 'responder_to_host') {
        if (body.status === 'responder_transferred') {
          session.localSasConfirmed = true;
          session.localChosenDirection = 'responder_to_host';
          const adopted = await approveAndAdoptResponderTransfer(baseUrl, session);
          return adopted.ok
            ? adopted.snap
            : toSnapshot(session, 'rejected', {
                sas: null,
                direction: 'responder_to_host',
                errorCode: adopted.errorCode,
              });
        }
        session.localStatus = 'waiting_approval';
        return toSnapshot(session, 'waiting_approval');
      }
      session.localStatus = 'awaiting_sas';
      return toSnapshot(session, 'awaiting_sas');
    }

    if (session.localChosenDirection === 'responder_to_host') {
      if (
        typeof body.encryptedPayload === 'string' &&
        typeof body.iv === 'string' &&
        session.keys !== null
      ) {
        const resAdopt = await decryptAndAdopt(
          baseUrl,
          session,
          session.keys.responderToHostKey,
          session.keys.aad,
          body.encryptedPayload,
          body.iv,
          'responder_to_host',
        );
        return resAdopt.ok
          ? resAdopt.snap
          : toSnapshot(session, 'rejected', {
              sas: null,
              direction: 'responder_to_host',
              errorCode: resAdopt.errorCode,
            });
      }
      if (body.status === 'completed') {
        cleanupSession(pairingId);
        return toSnapshot(session, 'rejected', {
          sas: null,
          direction: 'responder_to_host',
          errorCode: 'pair_payload_missing',
        });
      }
      return toSnapshot(session, 'waiting_approval', { direction: 'responder_to_host' });
    }

    cleanupSession(pairingId);
    const snap = toSnapshot(session, 'completed', { sas: null });
    recordCompleted(pairingId, snap);
    return snap;
  };

  const handleResponderPoll = async (
    baseUrl: string,
    session: ResponderSessionState,
    body: Record<string, unknown>,
  ): Promise<BidirectionalPairingSnapshotIpc> => {
    const pairingId = session.pairingId;
    if (session.direction === 'neither_signed_in') {
      return toSnapshot(session, 'awaiting_sas', { sas: null, errorCode: 'neither_signed_in' });
    }
    const finalDir =
      typeof body.direction === 'string' ? (body.direction as PairingDirection) : session.direction;

    // Signed-out receiver (`host_to_responder`) waits on SAS screen until signed-in Host confirms & uploads payload;
    // `different_accounts` strictly requires local SAS confirmation before decrypting or adopting!
    const isSignedOutReceiver = session.direction === 'host_to_responder';
    if (!session.localSasConfirmed && !isSignedOutReceiver) {
      if (typeof body.encryptedPayload === 'string' && typeof body.iv === 'string') {
        session.bufferedReturnPayload = { ciphertext: body.encryptedPayload, iv: body.iv };
      }
      return toSnapshot(session, 'awaiting_sas');
    }

    const effectiveDir = session.localChosenDirection ?? session.direction;
    if (effectiveDir === 'host_to_responder') {
      const cipher =
        session.bufferedReturnPayload ??
        (typeof body.encryptedPayload === 'string' && typeof body.iv === 'string'
          ? { ciphertext: body.encryptedPayload, iv: body.iv }
          : null);
      if (cipher !== null && session.keys !== null) {
        session.bufferedReturnPayload = null;
        const resAdopt = await decryptAndAdopt(
          baseUrl,
          session,
          session.keys.hostToResponderKey,
          session.keys.aad,
          cipher.ciphertext,
          cipher.iv,
          'host_to_responder',
        );
        return resAdopt.ok
          ? resAdopt.snap
          : toSnapshot(session, 'rejected', {
              sas: null,
              direction: 'host_to_responder',
              errorCode: resAdopt.errorCode,
            });
      }
      if (body.status === 'completed') {
        cleanupSession(pairingId);
        return toSnapshot(session, 'rejected', {
          sas: null,
          direction: finalDir,
          errorCode: 'pair_payload_missing',
        });
      }
      return toSnapshot(session, 'waiting_approval', { direction: 'host_to_responder' });
    }

    if (effectiveDir === 'responder_to_host') {
      if (body.status === 'completed') {
        if (finalDir === 'host_to_responder') {
          cleanupSession(pairingId);
          return toSnapshot(session, 'rejected', {
            sas: null,
            direction: finalDir,
            errorCode: 'direction_mismatch',
          });
        }
        cleanupSession(pairingId);
        const snap = toSnapshot(session, 'completed', {
          sas: null,
          direction: 'responder_to_host',
        });
        recordCompleted(pairingId, snap);
        return snap;
      }
      return toSnapshot(session, 'waiting_approval', { direction: 'responder_to_host' });
    }

    return toSnapshot(session, session.localStatus);
  };

  return {
    async startBidirectionalPairing(): Promise<BidirectionalPairingSnapshotIpc> {
      const baseUrl = deps.getBaseUrl().replace(/\/+$/, '');
      if (baseUrl.length === 0) throw new Error('server_not_configured');

      const auth = deps.getLocalAuth();
      const localMaskedEmail = auth.signedIn && auth.email ? maskEmail(auth.email) : null;
      const localEmailHash = auth.signedIn && auth.email ? hashPairingEmail(auth.email) : null;
      const keyPair = generateX25519KeyPair(deps.randomBytes);
      const hostPublicKeyB64 = base64UrlEncode(keyPair.publicKey);

      let res: { readonly status: number; readonly bodyText: string };
      try {
        res = await postPairJson(deps.http, `${baseUrl}/v1/pair/create`, {
          hostPublicKey: hostPublicKeyB64,
          hostAuthState: auth.signedIn ? 'signed_in' : 'signed_out',
          hostMaskedEmail: localMaskedEmail,
          hostEmailHash: localEmailHash,
        });
      } catch (error) {
        zeroBytes(keyPair.privateKey);
        throw error;
      }

      const body = parseJsonBody(res.bodyText);
      if (
        res.status < 200 ||
        res.status >= 300 ||
        body === null ||
        typeof body.pairingId !== 'string' ||
        typeof body.code !== 'string' ||
        typeof body.pollToken !== 'string'
      ) {
        zeroBytes(keyPair.privateKey);
        throw new Error(httpErrorCode(body, res.status));
      }

      const origin = validHttpsLinkOrigin(deps.linkOrigin);
      const state: HostSessionState = {
        role: 'host',
        pairingId: body.pairingId,
        code: body.code,
        qrUri: encodeBidirectionalPairingQr({
          code: body.code,
          hostPublicKeyB64Url: hostPublicKeyB64,
          ...(origin !== undefined ? { origin } : {}),
        }),
        pollToken: body.pollToken,
        expiresAtMs: parseExpiresAt(body.expiresAt, deps.clock.now()),
        hostPublicKey: keyPair.publicKey,
        privateKey: keyPair.privateKey,
        localSignedIn: auth.signedIn,
        localMaskedEmail,
        localEmailHash,
        keys: null,
        direction: null,
        peerMaskedEmail: null,
        localSasConfirmed: false,
        localChosenDirection: null,
        localStatus: 'pending',
      };
      sessions.set(state.pairingId, state);
      return toSnapshot(state, 'pending');
    },

    async joinBidirectionalPairing(codeOrUri: string): Promise<BidirectionalPairingSnapshotIpc> {
      const baseUrl = deps.getBaseUrl().replace(/\/+$/, '');
      if (baseUrl.length === 0) throw new Error('server_not_configured');

      const parsed = parsePairingQrOrCode(codeOrUri);
      if (!parsed.ok) throw new Error(errorCodeFrom(parsed.error));
      const code = parsed.value.code;

      let lookupRes: { readonly status: number; readonly bodyText: string };
      try {
        lookupRes = await postPairJson(deps.http, `${baseUrl}/v1/pair/lookup`, { code });
      } catch (error) {
        throw error instanceof Error ? error : new Error('network_error');
      }

      const lookup = parseJsonBody(lookupRes.bodyText);
      if (lookupRes.status === 423) throw new Error('pairing_locked');
      if (
        lookupRes.status < 200 ||
        lookupRes.status >= 300 ||
        lookup === null ||
        typeof lookup.pairingId !== 'string' ||
        typeof lookup.hostPublicKey !== 'string'
      ) {
        throw new Error(httpErrorCode(lookup, lookupRes.status));
      }

      if (
        parsed.value.kind === 'qr' &&
        !constantTimeEqual(
          utf8Encode(parsed.value.hostPublicKeyB64Url),
          utf8Encode(lookup.hostPublicKey),
        )
      ) {
        throw new Error('host_key_mismatch');
      }

      const hostPublicKey = base64UrlDecode(lookup.hostPublicKey);
      const respKeyPair = generateX25519KeyPair(deps.randomBytes);
      let sharedSecret: Uint8Array | null = null;
      let keys: PairingSessionKeys;
      try {
        sharedSecret = x25519(respKeyPair.privateKey, hostPublicKey);
        keys = derivePairingSessionKeys(sharedSecret, {
          code,
          hostPublicKey,
          responderPublicKey: respKeyPair.publicKey,
        });
      } finally {
        zeroBytes(sharedSecret);
        zeroBytes(respKeyPair.privateKey);
      }

      const auth = deps.getLocalAuth();
      const localMaskedEmail = auth.signedIn && auth.email ? maskEmail(auth.email) : null;
      const localEmailHash = auth.signedIn && auth.email ? hashPairingEmail(auth.email) : null;
      const hostMaskedEmail =
        typeof lookup.hostMaskedEmail === 'string' ? lookup.hostMaskedEmail : null;
      const direction = resolvePairingDirection(
        {
          signedIn: lookup.hostAuthState === 'signed_in',
          emailHash: typeof lookup.hostEmailHash === 'string' ? lookup.hostEmailHash : null,
        },
        { signedIn: auth.signedIn, emailHash: localEmailHash },
      );

      // Phase 1: key exchange metadata ONLY — never mint refreshToken or send encryptedPayload/iv before SAS confirmation.
      let respondRes: { readonly status: number; readonly bodyText: string };
      try {
        respondRes = await postPairJson(deps.http, `${baseUrl}/v1/pair/respond`, {
          code,
          responderPublicKey: base64UrlEncode(respKeyPair.publicKey),
          responderAuthState: auth.signedIn ? 'signed_in' : 'signed_out',
          responderMaskedEmail: localMaskedEmail,
          responderEmailHash: localEmailHash,
          direction,
        });
      } catch (error) {
        zeroBytes(keys.hostToResponderKey);
        zeroBytes(keys.responderToHostKey);
        throw error;
      }

      const respondBody = parseJsonBody(respondRes.bodyText);
      if (
        respondRes.status < 200 ||
        respondRes.status >= 300 ||
        respondBody === null ||
        typeof respondBody.pairingId !== 'string' ||
        typeof respondBody.responderToken !== 'string'
      ) {
        zeroBytes(keys.hostToResponderKey);
        zeroBytes(keys.responderToHostKey);
        throw new Error(httpErrorCode(respondBody, respondRes.status));
      }

      const state: ResponderSessionState = {
        role: 'responder',
        pairingId: respondBody.pairingId,
        code,
        responderToken: respondBody.responderToken,
        expiresAtMs: parseExpiresAt(lookup.expiresAt, deps.clock.now()),
        localMaskedEmail,
        peerMaskedEmail: hostMaskedEmail,
        direction,
        sas: direction === 'neither_signed_in' ? null : keys.sas,
        keys,
        localSasConfirmed: false,
        localChosenDirection: null,
        localStatus: direction === 'host_to_responder' ? 'waiting_approval' : 'awaiting_sas',
        bufferedReturnPayload: null,
        transferred: false,
      };
      if (direction === 'same_account') {
        zeroSessionKeys(state);
        await deps.triggerImmediateSync().catch(() => undefined);
        const snap = toSnapshot(state, 'completed');
        recordCompleted(state.pairingId, snap);
        return snap;
      }
      if (direction === 'neither_signed_in') {
        zeroSessionKeys(state);
        sessions.set(state.pairingId, state);
        return toSnapshot(state, 'awaiting_sas', { sas: null, errorCode: 'neither_signed_in' });
      }
      sessions.set(state.pairingId, state);
      return toSnapshot(state, state.localStatus);
    },

    async pollBidirectionalPairing(pairingId: string): Promise<BidirectionalPairingSnapshotIpc> {
      const doneSnap = completedSnapshots.get(pairingId);
      if (doneSnap !== undefined) return doneSnap;

      const session = sessions.get(pairingId);
      const baseUrl = deps.getBaseUrl().replace(/\/+$/, '');
      if (
        session === undefined ||
        baseUrl.length === 0 ||
        deps.clock.now() >= session.expiresAtMs
      ) {
        cleanupSession(pairingId);
        return session !== undefined
          ? toSnapshot(session, 'expired', { sas: null })
          : expiredUnknownSnapshot(pairingId);
      }

      let res: { readonly status: number; readonly bodyText: string };
      try {
        res = await deps.http.request({
          method: 'GET',
          url: `${baseUrl}/v1/pair/poll/${encodeURIComponent(pairingId)}`,
          headers: { Accept: 'application/json', ...pairAuthHeader(session) },
        });
      } catch {
        cleanupSession(pairingId);
        return toSnapshot(session, 'rejected', { sas: null, errorCode: 'network_error' });
      }

      if (res.status === 410 || res.status === 404) {
        cleanupSession(pairingId);
        return toSnapshot(session, 'expired', { sas: null });
      }
      if (res.status === 423) {
        cleanupSession(pairingId);
        return toSnapshot(session, 'locked', { sas: null, errorCode: 'pairing_locked' });
      }
      const body = parseJsonBody(res.bodyText);
      if (
        res.status < 200 ||
        res.status >= 300 ||
        body === null ||
        typeof body.status !== 'string'
      ) {
        return toSnapshot(session, session.localStatus);
      }
      if (body.status === 'rejected') {
        cleanupSession(pairingId);
        return toSnapshot(session, 'rejected', { sas: null });
      }

      return session.role === 'host'
        ? handleHostPoll(baseUrl, session, body)
        : handleResponderPoll(baseUrl, session, body);
    },

    async confirmBidirectionalPairing(
      pairingId: string,
      chosenDirection?: TransferDirection,
    ): Promise<SyncActionResultIpc> {
      const session = sessions.get(pairingId);
      const baseUrl = deps.getBaseUrl().replace(/\/+$/, '');
      if (baseUrl.length === 0) return { ok: false, errorCode: 'server_not_configured' };
      if (session === undefined || session.keys === null) {
        return { ok: false, errorCode: 'pairing_not_ready' };
      }
      if (deps.clock.now() >= session.expiresAtMs) {
        cleanupSession(pairingId);
        return { ok: false, errorCode: 'pairing_expired' };
      }

      const resolved = resolveEffectiveDirection(session.direction, chosenDirection);
      if (!resolved.ok) return { ok: false, errorCode: resolved.errorCode };
      const effectiveDirection = resolved.direction;

      if (session.role === 'responder') {
        if (session.localSasConfirmed) {
          if (effectiveDirection === 'responder_to_host' && session.transferred)
            return { ok: true };
          if (
            effectiveDirection === 'host_to_responder' &&
            session.bufferedReturnPayload === null
          ) {
            return { ok: true };
          }
        }
        session.localSasConfirmed = true;
        session.localChosenDirection = effectiveDirection;

        if (effectiveDirection === 'responder_to_host') {
          const minted = await deps.mintPairTransferPayload(baseUrl);
          if (!minted.ok) {
            cleanupSession(pairingId);
            return { ok: false, errorCode: errorCodeFrom(minted.error) };
          }
          const enc = encryptPairingTransfer(
            session.keys.responderToHostKey,
            session.keys.aad,
            minted.value,
            { randomBytes: deps.randomBytes },
          );
          zeroBytes(session.keys.responderToHostKey);

          let transferRes: { readonly status: number; readonly bodyText: string };
          try {
            transferRes = await postPairJson(
              deps.http,
              `${baseUrl}/v1/pair/transfer`,
              {
                pairingId,
                direction: 'responder_to_host',
                encryptedPayload: enc.ciphertext,
                iv: enc.iv,
              },
              { 'X-Pair-Responder-Token': session.responderToken },
            );
          } catch {
            cleanupSession(pairingId);
            return { ok: false, errorCode: 'network_error' };
          }
          const transferBody = parseJsonBody(transferRes.bodyText);
          if (transferRes.status < 200 || transferRes.status >= 300) {
            cleanupSession(pairingId);
            return { ok: false, errorCode: httpErrorCode(transferBody, transferRes.status) };
          }
          session.transferred = true;
          if (transferBody?.status === 'completed') {
            cleanupSession(pairingId);
            recordCompleted(
              pairingId,
              toSnapshot(session, 'completed', { sas: null, direction: 'responder_to_host' }),
            );
            return { ok: true };
          }
          session.localStatus = 'waiting_approval';
          return { ok: true };
        }

        if (session.bufferedReturnPayload !== null) {
          const { ciphertext, iv } = session.bufferedReturnPayload;
          session.bufferedReturnPayload = null;
          const resAdopt = await decryptAndAdopt(
            baseUrl,
            session,
            session.keys.hostToResponderKey,
            session.keys.aad,
            ciphertext,
            iv,
            'host_to_responder',
          );
          return resAdopt.ok ? { ok: true } : { ok: false, errorCode: resAdopt.errorCode };
        }
        session.localStatus = 'waiting_approval';
        return { ok: true };
      }

      if (session.localSasConfirmed) return { ok: true };
      session.localSasConfirmed = true;
      session.localChosenDirection = effectiveDirection;

      if (effectiveDirection === 'host_to_responder') {
        const minted = await deps.mintPairTransferPayload(baseUrl);
        if (!minted.ok) {
          cleanupSession(pairingId);
          return { ok: false, errorCode: errorCodeFrom(minted.error) };
        }
        const enc = encryptPairingTransfer(
          session.keys.hostToResponderKey,
          session.keys.aad,
          minted.value,
          { randomBytes: deps.randomBytes },
        );
        let approveRes: { readonly status: number; readonly bodyText: string };
        try {
          approveRes = await postApprove(baseUrl, session.pollToken, {
            pairingId,
            direction: 'host_to_responder',
            encryptedPayload: enc.ciphertext,
            iv: enc.iv,
          });
        } catch {
          cleanupSession(pairingId);
          return { ok: false, errorCode: 'network_error' };
        } finally {
          cleanupSession(pairingId);
        }
        const approveBody = parseJsonBody(approveRes.bodyText);
        if (approveRes.status < 200 || approveRes.status >= 300) {
          return { ok: false, errorCode: httpErrorCode(approveBody, approveRes.status) };
        }
        recordCompleted(
          pairingId,
          toSnapshot(session, 'completed', { sas: null, direction: 'host_to_responder' }),
        );
        void deps.triggerImmediateSync().catch(() => undefined);
        return { ok: true };
      }

      const approved = await approveAndAdoptResponderTransfer(baseUrl, session);
      return approved.ok ? { ok: true } : { ok: false, errorCode: approved.errorCode };
    },

    async cancelBidirectionalPairing(pairingId: string): Promise<void> {
      const session = sessions.get(pairingId);
      const baseUrl = deps.getBaseUrl().replace(/\/+$/, '');
      try {
        if (session !== undefined && baseUrl.length > 0) {
          await postPairJson(
            deps.http,
            `${baseUrl}/v1/pair/cancel`,
            { pairingId },
            pairAuthHeader(session),
          );
        }
      } catch {
        // Best-effort cancellation; keys are always zeroed in finally.
      } finally {
        cleanupSession(pairingId);
        completedSnapshots.delete(pairingId);
      }
    },

    dispose(): void {
      for (const id of [...sessions.keys()]) cleanupSession(id);
      completedSnapshots.clear();
    },
  };
}
