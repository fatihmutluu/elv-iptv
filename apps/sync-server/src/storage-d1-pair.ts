import { MAX_PAIR_ATTEMPTS, type PairAuthState, type PairDirection } from './pair-validation.ts';
import type {
  PairApproveParams,
  PairApproveResult,
  PairAttemptResult,
  PairCancelResult,
  PairClaimResult,
  PairConsumeResult,
  PairRespondParams,
  PairRespondResult,
  PairSessionRecord,
  PairSessionStatus,
  PairTransferParams,
  PairTransferResult,
  SyncServerStorage,
} from './storage.ts';
import type { D1Database } from './storage-d1-types.ts';

interface PairSessionRow {
  readonly id: string;
  readonly code: string;
  readonly poll_token_hash: string;
  readonly status: PairSessionStatus;
  readonly attempts: number | null;
  readonly claimed_by_user_id: string | null;
  readonly encrypted_payload: string | null;
  readonly iv: string | null;
  readonly host_public_key: string | null;
  readonly responder_public_key: string | null;
  readonly host_auth_state: PairAuthState | null;
  readonly host_masked_email: string | null;
  readonly host_email_hash: string | null;
  readonly responder_auth_state: PairAuthState | null;
  readonly responder_masked_email: string | null;
  readonly responder_email_hash: string | null;
  readonly responder_token_hash: string | null;
  readonly direction: PairDirection | null;
  readonly host_approved_at: number | null;
  readonly return_encrypted_payload: string | null;
  readonly return_iv: string | null;
  readonly expires_at: string;
  readonly created_at: string;
}

const PAIR_SELECT_COLUMNS = `id, code, poll_token_hash, status, attempts, claimed_by_user_id,
  encrypted_payload, iv, host_public_key, responder_public_key,
  host_auth_state, host_masked_email, host_email_hash,
  responder_auth_state, responder_masked_email, responder_email_hash,
  responder_token_hash, direction, host_approved_at,
  return_encrypted_payload, return_iv, expires_at, created_at`;

function mapPairSession(row: PairSessionRow): PairSessionRecord {
  return {
    id: row.id,
    code: row.code,
    pollTokenHash: row.poll_token_hash,
    status: row.status,
    attempts: Number(row.attempts ?? 0),
    claimedByUserId: row.claimed_by_user_id,
    encryptedPayload: row.encrypted_payload,
    iv: row.iv,
    hostPublicKey: row.host_public_key ?? null,
    responderPublicKey: row.responder_public_key ?? null,
    hostAuthState: row.host_auth_state ?? 'signed_out',
    hostMaskedEmail: row.host_masked_email ?? null,
    hostEmailHash: row.host_email_hash ?? null,
    responderAuthState: row.responder_auth_state ?? null,
    responderMaskedEmail: row.responder_masked_email ?? null,
    responderEmailHash: row.responder_email_hash ?? null,
    responderTokenHash: row.responder_token_hash ?? null,
    direction: row.direction ?? null,
    hostApprovedAt: row.host_approved_at ?? null,
    returnEncryptedPayload: row.return_encrypted_payload ?? null,
    returnIv: row.return_iv ?? null,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

/** Pairing subset of `SyncServerStorage` implemented over Cloudflare D1. */
export type D1PairStorage = Pick<
  SyncServerStorage,
  | 'createPairSession'
  | 'findPairSessionById'
  | 'findPairSessionByCode'
  | 'claimPairSession'
  | 'consumeClaimedPairSession'
  | 'incrementPairAttempts'
  | 'respondPairSession'
  | 'transferPairSession'
  | 'approvePairSession'
  | 'cancelPairSession'
  | 'consumeHostPairPayload'
  | 'consumeResponderPairPayload'
  | 'deletePairSession'
>;

/** Creates the Cloudflare D1 persistence adapter for legacy and Wave P9 pairing sessions. */
export function createD1PairStorage(db: D1Database): D1PairStorage {
  return {
    async createPairSession(session: PairSessionRecord): Promise<void> {
      await db
        .prepare('DELETE FROM pair_sessions WHERE expires_at <= ?')
        .bind(session.createdAt)
        .run();
      await db
        .prepare(
          `INSERT INTO pair_sessions (
            id, code, poll_token_hash, status, attempts, claimed_by_user_id,
            encrypted_payload, iv, host_public_key, responder_public_key,
            host_auth_state, host_masked_email, host_email_hash,
            responder_auth_state, responder_masked_email, responder_email_hash,
            responder_token_hash, direction, host_approved_at,
            return_encrypted_payload, return_iv, expires_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          session.id,
          session.code,
          session.pollTokenHash,
          session.status,
          session.attempts,
          session.claimedByUserId,
          session.encryptedPayload,
          session.iv,
          session.hostPublicKey,
          session.responderPublicKey,
          session.hostAuthState,
          session.hostMaskedEmail,
          session.hostEmailHash,
          session.responderAuthState,
          session.responderMaskedEmail,
          session.responderEmailHash,
          session.responderTokenHash,
          session.direction,
          session.hostApprovedAt,
          session.returnEncryptedPayload,
          session.returnIv,
          session.expiresAt,
          session.createdAt,
        )
        .run();
    },

    async findPairSessionById(id: string): Promise<PairSessionRecord | null> {
      const row = await db
        .prepare(`SELECT ${PAIR_SELECT_COLUMNS} FROM pair_sessions WHERE id = ?`)
        .bind(id)
        .first<PairSessionRow>();
      return row ? mapPairSession(row) : null;
    },

    async findPairSessionByCode(code: string): Promise<PairSessionRecord | null> {
      const row = await db
        .prepare(`SELECT ${PAIR_SELECT_COLUMNS} FROM pair_sessions WHERE code = ?`)
        .bind(code)
        .first<PairSessionRow>();
      return row ? mapPairSession(row) : null;
    },

    async claimPairSession(
      code: string,
      claimedByUserId: string,
      encryptedPayload: string,
      iv: string,
      nowIso: string,
    ): Promise<PairClaimResult> {
      const row = await db
        .prepare(
          'SELECT id, status, attempts, expires_at, host_public_key FROM pair_sessions WHERE code = ?',
        )
        .bind(code)
        .first<{
          readonly id: string;
          readonly status: string;
          readonly attempts: number | null;
          readonly expires_at: string;
          readonly host_public_key: string | null;
        }>();
      if (!row || row.host_public_key !== null) return { status: 'not_found' };
      if (row.expires_at <= nowIso) {
        await db.prepare('DELETE FROM pair_sessions WHERE id = ?').bind(row.id).run();
        return { status: 'expired' };
      }
      if (row.status === 'locked' || Number(row.attempts ?? 0) >= MAX_PAIR_ATTEMPTS) {
        return { status: 'locked' };
      }
      if (row.status !== 'pending') return { status: 'already_claimed' };

      const updateRes = await db
        .prepare(
          `UPDATE pair_sessions
           SET status = 'claimed', claimed_by_user_id = ?, encrypted_payload = ?, iv = ?
           WHERE id = ? AND status = 'pending' AND host_public_key IS NULL AND attempts < ? AND expires_at > ?`,
        )
        .bind(claimedByUserId, encryptedPayload, iv, row.id, MAX_PAIR_ATTEMPTS, nowIso)
        .run();
      return (updateRes.meta?.changes ?? 0) === 1
        ? { status: 'claimed' }
        : { status: 'already_claimed' };
    },

    async consumeClaimedPairSession(id: string): Promise<PairConsumeResult> {
      const row = await db
        .prepare(
          `DELETE FROM pair_sessions
           WHERE id = ? AND status = 'claimed'
           RETURNING encrypted_payload, iv`,
        )
        .bind(id)
        .first<{ readonly encrypted_payload: string | null; readonly iv: string | null }>();
      if (!row || row.encrypted_payload === null || row.iv === null) {
        return { status: 'not_claimed' };
      }
      return {
        status: 'consumed',
        encryptedPayload: row.encrypted_payload,
        iv: row.iv,
      };
    },

    async incrementPairAttempts(id: string, maxAttempts: number): Promise<PairAttemptResult> {
      const row = await db
        .prepare(
          `UPDATE pair_sessions
           SET attempts = attempts + 1,
               status = CASE WHEN attempts + 1 >= ? THEN 'locked' ELSE status END,
               encrypted_payload = CASE WHEN attempts + 1 >= ? THEN NULL ELSE encrypted_payload END,
               iv = CASE WHEN attempts + 1 >= ? THEN NULL ELSE iv END,
               return_encrypted_payload = CASE WHEN attempts + 1 >= ? THEN NULL ELSE return_encrypted_payload END,
               return_iv = CASE WHEN attempts + 1 >= ? THEN NULL ELSE return_iv END
           WHERE id = ?
           RETURNING attempts, status`,
        )
        .bind(maxAttempts, maxAttempts, maxAttempts, maxAttempts, maxAttempts, id)
        .first<{ readonly attempts: number; readonly status: string }>();
      if (!row) return { status: 'not_found' };
      return row.status === 'locked' || row.attempts >= maxAttempts
        ? { status: 'locked', attempts: row.attempts }
        : { status: 'incremented', attempts: row.attempts };
    },

    async respondPairSession(params: PairRespondParams): Promise<PairRespondResult> {
      const updateRes = await db
        .prepare(
          `UPDATE pair_sessions
           SET status = 'responder_joined',
               responder_public_key = ?,
               responder_auth_state = ?,
               responder_masked_email = ?,
               responder_email_hash = ?,
               responder_token_hash = ?,
               direction = ?
           WHERE id = ? AND status = 'pending' AND host_public_key IS NOT NULL AND responder_token_hash IS NULL AND attempts < ? AND expires_at > ?`,
        )
        .bind(
          params.responderPublicKey,
          params.responderAuthState,
          params.responderMaskedEmail,
          params.responderEmailHash,
          params.responderTokenHash,
          params.direction,
          params.id,
          params.maxAttempts,
          params.nowIso,
        )
        .run();
      if ((updateRes.meta?.changes ?? 0) === 1) {
        return { status: 'responder_joined' };
      }
      const existing = await db
        .prepare('SELECT id, status, attempts, expires_at FROM pair_sessions WHERE id = ?')
        .bind(params.id)
        .first<{
          readonly id: string;
          readonly status: string;
          readonly attempts: number | null;
          readonly expires_at: string;
        }>();
      if (!existing) return { status: 'not_found' };
      if (existing.expires_at <= params.nowIso) {
        await db.prepare('DELETE FROM pair_sessions WHERE id = ?').bind(existing.id).run();
        return { status: 'expired' };
      }
      if (existing.status === 'locked' || Number(existing.attempts ?? 0) >= params.maxAttempts) {
        return { status: 'locked' };
      }
      return { status: 'already_responded' };
    },

    async transferPairSession(params: PairTransferParams): Promise<PairTransferResult> {
      const updated = await db
        .prepare(
          `UPDATE pair_sessions
           SET encrypted_payload = ?,
               iv = ?,
               direction = ?,
               status = CASE WHEN host_approved_at IS NOT NULL THEN 'completed' ELSE 'responder_transferred' END
           WHERE id = ?
             AND host_public_key IS NOT NULL
             AND (status = 'responder_joined' OR (status = 'approved' AND direction = 'responder_to_host'))
             AND encrypted_payload IS NULL
             AND return_encrypted_payload IS NULL
             AND attempts < ?
             AND expires_at > ?
           RETURNING status`,
        )
        .bind(
          params.encryptedPayload,
          params.iv,
          params.direction,
          params.id,
          params.maxAttempts,
          params.nowIso,
        )
        .first<{ readonly status: string }>();

      if (updated) {
        return {
          status: updated.status === 'completed' ? 'completed' : 'responder_transferred',
        };
      }

      const existing = await db
        .prepare(
          'SELECT id, status, attempts, expires_at, encrypted_payload FROM pair_sessions WHERE id = ?',
        )
        .bind(params.id)
        .first<{
          readonly id: string;
          readonly status: string;
          readonly attempts: number | null;
          readonly expires_at: string;
          readonly encrypted_payload: string | null;
        }>();
      if (!existing) return { status: 'not_found' };
      if (existing.expires_at <= params.nowIso) {
        await db.prepare('DELETE FROM pair_sessions WHERE id = ?').bind(existing.id).run();
        return { status: 'expired' };
      }
      if (existing.status === 'locked' || Number(existing.attempts ?? 0) >= params.maxAttempts) {
        return { status: 'locked' };
      }
      if (existing.status === 'responder_transferred' || existing.encrypted_payload !== null) {
        return { status: 'already_transferred' };
      }
      return { status: 'invalid_state' };
    },

    async approvePairSession(params: PairApproveParams): Promise<PairApproveResult> {
      if (params.reject) {
        const updateRes = await db
          .prepare(
            `UPDATE pair_sessions
             SET status = 'rejected',
                 direction = COALESCE(?, direction),
                 host_approved_at = NULL,
                 encrypted_payload = NULL,
                 iv = NULL,
                 return_encrypted_payload = NULL,
                 return_iv = NULL
             WHERE id = ?
               AND host_public_key IS NOT NULL
               AND status IN ('pending', 'responder_joined', 'approved', 'responder_transferred')
               AND attempts < ?
               AND expires_at > ?`,
          )
          .bind(params.direction, params.id, MAX_PAIR_ATTEMPTS, params.nowIso)
          .run();
        if ((updateRes.meta?.changes ?? 0) === 1) {
          return { status: 'rejected' };
        }
      } else if (params.returnEncryptedPayload !== null && params.returnIv !== null) {
        const updateRes = await db
          .prepare(
            `UPDATE pair_sessions
             SET status = 'approved',
                 direction = ?,
                 host_approved_at = ?,
                 encrypted_payload = NULL,
                 iv = NULL,
                 return_encrypted_payload = ?,
                 return_iv = ?
             WHERE id = ?
               AND host_public_key IS NOT NULL
               AND status IN ('responder_joined', 'responder_transferred')
               AND attempts < ?
               AND expires_at > ?`,
          )
          .bind(
            params.direction,
            params.hostApprovedAt,
            params.returnEncryptedPayload,
            params.returnIv,
            params.id,
            MAX_PAIR_ATTEMPTS,
            params.nowIso,
          )
          .run();
        if ((updateRes.meta?.changes ?? 0) === 1) {
          return { status: 'approved' };
        }
      } else if (params.direction === 'responder_to_host') {
        const updated = await db
          .prepare(
            `UPDATE pair_sessions
             SET status = CASE
                   WHEN status = 'responder_transferred' AND encrypted_payload IS NOT NULL AND iv IS NOT NULL
                   THEN 'completed'
                   ELSE 'approved'
                 END,
                 direction = ?,
                 host_approved_at = ?
             WHERE id = ?
               AND host_public_key IS NOT NULL
               AND status IN ('responder_joined', 'responder_transferred')
               AND attempts < ?
               AND expires_at > ?
             RETURNING status`,
          )
          .bind(
            params.direction,
            params.hostApprovedAt,
            params.id,
            MAX_PAIR_ATTEMPTS,
            params.nowIso,
          )
          .first<{ readonly status: string }>();
        if (updated) {
          return { status: updated.status === 'completed' ? 'completed' : 'approved' };
        }
      } else {
        const updateRes = await db
          .prepare(
            `UPDATE pair_sessions
             SET status = 'approved',
                 direction = ?,
                 host_approved_at = ?,
                 encrypted_payload = NULL,
                 iv = NULL,
                 return_encrypted_payload = NULL,
                 return_iv = NULL
             WHERE id = ?
               AND host_public_key IS NOT NULL
               AND status IN ('responder_joined', 'responder_transferred')
               AND attempts < ?
               AND expires_at > ?`,
          )
          .bind(
            params.direction,
            params.hostApprovedAt,
            params.id,
            MAX_PAIR_ATTEMPTS,
            params.nowIso,
          )
          .run();
        if ((updateRes.meta?.changes ?? 0) === 1) {
          return { status: 'approved' };
        }
      }

      const existing = await db
        .prepare('SELECT id, status, attempts, expires_at FROM pair_sessions WHERE id = ?')
        .bind(params.id)
        .first<{
          readonly id: string;
          readonly status: string;
          readonly attempts: number | null;
          readonly expires_at: string;
        }>();
      if (!existing) return { status: 'not_found' };
      if (existing.expires_at <= params.nowIso) {
        await db.prepare('DELETE FROM pair_sessions WHERE id = ?').bind(existing.id).run();
        return { status: 'expired' };
      }
      if (existing.status === 'locked' || Number(existing.attempts ?? 0) >= MAX_PAIR_ATTEMPTS) {
        return { status: 'locked' };
      }
      if (!params.reject && existing.status === 'pending') return { status: 'not_responded' };
      return { status: 'invalid_state' };
    },

    async cancelPairSession(id: string, nowIso: string): Promise<PairCancelResult> {
      const updateRes = await db
        .prepare(
          `UPDATE pair_sessions
           SET status = 'rejected',
               host_approved_at = NULL,
               encrypted_payload = NULL,
               iv = NULL,
               return_encrypted_payload = NULL,
               return_iv = NULL
           WHERE id = ?
             AND (
               status IN ('pending', 'responder_joined', 'approved', 'responder_transferred', 'rejected')
               OR (status = 'completed' AND (encrypted_payload IS NOT NULL OR return_encrypted_payload IS NOT NULL))
             )
             AND attempts < ?
             AND expires_at > ?`,
        )
        .bind(id, MAX_PAIR_ATTEMPTS, nowIso)
        .run();
      if ((updateRes.meta?.changes ?? 0) === 1) {
        return { status: 'rejected' };
      }

      const existing = await db
        .prepare('SELECT id, status, attempts, expires_at FROM pair_sessions WHERE id = ?')
        .bind(id)
        .first<{
          readonly id: string;
          readonly status: string;
          readonly attempts: number | null;
          readonly expires_at: string;
        }>();
      if (!existing) return { status: 'not_found' };
      if (existing.expires_at <= nowIso) {
        await db.prepare('DELETE FROM pair_sessions WHERE id = ?').bind(existing.id).run();
        return { status: 'expired' };
      }
      if (existing.status === 'locked' || Number(existing.attempts ?? 0) >= MAX_PAIR_ATTEMPTS) {
        return { status: 'locked' };
      }
      return { status: 'invalid_state' };
    },

    async consumeHostPairPayload(id: string): Promise<PairConsumeResult> {
      const row = await db
        .prepare(
          `SELECT encrypted_payload, iv
           FROM pair_sessions
           WHERE id = ?
             AND host_approved_at IS NOT NULL
             AND status IN ('approved', 'responder_transferred', 'completed')
             AND encrypted_payload IS NOT NULL
             AND iv IS NOT NULL`,
        )
        .bind(id)
        .first<{ readonly encrypted_payload: string; readonly iv: string }>();
      if (!row) return { status: 'not_claimed' };
      const res = await db
        .prepare(
          `UPDATE pair_sessions
           SET encrypted_payload = NULL, iv = NULL, status = 'completed'
           WHERE id = ?
             AND host_approved_at IS NOT NULL
             AND status IN ('approved', 'responder_transferred', 'completed')
             AND encrypted_payload = ?
             AND iv = ?`,
        )
        .bind(id, row.encrypted_payload, row.iv)
        .run();
      if ((res.meta?.changes ?? 0) !== 1) return { status: 'not_claimed' };
      return { status: 'consumed', encryptedPayload: row.encrypted_payload, iv: row.iv };
    },

    async consumeResponderPairPayload(id: string): Promise<PairConsumeResult> {
      const row = await db
        .prepare(
          `SELECT return_encrypted_payload, return_iv
           FROM pair_sessions
           WHERE id = ?
             AND host_approved_at IS NOT NULL
             AND status = 'approved'
             AND return_encrypted_payload IS NOT NULL
             AND return_iv IS NOT NULL`,
        )
        .bind(id)
        .first<{ readonly return_encrypted_payload: string; readonly return_iv: string }>();
      if (!row) return { status: 'not_claimed' };
      const res = await db
        .prepare(
          `UPDATE pair_sessions
           SET return_encrypted_payload = NULL, return_iv = NULL, status = 'completed'
           WHERE id = ?
             AND host_approved_at IS NOT NULL
             AND status = 'approved'
             AND return_encrypted_payload = ?
             AND return_iv = ?`,
        )
        .bind(id, row.return_encrypted_payload, row.return_iv)
        .run();
      if ((res.meta?.changes ?? 0) !== 1) return { status: 'not_claimed' };
      return {
        status: 'consumed',
        encryptedPayload: row.return_encrypted_payload,
        iv: row.return_iv,
      };
    },

    async deletePairSession(id: string): Promise<void> {
      await db.prepare('DELETE FROM pair_sessions WHERE id = ?').bind(id).run();
    },
  };
}
