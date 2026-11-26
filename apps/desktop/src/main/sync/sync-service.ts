import {
  normalizeSyncServerUrl,
  type PreferencesPatch,
  type SecretStore,
  sanitizeInitialPreferencesPatch,
} from '@elv/domain';
import {
  base64UrlDecode,
  base64UrlEncode,
  createEmptyVaultSnapshot,
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
  type VaultCryptoPort,
  type VaultSnapshot,
} from '@elv/sync';
import type {
  FeedbackSubmitRequest,
  FeedbackSubmitResultIpc,
  SyncAccountStateIpc,
  SyncActionResultIpc,
  SyncQrPairingSessionIpc,
  SyncQrPollStatusIpc,
  TelemetryRecordRequest,
  TelemetryStatusIpc,
} from '../../shared/sync-ipc.ts';
import {
  createFetchHttpPort,
  createNodeWebCryptoPort,
  DEFAULT_FLUSH_INTERVAL_MS,
  type DesktopSyncFetchFn,
  errorCodeFrom,
  FEEDBACK_LOG_TAIL_LINES,
  initialPrefsAppliedKey,
  isAuthTokenExpiredError,
  type PersistedSessionRecord,
  parsePersistedSession,
  redactDiagnosticsLine,
  SESSION_SECRET_KEY,
  SIGNED_OUT_STATE,
  VAULT_KEY_BYTES,
} from './sync-service-helpers.ts';

export { type DesktopSyncFetchFn, redactDiagnosticsLine };

/** Options for {@link createDesktopSyncService}. */
export interface DesktopSyncServiceOptions {
  readonly secretStore: SecretStore;
  readonly platform: string;
  readonly appVersion: string;
  readonly mpvVersion?: string;
  readonly initialServerUrl?: string;
  readonly fetchFn?: DesktopSyncFetchFn;
  readonly crypto?: VaultCryptoPort;
  readonly clock?: SyncClockPort;
  readonly kdfIterations?: number;
  readonly flushIntervalMs?: number;
  readonly readLogTail?: (maxLines: number) => Promise<readonly string[]>;
  readonly getLocalSnapshot?: () => Promise<VaultSnapshot> | VaultSnapshot;
  readonly applyMergedSnapshot?: (snapshot: VaultSnapshot) => Promise<void> | void;
  readonly onInitialPreferences?: (patch: PreferencesPatch) => Promise<void> | void;
}

/** Electron main-process E2EE sync, telemetry, and feedback service (`#26`, `#458`). */
export interface DesktopSyncService {
  hydrate(): Promise<void>;
  getState(): SyncAccountStateIpc;
  subscribe(listener: (state: SyncAccountStateIpc) => void): () => void;
  subscribeInitialPreferences(listener: (patch: PreferencesPatch) => void): () => void;
  setServerUrl(serverUrl: string): void;
  setSyncablePreferences(preferences: Readonly<Record<string, unknown>>): void;
  signIn(email: string, password: string): Promise<SyncActionResultIpc>;
  register(email: string, password: string, confirmPassword: string): Promise<SyncActionResultIpc>;
  acknowledgeRecoveryCode(): void;
  syncNow(): Promise<SyncActionResultIpc>;
  signOut(): Promise<void>;
  deleteAccount(password: string): Promise<SyncActionResultIpc>;
  createQrPairing(): Promise<SyncQrPairingSessionIpc>;
  pollQrPairing(pairingId: string): Promise<SyncQrPollStatusIpc>;
  claimQrPairing(codeOrUri: string): Promise<SyncActionResultIpc>;
  setTelemetryOptIn(enabled: boolean): TelemetryStatusIpc;
  getTelemetryStatus(): TelemetryStatusIpc;
  recordTelemetry(event: TelemetryRecordRequest): void;
  flushTelemetry(): Promise<void>;
  submitFeedback(input: FeedbackSubmitRequest): Promise<FeedbackSubmitResultIpc>;
  dispose(): void;
}

/**
 * Creates the Electron main-process sync, telemetry, and feedback service backed by Node 24
 * WebCrypto and `safeStorage` `SecretStore` so tokens and vault keys never enter the renderer (`#26`, `#458`).
 */
export function createDesktopSyncService(options: DesktopSyncServiceOptions): DesktopSyncService {
  const cryptoPort = options.crypto ?? createNodeWebCryptoPort();
  const clock: SyncClockPort = options.clock ?? { now: () => Date.now() };
  const fetchFn: DesktopSyncFetchFn =
    options.fetchFn ??
    ((input, init) =>
      globalThis.fetch(input, {
        ...(init?.method !== undefined ? { method: init.method } : {}),
        ...(init?.headers !== undefined ? { headers: { ...init.headers } } : {}),
        ...(init?.body !== undefined ? { body: init.body } : {}),
        ...(init?.signal !== undefined ? { signal: init.signal } : {}),
      }));
  const http = createFetchHttpPort(fetchFn);

  let serverUrl = normalizeSyncServerUrl(options.initialServerUrl ?? '', '');
  let state: SyncAccountStateIpc = SIGNED_OUT_STATE;
  const listeners = new Set<(next: SyncAccountStateIpc) => void>();
  const initialPrefsListeners = new Set<(patch: PreferencesPatch) => void>();
  let activeSession: SyncSession | null = null;
  let lastRevision = 0;
  let localSnapshot: VaultSnapshot = createEmptyVaultSnapshot(0);
  let localSyncablePrefs: Readonly<Record<string, unknown>> | undefined;
  const qrSessions = new Map<string, QrPairingSession>();

  const hasAppliedInitialPrefs = async (userId: string): Promise<boolean> => {
    const val = await options.secretStore
      .get(initialPrefsAppliedKey(userId))
      .catch(() => undefined);
    return val === '1';
  };

  const markInitialPrefsApplied = async (userId: string): Promise<void> => {
    await options.secretStore.set(initialPrefsAppliedKey(userId), '1').catch(() => undefined);
  };

  const emitInitialPreferences = async (patch: PreferencesPatch): Promise<void> => {
    await options.onInitialPreferences?.(patch);
    for (const listener of [...initialPrefsListeners]) {
      try {
        listener(patch);
      } catch {
        // Isolate subscriber errors.
      }
    }
  };

  const setState = (next: SyncAccountStateIpc): void => {
    state = Object.freeze({
      status: next.status,
      email: next.email,
      lastSyncedAtIso: next.lastSyncedAtIso,
      pendingRecoveryCode: next.pendingRecoveryCode,
      errorCode: next.errorCode,
    });
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch {
        // Isolate subscriber errors.
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
  ): Promise<
    | { readonly ok: true; readonly session: SyncSession }
    | { readonly ok: false; readonly errorCode: 'session_expired' | 'invalid_session' }
  > => {
    if (activeSession === null) return { ok: false, errorCode: 'session_expired' };
    if (!forceRefresh && activeSession.accessToken.length > 0) {
      return { ok: true, session: activeSession };
    }
    const refreshed = await makeAuthClient(baseUrl).refresh(activeSession.refreshToken);
    if (!refreshed.ok) return { ok: false, errorCode: 'session_expired' };
    const refreshedUser = refreshed.value.user;
    if (
      refreshedUser === undefined ||
      typeof refreshedUser.id !== 'string' ||
      refreshedUser.id.trim().length === 0
    ) {
      return { ok: false, errorCode: 'invalid_session' };
    }
    const updated: SyncSession = {
      ...activeSession,
      user: {
        id: refreshedUser.id,
        email: refreshedUser.email.length > 0 ? refreshedUser.email : activeSession.user.email,
      },
      accessToken: refreshed.value.accessToken,
      refreshToken: refreshed.value.refreshToken,
    };
    activeSession = updated;
    await persistSession(updated, state.lastSyncedAtIso, lastRevision);
    return { ok: true, session: updated };
  };

  let hydrated = false;
  let telemetryOptIn = false;
  let sessionId = `s_${base64UrlEncode(cryptoPort.randomBytes(12))}`;
  const telemetryQueue = createTelemetryQueue();
  let cachedUploader: { baseUrl: string; sid: string; uploader: TelemetryUploader } | null = null;

  const getUploader = (): TelemetryUploader => {
    if (
      cachedUploader === null ||
      cachedUploader.baseUrl !== serverUrl ||
      cachedUploader.sid !== sessionId
    ) {
      cachedUploader = {
        baseUrl: serverUrl,
        sid: sessionId,
        uploader: createTelemetryUploader({
          baseUrl: serverUrl.length > 0 ? serverUrl : 'https://invalid.local',
          http,
          isOptedIn: () => telemetryOptIn,
          clock,
          sessionId,
          platform: options.platform,
          appVersion: options.appVersion,
          queue: telemetryQueue,
        }),
      };
    }
    return cachedUploader.uploader;
  };

  const getTelemetryStatus = (): TelemetryStatusIpc => ({
    optedIn: telemetryOptIn,
    queuedCount: telemetryQueue.size(),
    previewJson: getUploader().preview(),
  });

  const flushTelemetry = async (): Promise<void> => {
    if (!telemetryOptIn || serverUrl.length === 0) return;
    await getUploader().flush();
  };

  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const intervalHandle =
    flushIntervalMs > 0
      ? setInterval(() => {
          if (telemetryOptIn && telemetryQueue.size() > 0) {
            void flushTelemetry();
          }
        }, flushIntervalMs)
      : undefined;
  intervalHandle?.unref?.();

  return {
    async hydrate(): Promise<void> {
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
      if (persisted.lastSyncedAtIso !== null || persisted.lastRevision > 0) {
        await markInitialPrefsApplied(persisted.userId);
      }
      setState({
        status: 'signed_in',
        email: persisted.email,
        lastSyncedAtIso: persisted.lastSyncedAtIso,
        pendingRecoveryCode: null,
        errorCode: null,
      });
    },

    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    subscribeInitialPreferences(listener) {
      initialPrefsListeners.add(listener);
      return () => {
        initialPrefsListeners.delete(listener);
      };
    },

    setServerUrl(nextUrl: string): void {
      serverUrl = normalizeSyncServerUrl(nextUrl, '');
    },

    setSyncablePreferences(preferences: Readonly<Record<string, unknown>>): void {
      const sanitized = sanitizeInitialPreferencesPatch(preferences) as Record<string, unknown>;
      localSyncablePrefs = Object.keys(sanitized).length > 0 ? sanitized : undefined;
    },

    async signIn(email, password): Promise<SyncActionResultIpc> {
      if (serverUrl.length === 0) {
        setState({ ...state, errorCode: 'server_not_configured' });
        return { ok: false, errorCode: 'server_not_configured' };
      }
      setState({ ...state, status: 'signing_in', errorCode: null });
      const res = await makeAuthClient(serverUrl).login(email, password);
      if (!res.ok) {
        const errorCode = errorCodeFrom(res.error);
        setState({ ...SIGNED_OUT_STATE, errorCode });
        return { ok: false, errorCode };
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

    async register(email, password, confirmPassword): Promise<SyncActionResultIpc> {
      if (serverUrl.length === 0) {
        setState({ ...state, errorCode: 'server_not_configured' });
        return { ok: false, errorCode: 'server_not_configured' };
      }
      setState({ ...state, status: 'signing_in', errorCode: null });
      const res = await makeAuthClient(serverUrl).register(email, password, confirmPassword);
      if (!res.ok) {
        const errorCode = errorCodeFrom(res.error);
        setState({ ...SIGNED_OUT_STATE, errorCode });
        return { ok: false, errorCode };
      }
      activeSession = res.value.session;
      lastRevision = 0;
      await persistSession(res.value.session, null, 0);
      await markInitialPrefsApplied(res.value.session.user.id);
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

    async syncNow(): Promise<SyncActionResultIpc> {
      if (serverUrl.length === 0) return { ok: false, errorCode: 'server_not_configured' };
      if (activeSession === null) return { ok: false, errorCode: 'not_signed_in' };

      setState({ ...state, status: 'syncing', errorCode: null });
      const client = makeAuthClient(serverUrl);
      const tokenRes = await ensureAccessToken(serverUrl);
      if (!tokenRes.ok) {
        setState({ ...state, status: 'signed_in', errorCode: tokenRes.errorCode });
        return { ok: false, errorCode: tokenRes.errorCode };
      }
      let session = tokenRes.session;

      let pullRes = await client.pullVault(session);
      if (!pullRes.ok && isAuthTokenExpiredError(pullRes.error)) {
        const retryToken = await ensureAccessToken(serverUrl, true);
        if (!retryToken.ok) {
          setState({ ...state, status: 'signed_in', errorCode: retryToken.errorCode });
          return { ok: false, errorCode: retryToken.errorCode };
        }
        session = retryToken.session;
        pullRes = await client.pullVault(session);
      }
      if (!pullRes.ok) {
        const errorCode = errorCodeFrom(pullRes.error);
        setState({ ...state, status: 'signed_in', errorCode });
        return { ok: false, errorCode };
      }

      const alreadyAppliedInitialPrefs = await hasAppliedInitialPrefs(session.user.id);
      let remoteInitialPrefs = pullRes.value.snapshot?.initialPreferences;
      const shouldApplyRemoteInitial =
        !alreadyAppliedInitialPrefs && remoteInitialPrefs !== undefined;

      const baseLocal = options.getLocalSnapshot ? await options.getLocalSnapshot() : localSnapshot;
      const currentLocal: VaultSnapshot =
        !shouldApplyRemoteInitial && localSyncablePrefs !== undefined
          ? {
              ...baseLocal,
              initialPreferences: localSyncablePrefs,
              initialPreferencesUpdatedAt: clock.now(),
            }
          : baseLocal;
      let merged =
        pullRes.value.snapshot !== null
          ? mergeVaultSnapshots(currentLocal, pullRes.value.snapshot)
          : currentLocal;
      let pushRes = await client.pushVault(session, pullRes.value.revision, merged);

      if (pushRes.ok && pushRes.value.status === 'conflict') {
        const retryPull = await client.pullVault(session);
        if (!retryPull.ok) {
          const errorCode = errorCodeFrom(retryPull.error);
          setState({ ...state, status: 'signed_in', errorCode });
          return { ok: false, errorCode };
        }
        if (remoteInitialPrefs === undefined && retryPull.value.snapshot?.initialPreferences) {
          remoteInitialPrefs = retryPull.value.snapshot.initialPreferences;
        }
        merged =
          retryPull.value.snapshot !== null
            ? mergeVaultSnapshots(merged, retryPull.value.snapshot)
            : merged;
        pushRes = await client.pushVault(session, retryPull.value.revision, merged);
      }

      if (!pushRes.ok || pushRes.value.status !== 'ok') {
        const errorCode = pushRes.ok ? 'sync_conflict' : errorCodeFrom(pushRes.error);
        setState({ ...state, status: 'signed_in', errorCode });
        return { ok: false, errorCode };
      }

      localSnapshot = merged;
      await options.applyMergedSnapshot?.(merged);
      if (!alreadyAppliedInitialPrefs) {
        if (remoteInitialPrefs !== undefined) {
          const patch = sanitizeInitialPreferencesPatch(remoteInitialPrefs);
          if (Object.keys(patch).length > 0) {
            await emitInitialPreferences(patch);
          }
        }
        await markInitialPrefsApplied(session.user.id);
      }
      lastRevision = pushRes.value.revision;
      const syncedIso = new Date(clock.now()).toISOString();
      await persistSession(session, syncedIso, lastRevision);
      setState({
        ...state,
        status: 'signed_in',
        lastSyncedAtIso: syncedIso,
        errorCode: null,
      });
      return { ok: true };
    },

    async signOut(): Promise<void> {
      if (serverUrl.length > 0 && activeSession !== null) {
        await makeAuthClient(serverUrl)
          .logout(activeSession.refreshToken, activeSession.accessToken)
          .catch(() => undefined);
      }
      await clearLocalSession();
    },

    async deleteAccount(password): Promise<SyncActionResultIpc> {
      if (serverUrl.length === 0) return { ok: false, errorCode: 'server_not_configured' };
      if (activeSession === null) return { ok: false, errorCode: 'not_signed_in' };

      const client = makeAuthClient(serverUrl);
      const tokenRes = await ensureAccessToken(serverUrl);
      if (!tokenRes.ok) {
        setState({ ...state, errorCode: tokenRes.errorCode });
        return { ok: false, errorCode: tokenRes.errorCode };
      }
      let session = tokenRes.session;
      let res = await client.deleteAccount(session.accessToken, session.user.email, password);
      if (!res.ok && isAuthTokenExpiredError(res.error)) {
        const retryToken = await ensureAccessToken(serverUrl, true);
        if (!retryToken.ok) {
          setState({ ...state, errorCode: retryToken.errorCode });
          return { ok: false, errorCode: retryToken.errorCode };
        }
        session = retryToken.session;
        res = await client.deleteAccount(session.accessToken, session.user.email, password);
      }
      if (!res.ok) {
        const errorCode = errorCodeFrom(res.error);
        setState({ ...state, errorCode });
        return { ok: false, errorCode };
      }
      await clearLocalSession();
      return { ok: true };
    },

    async createQrPairing(): Promise<SyncQrPairingSessionIpc> {
      if (serverUrl.length === 0) throw new Error('server_not_configured');
      const res = await makeQrClient(serverUrl).createSession({ includeServerUrl: true });
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

    async pollQrPairing(pairingId): Promise<SyncQrPollStatusIpc> {
      const session = qrSessions.get(pairingId);
      if (serverUrl.length === 0 || session === undefined || clock.now() >= session.expiresAt) {
        qrSessions.delete(pairingId);
        return 'expired';
      }
      const res = await makeQrClient(serverUrl).pollSession(session);
      if (!res.ok) return 'pending';
      if (res.value.status === 'pending') return 'pending';
      qrSessions.delete(pairingId);
      if (res.value.status === 'expired') return 'expired';

      let vaultKey: Uint8Array;
      try {
        vaultKey = base64UrlDecode(res.value.payload.vaultKeyB64);
      } catch {
        return 'expired';
      }
      if (vaultKey.length !== VAULT_KEY_BYTES) return 'expired';

      const refreshed = await makeAuthClient(serverUrl).refresh(res.value.payload.refreshToken);
      if (!refreshed.ok) {
        setState({ ...state, errorCode: errorCodeFrom(refreshed.error) });
        return 'expired';
      }
      const refreshedUser = refreshed.value.user;
      if (
        refreshedUser === undefined ||
        typeof refreshedUser.id !== 'string' ||
        refreshedUser.id.trim().length === 0
      ) {
        setState({ ...state, errorCode: 'invalid_session' });
        return 'expired';
      }
      const pairedSession: SyncSession = {
        user: {
          id: refreshedUser.id,
          email: refreshedUser.email.length > 0 ? refreshedUser.email : res.value.payload.email,
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

    async claimQrPairing(codeOrUri): Promise<SyncActionResultIpc> {
      if (serverUrl.length === 0) return { ok: false, errorCode: 'server_not_configured' };
      if (activeSession === null) return { ok: false, errorCode: 'not_signed_in' };

      const parsed = parsePairingQrUri(codeOrUri);
      if (!parsed.ok) return { ok: false, errorCode: errorCodeFrom(parsed.error) };

      const tokenRes = await ensureAccessToken(serverUrl);
      if (!tokenRes.ok) return { ok: false, errorCode: tokenRes.errorCode };
      let session = tokenRes.session;

      const authClient = makeAuthClient(serverUrl);
      let pairTokenRes = await authClient.issuePairRefreshToken(session.accessToken);
      if (!pairTokenRes.ok && isAuthTokenExpiredError(pairTokenRes.error)) {
        const retryToken = await ensureAccessToken(serverUrl, true);
        if (!retryToken.ok) return { ok: false, errorCode: retryToken.errorCode };
        session = retryToken.session;
        pairTokenRes = await authClient.issuePairRefreshToken(session.accessToken);
      }
      if (!pairTokenRes.ok) {
        return { ok: false, errorCode: errorCodeFrom(pairTokenRes.error) };
      }

      const qrClient = makeQrClient(serverUrl);
      let res = await qrClient.claimSession({
        accessToken: session.accessToken,
        qrUriOrParams: parsed.value,
        payload: {
          email: session.user.email,
          refreshToken: pairTokenRes.value.refreshToken,
          vaultKeyB64: base64UrlEncode(session.vaultKey),
        },
      });
      if (!res.ok && isAuthTokenExpiredError(res.error)) {
        const retryToken = await ensureAccessToken(serverUrl, true);
        if (!retryToken.ok) return { ok: false, errorCode: retryToken.errorCode };
        session = retryToken.session;
        res = await qrClient.claimSession({
          accessToken: session.accessToken,
          qrUriOrParams: parsed.value,
          payload: {
            email: session.user.email,
            refreshToken: pairTokenRes.value.refreshToken,
            vaultKeyB64: base64UrlEncode(session.vaultKey),
          },
        });
      }
      if (!res.ok) return { ok: false, errorCode: errorCodeFrom(res.error) };
      return { ok: true };
    },

    setTelemetryOptIn(enabled: boolean): TelemetryStatusIpc {
      const next = Boolean(enabled);
      if (next && !telemetryOptIn) {
        sessionId = `s_${base64UrlEncode(cryptoPort.randomBytes(12))}`;
      }
      telemetryOptIn = next;
      if (!next) {
        telemetryQueue.clear();
      }
      return getTelemetryStatus();
    },

    getTelemetryStatus,

    recordTelemetry(event: TelemetryRecordRequest): void {
      if (!telemetryOptIn) return;
      const ts = clock.now();
      if (event.kind === 'screen_transition') {
        getUploader().record({
          kind: 'screen_transition',
          ts,
          screen: event.screen,
          durationMs: event.durationMs,
        });
      } else if (event.kind === 'media_decode_failure') {
        getUploader().record({
          kind: 'media_decode_failure',
          ts,
          engine: event.engine,
          container: event.container ?? 'unknown',
          videoCodec: event.videoCodec ?? 'unknown',
          audioCodec: event.audioCodec ?? 'unknown',
          errorCode: event.errorCode,
          ...(event.hdrFormat !== undefined ? { hdrFormat: event.hdrFormat } : {}),
          isLive: event.isLive,
        });
      } else {
        getUploader().record({
          kind: 'playback_error',
          ts,
          engine: event.engine,
          errorCode: event.errorCode,
          isLive: event.isLive,
        });
      }
    },

    flushTelemetry,

    async submitFeedback(input: FeedbackSubmitRequest): Promise<FeedbackSubmitResultIpc> {
      if (serverUrl.length === 0) return { ok: false, errorCode: 'server_not_configured' };
      let diagnostics: Record<string, string | number | boolean> | undefined;
      if (input.includeDiagnostics) {
        const rawLogs = options.readLogTail
          ? await options.readLogTail(FEEDBACK_LOG_TAIL_LINES).catch(() => [] as readonly string[])
          : [];
        const logTail = rawLogs
          .slice(-FEEDBACK_LOG_TAIL_LINES)
          .map((line) => redactDiagnosticsLine(line))
          .join('\n');
        diagnostics = {
          platform: options.platform,
          appVersion: options.appVersion,
          ...(options.mpvVersion !== undefined ? { mpvVersion: options.mpvVersion } : {}),
          ...(logTail.length > 0 ? { logTail } : {}),
        };
      }
      const res = await submitFeedback({
        baseUrl: serverUrl,
        http,
        submission: {
          category: input.category,
          message: input.message,
          platform: options.platform,
          appVersion: options.appVersion,
          ...(diagnostics !== undefined ? { diagnostics } : {}),
        },
      });
      if (!res.ok) return { ok: false, errorCode: errorCodeFrom(res.error) };
      return { ok: true, id: res.value.id };
    },

    dispose(): void {
      if (intervalHandle !== undefined) clearInterval(intervalHandle);
      activeSession = null;
      qrSessions.clear();
      listeners.clear();
      initialPrefsListeners.clear();
    },
  };
}
