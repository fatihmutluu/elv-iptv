import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createD1Storage,
  type D1Database,
  type D1PreparedStatement,
  type D1Result,
} from './storage-d1.ts';
import worker from './worker.ts';

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
  '0001_init.sql',
);

interface SchemaMap {
  readonly tables: Map<string, Set<string>>;
}

function parseMigrationSchema(sql: string): SchemaMap {
  const tables = new Map<string, Set<string>>();
  const createRe = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\);/gi;
  let match = createRe.exec(sql);
  while (match !== null) {
    const tableName = match[1] ?? '';
    const body = match[2] ?? '';
    const cols = new Set<string>();
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('--')) continue;
      const colMatch = /^(\w+)\s+(?:TEXT|INTEGER|REAL|BLOB)/i.exec(line);
      if (colMatch?.[1]) cols.add(colMatch[1]);
    }
    tables.set(tableName, cols);
    match = createRe.exec(sql);
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

  // Verify explicit INSERT column lists
  const insertCols = /INSERT(?:\s+OR\s+IGNORE)?\s+INTO\s+\w+\s*\(([^)]+)\)/i.exec(normalized);
  if (insertCols?.[1]) {
    for (const col of insertCols[1].split(',').map((c) => c.trim())) {
      expect(columns.has(col), `Unknown INSERT column ${tableName}.${col}`).toBe(true);
    }
  }

  // Verify SELECT column lists
  const selectCols = /^SELECT\s+(.+?)\s+FROM\s+\w+/i.exec(normalized);
  if (selectCols?.[1] && selectCols[1] !== '*') {
    for (const col of selectCols[1].split(',').map((c) => c.trim())) {
      if (/^COUNT\(\*\)(?:\s+AS\s+\w+)?$/i.test(col)) continue;
      expect(columns.has(col), `Unknown SELECT column ${tableName}.${col}`).toBe(true);
    }
  }

  // Verify RETURNING column lists
  const returningCols = /RETURNING\s+(.+)$/i.exec(normalized);
  if (returningCols?.[1]) {
    for (const col of returningCols[1].split(',').map((c) => c.trim())) {
      expect(columns.has(col), `Unknown RETURNING column ${tableName}.${col}`).toBe(true);
    }
  }
}

interface MockD1State {
  users: Record<string, Record<string, unknown>>;
  refresh_tokens: Record<string, Record<string, unknown>>;
  vaults: Record<string, Record<string, unknown>>;
  pair_sessions: Record<string, Record<string, unknown>>;
  telemetry_events: Record<string, unknown>[];
  feedback_submissions: Record<string, unknown>[];
  account_deletion_requests: Record<string, unknown>[];
  executedSql: string[];
}

function createMockD1(schema: SchemaMap): { db: D1Database; state: MockD1State } {
  const state: MockD1State = {
    users: {},
    refresh_tokens: {},
    vaults: {},
    pair_sessions: {},
    telemetry_events: [],
    feedback_submissions: [],
    account_deletion_requests: [],
    executedSql: [],
  };

  function execute(
    sql: string,
    params: unknown[],
  ): { rows: Record<string, unknown>[]; changes: number } {
    assertSqlMatchesSchema(sql, schema);
    const norm = sql.replace(/\s+/g, ' ').trim();
    state.executedSql.push(norm);

    if (norm.startsWith('INSERT OR IGNORE INTO users')) {
      const email = String(params[1]);
      if (Object.values(state.users).some((u) => u.email === email)) {
        return { rows: [], changes: 0 };
      }
      const id = String(params[0]);
      state.users[id] = {
        id,
        email,
        verifier_hash: params[2],
        verifier_salt: params[3],
        verifier_iterations: params[4],
        kdf_salt: params[5],
        kdf_iterations: params[6],
        wrapped_vault_key: params[7],
        recovery_wrapped_vault_key: params[8],
        created_at: params[9],
        updated_at: params[10],
      };
      return { rows: [], changes: 1 };
    }
    if (norm.startsWith('SELECT') && norm.includes('FROM users WHERE email = ?')) {
      const found = Object.values(state.users).find((u) => u.email === params[0]);
      return { rows: found ? [found] : [], changes: 0 };
    }
    if (norm.startsWith('SELECT') && norm.includes('FROM users WHERE id = ?')) {
      const found = state.users[String(params[0])];
      return { rows: found ? [found] : [], changes: 0 };
    }
    if (norm === 'DELETE FROM refresh_tokens WHERE user_id = ?') {
      let changes = 0;
      for (const [id, row] of Object.entries(state.refresh_tokens)) {
        if (row.user_id === params[0]) {
          delete state.refresh_tokens[id];
          changes += 1;
        }
      }
      return { rows: [], changes };
    }
    if (norm === 'DELETE FROM vaults WHERE user_id = ?') {
      const existed = String(params[0]) in state.vaults;
      delete state.vaults[String(params[0])];
      return { rows: [], changes: existed ? 1 : 0 };
    }
    if (norm === 'DELETE FROM pair_sessions WHERE claimed_by_user_id = ?') {
      let changes = 0;
      for (const [id, row] of Object.entries(state.pair_sessions)) {
        if (row.claimed_by_user_id === params[0]) {
          delete state.pair_sessions[id];
          changes += 1;
        }
      }
      return { rows: [], changes };
    }
    if (norm === 'DELETE FROM users WHERE id = ?') {
      const existed = String(params[0]) in state.users;
      delete state.users[String(params[0])];
      return { rows: [], changes: existed ? 1 : 0 };
    }
    if (norm.startsWith('INSERT INTO refresh_tokens')) {
      const id = String(params[0]);
      state.refresh_tokens[id] = {
        id,
        user_id: params[1],
        family_id: params[2],
        token_hash: params[3],
        replaced_by_id: params[4],
        revoked_at: params[5],
        expires_at: params[6],
        created_at: params[7],
      };
      return { rows: [], changes: 1 };
    }
    if (norm.includes('FROM refresh_tokens WHERE token_hash = ?')) {
      const found = Object.values(state.refresh_tokens).find((r) => r.token_hash === params[0]);
      return { rows: found ? [found] : [], changes: 0 };
    }
    if (norm.startsWith('UPDATE refresh_tokens SET replaced_by_id = ?')) {
      const row = state.refresh_tokens[String(params[2])];
      if (!row || row.replaced_by_id !== null || row.revoked_at !== null) {
        return { rows: [], changes: 0 };
      }
      row.replaced_by_id = params[0];
      row.revoked_at = params[1];
      return { rows: [], changes: 1 };
    }
    if (norm.includes('UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ?')) {
      let changes = 0;
      for (const row of Object.values(state.refresh_tokens)) {
        if (row.token_hash === params[1] && row.revoked_at === null) {
          row.revoked_at = params[0];
          changes += 1;
        }
      }
      return { rows: [], changes };
    }
    if (norm.includes('UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ?')) {
      let changes = 0;
      for (const row of Object.values(state.refresh_tokens)) {
        if (row.family_id === params[1] && row.revoked_at === null) {
          row.revoked_at = params[0];
          changes += 1;
        }
      }
      return { rows: [], changes };
    }
    if (norm.startsWith('SELECT') && norm.includes('FROM vaults WHERE user_id = ?')) {
      const row = state.vaults[String(params[0])];
      return { rows: row ? [row] : [], changes: 0 };
    }
    if (norm.startsWith('INSERT OR IGNORE INTO vaults')) {
      const uid = String(params[0]);
      if (uid in state.vaults) return { rows: [], changes: 0 };
      state.vaults[uid] = {
        user_id: uid,
        revision: 1,
        ciphertext: params[1],
        iv: params[2],
        updated_at: params[3],
      };
      return { rows: [], changes: 1 };
    }
    if (norm.startsWith('UPDATE vaults SET revision = ?')) {
      const uid = String(params[4]);
      const row = state.vaults[uid];
      if (!row || row.revision !== params[5]) return { rows: [], changes: 0 };
      row.revision = params[0];
      row.ciphertext = params[1];
      row.iv = params[2];
      row.updated_at = params[3];
      return { rows: [], changes: 1 };
    }
    if (norm.startsWith('INSERT INTO pair_sessions')) {
      const id = String(params[0]);
      state.pair_sessions[id] = {
        id,
        code: params[1],
        poll_token_hash: params[2],
        status: params[3],
        claimed_by_user_id: params[4],
        encrypted_payload: params[5],
        iv: params[6],
        expires_at: params[7],
        created_at: params[8],
      };
      return { rows: [], changes: 1 };
    }
    if (norm.startsWith('SELECT') && norm.includes('FROM pair_sessions WHERE id = ?')) {
      const row = state.pair_sessions[String(params[0])];
      return { rows: row ? [row] : [], changes: 0 };
    }
    if (norm.startsWith('SELECT') && norm.includes('FROM pair_sessions WHERE code = ?')) {
      const row = Object.values(state.pair_sessions).find((p) => p.code === params[0]);
      return { rows: row ? [row] : [], changes: 0 };
    }
    if (norm.startsWith("UPDATE pair_sessions SET status = 'claimed'")) {
      const row = state.pair_sessions[String(params[3])];
      if (row?.status !== 'pending' || String(row.expires_at) <= String(params[4])) {
        return { rows: [], changes: 0 };
      }
      row.status = 'claimed';
      row.claimed_by_user_id = params[0];
      row.encrypted_payload = params[1];
      row.iv = params[2];
      return { rows: [], changes: 1 };
    }
    if (norm.includes("DELETE FROM pair_sessions WHERE id = ? AND status = 'claimed' RETURNING")) {
      const id = String(params[0]);
      const row = state.pair_sessions[id];
      if (row?.status !== 'claimed') return { rows: [], changes: 0 };
      delete state.pair_sessions[id];
      return {
        rows: [{ encrypted_payload: row.encrypted_payload, iv: row.iv }],
        changes: 1,
      };
    }
    if (norm === 'DELETE FROM pair_sessions WHERE id = ?') {
      const id = String(params[0]);
      const existed = id in state.pair_sessions;
      delete state.pair_sessions[id];
      return { rows: [], changes: existed ? 1 : 0 };
    }
    if (norm.startsWith('INSERT INTO telemetry_events')) {
      state.telemetry_events.push({
        id: params[0],
        received_at: params[1],
        event_ts: params[2],
        session_id: params[3],
        kind: params[4],
        app_version: params[5],
        platform: params[6],
        os_version: params[7],
        form_factor: params[8],
        payload_json: params[9],
      });
      return { rows: [], changes: 1 };
    }
    if (norm.includes('FROM telemetry_events')) {
      const since = params[0] ? String(params[0]) : null;
      const limitMatch = /\bLIMIT\s+(\d+)\b/i.exec(norm);
      const limit = limitMatch?.[1] ? Number(limitMatch[1]) : Number.POSITIVE_INFINITY;
      const rows = (
        since
          ? state.telemetry_events.filter((e) => String(e.received_at) >= since)
          : [...state.telemetry_events]
      ).slice(0, limit);
      return { rows, changes: 0 };
    }
    if (norm.startsWith('INSERT INTO feedback_submissions')) {
      state.feedback_submissions.push({
        id: params[0],
        received_at: params[1],
        category: params[2],
        message: params[3],
        app_version: params[4],
        platform: params[5],
        locale: params[6],
        diagnostics_json: params[7],
      });
      return { rows: [], changes: 1 };
    }
    if (norm.includes('FROM feedback_submissions')) {
      const since = params[0] ? String(params[0]) : null;
      const limitMatch = /\bLIMIT\s+(\d+)\b/i.exec(norm);
      const limit = limitMatch?.[1] ? Number(limitMatch[1]) : Number.POSITIVE_INFINITY;
      const rows = (
        since
          ? state.feedback_submissions.filter((f) => String(f.received_at) >= since)
          : [...state.feedback_submissions]
      ).slice(0, limit);
      return { rows, changes: 0 };
    }
    if (norm.startsWith('INSERT INTO account_deletion_requests')) {
      state.account_deletion_requests.push({
        id: params[0],
        email_hash: params[1],
        note: params[2],
        created_at_ms: params[3],
      });
      return { rows: [], changes: 1 };
    }
    if (norm.includes('FROM account_deletion_requests')) {
      return { rows: [{ count: state.account_deletion_requests.length }], changes: 0 };
    }
    throw new Error(`Unhandled mock D1 SQL: ${norm}`);
  }

  function makeStatement(
    query: string,
    bound: unknown[] = [],
  ): D1PreparedStatement & {
    readonly _runSync: () => { rows: Record<string, unknown>[]; changes: number };
  } {
    return {
      bind(...values: unknown[]) {
        return makeStatement(query, values);
      },
      async first<T>() {
        const res = execute(query, bound);
        return (res.rows[0] as T | undefined) ?? null;
      },
      async all<T>() {
        const res = execute(query, bound);
        return { success: true, results: res.rows as T[], meta: { changes: res.changes } };
      },
      async run() {
        const res = execute(query, bound);
        return { success: true, meta: { changes: res.changes } };
      },
      _runSync() {
        return execute(query, bound);
      },
    };
  }

  const db: D1Database = {
    prepare(query: string) {
      return makeStatement(query);
    },
    async batch<T>(statements: readonly D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const results: D1Result<T>[] = [];
      for (const stmt of statements) {
        const res = await stmt.run();
        results.push(res as D1Result<T>);
      }
      return results;
    },
  };

  return { db, state };
}

describe('Cloudflare D1 storage adapter & worker entry', () => {
  const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');
  const schema = parseMigrationSchema(migrationSql);

  it('defines all seven required tables in migrations/0001_init.sql', () => {
    expect([...schema.tables.keys()].sort()).toEqual([
      'account_deletion_requests',
      'feedback_submissions',
      'pair_sessions',
      'refresh_tokens',
      'telemetry_events',
      'users',
      'vaults',
    ]);
  });

  it('executes every D1 storage operation matching migrations/0001_init.sql', async () => {
    const { db, state } = createMockD1(schema);
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

    // Pair sessions: create, find, claim, already_claimed, consume, replay, expired, delete
    await storage.createPairSession({
      id: 'pair-1',
      code: 'ABCDEFGH2345',
      pollTokenHash: 'pth-1',
      status: 'pending',
      claimedByUserId: null,
      encryptedPayload: null,
      iv: null,
      expiresAt: '2026-11-25T10:15:00.000Z',
      createdAt: '2026-11-25T10:10:00.000Z',
    });
    expect((await storage.findPairSessionById('pair-1'))?.code).toBe('ABCDEFGH2345');
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
        'ABCDEFGH2345',
        'user-1',
        'enc-payload',
        'iv-pair',
        '2026-11-25T10:11:00.000Z',
      ),
    ).toEqual({ status: 'claimed' });
    expect(
      await storage.claimPairSession(
        'ABCDEFGH2345',
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

    await storage.createPairSession({
      id: 'pair-exp',
      code: 'EXPIRED12345',
      pollTokenHash: 'pth-exp',
      status: 'pending',
      claimedByUserId: null,
      encryptedPayload: null,
      iv: null,
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
    await storage.deletePairSession('pair-exp');

    // Telemetry & feedback
    await storage.insertTelemetryEvents([
      {
        id: 'tel-1',
        receivedAt: '2026-11-25T11:00:00.000Z',
        eventTs: '2026-11-25T10:59:55.000Z',
        sessionId: 'sess-d1',
        kind: 'startup',
        appVersion: '1.0.0',
        platform: 'tvos',
        osVersion: '18.1',
        formFactor: 'tv',
        payloadJson: '{"durationMs":300}',
      },
    ]);
    expect(await storage.listTelemetryEvents(null)).toHaveLength(1);
    expect(await storage.listTelemetryEvents('2026-11-25T12:00:00.000Z')).toHaveLength(0);

    await storage.insertFeedbackSubmission({
      id: 'fb-1',
      receivedAt: '2026-11-25T11:05:00.000Z',
      category: 'ui_remote',
      message: 'D-pad focus jumps cleanly',
      appVersion: '1.0.0',
      platform: 'tvos',
      locale: 'en',
      diagnosticsJson: null,
    });
    expect(await storage.listFeedbackSubmissions(null)).toHaveLength(1);
    expect(await storage.listFeedbackSubmissions('2026-11-25T12:00:00.000Z')).toHaveLength(0);

    // Verify explicit D1 query LIMIT clauses
    expect(
      state.executedSql.some(
        (s) => s.includes('FROM telemetry_events') && s.includes('LIMIT 5000'),
      ),
    ).toBe(true);
    expect(
      state.executedSql.some(
        (s) => s.includes('FROM feedback_submissions') && s.includes('LIMIT 500'),
      ),
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
    expect(Object.keys(state.refresh_tokens)).toHaveLength(0);
    expect(state.executedSql.length).toBeGreaterThan(20);
  });

  it('wires Cloudflare Worker entry fetch() cleanly and fails closed if JWT_SECRET is missing', async () => {
    const { db } = createMockD1(schema);

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
  });
});
