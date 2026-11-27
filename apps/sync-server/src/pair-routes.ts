import {
  PAIR_SESSION_TTL_SEC,
  randomBase64Url,
  randomId,
  randomPairingCode,
  sha256Hex,
  timingSafeEqualHex,
} from './crypto.ts';
import {
  extractRespondCode,
  isDirectionConsistentWithAuthStates,
  MAX_PAIR_ATTEMPTS,
  type PairCreateV2Input,
  validatePairApproveInput,
  validatePairCancelInput,
  validatePairCreateV2Input,
  validatePairLookupInput,
  validatePairRespondInput,
  validatePairTransferInput,
} from './pair-validation.ts';
import type { RateLimitConfig } from './rate-limit.ts';
import type { SyncServerStorage, UserRecord } from './storage.ts';
import {
  BODY_LIMITS,
  readBoundedJson,
  readBoundedText,
  validatePairClaimInput,
} from './validation.ts';

const MAX_CODE_COLLISION_RETRIES = 3;

function isUniqueCodeCollision(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return msg.includes('unique') && (msg.includes('code') || msg.includes('constraint'));
}

/** Dependencies injected by `createSyncApp` into the pairing route handlers. */
export interface PairRoutesContext {
  readonly storage: SyncServerStorage;
  readonly nowMs: () => number;
  readonly checkRateLimit: (
    request: Request,
    bucket: keyof RateLimitConfig,
    directClientIp?: string,
  ) => Response | null;
  readonly requireActiveUser: (request: Request) => Promise<UserRecord | null>;
  readonly jsonResponse: (
    status: number,
    body: unknown,
    extraHeaders?: Readonly<Record<string, string>>,
  ) => Response;
}

/** Route handlers for legacy and Wave P9 bidirectional pairing endpoints. */
export interface PairRouteHandlers {
  handlePairCreate(request: Request, clientIp?: string): Promise<Response>;
  handlePairLookup(request: Request, clientIp?: string): Promise<Response>;
  handlePairRespond(request: Request, clientIp?: string): Promise<Response>;
  handlePairTransfer(request: Request, clientIp?: string): Promise<Response>;
  handlePairApprove(request: Request, clientIp?: string): Promise<Response>;
  handlePairCancel(request: Request, clientIp?: string): Promise<Response>;
  handlePairClaim(request: Request, clientIp?: string): Promise<Response>;
  handlePairPoll(request: Request, pairingId: string, clientIp?: string): Promise<Response>;
}

/** Creates handlers for `/v1/pair/{create,lookup,respond,transfer,approve,cancel,claim,poll/:id}`. */
export function createPairRouteHandlers(ctx: PairRoutesContext): PairRouteHandlers {
  const { storage, nowMs, checkRateLimit, requireActiveUser, jsonResponse } = ctx;

  return {
    async handlePairCreate(request: Request, clientIp?: string): Promise<Response> {
      const limited = checkRateLimit(request, 'pair', clientIp);
      if (limited) return limited;

      const rawText = await readBoundedText(request, BODY_LIMITS.pair);
      let v2: PairCreateV2Input | null = null;
      if (rawText.trim().length > 0) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawText) as unknown;
        } catch {
          return jsonResponse(400, { error: 'invalid_json' });
        }
        const isEmptyObj =
          parsed !== null &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed) &&
          Object.keys(parsed).length === 0;
        if (!isEmptyObj) {
          const valid = validatePairCreateV2Input(parsed);
          if (!valid.ok) return jsonResponse(400, { error: valid.error });
          v2 = valid.value;
        }
      }

      const currentMs = nowMs();
      const createdAt = new Date(currentMs).toISOString();
      const expiresAt = new Date(currentMs + PAIR_SESSION_TTL_SEC * 1000).toISOString();
      const pairingId = randomId();
      const pollToken = randomBase64Url(32);
      const pollTokenHash = await sha256Hex(pollToken);

      for (let attempt = 0; attempt <= MAX_CODE_COLLISION_RETRIES; attempt += 1) {
        const code = randomPairingCode();
        const codeHash = await sha256Hex(code);
        try {
          await storage.createPairSession({
            id: pairingId,
            code: codeHash,
            pollTokenHash,
            status: 'pending',
            attempts: 0,
            claimedByUserId: null,
            encryptedPayload: null,
            iv: null,
            hostPublicKey: v2?.hostPublicKey ?? null,
            responderPublicKey: null,
            hostAuthState: v2?.hostAuthState ?? 'signed_out',
            hostMaskedEmail: v2?.hostMaskedEmail ?? null,
            hostEmailHash: v2?.hostEmailHash ?? null,
            responderAuthState: null,
            responderMaskedEmail: null,
            responderEmailHash: null,
            responderTokenHash: null,
            direction: null,
            hostApprovedAt: null,
            returnEncryptedPayload: null,
            returnIv: null,
            expiresAt,
            createdAt,
          });
          return jsonResponse(201, { pairingId, code, pollToken, expiresAt });
        } catch (error) {
          if (isUniqueCodeCollision(error) && attempt < MAX_CODE_COLLISION_RETRIES) {
            continue;
          }
          throw error;
        }
      }
      return jsonResponse(500, { error: 'internal_error' });
    },

    async handlePairLookup(request: Request, clientIp?: string): Promise<Response> {
      const limited = checkRateLimit(request, 'pairLookup', clientIp);
      if (limited) return limited;

      const parsed = await readBoundedJson(request, BODY_LIMITS.pair);
      if (!parsed.ok) return jsonResponse(400, { error: parsed.error });
      const valid = validatePairLookupInput(parsed.value);
      if (!valid.ok) return jsonResponse(400, { error: valid.error });

      const codeHash = await sha256Hex(valid.value);
      const session = await storage.findPairSessionByCode(codeHash);
      if (!session) return jsonResponse(404, { error: 'pair_not_found' });

      const nowIso = new Date(nowMs()).toISOString();
      if (session.expiresAt <= nowIso) {
        await storage.deletePairSession(session.id);
        return jsonResponse(404, { error: 'pair_not_found' });
      }
      if (session.status === 'locked' || session.attempts >= MAX_PAIR_ATTEMPTS) {
        return jsonResponse(423, { error: 'pair_locked' });
      }
      if (
        session.hostPublicKey === null ||
        session.status === 'completed' ||
        session.status === 'rejected' ||
        session.status === 'claimed'
      ) {
        return jsonResponse(404, { error: 'pair_not_found' });
      }

      return jsonResponse(200, {
        pairingId: session.id,
        hostPublicKey: session.hostPublicKey,
        hostAuthState: session.hostAuthState,
        hostMaskedEmail: session.hostMaskedEmail,
        hostEmailHash: session.hostEmailHash,
        status: session.status,
        expiresAt: session.expiresAt,
      });
    },

    async handlePairRespond(request: Request, clientIp?: string): Promise<Response> {
      const limited = checkRateLimit(request, 'pairLookup', clientIp);
      if (limited) return limited;

      const parsed = await readBoundedJson(request, BODY_LIMITS.pair);
      if (!parsed.ok) return jsonResponse(400, { error: parsed.error });

      const rawCode = extractRespondCode(parsed.value);
      if (!rawCode) return jsonResponse(400, { error: 'invalid_pair_code' });

      const codeHash = await sha256Hex(rawCode);
      const session = await storage.findPairSessionByCode(codeHash);
      if (!session) return jsonResponse(404, { error: 'pair_not_found' });

      const nowIso = new Date(nowMs()).toISOString();
      if (session.expiresAt <= nowIso) {
        await storage.deletePairSession(session.id);
        return jsonResponse(410, { error: 'pair_expired' });
      }
      if (session.status === 'locked' || session.attempts >= MAX_PAIR_ATTEMPTS) {
        return jsonResponse(423, { error: 'pair_locked' });
      }
      if (session.status !== 'pending' || session.responderTokenHash !== null) {
        return jsonResponse(409, { error: 'pair_already_responded' });
      }

      const recordFailedAttempt = async (errorCode: string): Promise<Response> => {
        const res = await storage.incrementPairAttempts(session.id, MAX_PAIR_ATTEMPTS);
        if (res.status === 'locked') {
          return jsonResponse(423, { error: 'pair_locked' });
        }
        return jsonResponse(400, { error: errorCode });
      };

      if (session.hostPublicKey === null) {
        return recordFailedAttempt('pair_legacy_session');
      }

      const valid = validatePairRespondInput(parsed.value);
      if (!valid.ok) {
        return recordFailedAttempt(valid.error);
      }

      if (
        !isDirectionConsistentWithAuthStates(
          valid.value.direction,
          session.hostAuthState,
          valid.value.responderAuthState,
        )
      ) {
        return recordFailedAttempt('direction_auth_mismatch');
      }

      const responderToken = randomBase64Url(32);
      const responderTokenHash = await sha256Hex(responderToken);
      const respondResult = await storage.respondPairSession({
        id: session.id,
        responderPublicKey: valid.value.responderPublicKey,
        responderAuthState: valid.value.responderAuthState,
        responderMaskedEmail: valid.value.responderMaskedEmail,
        responderEmailHash: valid.value.responderEmailHash,
        responderTokenHash,
        direction: valid.value.direction,
        maxAttempts: MAX_PAIR_ATTEMPTS,
        nowIso,
      });

      if (respondResult.status === 'not_found')
        return jsonResponse(404, { error: 'pair_not_found' });
      if (respondResult.status === 'expired') return jsonResponse(410, { error: 'pair_expired' });
      if (respondResult.status === 'locked') return jsonResponse(423, { error: 'pair_locked' });
      if (respondResult.status === 'already_responded') {
        return jsonResponse(409, { error: 'pair_already_responded' });
      }

      return jsonResponse(200, {
        pairingId: session.id,
        responderToken,
        status: 'responder_joined',
        direction: valid.value.direction,
      });
    },

    async handlePairTransfer(request: Request, clientIp?: string): Promise<Response> {
      const limited = checkRateLimit(request, 'pair', clientIp);
      if (limited) return limited;

      const responderToken = request.headers.get('x-pair-responder-token')?.trim();
      if (!responderToken) return jsonResponse(401, { error: 'missing_responder_token' });

      const parsed = await readBoundedJson(request, BODY_LIMITS.pair);
      if (!parsed.ok) return jsonResponse(400, { error: parsed.error });
      const valid = validatePairTransferInput(parsed.value);
      if (!valid.ok) return jsonResponse(400, { error: valid.error });

      const session = await storage.findPairSessionById(valid.value.pairingId);
      if (!session) return jsonResponse(404, { error: 'pair_not_found' });

      const providedHash = await sha256Hex(responderToken);
      if (
        !session.responderTokenHash ||
        !timingSafeEqualHex(providedHash, session.responderTokenHash)
      ) {
        return jsonResponse(401, { error: 'invalid_responder_token' });
      }

      const nowIso = new Date(nowMs()).toISOString();
      if (session.expiresAt <= nowIso) {
        await storage.deletePairSession(session.id);
        return jsonResponse(410, { error: 'pair_expired' });
      }
      if (session.status === 'locked' || session.attempts >= MAX_PAIR_ATTEMPTS) {
        return jsonResponse(423, { error: 'pair_locked' });
      }
      if (session.hostPublicKey === null) {
        return jsonResponse(409, { error: 'pair_invalid_state' });
      }
      if (session.responderAuthState !== 'signed_in') {
        return jsonResponse(400, { error: 'direction_auth_mismatch' });
      }
      if (
        session.status === 'approved' &&
        (session.direction !== 'responder_to_host' ||
          valid.value.direction !== 'responder_to_host' ||
          session.returnEncryptedPayload !== null)
      ) {
        return jsonResponse(409, { error: 'pair_invalid_state' });
      }
      if (
        session.status === 'responder_joined' &&
        session.direction !== 'responder_to_host' &&
        session.direction !== 'different_accounts'
      ) {
        return jsonResponse(409, { error: 'pair_invalid_state' });
      }
      if (
        session.status === 'responder_joined' &&
        session.direction === 'responder_to_host' &&
        valid.value.direction !== 'responder_to_host'
      ) {
        return jsonResponse(400, { error: 'direction_auth_mismatch' });
      }

      const result = await storage.transferPairSession({
        id: session.id,
        direction: valid.value.direction,
        encryptedPayload: valid.value.encryptedPayload,
        iv: valid.value.iv,
        maxAttempts: MAX_PAIR_ATTEMPTS,
        nowIso,
      });

      if (result.status === 'not_found') return jsonResponse(404, { error: 'pair_not_found' });
      if (result.status === 'expired') return jsonResponse(410, { error: 'pair_expired' });
      if (result.status === 'locked') return jsonResponse(423, { error: 'pair_locked' });
      if (result.status === 'already_transferred') {
        return jsonResponse(409, { error: 'pair_already_transferred' });
      }
      if (result.status === 'invalid_state') {
        return jsonResponse(409, { error: 'pair_invalid_state' });
      }

      return jsonResponse(200, {
        pairingId: session.id,
        status: result.status,
        direction: valid.value.direction,
      });
    },

    async handlePairApprove(request: Request, clientIp?: string): Promise<Response> {
      const limited = checkRateLimit(request, 'pair', clientIp);
      if (limited) return limited;

      const pollToken = request.headers.get('x-pair-poll-token')?.trim();
      if (!pollToken) return jsonResponse(401, { error: 'missing_poll_token' });

      const parsed = await readBoundedJson(request, BODY_LIMITS.pair);
      if (!parsed.ok) return jsonResponse(400, { error: parsed.error });
      const valid = validatePairApproveInput(parsed.value);
      if (!valid.ok) return jsonResponse(400, { error: valid.error });

      const session = await storage.findPairSessionById(valid.value.pairingId);
      if (!session) return jsonResponse(404, { error: 'pair_not_found' });

      const providedHash = await sha256Hex(pollToken);
      if (!timingSafeEqualHex(providedHash, session.pollTokenHash)) {
        return jsonResponse(401, { error: 'invalid_poll_token' });
      }

      const currentMs = nowMs();
      const nowIso = new Date(currentMs).toISOString();
      if (session.expiresAt <= nowIso) {
        await storage.deletePairSession(session.id);
        return jsonResponse(410, { error: 'pair_expired' });
      }
      if (session.status === 'locked' || session.attempts >= MAX_PAIR_ATTEMPTS) {
        return jsonResponse(423, { error: 'pair_locked' });
      }
      if (session.hostPublicKey === null) {
        return jsonResponse(409, { error: 'pair_invalid_state' });
      }

      if (!valid.value.reject) {
        if (session.status === 'pending') {
          return jsonResponse(409, { error: 'pair_not_responded' });
        }
        const dir = valid.value.direction;
        if (dir === 'host_to_responder') {
          if (session.hostAuthState !== 'signed_in') {
            return jsonResponse(400, { error: 'direction_auth_mismatch' });
          }
          if (valid.value.encryptedPayload === null || valid.value.iv === null) {
            return jsonResponse(400, { error: 'missing_encrypted_payload' });
          }
        } else {
          if (valid.value.encryptedPayload !== null || valid.value.iv !== null) {
            return jsonResponse(400, { error: 'unexpected_encrypted_payload' });
          }
          if (dir === 'responder_to_host' && session.responderAuthState !== 'signed_in') {
            return jsonResponse(400, { error: 'direction_auth_mismatch' });
          }
        }
      }

      const result = await storage.approvePairSession({
        id: session.id,
        direction: valid.value.direction,
        hostApprovedAt: currentMs,
        returnEncryptedPayload: valid.value.encryptedPayload,
        returnIv: valid.value.iv,
        reject: valid.value.reject,
        nowIso,
      });

      if (result.status === 'not_found') return jsonResponse(404, { error: 'pair_not_found' });
      if (result.status === 'expired') return jsonResponse(410, { error: 'pair_expired' });
      if (result.status === 'locked') return jsonResponse(423, { error: 'pair_locked' });
      if (result.status === 'not_responded') {
        return jsonResponse(409, { error: 'pair_not_responded' });
      }
      if (result.status === 'invalid_state') {
        return jsonResponse(409, { error: 'pair_invalid_state' });
      }

      return jsonResponse(200, {
        pairingId: session.id,
        status: result.status,
        direction: valid.value.direction ?? session.direction,
      });
    },

    async handlePairCancel(request: Request, clientIp?: string): Promise<Response> {
      const limited = checkRateLimit(request, 'pair', clientIp);
      if (limited) return limited;

      const pollToken = request.headers.get('x-pair-poll-token')?.trim() ?? '';
      const responderToken = request.headers.get('x-pair-responder-token')?.trim() ?? '';
      if (pollToken.length > 0 && responderToken.length > 0) {
        return jsonResponse(400, { error: 'ambiguous_pair_token' });
      }
      if (pollToken.length === 0 && responderToken.length === 0) {
        return jsonResponse(401, { error: 'missing_pair_token' });
      }

      const parsed = await readBoundedJson(request, BODY_LIMITS.pair);
      if (!parsed.ok) return jsonResponse(400, { error: parsed.error });
      const valid = validatePairCancelInput(parsed.value);
      if (!valid.ok) return jsonResponse(400, { error: valid.error });

      const session = await storage.findPairSessionById(valid.value.pairingId);
      if (!session) return jsonResponse(404, { error: 'pair_not_found' });

      if (pollToken.length > 0) {
        const providedHash = await sha256Hex(pollToken);
        if (!timingSafeEqualHex(providedHash, session.pollTokenHash)) {
          return jsonResponse(401, { error: 'invalid_poll_token' });
        }
      } else {
        const providedHash = await sha256Hex(responderToken);
        if (
          !session.responderTokenHash ||
          !timingSafeEqualHex(providedHash, session.responderTokenHash)
        ) {
          return jsonResponse(401, { error: 'invalid_responder_token' });
        }
      }

      const nowIso = new Date(nowMs()).toISOString();
      const result = await storage.cancelPairSession(session.id, nowIso);
      if (result.status === 'not_found') return jsonResponse(404, { error: 'pair_not_found' });
      if (result.status === 'expired') return jsonResponse(410, { error: 'pair_expired' });
      if (result.status === 'locked') return jsonResponse(423, { error: 'pair_locked' });
      if (result.status === 'invalid_state') {
        return jsonResponse(409, { error: 'pair_invalid_state' });
      }

      return jsonResponse(200, {
        pairingId: session.id,
        status: 'rejected',
      });
    },

    async handlePairClaim(request: Request, clientIp?: string): Promise<Response> {
      const limited = checkRateLimit(request, 'pair', clientIp);
      if (limited) return limited;

      const user = await requireActiveUser(request);
      if (!user) return jsonResponse(401, { error: 'unauthorized' });

      const parsed = await readBoundedJson(request, BODY_LIMITS.pair);
      if (!parsed.ok) return jsonResponse(400, { error: parsed.error });
      const valid = validatePairClaimInput(parsed.value);
      if (!valid.ok) return jsonResponse(400, { error: valid.error });

      const codeHash = await sha256Hex(valid.value.code);
      const result = await storage.claimPairSession(
        codeHash,
        user.id,
        valid.value.encryptedPayload,
        valid.value.iv,
        new Date(nowMs()).toISOString(),
      );

      if (result.status === 'not_found') return jsonResponse(404, { error: 'pair_not_found' });
      if (result.status === 'expired') return jsonResponse(410, { error: 'pair_expired' });
      if (result.status === 'locked') return jsonResponse(423, { error: 'pair_locked' });
      if (result.status === 'already_claimed') {
        return jsonResponse(409, { error: 'pair_already_claimed' });
      }
      return jsonResponse(200, { claimed: true });
    },

    async handlePairPoll(
      request: Request,
      pairingId: string,
      clientIp?: string,
    ): Promise<Response> {
      const limited = checkRateLimit(request, 'pair', clientIp);
      if (limited) return limited;

      const pollToken = request.headers.get('x-pair-poll-token')?.trim() ?? '';
      const responderToken = request.headers.get('x-pair-responder-token')?.trim() ?? '';
      if (pollToken.length > 0 && responderToken.length > 0) {
        return jsonResponse(400, { error: 'ambiguous_pair_token' });
      }
      if (pollToken.length === 0 && responderToken.length === 0) {
        return jsonResponse(401, { error: 'missing_poll_token' });
      }

      const session = await storage.findPairSessionById(pairingId);
      if (!session) return jsonResponse(404, { error: 'pair_not_found' });

      let role: 'host' | 'responder';
      if (pollToken.length > 0) {
        const providedHash = await sha256Hex(pollToken);
        if (!timingSafeEqualHex(providedHash, session.pollTokenHash)) {
          return jsonResponse(401, { error: 'invalid_poll_token' });
        }
        role = 'host';
      } else {
        const providedHash = await sha256Hex(responderToken);
        if (
          !session.responderTokenHash ||
          !timingSafeEqualHex(providedHash, session.responderTokenHash)
        ) {
          return jsonResponse(401, { error: 'invalid_responder_token' });
        }
        role = 'responder';
      }

      const nowIso = new Date(nowMs()).toISOString();
      if (session.expiresAt <= nowIso) {
        await storage.deletePairSession(session.id);
        return jsonResponse(410, { error: 'pair_expired' });
      }
      if (session.status === 'locked' || session.attempts >= MAX_PAIR_ATTEMPTS) {
        return jsonResponse(423, { error: 'pair_locked' });
      }

      // Legacy one-way pairing flow
      if (session.hostPublicKey === null) {
        if (session.status === 'pending') {
          return jsonResponse(200, { status: 'pending', expiresAt: session.expiresAt });
        }
        if (session.status === 'rejected') {
          return jsonResponse(200, { status: 'rejected', expiresAt: session.expiresAt });
        }
        const consumed = await storage.consumeClaimedPairSession(session.id);
        if (consumed.status !== 'consumed') {
          return jsonResponse(404, { error: 'pair_not_found' });
        }
        return jsonResponse(200, {
          status: 'claimed',
          encryptedPayload: consumed.encryptedPayload,
          iv: consumed.iv,
        });
      }

      // Bidirectional v2 pairing flow
      const hostApproved = session.hostApprovedAt !== null;

      if (role === 'host') {
        if (session.status === 'pending') {
          return jsonResponse(200, {
            status: 'pending',
            hostApproved: false,
            expiresAt: session.expiresAt,
          });
        }
        const hostMeta = {
          responderPublicKey: session.responderPublicKey,
          responderAuthState: session.responderAuthState,
          responderMaskedEmail: session.responderMaskedEmail,
          responderEmailHash: session.responderEmailHash,
          direction: session.direction,
          hostApproved,
          expiresAt: session.expiresAt,
        };
        if (
          hostApproved &&
          (session.status === 'approved' ||
            session.status === 'responder_transferred' ||
            session.status === 'completed') &&
          session.encryptedPayload !== null &&
          session.iv !== null
        ) {
          const consumed = await storage.consumeHostPairPayload(session.id);
          if (consumed.status === 'consumed') {
            return jsonResponse(200, {
              status: 'completed',
              ...hostMeta,
              encryptedPayload: consumed.encryptedPayload,
              iv: consumed.iv,
            });
          }
          return jsonResponse(200, { status: 'completed', ...hostMeta });
        }
        return jsonResponse(200, { status: session.status, ...hostMeta });
      }

      // role === 'responder'
      const responderMeta = {
        direction: session.direction,
        hostApproved,
        expiresAt: session.expiresAt,
      };
      if (
        hostApproved &&
        session.status === 'approved' &&
        session.returnEncryptedPayload !== null &&
        session.returnIv !== null
      ) {
        const consumed = await storage.consumeResponderPairPayload(session.id);
        if (consumed.status === 'consumed') {
          return jsonResponse(200, {
            status: 'completed',
            ...responderMeta,
            encryptedPayload: consumed.encryptedPayload,
            iv: consumed.iv,
          });
        }
        return jsonResponse(200, { status: 'completed', ...responderMeta });
      }
      return jsonResponse(200, { status: session.status, ...responderMeta });
    },
  };
}
