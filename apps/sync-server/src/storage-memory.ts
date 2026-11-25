import type {
  FeedbackSubmissionRecord,
  PairClaimResult,
  PairConsumeResult,
  PairSessionRecord,
  RefreshTokenRecord,
  SyncServerStorage,
  TelemetryEventRecord,
  UserRecord,
  VaultPutResult,
  VaultRecord,
} from './storage.ts';

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
      pairSessionsById.set(session.id, session);
      pairSessionIdsByCode.set(session.code, session.id);
    },

    async findPairSessionById(id: string): Promise<PairSessionRecord | null> {
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
      if (!existing) return { status: 'not_found' };
      if (existing.expiresAt <= nowIso) {
        pairSessionsById.delete(id);
        pairSessionIdsByCode.delete(code);
        return { status: 'expired' };
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
    },

    async listTelemetryEvents(sinceIso: string | null): Promise<TelemetryEventRecord[]> {
      if (!sinceIso) return [...telemetryEvents];
      return telemetryEvents.filter((event) => event.receivedAt >= sinceIso);
    },

    async insertFeedbackSubmission(feedback: FeedbackSubmissionRecord): Promise<void> {
      feedbackSubmissions.push(feedback);
    },

    async listFeedbackSubmissions(sinceIso: string | null): Promise<FeedbackSubmissionRecord[]> {
      const filtered = sinceIso
        ? feedbackSubmissions.filter((item) => item.receivedAt >= sinceIso)
        : [...feedbackSubmissions];
      return filtered.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
    },
  };
}
