import {
  ACCOUNT_DELETION_HTML_HEADERS,
  renderAccountDeletionHtml,
} from './account-deletion-html.ts';
import {
  ACCESS_TOKEN_TTL_SEC,
  type AccessTokenClaims,
  assertValidJwtSecret,
  DEFAULT_VERIFIER_HASH_ITERATIONS,
  hashAuthVerifier,
  REFRESH_TOKEN_TTL_SEC,
  randomBase64Url,
  randomId,
  sha256Base64Url,
  signAccessToken,
  timingSafeEqualStrings,
  verifyAccessToken,
  verifyAuthVerifier,
} from './crypto.ts';
import { buildTelemetryDigest } from './digest.ts';
import { createPairRouteHandlers } from './pair-routes.ts';
import {
  createSlidingWindowRateLimiter,
  DEFAULT_RATE_LIMITS,
  extractClientIp,
  type RateLimitConfig,
  type SlidingWindowRateLimiter,
  type TrustProxyMode,
} from './rate-limit.ts';
import type { SyncServerStorage, UserRecord } from './storage.ts';
import {
  BODY_LIMITS,
  PayloadTooLargeError,
  readBoundedJson,
  readBoundedText,
  validateAccountDeletionInput,
  validateDeleteAccountInput,
  validateFeedbackInput,
  validateLoginInput,
  validateRefreshTokenInput,
  validateRegisterInput,
  validateTelemetryBatch,
  validateVaultPutInput,
} from './validation.ts';

/** Configuration for `createSyncApp`. */
export interface SyncAppConfig {
  readonly storage: SyncServerStorage;
  readonly jwtSecret: string;
  readonly adminToken?: string;
  readonly telemetryDisabled?: boolean;
  readonly publicOrigin?: string;
  readonly trustProxy?: TrustProxyMode;
  readonly now?: () => number;
  readonly verifierHashIterations?: number;
  readonly rateLimiter?: SlidingWindowRateLimiter;
  readonly rateLimits?: Partial<RateLimitConfig>;
}

/** Web-Standard Fetch handler interface shared across Cloudflare Workers and Node HTTP. */
export interface SyncApp {
  fetch(request: Request, meta?: { readonly clientIp?: string }): Promise<Response>;
}

const DUMMY_VERIFIER_SALT = 'AAAAAAAAAAAAAAAAAAAAAA';
const DUMMY_VERIFIER_HASH = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function extractBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/** Creates the Web-Standard HTTP application serving sync, pairing, telemetry, feedback, and admin digest routes. */
export function createSyncApp(config: SyncAppConfig): SyncApp {
  assertValidJwtSecret(config.jwtSecret);
  const storage = config.storage;
  const nowMs = config.now ?? (() => Date.now());
  const publicOrigin = config.publicOrigin ?? '*';
  const trustProxy: TrustProxyMode = config.trustProxy ?? 'none';
  const telemetryDisabled = config.telemetryDisabled ?? false;
  const adminToken = config.adminToken ?? '';
  const verifierIterations = config.verifierHashIterations ?? DEFAULT_VERIFIER_HASH_ITERATIONS;
  const limiter = config.rateLimiter ?? createSlidingWindowRateLimiter(nowMs);
  const limits: RateLimitConfig = {
    auth: config.rateLimits?.auth ?? DEFAULT_RATE_LIMITS.auth,
    pair: config.rateLimits?.pair ?? DEFAULT_RATE_LIMITS.pair,
    pairLookup: config.rateLimits?.pairLookup ?? DEFAULT_RATE_LIMITS.pairLookup,
    vault: config.rateLimits?.vault ?? DEFAULT_RATE_LIMITS.vault,
    telemetry: config.rateLimits?.telemetry ?? DEFAULT_RATE_LIMITS.telemetry,
    feedback: config.rateLimits?.feedback ?? DEFAULT_RATE_LIMITS.feedback,
    accountDeletion: config.rateLimits?.accountDeletion ?? DEFAULT_RATE_LIMITS.accountDeletion,
    admin: config.rateLimits?.admin ?? DEFAULT_RATE_LIMITS.admin,
  };

  function corsHeaders(): Record<string, string> {
    return {
      'Access-Control-Allow-Origin': publicOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers':
        'Content-Type, Authorization, X-Pair-Poll-Token, X-Pair-Responder-Token',
      'Access-Control-Max-Age': '86400',
    };
  }

  function jsonResponse(
    status: number,
    body: unknown,
    extraHeaders?: Readonly<Record<string, string>>,
  ): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        ...corsHeaders(),
        ...extraHeaders,
      },
    });
  }

  function htmlResponse(status: number, html: string): Response {
    return new Response(html, {
      status,
      headers: ACCOUNT_DELETION_HTML_HEADERS,
    });
  }

  function checkRateLimit(
    request: Request,
    bucket: keyof RateLimitConfig,
    directClientIp?: string,
  ): Response | null {
    const clientIp = extractClientIp(request, trustProxy, directClientIp);
    const decision = limiter.check(bucket, clientIp, limits[bucket]);
    if (decision.allowed) return null;
    return jsonResponse(
      429,
      { error: 'rate_limited', retryAfterSec: decision.retryAfterSec },
      { 'Retry-After': String(decision.retryAfterSec) },
    );
  }

  async function requireAuth(request: Request): Promise<AccessTokenClaims | null> {
    const token = extractBearerToken(request);
    if (!token) return null;
    return verifyAccessToken(token, config.jwtSecret, Math.floor(nowMs() / 1000));
  }

  async function requireActiveUser(request: Request): Promise<UserRecord | null> {
    const claims = await requireAuth(request);
    if (!claims) return null;
    return storage.findUserById(claims.sub);
  }

  async function issueRefreshToken(
    userId: string,
    familyId: string,
    currentMs: number,
  ): Promise<string> {
    const createdAt = new Date(currentMs).toISOString();
    const expiresAt = new Date(currentMs + REFRESH_TOKEN_TTL_SEC * 1000).toISOString();
    const rawRefreshToken = randomBase64Url(32);
    const tokenHash = await sha256Base64Url(rawRefreshToken);

    await storage.insertRefreshToken({
      id: randomId(),
      userId,
      familyId,
      tokenHash,
      replacedById: null,
      revokedAt: null,
      expiresAt,
      createdAt,
    });
    return rawRefreshToken;
  }

  async function issueSessionTokens(
    user: UserRecord,
    familyId: string,
    currentMs: number,
  ): Promise<{ readonly accessToken: string; readonly refreshToken: string }> {
    const refreshToken = await issueRefreshToken(user.id, familyId, currentMs);
    const accessToken = await signAccessToken(
      { sub: user.id, email: user.email },
      config.jwtSecret,
      Math.floor(currentMs / 1000),
      ACCESS_TOKEN_TTL_SEC,
    );
    return { accessToken, refreshToken };
  }

  function publicUser(user: UserRecord) {
    return { id: user.id, email: user.email, createdAt: user.createdAt };
  }

  async function handleRegister(request: Request, clientIp?: string): Promise<Response> {
    const limited = checkRateLimit(request, 'auth', clientIp);
    if (limited) return limited;

    const parsed = await readBoundedJson(request, BODY_LIMITS.auth);
    if (!parsed.ok) return jsonResponse(400, { error: parsed.error });
    const valid = validateRegisterInput(parsed.value);
    if (!valid.ok) return jsonResponse(400, { error: valid.error });

    const currentMs = nowMs();
    const nowIso = new Date(currentMs).toISOString();
    const hashed = await hashAuthVerifier(valid.value.authVerifier, verifierIterations);
    const user: UserRecord = {
      id: randomId(),
      email: valid.value.email,
      verifierHash: hashed.hash,
      verifierSalt: hashed.salt,
      verifierIterations: hashed.iterations,
      kdfSalt: valid.value.kdfSalt,
      kdfIterations: valid.value.kdfIterations,
      wrappedVaultKey: valid.value.wrappedVaultKey,
      recoveryWrappedVaultKey: valid.value.recoveryWrappedVaultKey,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const { created } = await storage.createUser(user);
    if (!created) return jsonResponse(409, { error: 'email_exists' });

    const tokens = await issueSessionTokens(user, randomId(), currentMs);
    return jsonResponse(201, {
      user: publicUser(user),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: ACCESS_TOKEN_TTL_SEC,
    });
  }

  async function handleLogin(request: Request, clientIp?: string): Promise<Response> {
    const limited = checkRateLimit(request, 'auth', clientIp);
    if (limited) return limited;

    const parsed = await readBoundedJson(request, BODY_LIMITS.auth);
    if (!parsed.ok) return jsonResponse(400, { error: parsed.error });
    const valid = validateLoginInput(parsed.value);
    if (!valid.ok) return jsonResponse(401, { error: 'invalid_credentials' });

    const user = await storage.findUserByEmail(valid.value.email);
    if (!user) {
      await verifyAuthVerifier(
        valid.value.authVerifier,
        DUMMY_VERIFIER_SALT,
        verifierIterations,
        DUMMY_VERIFIER_HASH,
      );
      return jsonResponse(401, { error: 'invalid_credentials' });
    }

    const ok = await verifyAuthVerifier(
      valid.value.authVerifier,
      user.verifierSalt,
      user.verifierIterations,
      user.verifierHash,
    );
    if (!ok) return jsonResponse(401, { error: 'invalid_credentials' });

    const tokens = await issueSessionTokens(user, randomId(), nowMs());
    return jsonResponse(200, {
      user: publicUser(user),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: ACCESS_TOKEN_TTL_SEC,
      vaultMeta: {
        kdfSalt: user.kdfSalt,
        kdfIterations: user.kdfIterations,
        wrappedVaultKey: user.wrappedVaultKey,
        recoveryWrappedVaultKey: user.recoveryWrappedVaultKey,
      },
    });
  }

  async function handleRefresh(request: Request, clientIp?: string): Promise<Response> {
    const limited = checkRateLimit(request, 'auth', clientIp);
    if (limited) return limited;

    const parsed = await readBoundedJson(request, BODY_LIMITS.auth);
    if (!parsed.ok) return jsonResponse(400, { error: parsed.error });
    const valid = validateRefreshTokenInput(parsed.value);
    if (!valid.ok) return jsonResponse(400, { error: valid.error });

    const currentMs = nowMs();
    const nowIso = new Date(currentMs).toISOString();
    const tokenHash = await sha256Base64Url(valid.value);
    const existing = await storage.findRefreshTokenByHash(tokenHash);
    if (!existing) return jsonResponse(401, { error: 'invalid_refresh_token' });

    if (existing.replacedById !== null || existing.revokedAt !== null) {
      await storage.revokeRefreshTokenFamily(existing.familyId, nowIso);
      return jsonResponse(401, { error: 'refresh_token_reused' });
    }

    if (existing.expiresAt <= nowIso) {
      await storage.revokeRefreshTokenByHash(tokenHash, nowIso);
      return jsonResponse(401, { error: 'refresh_token_expired' });
    }

    const user = await storage.findUserById(existing.userId);
    if (!user) {
      await storage.revokeRefreshTokenFamily(existing.familyId, nowIso);
      return jsonResponse(401, { error: 'invalid_refresh_token' });
    }

    const newRawRefresh = randomBase64Url(32);
    const newHash = await sha256Base64Url(newRawRefresh);
    const newExpiresAt = new Date(currentMs + REFRESH_TOKEN_TTL_SEC * 1000).toISOString();
    const rotated = await storage.rotateRefreshToken(
      existing.id,
      {
        id: randomId(),
        userId: user.id,
        familyId: existing.familyId,
        tokenHash: newHash,
        replacedById: null,
        revokedAt: null,
        expiresAt: newExpiresAt,
        createdAt: nowIso,
      },
      nowIso,
    );
    if (!rotated) {
      await storage.revokeRefreshTokenFamily(existing.familyId, nowIso);
      return jsonResponse(401, { error: 'refresh_token_reused' });
    }

    const accessToken = await signAccessToken(
      { sub: user.id, email: user.email },
      config.jwtSecret,
      Math.floor(currentMs / 1000),
      ACCESS_TOKEN_TTL_SEC,
    );
    return jsonResponse(200, {
      user: publicUser(user),
      accessToken,
      refreshToken: newRawRefresh,
      expiresIn: ACCESS_TOKEN_TTL_SEC,
    });
  }

  async function handleLogout(request: Request, clientIp?: string): Promise<Response> {
    const limited = checkRateLimit(request, 'auth', clientIp);
    if (limited) return limited;

    const parsed = await readBoundedJson(request, BODY_LIMITS.auth);
    if (!parsed.ok) return jsonResponse(400, { error: parsed.error });
    const valid = validateRefreshTokenInput(parsed.value);
    if (!valid.ok) return jsonResponse(400, { error: valid.error });

    const tokenHash = await sha256Base64Url(valid.value);
    await storage.revokeRefreshTokenByHash(tokenHash, new Date(nowMs()).toISOString());
    return jsonResponse(200, { ok: true });
  }

  async function handlePairToken(request: Request, clientIp?: string): Promise<Response> {
    const limited = checkRateLimit(request, 'auth', clientIp);
    if (limited) return limited;

    const user = await requireActiveUser(request);
    if (!user) return jsonResponse(401, { error: 'unauthorized' });

    const refreshToken = await issueRefreshToken(user.id, randomId(), nowMs());
    return jsonResponse(201, { refreshToken });
  }

  async function handleDeleteAccount(request: Request, clientIp?: string): Promise<Response> {
    const limited = checkRateLimit(request, 'auth', clientIp);
    if (limited) return limited;

    const user = await requireActiveUser(request);
    if (!user) return jsonResponse(401, { error: 'unauthorized' });

    const parsed = await readBoundedJson(request, BODY_LIMITS.auth);
    if (!parsed.ok) return jsonResponse(400, { error: parsed.error });
    const valid = validateDeleteAccountInput(parsed.value);
    if (!valid.ok) return jsonResponse(400, { error: valid.error });

    const verified = await verifyAuthVerifier(
      valid.value,
      user.verifierSalt,
      user.verifierIterations,
      user.verifierHash,
    );
    if (!verified) return jsonResponse(401, { error: 'invalid_credentials' });

    await storage.deleteUserAccount(user.id);
    return jsonResponse(200, { deleted: true });
  }

  const pairRoutes = createPairRouteHandlers({
    storage,
    nowMs,
    checkRateLimit,
    requireActiveUser,
    jsonResponse,
  });

  async function handleVaultGet(request: Request, clientIp?: string): Promise<Response> {
    const limited = checkRateLimit(request, 'vault', clientIp);
    if (limited) return limited;

    const user = await requireActiveUser(request);
    if (!user) return jsonResponse(401, { error: 'unauthorized' });

    const vault = await storage.getVault(user.id);
    if (!vault) {
      return jsonResponse(200, { revision: 0, ciphertext: null, iv: null, updatedAt: null });
    }
    return jsonResponse(200, {
      revision: vault.revision,
      ciphertext: vault.ciphertext,
      iv: vault.iv,
      updatedAt: vault.updatedAt,
    });
  }

  async function handleVaultPut(request: Request, clientIp?: string): Promise<Response> {
    const limited = checkRateLimit(request, 'vault', clientIp);
    if (limited) return limited;

    const user = await requireActiveUser(request);
    if (!user) return jsonResponse(401, { error: 'unauthorized' });

    const parsed = await readBoundedJson(request, BODY_LIMITS.vault);
    if (!parsed.ok) return jsonResponse(400, { error: parsed.error });
    const valid = validateVaultPutInput(parsed.value);
    if (!valid.ok) return jsonResponse(400, { error: valid.error });

    const updatedAt = new Date(nowMs()).toISOString();
    const res = await storage.putVault(
      user.id,
      valid.value.expectedRevision,
      valid.value.ciphertext,
      valid.value.iv,
      updatedAt,
    );
    if (!res.ok) {
      return jsonResponse(409, {
        error: 'revision_conflict',
        currentRevision: res.currentRevision,
      });
    }
    return jsonResponse(200, { revision: res.revision, updatedAt: res.updatedAt });
  }

  async function handleTelemetry(request: Request, clientIp?: string): Promise<Response> {
    const limited = checkRateLimit(request, 'telemetry', clientIp);
    if (limited) return limited;

    if (telemetryDisabled) {
      return jsonResponse(200, { accepted: 0, disabled: true });
    }

    const parsed = await readBoundedJson(request, BODY_LIMITS.telemetry);
    if (!parsed.ok) return jsonResponse(400, { error: parsed.error });

    const receivedAt = new Date(nowMs()).toISOString();
    const valid = validateTelemetryBatch(parsed.value, receivedAt);
    if (!valid.ok) {
      return jsonResponse(400, { error: 'invalid_telemetry_payload', detail: valid.error });
    }

    const records = valid.value.map((event) => ({
      id: randomId(),
      receivedAt,
      eventTs: event.eventTs,
      sessionId: event.sessionId,
      kind: event.kind,
      appVersion: event.appVersion,
      platform: event.platform,
      osVersion: event.osVersion,
      formFactor: event.formFactor,
      payloadJson: JSON.stringify(event.payload),
      deviceProfileJson: event.deviceProfileJson,
    }));
    await storage.insertTelemetryEvents(records);
    return jsonResponse(200, { accepted: records.length, disabled: false });
  }

  async function handleFeedback(request: Request, clientIp?: string): Promise<Response> {
    const limited = checkRateLimit(request, 'feedback', clientIp);
    if (limited) return limited;

    const parsed = await readBoundedJson(request, BODY_LIMITS.feedback);
    if (!parsed.ok) return jsonResponse(400, { error: parsed.error });
    const valid = validateFeedbackInput(parsed.value);
    if (!valid.ok) return jsonResponse(400, { error: valid.error });

    const id = randomId();
    await storage.insertFeedbackSubmission({
      id,
      receivedAt: new Date(nowMs()).toISOString(),
      category: valid.value.category,
      message: valid.value.message,
      appVersion: valid.value.appVersion,
      platform: valid.value.platform,
      locale: valid.value.locale,
      diagnosticsJson: valid.value.diagnosticsJson,
    });
    return jsonResponse(201, { id });
  }

  async function handleAdminDigest(
    request: Request,
    url: URL,
    clientIp?: string,
  ): Promise<Response> {
    const limited = checkRateLimit(request, 'admin', clientIp);
    if (limited) return limited;

    if (adminToken.length === 0) {
      return jsonResponse(503, { error: 'admin_not_configured' });
    }
    const provided = extractBearerToken(request);
    if (!provided || !(await timingSafeEqualStrings(provided, adminToken))) {
      return jsonResponse(401, { error: 'unauthorized' });
    }

    const rawSince = url.searchParams.get('since');
    let sinceIso: string | null = null;
    if (rawSince !== null && rawSince.trim().length > 0) {
      const parsedMs = Date.parse(rawSince);
      if (Number.isNaN(parsedMs) || Math.abs(parsedMs) > 8.64e15) {
        return jsonResponse(400, { error: 'invalid_since' });
      }
      sinceIso = new Date(parsedMs).toISOString();
    }

    const [events, feedback, pendingAccountDeletionRequests] = await Promise.all([
      storage.listTelemetryEvents(sinceIso),
      storage.listFeedbackSubmissions(sinceIso),
      storage.countAccountDeletionRequests(),
    ]);
    const report = buildTelemetryDigest(
      events,
      feedback,
      new Date(nowMs()).toISOString(),
      sinceIso,
      pendingAccountDeletionRequests,
    );
    return jsonResponse(200, report);
  }

  async function handleAccountDeletionPost(request: Request, clientIp?: string): Promise<Response> {
    const limited = checkRateLimit(request, 'accountDeletion', clientIp);
    if (limited) return limited;

    const rawBody = await readBoundedText(request, BODY_LIMITS.accountDeletion);
    const contentType = (request.headers.get('content-type') ?? '').toLowerCase();
    const accept = request.headers.get('accept') ?? '';
    const wantsJson =
      accept.includes('application/json') || contentType.includes('application/json');

    let parsedBody: unknown;
    if (contentType.includes('application/json')) {
      try {
        parsedBody = JSON.parse(rawBody) as unknown;
      } catch {
        return jsonResponse(400, { error: 'invalid_json' });
      }
    } else {
      const params = new URLSearchParams(rawBody);
      parsedBody = {
        email: params.get('email') ?? '',
        note: params.get('note') ?? undefined,
      };
    }

    const valid = validateAccountDeletionInput(parsedBody);
    if (!valid.ok) {
      return wantsJson
        ? jsonResponse(400, { error: valid.error })
        : htmlResponse(400, renderAccountDeletionHtml(false));
    }

    const emailHash = await sha256Base64Url(valid.value.email);
    await storage.insertAccountDeletionRequest({
      id: randomId(),
      emailHash,
      note: valid.value.note,
      createdAtMs: nowMs(),
    });

    if (accept.includes('application/json')) {
      return jsonResponse(200, {
        accepted: true,
        message:
          'If an account matches the submitted address, deletion instructions apply. Use Settings -> Account -> Delete Account inside ELV IPTV for instant permanent erasure.',
      });
    }
    return htmlResponse(200, renderAccountDeletionHtml(true));
  }

  return {
    async fetch(request: Request, meta?: { readonly clientIp?: string }): Promise<Response> {
      try {
        const clientIp = meta?.clientIp;
        const method = request.method.toUpperCase();
        if (method === 'OPTIONS') {
          return new Response(null, { status: 204, headers: corsHeaders() });
        }

        const url = new URL(request.url);
        const path = url.pathname;

        if (method === 'GET' && path === '/health') {
          return jsonResponse(200, { ok: true, service: 'elv-sync-server', version: '1.0.0' });
        }
        if (method === 'GET' && path === '/account-deletion') {
          return htmlResponse(200, renderAccountDeletionHtml(false));
        }
        if (method === 'POST' && path === '/account-deletion') {
          return await handleAccountDeletionPost(request, clientIp);
        }
        if (method === 'POST' && path === '/v1/auth/register') {
          return await handleRegister(request, clientIp);
        }
        if (method === 'POST' && path === '/v1/auth/login') {
          return await handleLogin(request, clientIp);
        }
        if (method === 'POST' && path === '/v1/auth/refresh') {
          return await handleRefresh(request, clientIp);
        }
        if (method === 'POST' && path === '/v1/auth/logout') {
          return await handleLogout(request, clientIp);
        }
        if (method === 'POST' && path === '/v1/auth/pair-token') {
          return await handlePairToken(request, clientIp);
        }
        if (method === 'DELETE' && path === '/v1/auth/account') {
          return await handleDeleteAccount(request, clientIp);
        }
        if (method === 'POST' && path === '/v1/pair/create') {
          return await pairRoutes.handlePairCreate(request, clientIp);
        }
        if (method === 'POST' && path === '/v1/pair/lookup') {
          return await pairRoutes.handlePairLookup(request, clientIp);
        }
        if (method === 'POST' && path === '/v1/pair/respond') {
          return await pairRoutes.handlePairRespond(request, clientIp);
        }
        if (method === 'POST' && path === '/v1/pair/transfer') {
          return await pairRoutes.handlePairTransfer(request, clientIp);
        }
        if (method === 'POST' && path === '/v1/pair/approve') {
          return await pairRoutes.handlePairApprove(request, clientIp);
        }
        if (method === 'POST' && path === '/v1/pair/cancel') {
          return await pairRoutes.handlePairCancel(request, clientIp);
        }
        if (method === 'POST' && path === '/v1/pair/claim') {
          return await pairRoutes.handlePairClaim(request, clientIp);
        }
        if (method === 'GET' && path.startsWith('/v1/pair/poll/')) {
          let pairingId: string;
          try {
            pairingId = decodeURIComponent(path.slice('/v1/pair/poll/'.length));
          } catch {
            return jsonResponse(400, { error: 'invalid_pairing_id' });
          }
          if (!pairingId || pairingId.includes('/')) {
            return jsonResponse(404, { error: 'not_found' });
          }
          return await pairRoutes.handlePairPoll(request, pairingId, clientIp);
        }
        if (method === 'GET' && path === '/v1/vault') {
          return await handleVaultGet(request, clientIp);
        }
        if (method === 'PUT' && path === '/v1/vault') {
          return await handleVaultPut(request, clientIp);
        }
        if (method === 'POST' && path === '/v1/telemetry') {
          return await handleTelemetry(request, clientIp);
        }
        if (method === 'POST' && path === '/v1/feedback') {
          return await handleFeedback(request, clientIp);
        }
        if (method === 'GET' && path === '/v1/admin/digest') {
          return await handleAdminDigest(request, url, clientIp);
        }

        return jsonResponse(404, { error: 'not_found' });
      } catch (error) {
        if (error instanceof PayloadTooLargeError) {
          return jsonResponse(413, { error: 'payload_too_large', maxBytes: error.maxBytes });
        }
        return jsonResponse(500, { error: 'internal_error' });
      }
    },
  };
}
