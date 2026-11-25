/** Stored user account record (zero-knowledge: never holds raw password or vault key). */
export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly verifierHash: string;
  readonly verifierSalt: string;
  readonly verifierIterations: number;
  readonly kdfSalt: string;
  readonly kdfIterations: number;
  readonly wrappedVaultKey: string;
  readonly recoveryWrappedVaultKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Stored hashed refresh token record supporting rotation and reuse detection. */
export interface RefreshTokenRecord {
  readonly id: string;
  readonly userId: string;
  readonly familyId: string;
  readonly tokenHash: string;
  readonly replacedById: string | null;
  readonly revokedAt: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
}

/** Stored opaque E2EE vault ciphertext blob with optimistic concurrency revision. */
export interface VaultRecord {
  readonly userId: string;
  readonly revision: number;
  readonly ciphertext: string;
  readonly iv: string;
  readonly updatedAt: string;
}

/** Result of an optimistic-concurrency vault write. */
export type VaultPutResult =
  | { readonly ok: true; readonly revision: number; readonly updatedAt: string }
  | { readonly ok: false; readonly conflict: true; readonly currentRevision: number };

/** Stored ephemeral QR pairing session record. */
export interface PairSessionRecord {
  readonly id: string;
  readonly code: string;
  readonly pollTokenHash: string;
  readonly status: 'pending' | 'claimed';
  readonly claimedByUserId: string | null;
  readonly encryptedPayload: string | null;
  readonly iv: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
}

/** Result of claiming an active pairing session. */
export type PairClaimResult =
  | { readonly status: 'claimed' }
  | { readonly status: 'not_found' }
  | { readonly status: 'expired' }
  | { readonly status: 'already_claimed' };

/** Result of atomically consuming a claimed pairing session on poll. */
export type PairConsumeResult =
  | { readonly status: 'consumed'; readonly encryptedPayload: string; readonly iv: string }
  | { readonly status: 'not_claimed' };

/** Stored strictly redacted opt-in telemetry event. */
export interface TelemetryEventRecord {
  readonly id: string;
  readonly receivedAt: string;
  readonly eventTs: string;
  readonly sessionId: string;
  readonly kind: string;
  readonly appVersion: string;
  readonly platform: string;
  readonly osVersion: string | null;
  readonly formFactor: string | null;
  readonly payloadJson: string;
}

/** Stored user feedback submission. */
export interface FeedbackSubmissionRecord {
  readonly id: string;
  readonly receivedAt: string;
  readonly category: string;
  readonly message: string;
  readonly appVersion: string;
  readonly platform: string;
  readonly locale: string | null;
  readonly diagnosticsJson: string | null;
}

/** Stored privacy-preserving web account deletion request (hashed email only). */
export interface AccountDeletionRequestRecord {
  readonly id: string;
  readonly emailHash: string;
  readonly note: string | null;
  readonly createdAtMs: number;
}

/** Persistence port implemented by both in-memory (Node/tests) and Cloudflare D1 backends. */
export interface SyncServerStorage {
  createUser(user: UserRecord): Promise<{ readonly created: boolean }>;
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;
  deleteUserAccount(userId: string): Promise<boolean>;

  insertRefreshToken(token: RefreshTokenRecord): Promise<void>;
  findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRecord | null>;
  rotateRefreshToken(
    oldTokenId: string,
    newToken: RefreshTokenRecord,
    revokedAt: string,
  ): Promise<boolean>;
  revokeRefreshTokenByHash(tokenHash: string, revokedAt: string): Promise<void>;
  revokeRefreshTokenFamily(familyId: string, revokedAt: string): Promise<void>;

  getVault(userId: string): Promise<VaultRecord | null>;
  putVault(
    userId: string,
    expectedRevision: number,
    ciphertext: string,
    iv: string,
    updatedAt: string,
  ): Promise<VaultPutResult>;

  createPairSession(session: PairSessionRecord): Promise<void>;
  findPairSessionById(id: string): Promise<PairSessionRecord | null>;
  claimPairSession(
    code: string,
    claimedByUserId: string,
    encryptedPayload: string,
    iv: string,
    nowIso: string,
  ): Promise<PairClaimResult>;
  consumeClaimedPairSession(id: string): Promise<PairConsumeResult>;
  deletePairSession(id: string): Promise<void>;

  insertTelemetryEvents(events: readonly TelemetryEventRecord[]): Promise<void>;
  listTelemetryEvents(sinceIso: string | null): Promise<TelemetryEventRecord[]>;

  insertFeedbackSubmission(feedback: FeedbackSubmissionRecord): Promise<void>;
  listFeedbackSubmissions(sinceIso: string | null): Promise<FeedbackSubmissionRecord[]>;

  insertAccountDeletionRequest(request: AccountDeletionRequestRecord): Promise<void>;
  countAccountDeletionRequests(): Promise<number>;
}
