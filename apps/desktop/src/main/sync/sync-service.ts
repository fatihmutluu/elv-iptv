import {
  elvError,
  err,
  normalizeSyncServerUrl,
  ok,
  type PreferencesPatch,
  type Result,
  type SecretStore,
  sanitizeInitialPreferencesPatch,
} from '@elv/domain';
import {
  base64UrlDecode,
  base64UrlEncode,
  createAutoSyncScheduler,
  createEmptyVaultSnapshot,
  createQrPairingClient,
  createSyncAuthClient,
  createTelemetryQueue,
  createTelemetryUploader,
  type DeviceTechnicalProfile,
  mergeVaultSnapshots,
  parsePairingQrUri,
  type QrPairingPayload,
  type QrPairingSession,
  type SyncClockPort,
  type SyncSession,
  type TelemetryUploader,
  type VaultCryptoPort,
  type VaultSnapshot,
} from '@elv/sync';
import type {
  AutoSyncStateIpc,
  BidirectionalPairingSnapshotIpc,
  FeedbackSubmitRequest,
  FeedbackSubmitResultIpc,
  SyncAccountStateIpc,
  SyncActionResultIpc,
  SyncEmailCheckStatusIpc,
  SyncQrPairingSessionIpc,
  SyncQrPollStatusIpc,
  TelemetryRecordRequest,
  TelemetryStatusIpc,
} from '../../shared/sync-ipc.ts';
import { createBidirectionalPairingController } from './bidirectional-pairing.ts';
import { mapDesktopTelemetryRequestToEvent } from './device-profile.ts';
import { reconcileLocalSnapshotWithBaseline } from './snapshot-tombstones.ts';
import {
  broadcastToListeners,
  createFetchHttpPort,
  createNodeWebCryptoPort,
  createServerUrlController,
  DEFAULT_FLUSH_INTERVAL_MS,
  type DesktopSyncFetchFn,
  defaultDesktopFetchFn,
  errorCodeFrom,
  hasAppliedInitialPrefs,
  isAuthTokenExpiredError,
  loadVaultBaseline,
  mapSchedulerState,
  markInitialPrefsApplied,
  parsePersistedSession,
  persistSessionRecord,
  persistVaultBaseline,
  redactDiagnosticsLine,
  SESSION_SECRET_KEY,
  SIGNED_OUT_STATE,
  submitDesktopFeedbackRequest,
  VAULT_BASELINE_SECRET_KEY,
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
  readonly linkOrigin?: string;
  readonly deviceProfile?: DeviceTechnicalProfile;
  readonly fetchFn?: DesktopSyncFetchFn;
  readonly crypto?: VaultCryptoPort;
  readonly clock?: SyncClockPort;
  readonly kdfIterations?: number;
  readonly flushIntervalMs?: number;
  readonly readLogTail?: (maxLines: number) => Promise<readonly string[]>;
  readonly getLocalSnapshot?: () => Promise<VaultSnapshot> | VaultSnapshot;
  readonly applyMergedSnapshot?: (snapshot: VaultSnapshot) => Promise<void> | void;
  readonly onInitialPreferences?: (patch: PreferencesPatch) => Promise<void> | void;
  readonly onServerUrlChange?: (serverUrl: string) => void;
}

/** Electron main-process E2EE sync, bidirectional pairing, telemetry, and feedback service (`#26`, `#458`, `#509`, `#510`). */
export interface DesktopSyncService {
  hydrate(): Promise<void>;
  getState(): SyncAccountStateIpc;
  subscribe(listener: (state: SyncAccountStateIpc) => void): () => void;
  subscribeInitialPreferences(listener: (patch: PreferencesPatch) => void): () => void;
  subscribeServerUrl?(listener: (serverUrl: string) => void): () => void;
  setServerUrl(serverUrl: string): void;
  setSyncablePreferences(preferences: Readonly<Record<string, unknown>>): void;
  checkEmail(email: string): Promise<SyncEmailCheckStatusIpc>;
  signIn(email: string, password: string): Promise<SyncActionResultIpc>;
  register(email: string, password: string, confirmPassword: string): Promise<SyncActionResultIpc>;
  acknowledgeRecoveryCode(): void;
  syncNow(): Promise<SyncActionResultIpc>;
  signOut(): Promise<void>;
  deleteAccount(password: string): Promise<SyncActionResultIpc>;
  createQrPairing(): Promise<SyncQrPairingSessionIpc>;
  pollQrPairing(pairingId: string): Promise<SyncQrPollStatusIpc>;
  claimQrPairing(codeOrUri: string): Promise<SyncActionResultIpc>;
  markSyncDirty(): void;
  notifySyncDirty(): void;
  notifyPlaybackPause(): void;
  notifyPlaybackExitOrSwitch(): void;
  setViewingActive(active: boolean): void;
  notifyStartup(): void;
  notifyForeground(awayMs: number): void;
  notifyReconnect(): void;
  flushBeforeBackground(timeoutMs?: number): Promise<void>;
  startBidirectionalPairing(): Promise<BidirectionalPairingSnapshotIpc>;
  joinBidirectionalPairing(codeOrUri: string): Promise<BidirectionalPairingSnapshotIpc>;
  pollBidirectionalPairing(pairingId: string): Promise<BidirectionalPairingSnapshotIpc>;
  confirmBidirectionalPairing(
    pairingId: string,
    chosenDirection?: 'host_to_responder' | 'responder_to_host',
  ): Promise<SyncActionResultIpc>;
  cancelBidirectionalPairing(pairingId: string): Promise<void>;
  setTelemetryOptIn(enabled: boolean): TelemetryStatusIpc;
  getTelemetryStatus(): TelemetryStatusIpc;
  recordTelemetry(event: TelemetryRecordRequest): void;
  flushTelemetry(): Promise<void>;
  submitFeedback(input: FeedbackSubmitRequest): Promise<FeedbackSubmitResultIpc>;
  dispose(): void;
}

/**
 * Creates the Electron main-process sync, automatic background sync, bidirectional X25519 pairing,
 * unified telemetry, and feedback service (`#26`, `#458`, `#509`, `#510`).
 */
export function createDesktopSyncService(options: DesktopSyncServiceOptions): DesktopSyncService {
  const cryptoPort = options.crypto ?? createNodeWebCryptoPort();
  const clock: SyncClockPort = options.clock ?? { now: () => Date.now() };
  const http = createFetchHttpPort(options.fetchFn ?? defaultDesktopFetchFn);

  const defaultServerUrl = normalizeSyncServerUrl(options.initialServerUrl ?? '', '');
  let serverUrl = defaultServerUrl;
  const urlCtl = createServerUrlController(
    options.secretStore,
    defaultServerUrl,
    options.onServerUrlChange,
  );
  let autoSyncState: AutoSyncStateIpc = 'idle';
  let state: SyncAccountStateIpc = Object.freeze({ ...SIGNED_OUT_STATE, autoSyncState: 'idle' });
  const listeners = new Set<(next: SyncAccountStateIpc) => void>();
  const initialPrefsListeners = new Set<(patch: PreferencesPatch) => void>();
  let activeSession: SyncSession | null = null;
  let lastRevision = 0;
  let localSnapshot: VaultSnapshot = createEmptyVaultSnapshot(0);
  let localSyncablePrefs: Readonly<Record<string, unknown>> | undefined;
  let activeSyncRun: Promise<SyncActionResultIpc> | null = null;
  const qrSessions = new Map<string, QrPairingSession>();

  const emitInitialPreferences = async (patch: PreferencesPatch): Promise<void> => {
    await options.onInitialPreferences?.(patch);
    broadcastToListeners(initialPrefsListeners, patch);
  };

  const setState = (next: SyncAccountStateIpc): void => {
    state = Object.freeze({
      status: next.status,
      email: next.email,
      lastSyncedAtIso: next.lastSyncedAtIso,
      pendingRecoveryCode: next.pendingRecoveryCode,
      errorCode: next.errorCode,
      autoSyncState: next.status === 'signed_out' ? 'idle' : (next.autoSyncState ?? autoSyncState),
    });
    broadcastToListeners(listeners, state);
  };

  const persistSession = (
    session: SyncSession,
    lastSyncedAtIso: string | null,
    revision: number,
  ): Promise<void> => persistSessionRecord(options.secretStore, session, lastSyncedAtIso, revision);

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

  const adoptPairedSession = async (
    baseUrl: string,
    payload: QrPairingPayload,
  ): Promise<Result<void>> => {
    let vaultKey: Uint8Array;
    try {
      vaultKey = base64UrlDecode(payload.vaultKeyB64);
    } catch {
      return err(elvError('auth', 'invalid_vault_key'));
    }
    if (vaultKey.length !== VAULT_KEY_BYTES) {
      return err(elvError('auth', 'invalid_vault_key'));
    }
    const refreshed = await makeAuthClient(baseUrl).refresh(payload.refreshToken);
    if (!refreshed.ok) {
      setState({ ...state, errorCode: errorCodeFrom(refreshed.error) });
      return err(refreshed.error);
    }
    const refreshedUser = refreshed.value.user;
    if (
      refreshedUser === undefined ||
      typeof refreshedUser.id !== 'string' ||
      refreshedUser.id.trim().length === 0
    ) {
      setState({ ...state, errorCode: 'invalid_session' });
      return err(elvError('auth', 'invalid_session'));
    }
    const pairedSession: SyncSession = {
      user: {
        id: refreshedUser.id,
        email: refreshedUser.email.length > 0 ? refreshedUser.email : payload.email,
      },
      accessToken: refreshed.value.accessToken,
      refreshToken: refreshed.value.refreshToken,
      vaultKey,
    };
    activeSession = pairedSession;
    lastRevision = 0;
    localSnapshot = createEmptyVaultSnapshot(0);
    await options.secretStore.delete(VAULT_BASELINE_SECRET_KEY).catch(() => undefined);
    await persistSession(pairedSession, null, 0);
    setState({
      status: 'signed_in',
      email: pairedSession.user.email,
      lastSyncedAtIso: null,
      pendingRecoveryCode: null,
      errorCode: null,
    });
    return ok(undefined);
  };

  const mintPairTransferPayload = async (baseUrl: string): Promise<Result<QrPairingPayload>> => {
    const tokenRes = await ensureAccessToken(baseUrl);
    if (!tokenRes.ok) return err(elvError('auth', tokenRes.errorCode));
    let session = tokenRes.session;
    const authClient = makeAuthClient(baseUrl);
    let pairTokenRes = await authClient.issuePairRefreshToken(session.accessToken);
    if (!pairTokenRes.ok && isAuthTokenExpiredError(pairTokenRes.error)) {
      const retryToken = await ensureAccessToken(baseUrl, true);
      if (!retryToken.ok) return err(elvError('auth', retryToken.errorCode));
      session = retryToken.session;
      pairTokenRes = await authClient.issuePairRefreshToken(session.accessToken);
    }
    if (!pairTokenRes.ok) return pairTokenRes;
    return ok({
      email: session.user.email,
      refreshToken: pairTokenRes.value.refreshToken,
      vaultKeyB64: base64UrlEncode(session.vaultKey),
    });
  };

  const executeSyncNowInternal = async (): Promise<SyncActionResultIpc> => {
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

    const alreadyAppliedInitialPrefs = await hasAppliedInitialPrefs(
      options.secretStore,
      session.user.id,
    );
    let remoteInitialPrefs = pullRes.value.snapshot?.initialPreferences;
    const shouldApplyRemoteInitial =
      !alreadyAppliedInitialPrefs && remoteInitialPrefs !== undefined;

    const freshLocal = options.getLocalSnapshot ? await options.getLocalSnapshot() : localSnapshot;
    const baseLocal = options.getLocalSnapshot
      ? reconcileLocalSnapshotWithBaseline(freshLocal, localSnapshot, clock.now())
      : freshLocal;
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
      await markInitialPrefsApplied(options.secretStore, session.user.id);
    }
    lastRevision = pushRes.value.revision;
    await persistVaultBaseline(options.secretStore, cryptoPort, session, lastRevision, merged);
    const syncedIso = new Date(clock.now()).toISOString();
    await persistSession(session, syncedIso, lastRevision);
    setState({
      ...state,
      status: 'signed_in',
      lastSyncedAtIso: syncedIso,
      errorCode: null,
    });
    return { ok: true };
  };

  const syncNow = (): Promise<SyncActionResultIpc> => {
    if (activeSyncRun !== null) return activeSyncRun;
    const run = executeSyncNowInternal().finally(() => {
      if (activeSyncRun === run) activeSyncRun = null;
    });
    activeSyncRun = run;
    return run;
  };

  const autoSync = createAutoSyncScheduler({
    syncPush: () => syncNow(),
    syncPull: () => syncNow(),
    isSignedIn: () => activeSession !== null && serverUrl.length > 0,
    now: () => clock.now(),
  });
  const unsubAutoSync = autoSync.subscribe((status) => {
    const mapped = mapSchedulerState(status.state);
    if (mapped === autoSyncState) return;
    autoSyncState = mapped;
    if (state.status !== 'signed_out') {
      setState({ ...state, autoSyncState: mapped });
    }
  });

  const pairing = createBidirectionalPairingController({
    getBaseUrl: () => serverUrl,
    http,
    randomBytes: (len) => cryptoPort.randomBytes(len),
    clock,
    getLocalAuth: () => ({
      signedIn: activeSession !== null,
      email: activeSession?.user.email ?? null,
    }),
    mintPairTransferPayload,
    adoptPairedSession,
    triggerImmediateSync: async () => {
      await syncNow();
    },
    ...(options.linkOrigin !== undefined ? { linkOrigin: options.linkOrigin } : {}),
  });

  const clearLocalSession = async (): Promise<void> => {
    pairing.dispose();
    autoSync.reset();
    activeSession = null;
    lastRevision = 0;
    localSnapshot = createEmptyVaultSnapshot(0);
    qrSessions.clear();
    await Promise.all([
      options.secretStore.delete(SESSION_SECRET_KEY).catch(() => undefined),
      options.secretStore.delete(VAULT_BASELINE_SECRET_KEY).catch(() => undefined),
    ]);
    autoSyncState = 'idle';
    setState({ ...SIGNED_OUT_STATE, autoSyncState: 'idle' });
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
          ...(options.deviceProfile !== undefined ? { deviceProfile: options.deviceProfile } : {}),
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
      serverUrl = await urlCtl.hydrate();
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
      localSnapshot = await loadVaultBaseline(options.secretStore, cryptoPort, activeSession);
      if (persisted.lastSyncedAtIso !== null || persisted.lastRevision > 0) {
        await markInitialPrefsApplied(options.secretStore, persisted.userId);
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
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeInitialPreferences: (listener) => {
      initialPrefsListeners.add(listener);
      return () => {
        initialPrefsListeners.delete(listener);
      };
    },
    subscribeServerUrl: (listener) => urlCtl.subscribe(listener),
    setServerUrl: (nextUrl) => {
      serverUrl = urlCtl.set(nextUrl);
    },
    setSyncablePreferences(preferences: Readonly<Record<string, unknown>>): void {
      const sanitized = sanitizeInitialPreferencesPatch(preferences) as Record<string, unknown>;
      localSyncablePrefs = Object.keys(sanitized).length > 0 ? sanitized : undefined;
    },
    async checkEmail(email): Promise<SyncEmailCheckStatusIpc> {
      if (serverUrl.length === 0) return 'unknown';
      return makeAuthClient(serverUrl)
        .checkEmail(email)
        .catch(() => 'unknown');
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
      localSnapshot = createEmptyVaultSnapshot(0);
      await options.secretStore.delete(VAULT_BASELINE_SECRET_KEY).catch(() => undefined);
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
      localSnapshot = createEmptyVaultSnapshot(0);
      await options.secretStore.delete(VAULT_BASELINE_SECRET_KEY).catch(() => undefined);
      await persistSession(res.value.session, null, 0);
      await markInitialPrefsApplied(options.secretStore, res.value.session.user.id);
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

    syncNow,

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
      const adopted = await adoptPairedSession(serverUrl, res.value.payload);
      return adopted.ok ? 'claimed' : 'expired';
    },

    async claimQrPairing(codeOrUri): Promise<SyncActionResultIpc> {
      if (serverUrl.length === 0) return { ok: false, errorCode: 'server_not_configured' };
      if (activeSession === null) return { ok: false, errorCode: 'not_signed_in' };

      const parsed = parsePairingQrUri(codeOrUri);
      if (!parsed.ok) return { ok: false, errorCode: errorCodeFrom(parsed.error) };

      const payloadRes = await mintPairTransferPayload(serverUrl);
      if (!payloadRes.ok) return { ok: false, errorCode: errorCodeFrom(payloadRes.error) };

      const tokenRes = await ensureAccessToken(serverUrl);
      if (!tokenRes.ok) return { ok: false, errorCode: tokenRes.errorCode };
      const qrClient = makeQrClient(serverUrl);
      const runClaim = (token: string) =>
        qrClient.claimSession({
          accessToken: token,
          qrUriOrParams: parsed.value,
          payload: payloadRes.value,
        });
      let res = await runClaim(tokenRes.session.accessToken);
      if (!res.ok && isAuthTokenExpiredError(res.error)) {
        const retryToken = await ensureAccessToken(serverUrl, true);
        if (!retryToken.ok) return { ok: false, errorCode: retryToken.errorCode };
        res = await runClaim(retryToken.session.accessToken);
      }
      return res.ok ? { ok: true } : { ok: false, errorCode: errorCodeFrom(res.error) };
    },

    markSyncDirty: () => autoSync.markDirty(),
    notifySyncDirty: () => autoSync.notifyMutation(),
    notifyPlaybackPause: () => autoSync.notifyPlaybackPause(),
    notifyPlaybackExitOrSwitch: () => autoSync.notifyPlaybackExitOrSwitch(),
    setViewingActive: (active) => autoSync.setViewingActive(active),
    notifyStartup: () => autoSync.notifyStartup(),
    notifyForeground: (awayMs) => autoSync.notifyForeground(awayMs),
    notifyReconnect: () => autoSync.notifyReconnect(),
    flushBeforeBackground: (timeoutMs = 2_500) => autoSync.flushBeforeBackground(timeoutMs),

    startBidirectionalPairing: () => pairing.startBidirectionalPairing(),
    joinBidirectionalPairing: (codeOrUri) => pairing.joinBidirectionalPairing(codeOrUri),
    pollBidirectionalPairing: (pairingId) => pairing.pollBidirectionalPairing(pairingId),
    confirmBidirectionalPairing: (pairingId, chosenDirection) =>
      pairing.confirmBidirectionalPairing(pairingId, chosenDirection),
    cancelBidirectionalPairing: (pairingId) => pairing.cancelBidirectionalPairing(pairingId),

    setTelemetryOptIn(enabled: boolean): TelemetryStatusIpc {
      const next = Boolean(enabled);
      if (next && !telemetryOptIn) {
        sessionId = `s_${base64UrlEncode(cryptoPort.randomBytes(12))}`;
      }
      telemetryOptIn = next;
      if (!next) telemetryQueue.clear();
      return getTelemetryStatus();
    },

    getTelemetryStatus,

    recordTelemetry(event: TelemetryRecordRequest): void {
      if (!telemetryOptIn) return;
      getUploader().record(mapDesktopTelemetryRequestToEvent(event, clock.now()));
    },

    flushTelemetry,

    submitFeedback: (input: FeedbackSubmitRequest): Promise<FeedbackSubmitResultIpc> =>
      submitDesktopFeedbackRequest({
        serverUrl,
        http,
        platform: options.platform,
        appVersion: options.appVersion,
        ...(options.mpvVersion !== undefined ? { mpvVersion: options.mpvVersion } : {}),
        ...(options.readLogTail !== undefined ? { readLogTail: options.readLogTail } : {}),
        input,
      }),

    dispose(): void {
      if (intervalHandle !== undefined) clearInterval(intervalHandle);
      unsubAutoSync();
      autoSync.dispose();
      pairing.dispose();
      activeSession = null;
      qrSessions.clear();
      listeners.clear();
      initialPrefsListeners.clear();
      urlCtl.clearListeners();
    },
  };
}
