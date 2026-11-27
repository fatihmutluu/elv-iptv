import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createD1Storage } from './storage-d1.ts';
import type { D1Database, D1PreparedStatement, D1Result } from './storage-d1-types.ts';
import worker from './worker.ts';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const MIGRATION_0001_PATH = join(MIGRATIONS_DIR, '0001_init.sql');
const MIGRATION_0002_PATH = join(MIGRATIONS_DIR, '0002_wave_p9_pairing_telemetry.sql');
const MIGRATION_0003_PATH = join(MIGRATIONS_DIR, '0003_wave_e1_elv_metadata.sql');

interface SchemaMap {
  readonly tables: Map<string, Set<string>>;
}

function parseMigrationSchema(sqlFiles: readonly string[]): SchemaMap {
  const tables = new Map<string, Set<string>>();
  const combined = sqlFiles.join('\n');

  const createRe = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\);/gi;
  let match = createRe.exec(combined);
  while (match !== null) {
    const tableName = match[1] ?? '';
    const body = match[2] ?? '';
    const cols = tables.get(tableName) ?? new Set<string>();
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('--')) continue;
      const colMatch = /^(\w+)\s+(?:TEXT|INTEGER|REAL|BLOB)/i.exec(line);
      if (colMatch?.[1]) cols.add(colMatch[1]);
    }
    tables.set(tableName, cols);
    match = createRe.exec(combined);
  }

  const alterRe = /ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)\s+(?:TEXT|INTEGER|REAL|BLOB)/gi;
  let alterMatch = alterRe.exec(combined);
  while (alterMatch !== null) {
    const tableName = alterMatch[1] ?? '';
    const colName = alterMatch[2] ?? '';
    const cols = tables.get(tableName);
    if (cols && colName) cols.add(colName);
    alterMatch = alterRe.exec(combined);
  }

  return { tables };
}

function assertSqlMatchesSchema(sql: string, schema: SchemaMap): void {
  const normalized = sql.replace(/\s+/g, ' ').trim();
  const tableMatch = /(?:FROM|INTO|UPDATE)\s+(\w+)/i.exec(normalized);
  expect(tableMatch?.[1], `SQL must reference a known table: ${normalized}`).toBeTruthy();
  const tableName = tableMatch?.[1] ?? '';
  const columns = schema.tables.get(tableName);
  expect(columns, `Unknown table "${tableName}" in SQL: ${normalized}`).toBeDefined();
  if (!columns) return;

  const insertCols = /INSERT(?:\s+OR\s+IGNORE)?\s+INTO\s+\w+\s*\(([^)]+)\)/i.exec(normalized);
  if (insertCols?.[1]) {
    for (const col of insertCols[1].split(',').map((c) => c.trim())) {
      expect(columns.has(col), `Unknown INSERT column ${tableName}.${col}`).toBe(true);
    }
  }

  const selectCols = /^SELECT\s+(.+?)\s+FROM\s+\w+/i.exec(normalized);
  if (selectCols?.[1] && selectCols[1] !== '*') {
    for (const col of selectCols[1].split(',').map((c) => c.trim())) {
      if (/^COUNT\(\*\)(?:\s+AS\s+\w+)?$/i.test(col)) continue;
      expect(columns.has(col), `Unknown SELECT column ${tableName}.${col}`).toBe(true);
    }
  }

  const returningCols = /RETURNING\s+(.+)$/i.exec(normalized);
  if (returningCols?.[1]) {
    for (const col of returningCols[1].split(',').map((c) => c.trim())) {
      expect(columns.has(col), `Unknown RETURNING column ${tableName}.${col}`).toBe(true);
    }
  }
}

function createSqliteBackedD1(
  migrationSqlFiles: readonly string[],
  schema: SchemaMap,
): { db: D1Database; sqlite: DatabaseSync; executedSql: string[] } {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  for (const sql of migrationSqlFiles) {
    sqlite.exec(sql);
  }
  const executedSql: string[] = [];

  function toSqlParams(values: readonly unknown[]): SQLInputValue[] {
    return values.map((v) => {
      if (v === undefined || v === null) return null;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') return v;
      if (v instanceof Uint8Array) return v;
      return String(v);
    });
  }

  const stmtIsSelect = new WeakMap<D1PreparedStatement, boolean>();

  function makeStatement(query: string, bound: unknown[] = []): D1PreparedStatement {
    const stmt: D1PreparedStatement = {
      bind(...values: unknown[]) {
        return makeStatement(query, values);
      },
      async first<T>() {
        assertSqlMatchesSchema(query, schema);
        executedSql.push(query.replace(/\s+/g, ' ').trim());
        const compiled = sqlite.prepare(query);
        const row = compiled.get(...toSqlParams(bound));
        return (row ? { ...row } : null) as T | null;
      },
      async all<T>() {
        assertSqlMatchesSchema(query, schema);
        executedSql.push(query.replace(/\s+/g, ' ').trim());
        const compiled = sqlite.prepare(query);
        const rows = compiled.all(...toSqlParams(bound)).map((r) => ({ ...r })) as T[];
        return { success: true, results: rows, meta: { changes: 0 } };
      },
      async run() {
        assertSqlMatchesSchema(query, schema);
        executedSql.push(query.replace(/\s+/g, ' ').trim());
        const compiled = sqlite.prepare(query);
        const res = compiled.run(...toSqlParams(bound));
        return { success: true, meta: { changes: Number(res.changes) } };
      },
    };
    stmtIsSelect.set(stmt, /^\s*SELECT\b/i.test(query));
    return stmt;
  }

  const db: D1Database = {
    prepare(query: string) {
      return makeStatement(query);
    },
    async batch<T>(statements: readonly D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const results: D1Result<T>[] = [];
      for (const stmt of statements) {
        const res = stmtIsSelect.get(stmt) ? await stmt.all<T>() : await stmt.run();
        results.push(res as D1Result<T>);
      }
      return results;
    },
  };

  return { db, sqlite, executedSql };
}

const EMPTY_V2_PAIR_FIELDS = {
  attempts: 0,
  hostPublicKey: null,
  responderPublicKey: null,
  hostAuthState: 'signed_out' as const,
  hostMaskedEmail: null,
  hostEmailHash: null,
  responderAuthState: null,
  responderMaskedEmail: null,
  responderEmailHash: null,
  responderTokenHash: null,
  direction: null,
  hostApprovedAt: null,
  returnEncryptedPayload: null,
  returnIv: null,
};

describe('Cloudflare D1 storage adapter & worker entry (migrations 0001 + 0002 + 0003)', () => {
  const migration0001 = readFileSync(MIGRATION_0001_PATH, 'utf8');
  const migration0002 = readFileSync(MIGRATION_0002_PATH, 'utf8');
  const migration0003 = readFileSync(MIGRATION_0003_PATH, 'utf8');
  const migrationFiles = [migration0001, migration0002, migration0003];
  const schema = parseMigrationSchema(migrationFiles);

  it('applies 0001, 0002, and 0003_wave_e1_elv_metadata.sql cleanly on SQLite', () => {
    expect([...schema.tables.keys()].sort()).toEqual([
      'account_deletion_requests',
      'elv_feeds_cache',
      'elv_localized_synopses',
      'elv_title_cache',
      'elv_title_match_index',
      'feedback_submissions',
      'pair_sessions',
      'refresh_tokens',
      'telemetry_events',
      'users',
      'vaults',
    ]);

    const { sqlite } = createSqliteBackedD1(migrationFiles, schema);
    const pairCols = (
      sqlite.prepare('PRAGMA table_info(pair_sessions)').all() as Array<{ name: string }>
    ).map((r) => r.name);
    for (const col of [
      'status',
      'attempts',
      'host_public_key',
      'responder_public_key',
      'host_auth_state',
      'host_masked_email',
      'host_email_hash',
      'responder_auth_state',
      'responder_masked_email',
      'responder_email_hash',
      'responder_token_hash',
      'direction',
      'host_approved_at',
      'return_encrypted_payload',
      'return_iv',
    ]) {
      expect(pairCols).toContain(col);
    }

    const telemetryCols = (
      sqlite.prepare('PRAGMA table_info(telemetry_events)').all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(telemetryCols).toContain('device_profile_json');
    sqlite.close();
  });

  it('executes all legacy and Wave P9 D1 storage operations cleanly against real SQLite', async () => {
    const { db, sqlite, executedSql } = createSqliteBackedD1(migrationFiles, schema);
    const storage = createD1Storage(db);

    const user = {
      id: 'user-1',
      email: 'd1@example.com',
      verifierHash: 'hash1',
      verifierSalt: 'salt1',
      verifierIterations: 100_000,
      kdfSalt: 'kdf1',
      kdfIterations: 210_000,
      wrappedVaultKey: 'wk1',
      recoveryWrappedVaultKey: 'rwk1',
      createdAt: '2026-11-25T10:00:00.000Z',
      updatedAt: '2026-11-25T10:00:00.000Z',
    };
    expect(await storage.createUser(user)).toEqual({ created: true });
    expect(await storage.createUser(user)).toEqual({ created: false });
    expect(await storage.findUserByEmail('d1@example.com')).toEqual(user);
    expect(await storage.findUserById('user-1')).toEqual(user);

    // Refresh tokens: insert, find, rotate, race fail, revoke by hash & family
    const rt1 = {
      id: 'rt-1',
      userId: 'user-1',
      familyId: 'fam-1',
      tokenHash: 'th-1',
      replacedById: null,
      revokedAt: null,
      expiresAt: '2026-12-25T10:00:00.000Z',
      createdAt: '2026-11-25T10:00:00.000Z',
    };
    await storage.insertRefreshToken(rt1);
    expect(await storage.findRefreshTokenByHash('th-1')).toEqual(rt1);

    const rt2 = { ...rt1, id: 'rt-2', tokenHash: 'th-2' };
    expect(await storage.rotateRefreshToken('rt-1', rt2, '2026-11-25T10:05:00.000Z')).toBe(true);
    expect(await storage.rotateRefreshToken('rt-1', rt2, '2026-11-25T10:06:00.000Z')).toBe(false);
    await storage.revokeRefreshTokenByHash('th-2', '2026-11-25T10:07:00.000Z');
    await storage.revokeRefreshTokenFamily('fam-1', '2026-11-25T10:08:00.000Z');

    // Vaults: empty -> rev 1 -> conflict -> rev 2
    expect(await storage.getVault('user-1')).toBeNull();
    expect(await storage.putVault('user-1', 0, 'ct1', 'iv1', '2026-11-25T10:00:00.000Z')).toEqual({
      ok: true,
      revision: 1,
      updatedAt: '2026-11-25T10:00:00.000Z',
    });
    expect(
      await storage.putVault('user-1', 0, 'ct-stale', 'iv1', '2026-11-25T10:01:00.000Z'),
    ).toEqual({
      ok: false,
      conflict: true,
      currentRevision: 1,
    });
    expect(await storage.putVault('user-1', 1, 'ct2', 'iv2', '2026-11-25T10:02:00.000Z')).toEqual({
      ok: true,
      revision: 2,
      updatedAt: '2026-11-25T10:02:00.000Z',
    });
    expect((await storage.getVault('user-1'))?.ciphertext).toBe('ct2');

    // Legacy pair sessions: create, find, claim, already_claimed, consume, replay, expired, delete
    await storage.createPairSession({
      id: 'pair-1',
      code: 'legacy-code-hash-1',
      pollTokenHash: 'pth-1',
      status: 'pending',
      claimedByUserId: null,
      encryptedPayload: null,
      iv: null,
      ...EMPTY_V2_PAIR_FIELDS,
      expiresAt: '2026-11-25T10:15:00.000Z',
      createdAt: '2026-11-25T10:10:00.000Z',
    });
    expect((await storage.findPairSessionById('pair-1'))?.code).toBe('legacy-code-hash-1');
    expect((await storage.findPairSessionByCode('legacy-code-hash-1'))?.id).toBe('pair-1');
    expect(
      await storage.claimPairSession(
        'NONEXISTENT1',
        'user-1',
        'enc',
        'iv',
        '2026-11-25T10:11:00.000Z',
      ),
    ).toEqual({ status: 'not_found' });
    expect(
      await storage.claimPairSession(
        'legacy-code-hash-1',
        'user-1',
        'enc-payload',
        'iv-pair',
        '2026-11-25T10:11:00.000Z',
      ),
    ).toEqual({ status: 'claimed' });
    expect(
      await storage.claimPairSession(
        'legacy-code-hash-1',
        'user-1',
        'enc-payload',
        'iv-pair',
        '2026-11-25T10:11:00.000Z',
      ),
    ).toEqual({ status: 'already_claimed' });
    expect(await storage.consumeClaimedPairSession('pair-1')).toEqual({
      status: 'consumed',
      encryptedPayload: 'enc-payload',
      iv: 'iv-pair',
    });
    expect(await storage.consumeClaimedPairSession('pair-1')).toEqual({ status: 'not_claimed' });

    // Wave P9 bidirectional pairing D1 operations: respond, anti-hijack, approve, burn-after-read, lockout
    await storage.createPairSession({
      id: 'pair-v2-r2h',
      code: 'v2-hash-r2h',
      pollTokenHash: 'pth-v2-1',
      status: 'pending',
      claimedByUserId: null,
      encryptedPayload: null,
      iv: null,
      ...EMPTY_V2_PAIR_FIELDS,
      hostPublicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE',
      hostAuthState: 'signed_out',
      expiresAt: '2026-11-25T10:20:00.000Z',
      createdAt: '2026-11-25T10:15:00.000Z',
    });

    // Legacy claimPairSession MUST NOT hijack a v2 session (host_public_key IS NOT NULL)
    expect(
      await storage.claimPairSession(
        'v2-hash-r2h',
        'user-1',
        'hijack-enc',
        'hijack-iv',
        '2026-11-25T10:16:00.000Z',
      ),
    ).toEqual({ status: 'not_found' });

    // Approve before responder joins -> not_responded
    expect(
      await storage.approvePairSession({
        id: 'pair-v2-r2h',
        direction: 'responder_to_host',
        hostApprovedAt: 1_764_065_760_000,
        returnEncryptedPayload: null,
        returnIv: null,
        reject: false,
        nowIso: '2026-11-25T10:16:00.000Z',
      }),
    ).toEqual({ status: 'not_responded' });

    // Phase 1: First responder joins atomically (no payload pre-SAS)
    expect(
      await storage.respondPairSession({
        id: 'pair-v2-r2h',
        responderPublicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAI',
        responderAuthState: 'signed_in',
        responderMaskedEmail: 'b***@example.com',
        responderEmailHash: 'b'.repeat(64),
        responderTokenHash: 'rth-1',
        direction: 'responder_to_host',
        maxAttempts: 3,
        nowIso: '2026-11-25T10:16:00.000Z',
      }),
    ).toEqual({ status: 'responder_joined' });

    // Second responder rejected atomically
    expect(
      await storage.respondPairSession({
        id: 'pair-v2-r2h',
        responderPublicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM',
        responderAuthState: 'signed_in',
        responderMaskedEmail: 'e***@evil.test',
        responderEmailHash: 'e'.repeat(64),
        responderTokenHash: 'rth-evil',
        direction: 'responder_to_host',
        maxAttempts: 3,
        nowIso: '2026-11-25T10:16:01.000Z',
      }),
    ).toEqual({ status: 'already_responded' });

    // Phase 2: Responder transfers ciphertext post-SAS -> responder_transferred
    expect(
      await storage.transferPairSession({
        id: 'pair-v2-r2h',
        direction: 'responder_to_host',
        encryptedPayload: 'd1-r2h-ciphertext-0123456',
        iv: 'd1-r2h-iv-123456',
        maxAttempts: 3,
        nowIso: '2026-11-25T10:16:05.000Z',
      }),
    ).toEqual({ status: 'responder_transferred' });

    // Host cannot consume before approving SAS
    expect(await storage.consumeHostPairPayload('pair-v2-r2h')).toEqual({ status: 'not_claimed' });

    // Host approves -> status becomes completed, atomic burn-after-read delivers once and wipes
    expect(
      await storage.approvePairSession({
        id: 'pair-v2-r2h',
        direction: 'responder_to_host',
        hostApprovedAt: 1_764_065_770_000,
        returnEncryptedPayload: null,
        returnIv: null,
        reject: false,
        nowIso: '2026-11-25T10:16:10.000Z',
      }),
    ).toEqual({ status: 'completed' });
    expect(await storage.consumeHostPairPayload('pair-v2-r2h')).toEqual({
      status: 'consumed',
      encryptedPayload: 'd1-r2h-ciphertext-0123456',
      iv: 'd1-r2h-iv-123456',
    });
    expect(await storage.consumeHostPairPayload('pair-v2-r2h')).toEqual({ status: 'not_claimed' });

    // Wave P9 host_to_responder return payload burn-after-read
    await storage.createPairSession({
      id: 'pair-v2-h2r',
      code: 'v2-hash-h2r',
      pollTokenHash: 'pth-v2-2',
      status: 'pending',
      claimedByUserId: null,
      encryptedPayload: null,
      iv: null,
      ...EMPTY_V2_PAIR_FIELDS,
      hostPublicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE',
      hostAuthState: 'signed_in',
      hostMaskedEmail: 'a***@example.com',
      hostEmailHash: 'a'.repeat(64),
      expiresAt: '2026-11-25T10:20:00.000Z',
      createdAt: '2026-11-25T10:15:00.000Z',
    });
    expect(
      await storage.respondPairSession({
        id: 'pair-v2-h2r',
        responderPublicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAI',
        responderAuthState: 'signed_out',
        responderMaskedEmail: null,
        responderEmailHash: null,
        responderTokenHash: 'rth-2',
        direction: 'host_to_responder',
        maxAttempts: 3,
        nowIso: '2026-11-25T10:16:00.000Z',
      }),
    ).toEqual({ status: 'responder_joined' });
    expect(
      await storage.approvePairSession({
        id: 'pair-v2-h2r',
        direction: 'host_to_responder',
        hostApprovedAt: 1_764_065_780_000,
        returnEncryptedPayload: 'd1-h2r-return-ct-0123456',
        returnIv: 'd1-h2r-iv-123456',
        reject: false,
        nowIso: '2026-11-25T10:16:20.000Z',
      }),
    ).toEqual({ status: 'approved' });
    expect(await storage.consumeResponderPairPayload('pair-v2-h2r')).toEqual({
      status: 'consumed',
      encryptedPayload: 'd1-h2r-return-ct-0123456',
      iv: 'd1-h2r-iv-123456',
    });
    expect(await storage.consumeResponderPairPayload('pair-v2-h2r')).toEqual({
      status: 'not_claimed',
    });

    // Cancel wipes payloads in D1
    await storage.createPairSession({
      id: 'pair-v2-cancel',
      code: 'v2-hash-cancel',
      pollTokenHash: 'pth-v2-cancel',
      status: 'pending',
      claimedByUserId: null,
      encryptedPayload: null,
      iv: null,
      ...EMPTY_V2_PAIR_FIELDS,
      hostPublicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE',
      expiresAt: '2026-11-25T10:20:00.000Z',
      createdAt: '2026-11-25T10:15:00.000Z',
    });
    expect(await storage.cancelPairSession('pair-v2-cancel', '2026-11-25T10:16:00.000Z')).toEqual({
      status: 'rejected',
    });
    expect((await storage.findPairSessionById('pair-v2-cancel'))?.status).toBe('rejected');

    // 3-attempt lockout in D1 (legacy session returns locked on claim; v2 session returns locked on respond)
    await storage.createPairSession({
      id: 'pair-legacy-lock',
      code: 'legacy-hash-lock',
      pollTokenHash: 'pth-legacy-3',
      status: 'pending',
      claimedByUserId: null,
      encryptedPayload: null,
      iv: null,
      ...EMPTY_V2_PAIR_FIELDS,
      expiresAt: '2026-11-25T10:20:00.000Z',
      createdAt: '2026-11-25T10:15:00.000Z',
    });
    expect(await storage.incrementPairAttempts('pair-legacy-lock', 3)).toEqual({
      status: 'incremented',
      attempts: 1,
    });
    expect(await storage.incrementPairAttempts('pair-legacy-lock', 3)).toEqual({
      status: 'incremented',
      attempts: 2,
    });
    expect(await storage.incrementPairAttempts('pair-legacy-lock', 3)).toEqual({
      status: 'locked',
      attempts: 3,
    });
    expect((await storage.findPairSessionById('pair-legacy-lock'))?.status).toBe('locked');
    expect(
      await storage.claimPairSession(
        'legacy-hash-lock',
        'user-1',
        'enc',
        'iv',
        '2026-11-25T10:16:00.000Z',
      ),
    ).toEqual({ status: 'locked' });

    // Expired session & opportunistic prune on createPairSession
    await storage.createPairSession({
      id: 'pair-exp',
      code: 'EXPIRED12345',
      pollTokenHash: 'pth-exp',
      status: 'pending',
      claimedByUserId: null,
      encryptedPayload: null,
      iv: null,
      ...EMPTY_V2_PAIR_FIELDS,
      expiresAt: '2026-11-25T10:00:00.000Z',
      createdAt: '2026-11-25T09:55:00.000Z',
    });
    expect(
      await storage.claimPairSession(
        'EXPIRED12345',
        'user-1',
        'enc',
        'iv',
        '2026-11-25T10:05:00.000Z',
      ),
    ).toEqual({ status: 'expired' });
    await storage.createPairSession({
      id: 'pair-exp-prune',
      code: 'EXPIRED_PRUNE',
      pollTokenHash: 'pth-exp2',
      status: 'pending',
      claimedByUserId: null,
      encryptedPayload: null,
      iv: null,
      ...EMPTY_V2_PAIR_FIELDS,
      expiresAt: '2026-11-25T10:18:00.000Z',
      createdAt: '2026-11-25T10:13:00.000Z',
    });
    await storage.createPairSession({
      id: 'pair-fresh',
      code: 'FRESH_12345',
      pollTokenHash: 'pth-fresh',
      status: 'pending',
      claimedByUserId: null,
      encryptedPayload: null,
      iv: null,
      ...EMPTY_V2_PAIR_FIELDS,
      expiresAt: '2026-11-25T10:25:00.000Z',
      createdAt: '2026-11-25T10:20:00.000Z',
    });
    expect(await storage.findPairSessionById('pair-exp-prune')).toBeNull();
    expect(await storage.findPairSessionById('pair-fresh')).not.toBeNull();
    await storage.deletePairSession('pair-fresh');

    // Telemetry (with device_profile_json) & feedback
    const profileJson = JSON.stringify({
      arch: 'arm64',
      ramBucket: '2gb',
      gpu: 'Apple A15',
      resolution: '3840x2160',
      locale: 'en-US',
    });
    await storage.insertTelemetryEvents([
      {
        id: 'tel-1',
        receivedAt: '2026-11-25T11:00:00.000Z',
        eventTs: '2026-11-25T10:59:55.000Z',
        sessionId: 'sess-d1',
        kind: 'startup',
        appVersion: '1.4.0',
        platform: 'tvos',
        osVersion: '18.1',
        formFactor: 'tv',
        payloadJson: '{"durationMs":300}',
        deviceProfileJson: profileJson,
      },
    ]);
    const loadedEvents = await storage.listTelemetryEvents(null);
    expect(loadedEvents).toHaveLength(1);
    expect(loadedEvents[0]?.deviceProfileJson).toBe(profileJson);
    expect(await storage.listTelemetryEvents('2026-11-25T12:00:00.000Z')).toHaveLength(0);

    await storage.insertFeedbackSubmission({
      id: 'fb-1',
      receivedAt: '2026-11-25T11:05:00.000Z',
      category: 'ui_remote',
      message: 'D-pad focus jumps cleanly',
      appVersion: '1.4.0',
      platform: 'tvos',
      locale: 'en',
      diagnosticsJson: null,
    });
    expect(await storage.listFeedbackSubmissions(null)).toHaveLength(1);
    expect(await storage.listFeedbackSubmissions('2026-11-25T12:00:00.000Z')).toHaveLength(0);

    // Verify explicit D1 query LIMIT clauses
    expect(
      executedSql.some((s) => s.includes('FROM telemetry_events') && s.includes('LIMIT 5000')),
    ).toBe(true);
    expect(
      executedSql.some((s) => s.includes('FROM feedback_submissions') && s.includes('LIMIT 500')),
    ).toBe(true);

    // Account deletion requests persistence & counting
    expect(await storage.countAccountDeletionRequests()).toBe(0);
    await storage.insertAccountDeletionRequest({
      id: 'del-1',
      emailHash: 'hashed_email_base64url',
      note: 'Please remove my account',
      createdAtMs: 1_764_070_000_000,
    });
    expect(await storage.countAccountDeletionRequests()).toBe(1);

    // Atomic account deletion cascades all user rows
    expect(await storage.deleteUserAccount('user-1')).toBe(true);
    expect(await storage.findUserById('user-1')).toBeNull();
    expect(await storage.getVault('user-1')).toBeNull();
    expect(executedSql.length).toBeGreaterThan(25);
    sqlite.close();
  });

  it('wires Cloudflare Worker entry fetch() cleanly and fails closed if JWT_SECRET is missing', async () => {
    const { db, sqlite } = createSqliteBackedD1(migrationFiles, schema);

    const misconfigured = await worker.fetch(new Request('https://sync.example.test/health'), {
      DB: db,
      JWT_SECRET: '',
    });
    expect(misconfigured.status).toBe(503);

    const ok = await worker.fetch(new Request('https://sync.example.test/health'), {
      DB: db,
      JWT_SECRET: 'worker-secret-key-at-least-32-chars-long',
      ADMIN_TOKEN: 'worker-admin-token',
      TELEMETRY_DISABLED: 'false',
      PUBLIC_ORIGIN: 'https://elviptv.example',
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://elviptv.example');

    // Wave E1 D1 ELV metadata round-trip + Workers AI binding integration
    const storage = createD1Storage(db);
    await storage.upsertElvTitle({
      imdbId: 'tt1375666',
      mediaType: 'movie',
      originalTitle: 'Inception',
      englishTitle: 'Inception',
      year: 2010,
      rating: 8.8,
      votes: 2_500_000,
      runtimeMin: 148,
      genres: ['Action', 'Sci-Fi'],
      posterUrl: 'https://m.media-amazon.com/images/M/MV5INC._V1_QL75_UX300_.jpg',
      backdropUrl: 'https://m.media-amazon.com/images/M/MV5INCBG._V1_QL75_UX1280_.jpg',
      trailerStreamUrl: null,
      trailerYoutubeId: null,
      director: 'Christopher Nolan',
      cast: [
        { personId: 'nm0000138', name: 'Leonardo DiCaprio', character: 'Cobb', portraitUrl: null },
      ],
      mltImdbIds: ['tt0816692'],
      franchiseKey: null,
      franchiseName: null,
      franchiseOrder: null,
      originalSynopsis: 'A thief steals secrets through shared dreaming.',
      updatedAt: Date.now(),
    });
    expect((await storage.getElvTitle('tt1375666'))?.originalTitle).toBe('Inception');
    expect((await storage.getElvTitlesByIds(['tt1375666'])).size).toBe(1);

    const bulkMatches = Array.from({ length: 65 }, (_, i) => ({
      lookupKey: `movie:film ${i}:2020`,
      mediaType: 'movie' as const,
      year: 2020,
      imdbId: `tt${String(1000000 + i)}`,
      confidence: 0.95,
      updatedAt: 1_764_212_100_000,
    }));
    await storage.upsertElvMatches(bulkMatches);
    const loadedMatches = await storage.getElvMatchesByKeys(bulkMatches.map((m) => m.lookupKey));
    expect(loadedMatches.size).toBe(65);

    await storage.upsertElvLocalizedSynopsis({
      imdbId: 'tt1375666',
      lang: 'tr',
      localizedTitle: 'Başlangıç',
      synopsis: 'Rüyalardan sır çalan bir hırsızın hikayesi.',
      source: 'workers_ai',
      updatedAt: 1_764_212_100_000,
    });
    expect((await storage.getElvLocalizedSynopsis('tt1375666', 'tr'))?.localizedTitle).toBe(
      'Başlangıç',
    );
    expect((await storage.getElvLocalizedSynopsesByIds(['tt1375666'], 'tr')).size).toBe(1);

    await storage.upsertElvFeed(
      'moviemeter',
      [
        {
          imdbId: 'tt1375666',
          title: 'Inception',
          mediaType: 'movie',
          year: 2010,
          rating: 8.8,
          posterUrl: null,
          genres: ['Sci-Fi'],
          rank: 1,
        },
      ],
      1_764_212_100_000,
    );
    expect((await storage.getElvFeed('moviemeter'))?.items).toHaveLength(1);

    // Worker entry passes AI binding cleanly to /v1/elv/title/:imdbId
    let aiCalls = 0;
    const trWorkerRes = await worker.fetch(
      new Request('https://sync.example.test/v1/elv/title/tt1375666?lang=de'),
      {
        DB: db,
        JWT_SECRET: 'worker-secret-key-at-least-32-chars-long',
        AI: {
          run: async () => {
            aiCalls += 1;
            return { response: 'Ein Dieb stiehlt Geheimnisse durch gemeinsame Träume.' };
          },
        },
      },
    );
    expect(trWorkerRes.status).toBe(200);
    expect(aiCalls).toBe(1);
    const deBody = (await trWorkerRes.json()) as { synopsis: string; synopsisSource: string };
    expect(deBody.synopsis).toBe('Ein Dieb stiehlt Geheimnisse durch gemeinsame Träume.');
    expect(deBody.synopsisSource).toBe('workers_ai');
    sqlite.close();
  });
});
