import { webcrypto } from 'node:crypto';
import { normalizeSyncServerUrl, redactText, type SecretStore } from '@elv/domain';
import {
  base64UrlDecode,
  base64UrlEncode,
  createEmptyVaultSnapshot,
  createQrPairingClient,
  createSyncAuthClient,
  createTelemetryQueue,
  createTelemetryUploader,
  createWebCryptoVaultPort,
  mergeVaultSnapshots,
  parsePairingQrUri,
  type QrPairingSession,
  type SyncClockPort,
  type SyncHttpPort,
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

const SESSION_SECRET_KEY = 'elv.sync.session.v1';
const VAULT_KEY_BYTES = 32;
const DEFAULT_FLUSH_INTERVAL_MS = 60_000;
const FEEDBACK_LOG_TAIL_LINES = 25;

/** Minimal Fetch signature accepted by {@link createDesktopSyncService}. */
export type DesktopSyncFetchFn = (
  input: string,
  init?: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  },
) => Promise<{
  readonly status: number;
  text(): Promise<string>;
}>;

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
}

/** Electron main-process E2EE sync, telemetry, and feedback service (`#26`, `#458`). */
export interface DesktopSyncService {
  hydrate(): Promise<void>;
  getState(): SyncAccountStateIpc;
  subscribe(listener: (state: SyncAccountStateIpc) => void): () => void;
  setServerUrl(serverUrl: string): void;
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

interface PersistedSessionRecord {
  readonly userId: string;
  readonly email: string;
  readonly refreshToken: string;
  readonly vaultKeyB64: string;
  readonly lastSyncedAtIso: string | null;
  readonly lastRevision: number;
}

const SIGNED_OUT_STATE: SyncAccountStateIpc = Object.freeze({
  status: 'signed_out',
  email: null,
  lastSyncedAtIso: null,
  pendingRecoveryCode: null,
  errorCode: null,
});

function createNodeWebCryptoPort(): VaultCryptoPort {
  return createWebCryptoVaultPort(webcrypto.subtle as unknown as SubtleCrypto, (arr) =>
    webcrypto.getRandomValues(arr),
  );
}

function createFetchHttpPort(fetchFn: DesktopSyncFetchFn): SyncHttpPort {
  return {
    async request(req) {
      const res = await fetchFn(req.url, {
        method: req.method,
        ...(req.headers !== undefined ? { headers: req.headers } : {}),
        ...(req.body !== undefined ? { body: req.body } : {}),
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
      });
      return { status: res.status, bodyText: await res.text() };
    },
  };
}

function parsePersistedSession(raw: string | undefined): PersistedSessionRecord | null {
  if (raw === undefined || raw.length === 0) return null;
  try {
    const obj: unknown = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
    const rec = obj as Record<string, unknown>;
    if (
      typeof rec.userId !== 'string' ||
      rec.userId.length === 0 ||
      typeof rec.email !== 'string' ||
      rec.email.length === 0 ||
      typeof rec.refreshToken !== 'string' ||
      rec.refreshToken.length === 0 ||
      typeof rec.vaultKeyB64 !== 'string' ||
      rec.vaultKeyB64.length === 0
    ) {
      return null;
    }
    if (base64UrlDecode(rec.vaultKeyB64).length !== VAULT_KEY_BYTES) return null;
    return {
      userId: rec.userId,
      email: rec.email,
      refreshToken: rec.refreshToken,
      vaultKeyB64: rec.vaultKeyB64,
      lastSyncedAtIso: typeof rec.lastSyncedAtIso === 'string' ? rec.lastSyncedAtIso : null,
      lastRevision:
        typeof rec.lastRevision === 'number' &&
        Number.isInteger(rec.lastRevision) &&
        rec.lastRevision >= 0
          ? rec.lastRevision
          : 0,
    };
  } catch {
    return null;
  }
}

function errorCodeFrom(error: { readonly code: string; readonly detail?: string }): string {
  return error.detail !== undefined && error.detail.length > 0 ? error.detail : error.code;
}

function redactDiagnosticsLine(line: string): string {
  return redactText(line.replace(/\bhttps?:\/\/\S+/gi, '<redacted-url>'));
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
  let activeSession: SyncSession | null = null;
  let lastRevision = 0;
  let localSnapshot: VaultSnapshot = createEmptyVaultSnapshot(0);
  const qrSessions = new Map<string, QrPairingSession>();

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

    setServerUrl(nextUrl: string): void {
      serverUrl = normalizeSyncServerUrl(nextUrl, '');
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
      let session = await ensureAccessToken(serverUrl);
      if (session === null) {
        setState({ ...state, status: 'signed_in', errorCode: 'session_expired' });
        return { ok: false, errorCode: 'session_expired' };
      }

      let pullRes = await client.pullVault(session);
      if (!pullRes.ok && pullRes.error.code === 'auth') {
        session = await ensureAccessToken(serverUrl, true);
        if (session !== null) pullRes = await client.pullVault(session);
      }
      if (!pullRes.ok || session === null) {
        const errorCode = pullRes.ok ? 'session_expired' : errorCodeFrom(pullRes.error);
        setState({ ...state, status: 'signed_in', errorCode });
        return { ok: false, errorCode };
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
          const errorCode = errorCodeFrom(retryPull.error);
          setState({ ...state, status: 'signed_in', errorCode });
          return { ok: false, errorCode };
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
      let session = await ensureAccessToken(serverUrl);
      if (session === null) {
        setState({ ...state, errorCode: 'session_expired' });
        return { ok: false, errorCode: 'session_expired' };
      }
      let res = await client.deleteAccount(session.accessToken, session.user.email, password);
      if (!res.ok && res.error.code === 'auth' && res.error.detail === 'unauthorized') {
        session = await ensureAccessToken(serverUrl, true);
        if (session !== null) {
          res = await client.deleteAccount(session.accessToken, session.user.email, password);
        }
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

    async claimQrPairing(codeOrUri): Promise<SyncActionResultIpc> {
      if (serverUrl.length === 0) return { ok: false, errorCode: 'server_not_configured' };
      if (activeSession === null) return { ok: false, errorCode: 'not_signed_in' };

      const parsed = parsePairingQrUri(codeOrUri);
      if (!parsed.ok) return { ok: false, errorCode: errorCodeFrom(parsed.error) };

      const session = await ensureAccessToken(serverUrl);
      if (session === null) return { ok: false, errorCode: 'session_expired' };

      const res = await makeQrClient(serverUrl).claimSession({
        accessToken: session.accessToken,
        qrUriOrParams: parsed.value,
        payload: {
          email: session.user.email,
          refreshToken: session.refreshToken,
          vaultKeyB64: base64UrlEncode(session.vaultKey),
        },
      });
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
    },
  };
}
