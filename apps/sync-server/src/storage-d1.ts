import type {
  AccountDeletionRequestRecord,
  FeedbackSubmissionRecord,
  RefreshTokenRecord,
  SyncServerStorage,
  TelemetryEventRecord,
  UserRecord,
  VaultPutResult,
  VaultRecord,
} from './storage.ts';
import { createD1PairStorage } from './storage-d1-pair.ts';
import type { D1Database } from './storage-d1-types.ts';

interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly verifier_hash: string;
  readonly verifier_salt: string;
  readonly verifier_iterations: number;
  readonly kdf_salt: string;
  readonly kdf_iterations: number;
  readonly wrapped_vault_key: string;
  readonly recovery_wrapped_vault_key: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface RefreshTokenRow {
  readonly id: string;
  readonly user_id: string;
  readonly family_id: string;
  readonly token_hash: string;
  readonly replaced_by_id: string | null;
  readonly revoked_at: string | null;
  readonly expires_at: string;
  readonly created_at: string;
}

interface VaultRow {
  readonly user_id: string;
  readonly revision: number;
  readonly ciphertext: string;
  readonly iv: string;
  readonly updated_at: string;
}

interface TelemetryEventRow {
  readonly id: string;
  readonly received_at: string;
  readonly event_ts: string;
  readonly session_id: string;
  readonly kind: string;
  readonly app_version: string;
  readonly platform: string;
  readonly os_version: string | null;
  readonly form_factor: string | null;
  readonly payload_json: string;
  readonly device_profile_json: string | null;
}

interface FeedbackRow {
  readonly id: string;
  readonly received_at: string;
  readonly category: string;
  readonly message: string;
  readonly app_version: string;
  readonly platform: string;
  readonly locale: string | null;
  readonly diagnostics_json: string | null;
}

function mapUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    verifierHash: row.verifier_hash,
    verifierSalt: row.verifier_salt,
    verifierIterations: row.verifier_iterations,
    kdfSalt: row.kdf_salt,
    kdfIterations: row.kdf_iterations,
    wrappedVaultKey: row.wrapped_vault_key,
    recoveryWrappedVaultKey: row.recovery_wrapped_vault_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRefreshToken(row: RefreshTokenRow): RefreshTokenRecord {
  return {
    id: row.id,
    userId: row.user_id,
    familyId: row.family_id,
    tokenHash: row.token_hash,
    replacedById: row.replaced_by_id,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function mapVault(row: VaultRow): VaultRecord {
  return {
    userId: row.user_id,
    revision: row.revision,
    ciphertext: row.ciphertext,
    iv: row.iv,
    updatedAt: row.updated_at,
  };
}

function mapTelemetryEvent(row: TelemetryEventRow): TelemetryEventRecord {
  return {
    id: row.id,
    receivedAt: row.received_at,
    eventTs: row.event_ts,
    sessionId: row.session_id,
    kind: row.kind,
    appVersion: row.app_version,
    platform: row.platform,
    osVersion: row.os_version,
    formFactor: row.form_factor,
    payloadJson: row.payload_json,
    deviceProfileJson: row.device_profile_json ?? null,
  };
}

function mapFeedback(row: FeedbackRow): FeedbackSubmissionRecord {
  return {
    id: row.id,
    receivedAt: row.received_at,
    category: row.category,
    message: row.message,
    appVersion: row.app_version,
    platform: row.platform,
    locale: row.locale,
    diagnosticsJson: row.diagnostics_json,
  };
}

/** Creates a Cloudflare D1 `SyncServerStorage` adapter matching migrations `0001` and `0002`. */
export function createD1Storage(db: D1Database): SyncServerStorage {
  const pairStorage = createD1PairStorage(db);
  return {
    ...pairStorage,
    async createUser(user: UserRecord): Promise<{ readonly created: boolean }> {
      const res = await db
        .prepare(
          `INSERT OR IGNORE INTO users (
            id, email, verifier_hash, verifier_salt, verifier_iterations,
            kdf_salt, kdf_iterations, wrapped_vault_key, recovery_wrapped_vault_key,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          user.id,
          user.email,
          user.verifierHash,
          user.verifierSalt,
          user.verifierIterations,
          user.kdfSalt,
          user.kdfIterations,
          user.wrappedVaultKey,
          user.recoveryWrappedVaultKey,
          user.createdAt,
          user.updatedAt,
        )
        .run();
      return { created: (res.meta?.changes ?? 0) > 0 };
    },

    async findUserByEmail(email: string): Promise<UserRecord | null> {
      const row = await db
        .prepare(
          `SELECT id, email, verifier_hash, verifier_salt, verifier_iterations,
                  kdf_salt, kdf_iterations, wrapped_vault_key, recovery_wrapped_vault_key,
                  created_at, updated_at
           FROM users WHERE email = ?`,
        )
        .bind(email)
        .first<UserRow>();
      return row ? mapUser(row) : null;
    },

    async findUserById(id: string): Promise<UserRecord | null> {
      const row = await db
        .prepare(
          `SELECT id, email, verifier_hash, verifier_salt, verifier_iterations,
                  kdf_salt, kdf_iterations, wrapped_vault_key, recovery_wrapped_vault_key,
                  created_at, updated_at
           FROM users WHERE id = ?`,
        )
        .bind(id)
        .first<UserRow>();
      return row ? mapUser(row) : null;
    },

    async deleteUserAccount(userId: string): Promise<boolean> {
      const results = await db.batch([
        db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').bind(userId),
        db.prepare('DELETE FROM vaults WHERE user_id = ?').bind(userId),
        db.prepare('DELETE FROM pair_sessions WHERE claimed_by_user_id = ?').bind(userId),
        db.prepare('DELETE FROM users WHERE id = ?').bind(userId),
      ]);
      const userDelete = results[3];
      return (userDelete?.meta?.changes ?? 0) > 0;
    },

    async insertRefreshToken(token: RefreshTokenRecord): Promise<void> {
      await db
        .prepare(
          `INSERT INTO refresh_tokens (
            id, user_id, family_id, token_hash, replaced_by_id, revoked_at, expires_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          token.id,
          token.userId,
          token.familyId,
          token.tokenHash,
          token.replacedById,
          token.revokedAt,
          token.expiresAt,
          token.createdAt,
        )
        .run();
    },

    async findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
      const row = await db
        .prepare(
          `SELECT id, user_id, family_id, token_hash, replaced_by_id, revoked_at, expires_at, created_at
           FROM refresh_tokens WHERE token_hash = ?`,
        )
        .bind(tokenHash)
        .first<RefreshTokenRow>();
      return row ? mapRefreshToken(row) : null;
    },

    async rotateRefreshToken(
      oldTokenId: string,
      newToken: RefreshTokenRecord,
      revokedAt: string,
    ): Promise<boolean> {
      const updateRes = await db
        .prepare(
          `UPDATE refresh_tokens
           SET replaced_by_id = ?, revoked_at = ?
           WHERE id = ? AND replaced_by_id IS NULL AND revoked_at IS NULL`,
        )
        .bind(newToken.id, revokedAt, oldTokenId)
        .run();
      if ((updateRes.meta?.changes ?? 0) === 0) return false;
      await db
        .prepare(
          `INSERT INTO refresh_tokens (
            id, user_id, family_id, token_hash, replaced_by_id, revoked_at, expires_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          newToken.id,
          newToken.userId,
          newToken.familyId,
          newToken.tokenHash,
          newToken.replacedById,
          newToken.revokedAt,
          newToken.expiresAt,
          newToken.createdAt,
        )
        .run();
      return true;
    },

    async revokeRefreshTokenByHash(tokenHash: string, revokedAt: string): Promise<void> {
      await db
        .prepare(
          'UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
        )
        .bind(revokedAt, tokenHash)
        .run();
    },

    async revokeRefreshTokenFamily(familyId: string, revokedAt: string): Promise<void> {
      await db
        .prepare(
          'UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL',
        )
        .bind(revokedAt, familyId)
        .run();
    },

    async getVault(userId: string): Promise<VaultRecord | null> {
      const row = await db
        .prepare(
          'SELECT user_id, revision, ciphertext, iv, updated_at FROM vaults WHERE user_id = ?',
        )
        .bind(userId)
        .first<VaultRow>();
      return row ? mapVault(row) : null;
    },

    async putVault(
      userId: string,
      expectedRevision: number,
      ciphertext: string,
      iv: string,
      updatedAt: string,
    ): Promise<VaultPutResult> {
      if (expectedRevision === 0) {
        const insertRes = await db
          .prepare(
            `INSERT OR IGNORE INTO vaults (user_id, revision, ciphertext, iv, updated_at)
             VALUES (?, 1, ?, ?, ?)`,
          )
          .bind(userId, ciphertext, iv, updatedAt)
          .run();
        if ((insertRes.meta?.changes ?? 0) === 1) {
          return { ok: true, revision: 1, updatedAt };
        }
      } else {
        const nextRevision = expectedRevision + 1;
        const updateRes = await db
          .prepare(
            `UPDATE vaults
             SET revision = ?, ciphertext = ?, iv = ?, updated_at = ?
             WHERE user_id = ? AND revision = ?`,
          )
          .bind(nextRevision, ciphertext, iv, updatedAt, userId, expectedRevision)
          .run();
        if ((updateRes.meta?.changes ?? 0) === 1) {
          return { ok: true, revision: nextRevision, updatedAt };
        }
      }
      const current = await db
        .prepare('SELECT revision FROM vaults WHERE user_id = ?')
        .bind(userId)
        .first<{ readonly revision: number }>();
      return { ok: false, conflict: true, currentRevision: current?.revision ?? 0 };
    },

    async insertTelemetryEvents(events: readonly TelemetryEventRecord[]): Promise<void> {
      if (events.length === 0) return;
      const statements = events.map((event) =>
        db
          .prepare(
            `INSERT INTO telemetry_events (
              id, received_at, event_ts, session_id, kind,
              app_version, platform, os_version, form_factor, payload_json, device_profile_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            event.id,
            event.receivedAt,
            event.eventTs,
            event.sessionId,
            event.kind,
            event.appVersion,
            event.platform,
            event.osVersion,
            event.formFactor,
            event.payloadJson,
            event.deviceProfileJson,
          ),
      );
      await db.batch(statements);
    },

    async listTelemetryEvents(sinceIso: string | null): Promise<TelemetryEventRecord[]> {
      const res = sinceIso
        ? await db
            .prepare(
              `SELECT id, received_at, event_ts, session_id, kind,
                      app_version, platform, os_version, form_factor, payload_json, device_profile_json
               FROM telemetry_events
               WHERE received_at >= ?
               ORDER BY received_at ASC
               LIMIT 5000`,
            )
            .bind(sinceIso)
            .all<TelemetryEventRow>()
        : await db
            .prepare(
              `SELECT id, received_at, event_ts, session_id, kind,
                      app_version, platform, os_version, form_factor, payload_json, device_profile_json
               FROM telemetry_events
               ORDER BY received_at ASC
               LIMIT 5000`,
            )
            .all<TelemetryEventRow>();
      return (res.results ?? []).map(mapTelemetryEvent);
    },

    async insertFeedbackSubmission(feedback: FeedbackSubmissionRecord): Promise<void> {
      await db
        .prepare(
          `INSERT INTO feedback_submissions (
            id, received_at, category, message, app_version, platform, locale, diagnostics_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          feedback.id,
          feedback.receivedAt,
          feedback.category,
          feedback.message,
          feedback.appVersion,
          feedback.platform,
          feedback.locale,
          feedback.diagnosticsJson,
        )
        .run();
    },

    async listFeedbackSubmissions(sinceIso: string | null): Promise<FeedbackSubmissionRecord[]> {
      const res = sinceIso
        ? await db
            .prepare(
              `SELECT id, received_at, category, message, app_version, platform, locale, diagnostics_json
               FROM feedback_submissions
               WHERE received_at >= ?
               ORDER BY received_at DESC
               LIMIT 500`,
            )
            .bind(sinceIso)
            .all<FeedbackRow>()
        : await db
            .prepare(
              `SELECT id, received_at, category, message, app_version, platform, locale, diagnostics_json
               FROM feedback_submissions
               ORDER BY received_at DESC
               LIMIT 500`,
            )
            .all<FeedbackRow>();
      return (res.results ?? []).map(mapFeedback);
    },

    async insertAccountDeletionRequest(request: AccountDeletionRequestRecord): Promise<void> {
      await db
        .prepare(
          `INSERT INTO account_deletion_requests (
            id, email_hash, note, created_at_ms
          ) VALUES (?, ?, ?, ?)`,
        )
        .bind(request.id, request.emailHash, request.note, request.createdAtMs)
        .run();
    },

    async countAccountDeletionRequests(): Promise<number> {
      const row = await db
        .prepare('SELECT COUNT(*) AS count FROM account_deletion_requests')
        .first<{ readonly count: number }>();
      return Number(row?.count ?? 0);
    },
  };
}
