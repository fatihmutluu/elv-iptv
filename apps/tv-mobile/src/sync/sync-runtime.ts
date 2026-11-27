import {
  elvError,
  err,
  normalizeSyncServerUrl,
  ok,
  type Result,
  sanitizeInitialPreferencesPatch,
} from '@elv/domain';
import {
  base64UrlDecode,
  base64UrlEncode,
  createAutoSyncScheduler,
  createEmptyVaultSnapshot,
  createPureJsVaultCryptoPort,
  createQrPairingClient,
  createSyncAuthClient,
  mergeVaultSnapshots,
  parsePairingQrUri,
  type QrPairingPayload,
  type QrPairingSession,
  type SyncClockPort,
  type SyncSession,
  type VaultSnapshot,
} from '@elv/sync';
import { createMobileBidirectionalPairingController } from './bidirectional-pairing';
import { createMobileTelemetryAndFeedback } from './mobile-telemetry-feedback';
import { reconcileLocalSnapshotWithBaseline } from './snapshot-tombstones';
import {
  type AutoSyncState,
  type CreateTvMobileSyncPortsOptions,
  createFetchHttpPort,
  defaultCsprngBytes,
  errorCodeFrom,
  type FeedbackPort,
  initialPrefsAppliedKey,
  isAuthTokenExpiredError,
  loadVaultBaseline,
  type PersistedSessionRecord,
  parsePersistedSession,
  persistVaultBaseline,
  SESSION_SECRET_KEY,
  SIGNED_OUT_STATE,
  type SyncAccountPort,
  type SyncAccountState,
  type SyncActionResult,
  type SyncFetchFn,
  type SyncQrPairingSession,
  type TelemetryPort,
  type TvMobileSyncPorts,
  VAULT_BASELINE_SECRET_KEY,
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

function mapSchedulerState(raw: 'idle' | 'syncing' | 'pending' | 'error'): AutoSyncState {
  return raw === 'error' ? 'offline' : raw;
}

/**
 * Creates mobile & TV Wave F9/P9 runtime ports (`SyncAccountPort`, `TelemetryPort`, `FeedbackPort`)
 * using `@elv/sync` pure-JS crypto (100% Hermes-compatible), automatic background E2EE sync,
 * bidirectional X25519 pairing, unified 13-kind telemetry with `DeviceTechnicalProfile`, and
 * redacted feedback (`#26`, `#458`, `#509`, `#510`).
 */
export function createTvMobileSyncPorts(
  options: CreateTvMobileSyncPortsOptions,
): TvMobileSyncPorts {
  const randomBytes = options.randomBytes ?? defaultCsprngBytes;
  const clock: SyncClockPort = options.clock ?? { now: () => Date.now() };
  const cryptoPort = options.crypto ?? createPureJsVaultCryptoPort(randomBytes);
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
    const normalizedPref =
      typeof fromPref === 'string' && fromPref.trim().length > 0
        ? normalizeSyncServerUrl(fromPref, '')
        : '';
    if (normalizedPref.length > 0) return normalizedPref;
    return normalizeSyncServerUrl(options.getServerUrl(), '');
  };

  let autoSyncState: AutoSyncState = 'idle';
  let state: SyncAccountState = SIGNED_OUT_STATE;
  const listeners = new Set<(next: SyncAccountState) => void>();
  let activeSession: SyncSession | null = null;
  let lastRevision = 0;
  let localSnapshot: VaultSnapshot = createEmptyVaultSnapshot(0);
  let activeSyncRun: Promise<SyncActionResult> | null = null;
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

  const setState = (next: SyncAccountState): void => {
    state = Object.freeze({
      ...next,
      autoSyncState: next.status === 'signed_out' ? 'idle' : (next.autoSyncState ?? autoSyncState),
    });
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

  const executeSyncNowInternal = async (): Promise<SyncActionResult> => {
    const baseUrl = resolveBaseUrl();
    if (baseUrl.length === 0) return { ok: false, errorCode: 'server_not_configured' };
    if (activeSession === null) return { ok: false, errorCode: 'not_signed_in' };

    setState({ ...state, status: 'syncing', errorCode: null });
    const client = makeAuthClient(baseUrl);
    const tokenRes = await ensureAccessToken(baseUrl);
    if (!tokenRes.ok) {
      setState({ ...state, status: 'signed_in', errorCode: tokenRes.errorCode });
      return { ok: false, errorCode: tokenRes.errorCode };
    }
    let session = tokenRes.session;

    let pullRes = await client.pullVault(session);
    if (!pullRes.ok && isAuthTokenExpiredError(pullRes.error)) {
      const retryToken = await ensureAccessToken(baseUrl, true);
      if (!retryToken.ok) {
        setState({ ...state, status: 'signed_in', errorCode: retryToken.errorCode });
        return { ok: false, errorCode: retryToken.errorCode };
      }
      session = retryToken.session;
      pullRes = await client.pullVault(session);
    }
    if (!pullRes.ok) {
      const code = errorCodeFrom(pullRes.error);
      setState({ ...state, status: 'signed_in', errorCode: code });
      return { ok: false, errorCode: code };
    }

    const alreadyAppliedInitialPrefs = await hasAppliedInitialPrefs(session.user.id);
    let remoteInitialPrefs = pullRes.value.snapshot?.initialPreferences;
    const shouldApplyRemoteInitial =
      !alreadyAppliedInitialPrefs && remoteInitialPrefs !== undefined;

    const freshLocal = options.getLocalSnapshot ? await options.getLocalSnapshot() : localSnapshot;
    const baseLocal = options.getLocalSnapshot
      ? reconcileLocalSnapshotWithBaseline(freshLocal, localSnapshot, clock.now())
      : freshLocal;
    const rawLocalSeed =
      !shouldApplyRemoteInitial && options.getSyncablePreferences
        ? options.getSyncablePreferences()
        : undefined;
    const sanitizedLocalSeed =
      rawLocalSeed !== undefined
        ? (sanitizeInitialPreferencesPatch(rawLocalSeed) as Record<string, unknown>)
        : undefined;
    const currentLocal: VaultSnapshot =
      sanitizedLocalSeed !== undefined && Object.keys(sanitizedLocalSeed).length > 0
        ? {
            ...baseLocal,
            initialPreferences: sanitizedLocalSeed,
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
        const code = errorCodeFrom(retryPull.error);
        setState({ ...state, status: 'signed_in', errorCode: code });
        return { ok: false, errorCode: code };
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
      const code = pushRes.ok ? 'sync_conflict' : errorCodeFrom(pushRes.error);
      setState({ ...state, status: 'signed_in', errorCode: code });
      return { ok: false, errorCode: code };
    }

    localSnapshot = merged;
    await options.applyMergedSnapshot?.(merged);
    if (!alreadyAppliedInitialPrefs) {
      if (remoteInitialPrefs !== undefined) {
        const patch = sanitizeInitialPreferencesPatch(remoteInitialPrefs);
        if (Object.keys(patch).length > 0) {
          await options.applyInitialPreferences?.(patch);
        }
      }
      await markInitialPrefsApplied(session.user.id);
    }
    lastRevision = pushRes.value.revision;
    await persistVaultBaseline(options.secretStore, cryptoPort, session, lastRevision, merged);
    const syncedIso = new Date(clock.now()).toISOString();
    await persistSession(session, syncedIso, lastRevision);
    setState({ ...state, status: 'signed_in', lastSyncedAtIso: syncedIso, errorCode: null });
    return { ok: true };
  };

  const syncNow = (): Promise<SyncActionResult> => {
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
    isSignedIn: () => activeSession !== null && resolveBaseUrl().length > 0,
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

  const pairing = createMobileBidirectionalPairingController({
    getBaseUrl: resolveBaseUrl,
    http,
    randomBytes,
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
    setState(SIGNED_OUT_STATE);
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
    localSnapshot = await loadVaultBaseline(options.secretStore, cryptoPort, activeSession);
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
      localSnapshot = createEmptyVaultSnapshot(0);
      await options.secretStore.delete(VAULT_BASELINE_SECRET_KEY).catch(() => undefined);
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

    syncNow,

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
      const tokenRes = await ensureAccessToken(baseUrl);
      if (!tokenRes.ok) {
        setState({ ...state, errorCode: tokenRes.errorCode });
        return { ok: false, errorCode: tokenRes.errorCode };
      }
      let session = tokenRes.session;
      let res = await client.deleteAccount(session.accessToken, session.user.email, password);
      if (!res.ok && isAuthTokenExpiredError(res.error)) {
        const retryToken = await ensureAccessToken(baseUrl, true);
        if (!retryToken.ok) {
          setState({ ...state, errorCode: retryToken.errorCode });
          return { ok: false, errorCode: retryToken.errorCode };
        }
        session = retryToken.session;
        res = await client.deleteAccount(session.accessToken, session.user.email, password);
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
      const adopted = await adoptPairedSession(baseUrl, res.value.payload);
      return adopted.ok ? 'claimed' : 'expired';
    },

    async claimQrPairing(codeOrUri): Promise<SyncActionResult> {
      const baseUrl = resolveBaseUrl();
      if (baseUrl.length === 0) return { ok: false, errorCode: 'server_not_configured' };
      if (activeSession === null) return { ok: false, errorCode: 'not_signed_in' };

      const parsed = parsePairingQrUri(codeOrUri);
      if (!parsed.ok) return { ok: false, errorCode: errorCodeFrom(parsed.error) };

      const payloadRes = await mintPairTransferPayload(baseUrl);
      if (!payloadRes.ok) return { ok: false, errorCode: errorCodeFrom(payloadRes.error) };

      const tokenRes = await ensureAccessToken(baseUrl);
      if (!tokenRes.ok) return { ok: false, errorCode: tokenRes.errorCode };
      const qrClient = makeQrClient(baseUrl);
      const runClaim = (token: string) =>
        qrClient.claimSession({
          accessToken: token,
          qrUriOrParams: parsed.value,
          payload: payloadRes.value,
        });
      let claimRes = await runClaim(tokenRes.session.accessToken);
      if (!claimRes.ok && isAuthTokenExpiredError(claimRes.error)) {
        const retryToken = await ensureAccessToken(baseUrl, true);
        if (!retryToken.ok) return { ok: false, errorCode: retryToken.errorCode };
        claimRes = await runClaim(retryToken.session.accessToken);
      }
      return claimRes.ok ? { ok: true } : { ok: false, errorCode: errorCodeFrom(claimRes.error) };
    },

    markSyncDirty: () => autoSync.markDirty(),
    notifySyncDirty: () => autoSync.notifyMutation(),
    notifyPlaybackPause: () => autoSync.notifyPlaybackPause(),
    notifyPlaybackExitOrSwitch: () => autoSync.notifyPlaybackExitOrSwitch(),
    setViewingActive: (active) => autoSync.setViewingActive(active),
    startBidirectionalPairing: () => pairing.startBidirectionalPairing(),
    joinBidirectionalPairing: (codeOrUri) => pairing.joinBidirectionalPairing(codeOrUri),
    pollBidirectionalPairing: (pairingId) => pairing.pollBidirectionalPairing(pairingId),
    confirmBidirectionalPairing: (pairingId, chosenDirection) =>
      pairing.confirmBidirectionalPairing(pairingId, chosenDirection),
    cancelBidirectionalPairing: (pairingId) => pairing.cancelBidirectionalPairing(pairingId),
  };

  const telemetryFeedback = createMobileTelemetryAndFeedback({
    resolveBaseUrl,
    http,
    clock,
    randomBytes,
    options,
  });

  let backgroundedAt: number | null = null;
  const unsubscribeAppState = options.subscribeAppState?.((nextState) => {
    if (nextState === 'background' || nextState === 'inactive') {
      if (backgroundedAt === null) backgroundedAt = clock.now();
      void autoSync.flushBeforeBackground(2_500);
      telemetryFeedback.flushIfOptedIn();
    } else if (nextState === 'active' && backgroundedAt !== null) {
      const awayMs = Math.max(0, clock.now() - backgroundedAt);
      backgroundedAt = null;
      autoSync.notifyForeground(awayMs);
    }
  });

  return {
    syncAccount,
    telemetry: telemetryFeedback.telemetry,
    feedback: telemetryFeedback.feedback,
    hydrate,
    notifyStartup: () => autoSync.notifyStartup(),
    notifyForeground: (awayMs) => autoSync.notifyForeground(awayMs),
    notifyReconnect: () => autoSync.notifyReconnect(),
    flushBeforeBackground: (timeoutMs = 2_500) => autoSync.flushBeforeBackground(timeoutMs),
    dispose() {
      telemetryFeedback.dispose();
      unsubscribeAppState?.();
      unsubAutoSync();
      autoSync.dispose();
      pairing.dispose();
      listeners.clear();
      qrSessions.clear();
    },
  };
}
