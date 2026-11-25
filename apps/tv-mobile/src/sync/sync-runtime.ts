import { normalizeSyncServerUrl } from '@elv/domain';
import {
  base64UrlDecode,
  base64UrlEncode,
  createEmptyVaultSnapshot,
  createPureJsVaultCryptoPort,
  createQrPairingClient,
  createSyncAuthClient,
  createTelemetryQueue,
  createTelemetryUploader,
  mergeVaultSnapshots,
  parsePairingQrUri,
  type QrPairingSession,
  type SyncClockPort,
  type SyncSession,
  submitFeedback,
  type TelemetryUploader,
  type VaultSnapshot,
} from '@elv/sync';
import {
  type CreateTvMobileSyncPortsOptions,
  createFetchHttpPort,
  DEFAULT_FLUSH_INTERVAL_MS,
  defaultCsprngBytes,
  errorCodeFrom,
  FEEDBACK_LOG_TAIL_LINES,
  type FeedbackPort,
  type FeedbackSubmitInput,
  generateSessionId,
  type PersistedSessionRecord,
  parsePersistedSession,
  redactDiagnosticsLine,
  SESSION_SECRET_KEY,
  SIGNED_OUT_STATE,
  type SyncAccountPort,
  type SyncAccountState,
  type SyncActionResult,
  type SyncFetchFn,
  type SyncQrPairingSession,
  type TelemetryMediaDecodeFailure,
  type TelemetryPort,
  type TvMobileSyncPorts,
  VAULT_KEY_BYTES,
} from './sync-helpers';

export type {
  CreateTvMobileSyncPortsOptions,
  FeedbackPort,
  SyncAccountPort,
  SyncFetchFn,
  TelemetryPort,
  TvMobileSyncPorts,
};

/**
 * Creates mobile & TV Wave F9 runtime ports (`SyncAccountPort`, `TelemetryPort`, `FeedbackPort`)
 * using `@elv/sync` pure-JS crypto (100% Hermes-compatible), encrypted `SecretStore` session
 * persistence, strict zero-traffic opt-out telemetry, and redacted diagnostics feedback (`#26`, `#458`).
 */
export function createTvMobileSyncPorts(
  options: CreateTvMobileSyncPortsOptions,
): TvMobileSyncPorts {
  const randomBytes = options.randomBytes ?? defaultCsprngBytes;
  const clock: SyncClockPort = options.clock ?? { now: () => Date.now() };
  const cryptoPort = createPureJsVaultCryptoPort(randomBytes);
  const fetchFn: SyncFetchFn =
    options.fetchFn ??
    ((input, init) =>
      globalThis.fetch(input, {
        ...(init?.method !== undefined ? { method: init.method } : {}),
        ...(init?.headers !== undefined ? { headers: { ...init.headers } } : {}),
        ...(init?.body !== undefined ? { body: init.body } : {}),
        ...(init?.signal !== undefined ? { signal: init.signal } : {}),
      }));
  const http = createFetchHttpPort(fetchFn);

  const resolveBaseUrl = (): string => {
    const fromPref = options.getPreferences?.()?.syncServerUrl;
    const raw =
      typeof fromPref === 'string' && fromPref.trim().length > 0
        ? fromPref
        : options.getServerUrl();
    return normalizeSyncServerUrl(raw, '');
  };

  let state: SyncAccountState = SIGNED_OUT_STATE;
  const listeners = new Set<(next: SyncAccountState) => void>();
  let activeSession: SyncSession | null = null;
  let lastRevision = 0;
  let localSnapshot: VaultSnapshot = createEmptyVaultSnapshot(0);
  const qrSessions = new Map<string, QrPairingSession>();

  const setState = (next: SyncAccountState): void => {
    state = Object.freeze({ ...next });
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch {
        // Isolate subscriber failures.
      }
    }
  };

  const persistSession = async (
    session: SyncSession,
    lastSyncedAtIso: string | null,
    revision: number,
  ): Promise<void> => {
    const record: PersistedSessionRecord = {
      userId: session.user.id,
      email: session.user.email,
      refreshToken: session.refreshToken,
      vaultKeyB64: base64UrlEncode(session.vaultKey),
      lastSyncedAtIso,
      lastRevision: revision,
    };
    await options.secretStore.set(SESSION_SECRET_KEY, JSON.stringify(record));
  };

  const clearLocalSession = async (): Promise<void> => {
    activeSession = null;
    lastRevision = 0;
    qrSessions.clear();
    await options.secretStore.delete(SESSION_SECRET_KEY).catch(() => undefined);
    setState(SIGNED_OUT_STATE);
  };

  const makeAuthClient = (baseUrl: string) =>
    createSyncAuthClient({
      baseUrl,
      http,
      crypto: cryptoPort,
      ...(options.kdfIterations !== undefined ? { kdfIterations: options.kdfIterations } : {}),
    });

  const makeQrClient = (baseUrl: string) =>
    createQrPairingClient({ baseUrl, http, crypto: cryptoPort });

  const ensureAccessToken = async (
    baseUrl: string,
    forceRefresh = false,
  ): Promise<SyncSession | null> => {
    if (activeSession === null) return null;
    if (!forceRefresh && activeSession.accessToken.length > 0) return activeSession;
    const refreshed = await makeAuthClient(baseUrl).refresh(activeSession.refreshToken);
    if (!refreshed.ok) return null;
    const updated: SyncSession = {
      ...activeSession,
      user: refreshed.value.user ?? activeSession.user,
      accessToken: refreshed.value.accessToken,
      refreshToken: refreshed.value.refreshToken,
    };
    activeSession = updated;
    await persistSession(updated, state.lastSyncedAtIso, lastRevision);
    return updated;
  };

  let hydrated = false;
  const hydrate = async (): Promise<void> => {
    if (hydrated) return;
    hydrated = true;
    const raw = await options.secretStore.get(SESSION_SECRET_KEY).catch(() => undefined);
    const persisted = parsePersistedSession(raw);
    if (persisted === null || activeSession !== null) return;
    activeSession = {
      user: { id: persisted.userId, email: persisted.email },
      accessToken: '',
      refreshToken: persisted.refreshToken,
      vaultKey: base64UrlDecode(persisted.vaultKeyB64),
    };
    lastRevision = persisted.lastRevision;
    setState({
      status: 'signed_in',
      email: persisted.email,
      lastSyncedAtIso: persisted.lastSyncedAtIso,
      pendingRecoveryCode: null,
      errorCode: null,
    });
  };

  const syncAccount: SyncAccountPort = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async signIn(email, password): Promise<SyncActionResult> {
      const baseUrl = resolveBaseUrl();
      if (baseUrl.length === 0) {
        setState({ ...state, errorCode: 'server_not_configured' });
        return { ok: false, errorCode: 'server_not_configured' };
      }
      setState({ ...state, status: 'signing_in', errorCode: null });
      const res = await makeAuthClient(baseUrl).login(email, password);
      if (!res.ok) {
        const code = errorCodeFrom(res.error);
        setState({ ...SIGNED_OUT_STATE, errorCode: code });
        return { ok: false, errorCode: code };
      }
      activeSession = res.value;
      lastRevision = 0;
      await persistSession(res.value, null, 0);
      setState({
        status: 'signed_in',
        email: res.value.user.email,
        lastSyncedAtIso: null,
        pendingRecoveryCode: null,
        errorCode: null,
      });
      return { ok: true };
    },

    async register(email, password, confirmPassword): Promise<SyncActionResult> {
      const baseUrl = resolveBaseUrl();
      if (baseUrl.length === 0) {
        setState({ ...state, errorCode: 'server_not_configured' });
        return { ok: false, errorCode: 'server_not_configured' };
      }
      setState({ ...state, status: 'signing_in', errorCode: null });
      const res = await makeAuthClient(baseUrl).register(email, password, confirmPassword);
      if (!res.ok) {
        const code = errorCodeFrom(res.error);
        setState({ ...SIGNED_OUT_STATE, errorCode: code });
        return { ok: false, errorCode: code };
      }
      activeSession = res.value.session;
      lastRevision = 0;
      await persistSession(res.value.session, null, 0);
      setState({
        status: 'signed_in',
        email: res.value.session.user.email,
        lastSyncedAtIso: null,
        pendingRecoveryCode: res.value.recoveryCode,
        errorCode: null,
      });
      return { ok: true, recoveryCode: res.value.recoveryCode };
    },

    acknowledgeRecoveryCode(): void {
      if (state.pendingRecoveryCode === null) return;
      setState({ ...state, pendingRecoveryCode: null });
    },

    async syncNow(): Promise<SyncActionResult> {
      const baseUrl = resolveBaseUrl();
      if (baseUrl.length === 0) return { ok: false, errorCode: 'server_not_configured' };
      if (activeSession === null) return { ok: false, errorCode: 'not_signed_in' };

      setState({ ...state, status: 'syncing', errorCode: null });
      const client = makeAuthClient(baseUrl);
      let session = await ensureAccessToken(baseUrl);
      if (session === null) {
        setState({ ...state, status: 'signed_in', errorCode: 'session_expired' });
        return { ok: false, errorCode: 'session_expired' };
      }

      let pullRes = await client.pullVault(session);
      if (!pullRes.ok && pullRes.error.code === 'auth') {
        session = await ensureAccessToken(baseUrl, true);
        if (session !== null) pullRes = await client.pullVault(session);
      }
      if (!pullRes.ok || session === null) {
        const code = pullRes.ok ? 'session_expired' : errorCodeFrom(pullRes.error);
        setState({ ...state, status: 'signed_in', errorCode: code });
        return { ok: false, errorCode: code };
      }

      const currentLocal = options.getLocalSnapshot
        ? await options.getLocalSnapshot()
        : localSnapshot;
      let merged =
        pullRes.value.snapshot !== null
          ? mergeVaultSnapshots(currentLocal, pullRes.value.snapshot)
          : currentLocal;
      let pushRes = await client.pushVault(session, pullRes.value.revision, merged);

      if (pushRes.ok && pushRes.value.status === 'conflict') {
        const retryPull = await client.pullVault(session);
        if (!retryPull.ok) {
          const code = errorCodeFrom(retryPull.error);
          setState({ ...state, status: 'signed_in', errorCode: code });
          return { ok: false, errorCode: code };
        }
        merged =
          retryPull.value.snapshot !== null
            ? mergeVaultSnapshots(merged, retryPull.value.snapshot)
            : merged;
        pushRes = await client.pushVault(session, retryPull.value.revision, merged);
      }

      if (!pushRes.ok || pushRes.value.status !== 'ok') {
        const code = pushRes.ok ? 'sync_conflict' : errorCodeFrom(pushRes.error);
        setState({ ...state, status: 'signed_in', errorCode: code });
        return { ok: false, errorCode: code };
      }

      localSnapshot = merged;
      await options.applyMergedSnapshot?.(merged);
      lastRevision = pushRes.value.revision;
      const syncedIso = new Date(clock.now()).toISOString();
      await persistSession(session, syncedIso, lastRevision);
      setState({ ...state, status: 'signed_in', lastSyncedAtIso: syncedIso, errorCode: null });
      return { ok: true };
    },

    async signOut(): Promise<void> {
      const baseUrl = resolveBaseUrl();
      if (baseUrl.length > 0 && activeSession !== null) {
        await makeAuthClient(baseUrl)
          .logout(activeSession.refreshToken, activeSession.accessToken)
          .catch(() => undefined);
      }
      await clearLocalSession();
    },

    async deleteAccount(password): Promise<SyncActionResult> {
      const baseUrl = resolveBaseUrl();
      if (baseUrl.length === 0) return { ok: false, errorCode: 'server_not_configured' };
      if (activeSession === null) return { ok: false, errorCode: 'not_signed_in' };

      const client = makeAuthClient(baseUrl);
      let session = await ensureAccessToken(baseUrl);
      if (session === null) {
        setState({ ...state, errorCode: 'session_expired' });
        return { ok: false, errorCode: 'session_expired' };
      }
      let res = await client.deleteAccount(session.accessToken, session.user.email, password);
      if (!res.ok && res.error.code === 'auth' && res.error.detail === 'unauthorized') {
        session = await ensureAccessToken(baseUrl, true);
        if (session !== null) {
          res = await client.deleteAccount(session.accessToken, session.user.email, password);
        }
      }
      if (!res.ok) {
        const code = errorCodeFrom(res.error);
        setState({ ...state, errorCode: code });
        return { ok: false, errorCode: code };
      }
      await clearLocalSession();
      return { ok: true };
    },

    async createQrPairing(): Promise<SyncQrPairingSession> {
      const baseUrl = resolveBaseUrl();
      if (baseUrl.length === 0) throw new Error('server_not_configured');
      const includeServerUrl = Boolean(options.getPreferences?.()?.syncServerUrl?.trim());
      const res = await makeQrClient(baseUrl).createSession({ includeServerUrl });
      if (!res.ok) throw new Error(errorCodeFrom(res.error));
      qrSessions.set(res.value.pairingId, res.value);
      return {
        pairingId: res.value.pairingId,
        code: res.value.code,
        qrUri: res.value.qrUri,
        expiresAtMs: res.value.expiresAt,
        status: 'pending',
      };
    },

    async pollQrPairing(pairingId): Promise<'pending' | 'claimed' | 'expired'> {
      const baseUrl = resolveBaseUrl();
      const session = qrSessions.get(pairingId);
      if (baseUrl.length === 0 || session === undefined || clock.now() >= session.expiresAt) {
        qrSessions.delete(pairingId);
        return 'expired';
      }
      const res = await makeQrClient(baseUrl).pollSession(session);
      if (!res.ok || res.value.status === 'pending') return 'pending';
      qrSessions.delete(pairingId);
      if (res.value.status === 'expired') return 'expired';

      let vaultKey: Uint8Array;
      try {
        vaultKey = base64UrlDecode(res.value.payload.vaultKeyB64);
      } catch {
        return 'expired';
      }
      if (vaultKey.length !== VAULT_KEY_BYTES) return 'expired';

      const refreshed = await makeAuthClient(baseUrl).refresh(res.value.payload.refreshToken);
      if (!refreshed.ok) return 'expired';
      const pairedSession: SyncSession = {
        user: refreshed.value.user ?? {
          id: res.value.payload.email,
          email: res.value.payload.email,
        },
        accessToken: refreshed.value.accessToken,
        refreshToken: refreshed.value.refreshToken,
        vaultKey,
      };
      activeSession = pairedSession;
      lastRevision = 0;
      await persistSession(pairedSession, null, 0);
      setState({
        status: 'signed_in',
        email: pairedSession.user.email,
        lastSyncedAtIso: null,
        pendingRecoveryCode: null,
        errorCode: null,
      });
      return 'claimed';
    },

    async claimQrPairing(codeOrUri): Promise<SyncActionResult> {
      const baseUrl = resolveBaseUrl();
      if (baseUrl.length === 0) return { ok: false, errorCode: 'server_not_configured' };
      if (activeSession === null) return { ok: false, errorCode: 'not_signed_in' };

      const parsed = parsePairingQrUri(codeOrUri);
      if (!parsed.ok) return { ok: false, errorCode: errorCodeFrom(parsed.error) };

      const session = await ensureAccessToken(baseUrl);
      if (session === null) return { ok: false, errorCode: 'session_expired' };

      const claimRes = await makeQrClient(baseUrl).claimSession({
        accessToken: session.accessToken,
        qrUriOrParams: parsed.value,
        payload: {
          email: session.user.email,
          refreshToken: session.refreshToken,
          vaultKeyB64: base64UrlEncode(session.vaultKey),
        },
      });
      return claimRes.ok ? { ok: true } : { ok: false, errorCode: errorCodeFrom(claimRes.error) };
    },
  };

  let telemetryOptIn = Boolean(options.getPreferences?.()?.telemetryOptIn);
  let hasExplicitOptIn = false;
  let sessionId = generateSessionId(randomBytes);
  const telemetryQueue = createTelemetryQueue();
  let cachedUploader: { baseUrl: string; sid: string; uploader: TelemetryUploader } | null = null;

  const isOptedIn = (): boolean => {
    if (hasExplicitOptIn) return telemetryOptIn;
    const pref = options.getPreferences?.()?.telemetryOptIn;
    return typeof pref === 'boolean' ? pref : telemetryOptIn;
  };

  const getUploader = (): TelemetryUploader => {
    const baseUrl = resolveBaseUrl();
    const meta = options.getDeviceMeta();
    if (
      cachedUploader === null ||
      cachedUploader.baseUrl !== baseUrl ||
      cachedUploader.sid !== sessionId
    ) {
      cachedUploader = {
        baseUrl,
        sid: sessionId,
        uploader: createTelemetryUploader({
          baseUrl: baseUrl.length > 0 ? baseUrl : 'https://invalid.local',
          http,
          isOptedIn,
          clock,
          sessionId,
          platform: meta.platform,
          appVersion: meta.appVersion,
          queue: telemetryQueue,
        }),
      };
    }
    return cachedUploader.uploader;
  };

  const telemetry: TelemetryPort = {
    isOptedIn,
    setOptIn(enabled: boolean): void {
      const next = Boolean(enabled);
      const prev = isOptedIn();
      hasExplicitOptIn = true;
      if (next && !prev) sessionId = generateSessionId(randomBytes);
      telemetryOptIn = next;
      if (!next) telemetryQueue.clear();
      if (next !== prev) options.onTelemetryOptInChange?.(next);
    },
    queuedCount: () => telemetryQueue.size(),
    getPayloadPreviewJson: () => getUploader().preview(),
    recordScreenTransition(screen: string, durationMs: number): void {
      if (!isOptedIn()) return;
      getUploader().record({ kind: 'screen_transition', ts: clock.now(), screen, durationMs });
    },
    recordMediaDecodeFailure(meta: TelemetryMediaDecodeFailure): void {
      if (!isOptedIn()) return;
      getUploader().record({
        kind: 'media_decode_failure',
        ts: clock.now(),
        engine: meta.engine,
        container: meta.container ?? 'unknown',
        videoCodec: meta.videoCodec ?? 'unknown',
        audioCodec: meta.audioCodec ?? 'unknown',
        errorCode: meta.errorCode,
        ...(meta.hdrFormat !== undefined ? { hdrFormat: meta.hdrFormat } : {}),
        isLive: Boolean(meta.isLive),
      });
    },
    recordPlaybackError(meta): void {
      if (!isOptedIn()) return;
      getUploader().record({
        kind: 'playback_error',
        ts: clock.now(),
        engine: meta.engine,
        errorCode: meta.errorCode,
        isLive: Boolean(meta.isLive),
      });
    },
    async flush(): Promise<void> {
      if (!isOptedIn() || resolveBaseUrl().length === 0) return;
      await getUploader().flush();
    },
  };

  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const intervalHandle =
    flushIntervalMs > 0
      ? setInterval(() => {
          if (isOptedIn() && telemetryQueue.size() > 0) void telemetry.flush();
        }, flushIntervalMs)
      : undefined;
  if (
    intervalHandle !== undefined &&
    typeof (intervalHandle as { unref?: () => void }).unref === 'function'
  ) {
    (intervalHandle as { unref: () => void }).unref();
  }

  const unsubscribeAppState = options.subscribeAppState?.((nextState) => {
    if ((nextState === 'background' || nextState === 'inactive') && isOptedIn()) {
      void telemetry.flush();
    }
  });

  const feedback: FeedbackPort = {
    async submit(input: FeedbackSubmitInput) {
      const baseUrl = resolveBaseUrl();
      if (baseUrl.length === 0) return { ok: false, errorCode: 'server_not_configured' };
      const meta = options.getDeviceMeta();
      let diagnostics: Record<string, string | number | boolean> | undefined;
      if (input.includeDiagnostics) {
        const rawLogs = options.getRecentLogs
          ? await Promise.resolve(options.getRecentLogs(FEEDBACK_LOG_TAIL_LINES)).catch(
              () => [] as readonly string[],
            )
          : [];
        const logTail = rawLogs
          .slice(-FEEDBACK_LOG_TAIL_LINES)
          .map((line) => redactDiagnosticsLine(line))
          .join('\n');
        diagnostics = {
          platform: meta.platform,
          appVersion: meta.appVersion,
          ...(meta.osVersion !== undefined ? { osVersion: meta.osVersion } : {}),
          ...(logTail.length > 0 ? { logTail } : {}),
        };
      }
      const res = await submitFeedback({
        baseUrl,
        http,
        submission: {
          category: input.category,
          message: input.message,
          platform: meta.platform,
          appVersion: meta.appVersion,
          ...(meta.locale !== undefined ? { locale: meta.locale } : {}),
          ...(diagnostics !== undefined ? { diagnostics } : {}),
        },
      });
      return res.ok
        ? { ok: true, id: res.value.id }
        : { ok: false, errorCode: errorCodeFrom(res.error) };
    },
  };

  return {
    syncAccount,
    telemetry,
    feedback,
    hydrate,
    dispose() {
      if (intervalHandle !== undefined) clearInterval(intervalHandle);
      unsubscribeAppState?.();
      listeners.clear();
      qrSessions.clear();
    },
  };
}
