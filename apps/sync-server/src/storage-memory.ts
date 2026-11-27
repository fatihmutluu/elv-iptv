import { MAX_PAIR_ATTEMPTS } from './pair-validation.ts';
import type {
  AccountDeletionRequestRecord,
  FeedbackSubmissionRecord,
  PairApproveParams,
  PairApproveResult,
  PairAttemptResult,
  PairCancelResult,
  PairClaimResult,
  PairConsumeResult,
  PairRespondParams,
  PairRespondResult,
  PairSessionRecord,
  PairTransferParams,
  PairTransferResult,
  RefreshTokenRecord,
  SyncServerStorage,
  TelemetryEventRecord,
  UserRecord,
  VaultPutResult,
  VaultRecord,
} from './storage.ts';

const MAX_TELEMETRY_EVENTS = 5_000;
const MAX_FEEDBACK_SUBMISSIONS = 500;
const MAX_ACCOUNT_DELETION_REQUESTS = 5_000;

/** Creates an in-memory `SyncServerStorage` for Node self-hosting and unit tests. */
export function createMemoryStorage(): SyncServerStorage {
  const usersById = new Map<string, UserRecord>();
  const userIdsByEmail = new Map<string, string>();
  const refreshTokensById = new Map<string, RefreshTokenRecord>();
  const refreshTokenIdsByHash = new Map<string, string>();
  const vaultsByUserId = new Map<string, VaultRecord>();
  const pairSessionsById = new Map<string, PairSessionRecord>();
  const pairSessionIdsByCode = new Map<string, string>();
  const telemetryEvents: TelemetryEventRecord[] = [];
  const feedbackSubmissions: FeedbackSubmissionRecord[] = [];
  const accountDeletionRequests: AccountDeletionRequestRecord[] = [];

  function pruneExpiredRefreshTokens(referenceIso: string): void {
    for (const [id, token] of refreshTokensById) {
      if (token.expiresAt <= referenceIso) {
        refreshTokensById.delete(id);
        refreshTokenIdsByHash.delete(token.tokenHash);
      }
    }
  }

  function pruneExpiredPairSessions(referenceIso: string): void {
    for (const [id, session] of pairSessionsById) {
      if (session.expiresAt <= referenceIso) {
        pairSessionsById.delete(id);
        pairSessionIdsByCode.delete(session.code);
      }
    }
  }

  return {
    async createUser(user: UserRecord): Promise<{ readonly created: boolean }> {
      if (userIdsByEmail.has(user.email)) {
        return { created: false };
      }
      usersById.set(user.id, user);
      userIdsByEmail.set(user.email, user.id);
      return { created: true };
    },

    async findUserByEmail(email: string): Promise<UserRecord | null> {
      const id = userIdsByEmail.get(email);
      if (!id) return null;
      return usersById.get(id) ?? null;
    },

    async findUserById(id: string): Promise<UserRecord | null> {
      return usersById.get(id) ?? null;
    },

    async deleteUserAccount(userId: string): Promise<boolean> {
      const user = usersById.get(userId);
      if (!user) return false;
      usersById.delete(userId);
      userIdsByEmail.delete(user.email);
      vaultsByUserId.delete(userId);

      for (const [tokenId, token] of refreshTokensById) {
        if (token.userId === userId) {
          refreshTokensById.delete(tokenId);
          refreshTokenIdsByHash.delete(token.tokenHash);
        }
      }
      for (const [pairId, session] of pairSessionsById) {
        if (session.claimedByUserId === userId) {
          pairSessionsById.delete(pairId);
          pairSessionIdsByCode.delete(session.code);
        }
      }
      return true;
    },

    async insertRefreshToken(token: RefreshTokenRecord): Promise<void> {
      pruneExpiredRefreshTokens(token.createdAt);
      refreshTokensById.set(token.id, token);
      refreshTokenIdsByHash.set(token.tokenHash, token.id);
    },

    async findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
      const id = refreshTokenIdsByHash.get(tokenHash);
      if (!id) return null;
      return refreshTokensById.get(id) ?? null;
    },

    async rotateRefreshToken(
      oldTokenId: string,
      newToken: RefreshTokenRecord,
      revokedAt: string,
    ): Promise<boolean> {
      const existing = refreshTokensById.get(oldTokenId);
      if (!existing || existing.replacedById !== null || existing.revokedAt !== null) {
        return false;
      }
      pruneExpiredRefreshTokens(revokedAt);
      refreshTokensById.set(oldTokenId, {
        ...existing,
        replacedById: newToken.id,
        revokedAt,
      });
      refreshTokensById.set(newToken.id, newToken);
      refreshTokenIdsByHash.set(newToken.tokenHash, newToken.id);
      return true;
    },

    async revokeRefreshTokenByHash(tokenHash: string, revokedAt: string): Promise<void> {
      const id = refreshTokenIdsByHash.get(tokenHash);
      if (!id) return;
      const existing = refreshTokensById.get(id);
      if (!existing || existing.revokedAt !== null) return;
      refreshTokensById.set(id, { ...existing, revokedAt });
    },

    async revokeRefreshTokenFamily(familyId: string, revokedAt: string): Promise<void> {
      for (const [id, token] of refreshTokensById) {
        if (token.familyId === familyId && token.revokedAt === null) {
          refreshTokensById.set(id, { ...token, revokedAt });
        }
      }
    },

    async getVault(userId: string): Promise<VaultRecord | null> {
      return vaultsByUserId.get(userId) ?? null;
    },

    async putVault(
      userId: string,
      expectedRevision: number,
      ciphertext: string,
      iv: string,
      updatedAt: string,
    ): Promise<VaultPutResult> {
      const existing = vaultsByUserId.get(userId);
      const currentRevision = existing?.revision ?? 0;
      if (expectedRevision !== currentRevision) {
        return { ok: false, conflict: true, currentRevision };
      }
      const nextRevision = currentRevision + 1;
      vaultsByUserId.set(userId, {
        userId,
        revision: nextRevision,
        ciphertext,
        iv,
        updatedAt,
      });
      return { ok: true, revision: nextRevision, updatedAt };
    },

    async createPairSession(session: PairSessionRecord): Promise<void> {
      pruneExpiredPairSessions(session.createdAt);
      if (pairSessionIdsByCode.has(session.code)) {
        throw new Error('UNIQUE constraint failed: pair_sessions.code');
      }
      pairSessionsById.set(session.id, session);
      pairSessionIdsByCode.set(session.code, session.id);
    },

    async findPairSessionById(id: string): Promise<PairSessionRecord | null> {
      return pairSessionsById.get(id) ?? null;
    },

    async findPairSessionByCode(code: string): Promise<PairSessionRecord | null> {
      const id = pairSessionIdsByCode.get(code);
      if (!id) return null;
      return pairSessionsById.get(id) ?? null;
    },

    async claimPairSession(
      code: string,
      claimedByUserId: string,
      encryptedPayload: string,
      iv: string,
      nowIso: string,
    ): Promise<PairClaimResult> {
      const id = pairSessionIdsByCode.get(code);
      if (!id) return { status: 'not_found' };
      const existing = pairSessionsById.get(id);
      if (!existing || existing.hostPublicKey !== null) return { status: 'not_found' };
      if (existing.expiresAt <= nowIso) {
        pairSessionsById.delete(id);
        pairSessionIdsByCode.delete(code);
        return { status: 'expired' };
      }
      if (existing.status === 'locked' || existing.attempts >= MAX_PAIR_ATTEMPTS) {
        return { status: 'locked' };
      }
      if (existing.status !== 'pending') {
        return { status: 'already_claimed' };
      }
      pairSessionsById.set(id, {
        ...existing,
        status: 'claimed',
        claimedByUserId,
        encryptedPayload,
        iv,
      });
      return { status: 'claimed' };
    },

    async consumeClaimedPairSession(id: string): Promise<PairConsumeResult> {
      const existing = pairSessionsById.get(id);
      if (
        existing?.status !== 'claimed' ||
        existing.encryptedPayload === null ||
        existing.iv === null
      ) {
        return { status: 'not_claimed' };
      }
      pairSessionsById.delete(id);
      pairSessionIdsByCode.delete(existing.code);
      return {
        status: 'consumed',
        encryptedPayload: existing.encryptedPayload,
        iv: existing.iv,
      };
    },

    async incrementPairAttempts(id: string, maxAttempts: number): Promise<PairAttemptResult> {
      const existing = pairSessionsById.get(id);
      if (!existing) return { status: 'not_found' };
      const nextAttempts = existing.attempts + 1;
      const shouldLock = nextAttempts >= maxAttempts || existing.status === 'locked';
      pairSessionsById.set(id, {
        ...existing,
        attempts: nextAttempts,
        status: shouldLock ? 'locked' : existing.status,
        encryptedPayload: shouldLock ? null : existing.encryptedPayload,
        iv: shouldLock ? null : existing.iv,
        returnEncryptedPayload: shouldLock ? null : existing.returnEncryptedPayload,
        returnIv: shouldLock ? null : existing.returnIv,
      });
      return shouldLock
        ? { status: 'locked', attempts: nextAttempts }
        : { status: 'incremented', attempts: nextAttempts };
    },

    async respondPairSession(params: PairRespondParams): Promise<PairRespondResult> {
      const existing = pairSessionsById.get(params.id);
      if (!existing) return { status: 'not_found' };
      if (existing.expiresAt <= params.nowIso) {
        pairSessionsById.delete(existing.id);
        pairSessionIdsByCode.delete(existing.code);
        return { status: 'expired' };
      }
      if (existing.status === 'locked' || existing.attempts >= params.maxAttempts) {
        return { status: 'locked' };
      }
      if (
        existing.hostPublicKey === null ||
        existing.status !== 'pending' ||
        existing.responderTokenHash !== null
      ) {
        return { status: 'already_responded' };
      }
      pairSessionsById.set(existing.id, {
        ...existing,
        status: 'responder_joined',
        responderPublicKey: params.responderPublicKey,
        responderAuthState: params.responderAuthState,
        responderMaskedEmail: params.responderMaskedEmail,
        responderEmailHash: params.responderEmailHash,
        responderTokenHash: params.responderTokenHash,
        direction: params.direction,
      });
      return { status: 'responder_joined' };
    },

    async transferPairSession(params: PairTransferParams): Promise<PairTransferResult> {
      const existing = pairSessionsById.get(params.id);
      if (!existing) return { status: 'not_found' };
      if (existing.expiresAt <= params.nowIso) {
        pairSessionsById.delete(existing.id);
        pairSessionIdsByCode.delete(existing.code);
        return { status: 'expired' };
      }
      if (existing.status === 'locked' || existing.attempts >= params.maxAttempts) {
        return { status: 'locked' };
      }
      if (existing.status === 'responder_transferred' || existing.encryptedPayload !== null) {
        return { status: 'already_transferred' };
      }
      const allowed =
        existing.hostPublicKey !== null &&
        existing.returnEncryptedPayload === null &&
        (existing.status === 'responder_joined' ||
          (existing.status === 'approved' && existing.direction === 'responder_to_host'));
      if (!allowed) {
        return { status: 'invalid_state' };
      }
      const nextStatus = existing.hostApprovedAt !== null ? 'completed' : 'responder_transferred';
      pairSessionsById.set(existing.id, {
        ...existing,
        status: nextStatus,
        direction: params.direction,
        encryptedPayload: params.encryptedPayload,
        iv: params.iv,
      });
      return { status: nextStatus };
    },

    async approvePairSession(params: PairApproveParams): Promise<PairApproveResult> {
      const existing = pairSessionsById.get(params.id);
      if (!existing) return { status: 'not_found' };
      if (existing.expiresAt <= params.nowIso) {
        pairSessionsById.delete(existing.id);
        pairSessionIdsByCode.delete(existing.code);
        return { status: 'expired' };
      }
      if (existing.status === 'locked' || existing.attempts >= MAX_PAIR_ATTEMPTS) {
        return { status: 'locked' };
      }
      if (existing.hostPublicKey === null) return { status: 'invalid_state' };

      if (params.reject) {
        const rejectable =
          existing.status === 'pending' ||
          existing.status === 'responder_joined' ||
          existing.status === 'approved' ||
          existing.status === 'responder_transferred';
        if (!rejectable) return { status: 'invalid_state' };
        pairSessionsById.set(existing.id, {
          ...existing,
          status: 'rejected',
          direction: params.direction ?? existing.direction,
          hostApprovedAt: null,
          encryptedPayload: null,
          iv: null,
          returnEncryptedPayload: null,
          returnIv: null,
        });
        return { status: 'rejected' };
      }

      if (existing.status === 'pending') return { status: 'not_responded' };
      if (existing.status !== 'responder_joined' && existing.status !== 'responder_transferred') {
        return { status: 'invalid_state' };
      }

      const hasReturnPayload = params.returnEncryptedPayload !== null && params.returnIv !== null;
      if (hasReturnPayload) {
        pairSessionsById.set(existing.id, {
          ...existing,
          status: 'approved',
          direction: params.direction,
          hostApprovedAt: params.hostApprovedAt,
          encryptedPayload: null,
          iv: null,
          returnEncryptedPayload: params.returnEncryptedPayload,
          returnIv: params.returnIv,
        });
        return { status: 'approved' };
      }

      if (params.direction === 'responder_to_host') {
        const hasResponderPayload =
          existing.status === 'responder_transferred' &&
          existing.encryptedPayload !== null &&
          existing.iv !== null;
        const nextStatus = hasResponderPayload ? 'completed' : 'approved';
        pairSessionsById.set(existing.id, {
          ...existing,
          status: nextStatus,
          direction: params.direction,
          hostApprovedAt: params.hostApprovedAt,
        });
        return { status: nextStatus };
      }

      pairSessionsById.set(existing.id, {
        ...existing,
        status: 'approved',
        direction: params.direction,
        hostApprovedAt: params.hostApprovedAt,
        encryptedPayload: null,
        iv: null,
        returnEncryptedPayload: null,
        returnIv: null,
      });
      return { status: 'approved' };
    },

    async cancelPairSession(id: string, nowIso: string): Promise<PairCancelResult> {
      const existing = pairSessionsById.get(id);
      if (!existing) return { status: 'not_found' };
      if (existing.expiresAt <= nowIso) {
        pairSessionsById.delete(existing.id);
        pairSessionIdsByCode.delete(existing.code);
        return { status: 'expired' };
      }
      if (existing.status === 'locked' || existing.attempts >= MAX_PAIR_ATTEMPTS) {
        return { status: 'locked' };
      }
      const cancellable =
        existing.status === 'pending' ||
        existing.status === 'responder_joined' ||
        existing.status === 'approved' ||
        existing.status === 'responder_transferred' ||
        existing.status === 'rejected' ||
        (existing.status === 'completed' &&
          (existing.encryptedPayload !== null || existing.returnEncryptedPayload !== null));
      if (!cancellable) return { status: 'invalid_state' };
      pairSessionsById.set(existing.id, {
        ...existing,
        status: 'rejected',
        hostApprovedAt: null,
        encryptedPayload: null,
        iv: null,
        returnEncryptedPayload: null,
        returnIv: null,
      });
      return { status: 'rejected' };
    },

    async consumeHostPairPayload(id: string): Promise<PairConsumeResult> {
      const existing = pairSessionsById.get(id);
      if (
        !existing ||
        existing.hostApprovedAt === null ||
        (existing.status !== 'approved' &&
          existing.status !== 'responder_transferred' &&
          existing.status !== 'completed') ||
        existing.encryptedPayload === null ||
        existing.iv === null
      ) {
        return { status: 'not_claimed' };
      }
      const { encryptedPayload, iv } = existing;
      pairSessionsById.set(id, {
        ...existing,
        status: 'completed',
        encryptedPayload: null,
        iv: null,
      });
      return { status: 'consumed', encryptedPayload, iv };
    },

    async consumeResponderPairPayload(id: string): Promise<PairConsumeResult> {
      const existing = pairSessionsById.get(id);
      if (
        !existing ||
        existing.hostApprovedAt === null ||
        existing.status !== 'approved' ||
        existing.returnEncryptedPayload === null ||
        existing.returnIv === null
      ) {
        return { status: 'not_claimed' };
      }
      const encryptedPayload = existing.returnEncryptedPayload;
      const iv = existing.returnIv;
      pairSessionsById.set(id, {
        ...existing,
        status: 'completed',
        returnEncryptedPayload: null,
        returnIv: null,
      });
      return { status: 'consumed', encryptedPayload, iv };
    },

    async deletePairSession(id: string): Promise<void> {
      const existing = pairSessionsById.get(id);
      if (!existing) return;
      pairSessionsById.delete(id);
      pairSessionIdsByCode.delete(existing.code);
    },

    async insertTelemetryEvents(events: readonly TelemetryEventRecord[]): Promise<void> {
      for (const event of events) {
        telemetryEvents.push(event);
      }
      if (telemetryEvents.length > MAX_TELEMETRY_EVENTS) {
        telemetryEvents.splice(0, telemetryEvents.length - MAX_TELEMETRY_EVENTS);
      }
    },

    async listTelemetryEvents(sinceIso: string | null): Promise<TelemetryEventRecord[]> {
      if (!sinceIso) return [...telemetryEvents];
      return telemetryEvents.filter((event) => event.receivedAt >= sinceIso);
    },

    async insertFeedbackSubmission(feedback: FeedbackSubmissionRecord): Promise<void> {
      feedbackSubmissions.push(feedback);
      if (feedbackSubmissions.length > MAX_FEEDBACK_SUBMISSIONS) {
        feedbackSubmissions.splice(0, feedbackSubmissions.length - MAX_FEEDBACK_SUBMISSIONS);
      }
    },

    async listFeedbackSubmissions(sinceIso: string | null): Promise<FeedbackSubmissionRecord[]> {
      const filtered = sinceIso
        ? feedbackSubmissions.filter((item) => item.receivedAt >= sinceIso)
        : [...feedbackSubmissions];
      return filtered.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
    },

    async insertAccountDeletionRequest(request: AccountDeletionRequestRecord): Promise<void> {
      accountDeletionRequests.push(request);
      if (accountDeletionRequests.length > MAX_ACCOUNT_DELETION_REQUESTS) {
        accountDeletionRequests.splice(
          0,
          accountDeletionRequests.length - MAX_ACCOUNT_DELETION_REQUESTS,
        );
      }
    },

    async countAccountDeletionRequests(): Promise<number> {
      return accountDeletionRequests.length;
    },
  };
}
