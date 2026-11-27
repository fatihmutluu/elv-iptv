import { type PreferencesPatch, redactText, sanitizeInitialPreferencesPatch } from '@elv/domain';
import type {
  BidirectionalPairingSnapshotIpc,
  FeedbackBridge,
  FeedbackSubmitRequest,
  FeedbackSubmitResultIpc,
  SyncAccountStateIpc,
  SyncActionResultIpc,
  SyncBridge,
  SyncQrPairingSessionIpc,
  SyncQrPollStatusIpc,
  TelemetryBridge,
  TelemetryRecordRequest,
  TelemetryStatusIpc,
} from '../../../src/shared/sync-ipc.ts';

/** Supported third-party OAuth providers when store credentials are configured (`#513`). */
type DesktopOAuthProviderId = 'google' | 'apple';

/** Result of checking whether an email already has a sync account (`#513`). */
type DesktopEmailCheckStatus = 'exists' | 'not_found' | 'unknown';

type DesktopSyncBridgeWithCheckEmail = SyncBridge & {
  checkEmail?(email: string): Promise<DesktopEmailCheckStatus>;
};

const EMPTY_OAUTH_PROVIDERS: readonly DesktopOAuthProviderId[] = Object.freeze([]);

/** Structural `SyncAccountPort` implemented by {@link createDesktopSyncPorts} (`#26`, `#510`, `#513`). */
export interface DesktopSyncAccountPort {
  getState(): SyncAccountStateIpc;
  subscribe(listener: (state: SyncAccountStateIpc) => void): () => void;
  checkEmail(email: string): Promise<DesktopEmailCheckStatus>;
  readonly supportedOAuthProviders: readonly DesktopOAuthProviderId[];
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
  startBidirectionalPairing(): Promise<BidirectionalPairingSnapshotIpc>;
  joinBidirectionalPairing(codeOrUri: string): Promise<BidirectionalPairingSnapshotIpc>;
  pollBidirectionalPairing(pairingId: string): Promise<BidirectionalPairingSnapshotIpc>;
  confirmBidirectionalPairing(
    pairingId: string,
    chosenDirection?: 'host_to_responder' | 'responder_to_host',
  ): Promise<SyncActionResultIpc>;
  cancelBidirectionalPairing(pairingId: string): Promise<void>;
}

/** Structural `TelemetryMediaDecodeFailure` payload (`#458`, `#70`). */
interface DesktopTelemetryMediaDecodeFailure {
  readonly engine: string;
  readonly container?: string;
  readonly videoCodec?: string;
  readonly audioCodec?: string;
  readonly errorCode: string;
  readonly hdrFormat?: string;
  readonly isLive: boolean;
}

/** Structural `TelemetryPort` supporting all 13 event kinds (`#458`, `#509`). */
export interface DesktopTelemetryPort {
  isOptedIn(): boolean;
  setOptIn(enabled: boolean): void;
  queuedCount(): number;
  getPayloadPreviewJson(): string;
  subscribe?(listener: (status: TelemetryStatusIpc) => void): () => void;
  recordScreenTransition(screen: string, durationMs: number): void;
  recordMediaDecodeFailure(meta: DesktopTelemetryMediaDecodeFailure): void;
  recordPlaybackError(meta: {
    readonly engine: string;
    readonly errorCode: string;
    readonly isLive: boolean;
  }): void;
  recordStartup(durationMs: number, coldStart: boolean): void;
  recordPlaybackStart(meta: {
    readonly engine: string;
    readonly ttffMs: number;
    readonly isLive: boolean;
    readonly container?: string;
    readonly videoCodec?: string;
  }): void;
  recordPlaybackRebuffer(meta: {
    readonly engine: string;
    readonly durationMs: number;
    readonly isLive: boolean;
  }): void;
  recordCatalogImport(meta: {
    readonly sourceKind: string;
    readonly stage: string;
    readonly durationMs: number;
    readonly itemCount: number;
    readonly success: boolean;
    readonly errorCode?: string;
  }): void;
  recordSqliteSlowOp(meta: { readonly op: string; readonly durationMs: number }): void;
  recordFrameJank(meta: {
    readonly screen: string;
    readonly droppedFrames: number;
    readonly maxFrameMs: number;
  }): void;
  recordJsStall(meta: { readonly screen: string; readonly durationMs: number }): void;
  recordMemoryPressure(meta: {
    readonly level: 'moderate' | 'critical';
    readonly usedMb?: number;
  }): void;
  recordAppCrash(meta: {
    readonly errorName: string;
    readonly stackSig: string;
    readonly screen?: string;
    readonly fatal: boolean;
    readonly uptimeMs?: number;
  }): void;
  recordUnhandledError(meta: {
    readonly errorName: string;
    readonly stackSig: string;
    readonly screen?: string;
    readonly source?: string;
  }): void;
  flush(): Promise<void>;
}

/** Structural `FeedbackPort` implemented by {@link createDesktopSyncPorts} (`#458`). */
export interface DesktopFeedbackPort {
  submit(input: FeedbackSubmitRequest): Promise<FeedbackSubmitResultIpc>;
}

/** Preload bridges subset passed into {@link createDesktopSyncPorts}. */
export interface DesktopSyncBridgesInput {
  readonly sync?: SyncBridge;
  readonly telemetry?: TelemetryBridge;
  readonly feedback?: FeedbackBridge;
}

/** Renderer Wave F9/P9 ports bundle returned by {@link createDesktopSyncPorts}. */
export interface DesktopSyncPorts {
  readonly syncAccount?: DesktopSyncAccountPort;
  readonly telemetry?: DesktopTelemetryPort;
  readonly feedback?: DesktopFeedbackPort;
  onTelemetryStatusChanged(listener: (status: TelemetryStatusIpc) => void): () => void;
  onInitialPreferences(listener: (patch: PreferencesPatch) => void): () => void;
  onPairDeepLink(listener: (uri: string) => void): () => void;
  consumePendingPairUri(): Promise<string | null>;
  notifyReconnect(): void;
  hydrate(): Promise<void>;
  setServerUrl(serverUrl: string): Promise<void>;
  setSyncablePreferences(preferences: Readonly<Record<string, unknown>>): Promise<void>;
  dispose(): void;
}

const INITIAL_SYNC_STATE: SyncAccountStateIpc = Object.freeze({
  status: 'signed_out',
  email: null,
  lastSyncedAtIso: null,
  pendingRecoveryCode: null,
  errorCode: null,
  autoSyncState: 'idle',
});

const INITIAL_PREVIEW_JSON = JSON.stringify(
  {
    schemaVersion: 1,
    sessionId: 'anonymous',
    platform: 'desktop',
    appVersion: '0.0.0',
    sentAt: 0,
    events: [],
  },
  null,
  2,
);

/**
 * Adapts the sandboxed preload bridges (`window.elv.{sync,telemetry,feedback}`) into the
 * synchronous + async ports expected by `<AppShell>` (`#26`, `#458`, `#509`, `#510`).
 */
export function createDesktopSyncPorts(bridges?: DesktopSyncBridgesInput): DesktopSyncPorts {
  const syncBridge: DesktopSyncBridgeWithCheckEmail | undefined = bridges?.sync;
  const telemetryBridge = bridges?.telemetry;
  const feedbackBridge = bridges?.feedback;

  let disposed = false;
  let syncState: SyncAccountStateIpc = INITIAL_SYNC_STATE;
  const stateListeners = new Set<(state: SyncAccountStateIpc) => void>();

  const updateSyncState = (next: SyncAccountStateIpc): void => {
    syncState = Object.freeze({ ...next });
    for (const listener of [...stateListeners]) {
      try {
        listener(syncState);
      } catch {
        // Isolate subscriber failures.
      }
    }
  };

  const unsubscribeBridgeState = syncBridge?.onStateChanged((next) => {
    if (!disposed) updateSyncState(next);
  });

  const initialPrefsListeners = new Set<(patch: PreferencesPatch) => void>();
  const unsubscribeBridgeInitialPrefs = syncBridge?.onInitialPreferencesReceived?.((raw) => {
    if (disposed) return;
    const patch = sanitizeInitialPreferencesPatch(raw);
    if (Object.keys(patch).length === 0) return;
    for (const listener of [...initialPrefsListeners]) {
      try {
        listener(patch);
      } catch {
        // Isolate subscriber failures.
      }
    }
  });

  const pairDeepLinkListeners = new Set<(uri: string) => void>();
  const unsubscribeBridgePairDeepLink = syncBridge?.onPairDeepLink?.((uri) => {
    if (disposed) return;
    for (const listener of [...pairDeepLinkListeners]) {
      try {
        listener(uri);
      } catch {
        // Isolate subscriber failures.
      }
    }
  });

  const refreshSyncState = async (): Promise<void> => {
    if (!syncBridge) return;
    const next = await syncBridge.getState().catch(() => null);
    if (next && !disposed) updateSyncState(next);
  };

  const syncAccount: DesktopSyncAccountPort | undefined =
    syncBridge === undefined
      ? undefined
      : {
          getState: () => syncState,
          subscribe(listener) {
            stateListeners.add(listener);
            return () => {
              stateListeners.delete(listener);
            };
          },
          supportedOAuthProviders: EMPTY_OAUTH_PROVIDERS,
          async checkEmail(email) {
            if (!syncBridge.checkEmail) return 'unknown';
            try {
              const status = await syncBridge.checkEmail(email);
              return status === 'exists' || status === 'not_found' ? status : 'unknown';
            } catch {
              return 'unknown';
            }
          },
          async signIn(email, password) {
            try {
              const res = await syncBridge.signIn(email, password);
              await refreshSyncState();
              return res;
            } catch {
              return { ok: false, errorCode: 'ipc_failed' };
            }
          },
          async register(email, password, confirmPassword) {
            try {
              const res = await syncBridge.register(email, password, confirmPassword);
              await refreshSyncState();
              return res;
            } catch {
              return { ok: false, errorCode: 'ipc_failed' };
            }
          },
          acknowledgeRecoveryCode() {
            if (syncState.pendingRecoveryCode !== null) {
              updateSyncState({ ...syncState, pendingRecoveryCode: null });
            }
            void syncBridge.acknowledgeRecoveryCode().catch(() => undefined);
          },
          async syncNow() {
            try {
              const res = await syncBridge.syncNow();
              await refreshSyncState();
              return res;
            } catch {
              return { ok: false, errorCode: 'ipc_failed' };
            }
          },
          async signOut() {
            try {
              await syncBridge.signOut();
            } finally {
              if (!disposed) updateSyncState(INITIAL_SYNC_STATE);
            }
          },
          async deleteAccount(password) {
            try {
              const res = await syncBridge.deleteAccount(password);
              await refreshSyncState();
              return res;
            } catch {
              return { ok: false, errorCode: 'ipc_failed' };
            }
          },
          createQrPairing: () => syncBridge.createQrPairing(),
          pollQrPairing: async (pairingId) => {
            const status = await syncBridge.pollQrPairing(pairingId);
            if (status === 'claimed') await refreshSyncState();
            return status;
          },
          async claimQrPairing(codeOrUri) {
            try {
              return await syncBridge.claimQrPairing(codeOrUri);
            } catch {
              return { ok: false, errorCode: 'ipc_failed' };
            }
          },
          markSyncDirty() {
            void syncBridge.markSyncDirty?.().catch(() => undefined);
          },
          notifySyncDirty() {
            void syncBridge.notifySyncDirty?.().catch(() => undefined);
          },
          notifyPlaybackPause() {
            void syncBridge.notifyPlaybackPause?.().catch(() => undefined);
          },
          notifyPlaybackExitOrSwitch() {
            void syncBridge.notifyPlaybackExitOrSwitch?.().catch(() => undefined);
          },
          setViewingActive(active: boolean) {
            void syncBridge.setViewingActive?.(active).catch(() => undefined);
          },
          async startBidirectionalPairing() {
            if (!syncBridge.startBidirectionalPairing) {
              throw new Error('bidirectional_pairing_unsupported');
            }
            return syncBridge.startBidirectionalPairing();
          },
          async joinBidirectionalPairing(codeOrUri) {
            if (!syncBridge.joinBidirectionalPairing) {
              throw new Error('bidirectional_pairing_unsupported');
            }
            const snap = await syncBridge.joinBidirectionalPairing(codeOrUri);
            if (snap.status === 'completed') await refreshSyncState();
            return snap;
          },
          async pollBidirectionalPairing(pairingId) {
            if (!syncBridge.pollBidirectionalPairing) {
              throw new Error('bidirectional_pairing_unsupported');
            }
            const snap = await syncBridge.pollBidirectionalPairing(pairingId);
            if (snap.status === 'completed') await refreshSyncState();
            return snap;
          },
          async confirmBidirectionalPairing(pairingId, chosenDirection) {
            if (!syncBridge.confirmBidirectionalPairing) {
              return { ok: false, errorCode: 'bidirectional_pairing_unsupported' };
            }
            try {
              const res = await syncBridge.confirmBidirectionalPairing(pairingId, chosenDirection);
              await refreshSyncState();
              return res;
            } catch {
              return { ok: false, errorCode: 'ipc_failed' };
            }
          },
          async cancelBidirectionalPairing(pairingId) {
            await syncBridge.cancelBidirectionalPairing?.(pairingId).catch(() => undefined);
          },
        };

  let telemetryStatus: TelemetryStatusIpc = Object.freeze({
    optedIn: false,
    queuedCount: 0,
    previewJson: INITIAL_PREVIEW_JSON,
  });
  let telemetryMutationSeq = 0;
  const telemetryListeners = new Set<(status: TelemetryStatusIpc) => void>();

  const applyTelemetryStatus = (next: TelemetryStatusIpc): void => {
    if (disposed) return;
    telemetryStatus = Object.freeze({
      optedIn: Boolean(next.optedIn),
      queuedCount: next.queuedCount,
      previewJson: next.previewJson,
    });
    for (const listener of [...telemetryListeners]) {
      try {
        listener(telemetryStatus);
      } catch {
        // Isolate subscriber failures.
      }
    }
  };

  const subscribeTelemetryStatus = (
    listener: (status: TelemetryStatusIpc) => void,
  ): (() => void) => {
    telemetryListeners.add(listener);
    return () => {
      telemetryListeners.delete(listener);
    };
  };

  const refreshTelemetryStatus = (expectedSeq: number): void => {
    if (!telemetryBridge || disposed) return;
    void telemetryBridge
      .getStatus()
      .then((next) => {
        if (!disposed && expectedSeq === telemetryMutationSeq) {
          applyTelemetryStatus(next);
        }
      })
      .catch(() => undefined);
  };

  const emitTelemetry = (req: TelemetryRecordRequest): void => {
    if (!telemetryBridge || !telemetryStatus.optedIn) return;
    const seq = telemetryMutationSeq;
    void telemetryBridge
      .record(req)
      .then(() => refreshTelemetryStatus(seq))
      .catch(() => undefined);
  };

  const telemetry: DesktopTelemetryPort | undefined =
    telemetryBridge === undefined
      ? undefined
      : {
          isOptedIn: () => telemetryStatus.optedIn,
          setOptIn(enabled: boolean): void {
            const next = Boolean(enabled);
            const seq = ++telemetryMutationSeq;
            applyTelemetryStatus({
              ...telemetryStatus,
              optedIn: next,
              ...(next ? {} : { queuedCount: 0 }),
            });
            void telemetryBridge
              .setOptIn(next)
              .then((status) => {
                if (!disposed && seq === telemetryMutationSeq) {
                  applyTelemetryStatus(status);
                }
              })
              .catch(() => undefined);
          },
          queuedCount: () => telemetryStatus.queuedCount,
          getPayloadPreviewJson: () => telemetryStatus.previewJson,
          subscribe: subscribeTelemetryStatus,
          recordScreenTransition: (screen, durationMs) =>
            emitTelemetry({ kind: 'screen_transition', screen, durationMs }),
          recordMediaDecodeFailure: (meta) =>
            emitTelemetry({
              kind: 'media_decode_failure',
              engine: meta.engine,
              ...(meta.container !== undefined ? { container: meta.container } : {}),
              ...(meta.videoCodec !== undefined ? { videoCodec: meta.videoCodec } : {}),
              ...(meta.audioCodec !== undefined ? { audioCodec: meta.audioCodec } : {}),
              errorCode: meta.errorCode,
              ...(meta.hdrFormat !== undefined ? { hdrFormat: meta.hdrFormat } : {}),
              isLive: meta.isLive,
            }),
          recordPlaybackError: (meta) =>
            emitTelemetry({
              kind: 'playback_error',
              engine: meta.engine,
              errorCode: meta.errorCode,
              isLive: meta.isLive,
            }),
          recordStartup: (durationMs, coldStart) =>
            emitTelemetry({ kind: 'startup', durationMs, coldStart }),
          recordPlaybackStart: (meta) =>
            emitTelemetry({
              kind: 'playback_start',
              engine: meta.engine,
              ttffMs: meta.ttffMs,
              isLive: meta.isLive,
              ...(meta.container !== undefined ? { container: meta.container } : {}),
              ...(meta.videoCodec !== undefined ? { videoCodec: meta.videoCodec } : {}),
            }),
          recordPlaybackRebuffer: (meta) =>
            emitTelemetry({
              kind: 'playback_rebuffer',
              engine: meta.engine,
              durationMs: meta.durationMs,
              isLive: meta.isLive,
            }),
          recordCatalogImport: (meta) =>
            emitTelemetry({
              kind: 'catalog_import',
              sourceKind: meta.sourceKind,
              stage: meta.stage,
              durationMs: meta.durationMs,
              itemCount: meta.itemCount,
              success: meta.success,
              ...(meta.errorCode !== undefined ? { errorCode: meta.errorCode } : {}),
            }),
          recordSqliteSlowOp: (meta) =>
            emitTelemetry({ kind: 'sqlite_slow_op', op: meta.op, durationMs: meta.durationMs }),
          recordFrameJank: (meta) =>
            emitTelemetry({
              kind: 'frame_jank',
              screen: meta.screen,
              droppedFrames: meta.droppedFrames,
              maxFrameMs: meta.maxFrameMs,
            }),
          recordJsStall: (meta) =>
            emitTelemetry({ kind: 'js_stall', screen: meta.screen, durationMs: meta.durationMs }),
          recordMemoryPressure: (meta) =>
            emitTelemetry({
              kind: 'memory_pressure',
              level: meta.level,
              ...(meta.usedMb !== undefined ? { usedMb: meta.usedMb } : {}),
            }),
          recordAppCrash: (meta) =>
            emitTelemetry({
              kind: 'app_crash',
              errorName: meta.errorName,
              stackSig: meta.stackSig,
              ...(meta.screen !== undefined ? { screen: meta.screen } : {}),
              fatal: meta.fatal,
              ...(meta.uptimeMs !== undefined ? { uptimeMs: meta.uptimeMs } : {}),
            }),
          recordUnhandledError: (meta) =>
            emitTelemetry({
              kind: 'unhandled_error',
              errorName: meta.errorName,
              stackSig: meta.stackSig,
              ...(meta.screen !== undefined ? { screen: meta.screen } : {}),
              ...(meta.source !== undefined ? { source: meta.source } : {}),
            }),
          async flush(): Promise<void> {
            if (!telemetryStatus.optedIn) return;
            const seq = telemetryMutationSeq;
            try {
              await telemetryBridge.flush();
              const next = await telemetryBridge.getStatus().catch(() => null);
              if (next && !disposed && seq === telemetryMutationSeq) {
                applyTelemetryStatus(next);
              }
            } catch {
              // Swallow flush errors; main uploader applies backoff.
            }
          },
        };

  const feedback: DesktopFeedbackPort | undefined =
    feedbackBridge === undefined
      ? undefined
      : {
          async submit(input) {
            try {
              return await feedbackBridge.submit(input);
            } catch {
              return { ok: false, errorCode: 'ipc_failed' };
            }
          },
        };

  return {
    ...(syncAccount !== undefined ? { syncAccount } : {}),
    ...(telemetry !== undefined ? { telemetry } : {}),
    ...(feedback !== undefined ? { feedback } : {}),
    onTelemetryStatusChanged: subscribeTelemetryStatus,
    onInitialPreferences(listener: (patch: PreferencesPatch) => void): () => void {
      initialPrefsListeners.add(listener);
      return () => {
        initialPrefsListeners.delete(listener);
      };
    },
    onPairDeepLink(listener: (uri: string) => void): () => void {
      pairDeepLinkListeners.add(listener);
      return () => {
        pairDeepLinkListeners.delete(listener);
      };
    },
    async consumePendingPairUri(): Promise<string | null> {
      if (!syncBridge?.consumePendingPairUri || disposed) return null;
      return syncBridge.consumePendingPairUri().catch(() => null);
    },
    notifyReconnect(): void {
      if (disposed) return;
      void syncBridge?.notifyReconnect?.().catch(() => undefined);
    },
    async hydrate(): Promise<void> {
      if (disposed) return;
      if (syncBridge !== undefined) {
        const next = await syncBridge.getState().catch(() => null);
        if (next && !disposed) updateSyncState(next);
      }
      if (telemetryBridge !== undefined) {
        const seqBefore = telemetryMutationSeq;
        const status = await telemetryBridge.getStatus().catch(() => null);
        if (status && !disposed && seqBefore === telemetryMutationSeq) {
          applyTelemetryStatus(status);
        }
      }
    },
    async setServerUrl(serverUrl: string): Promise<void> {
      if (!syncBridge || disposed) return;
      await syncBridge.setServerUrl(serverUrl).catch(() => undefined);
    },
    async setSyncablePreferences(preferences: Readonly<Record<string, unknown>>): Promise<void> {
      if (!syncBridge?.setSyncablePreferences || disposed) return;
      await syncBridge.setSyncablePreferences(preferences).catch(() => undefined);
    },
    dispose(): void {
      disposed = true;
      unsubscribeBridgeState?.();
      unsubscribeBridgeInitialPrefs?.();
      unsubscribeBridgePairDeepLink?.();
      stateListeners.clear();
      initialPrefsListeners.clear();
      pairDeepLinkListeners.clear();
      telemetryListeners.clear();
    },
  };
}

const RENDERER_CODE_FRAME_RE = /\b([A-Za-z0-9._-]+\.(?:js|mjs|cjs|ts|tsx|jsx|bundle|hbc)):(\d+)/;
const RENDERER_CODE_FILE_RE = /\b([A-Za-z0-9._-]+\.(?:js|mjs|cjs|ts|tsx|jsx|bundle|hbc))\b/;
const RENDERER_IPV4_RE =
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|1?\d\d?)(?::\d{1,5})?\b/g;

function redactRendererText(raw: string, maxLen: number): string {
  const preStripped = raw
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)\]]+/gi, '[redacted-url]')
    .replace(/\bfile:[^\s'"<>)\]]+/gi, '[redacted-path]')
    .replace(/\b[A-Za-z]:[\\/]+Users[\\/]+[^\s'"<>)\]]+/gi, '[redacted-path]')
    .replace(/\b[A-Za-z]:\\[^\s'"<>)\]]+/g, '[redacted-path]')
    .replace(/\\\\[A-Za-z0-9_.-]+\\[^\s'"<>)\]]+/g, '[redacted-path]')
    .replace(
      /(^|[\s"'(=:|,])\/(?:Users|home|var|tmp|private|data|storage)\/[^\s'"<>)\]]+/g,
      '$1[redacted-path]',
    )
    .replace(
      /(^|[\s"'(=:|,])[^\s/:@]{1,128}:[^\s/:@]{1,128}@[^\s/:@"'<>)\]]+/g,
      '$1[redacted-cred]',
    )
    .replace(/\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/g, '[redacted-email]')
    .replace(RENDERER_IPV4_RE, '[redacted-ip]');
  return redactText(preStripped).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

/**
 * Extracts a strictly redacted `(errorName, stackSig)` pair for renderer telemetry, redacting
 * raw stack/filename text BEFORE matching code-bundle frames so provider URLs never leak (`#509`).
 */
export function extractSafeRendererErrorSignature(
  error: unknown,
  fallbackFilename?: string,
  fallbackLineno?: number,
): { readonly errorName: string; readonly stackSig: string } {
  const errObj = error instanceof Error ? error : undefined;
  const rawName = errObj ? errObj.name : 'Error';
  const errorName =
    redactRendererText(rawName, 64)
      .replace(/\//g, '.')
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/^[^A-Za-z0-9]+/, '')
      .slice(0, 64) || 'Error';

  let frameToken = '';
  if (typeof errObj?.stack === 'string' && errObj.stack.length > 0) {
    const lines = errObj.stack.split(/\r?\n/);
    const scanLines = lines.length > 1 ? lines.slice(1) : lines;
    for (const line of scanLines) {
      const redactedLine = redactRendererText(line, 512);
      const match = RENDERER_CODE_FRAME_RE.exec(redactedLine);
      if (match !== null) {
        frameToken = `${match[1]}:${match[2]}`;
        break;
      }
    }
  }
  if (
    frameToken.length === 0 &&
    typeof fallbackFilename === 'string' &&
    fallbackFilename.length > 0
  ) {
    const redactedFile = redactRendererText(fallbackFilename, 512);
    const fileMatch = RENDERER_CODE_FILE_RE.exec(redactedFile);
    if (fileMatch !== null) {
      const lineNo =
        typeof fallbackLineno === 'number' && Number.isFinite(fallbackLineno) && fallbackLineno > 0
          ? Math.floor(fallbackLineno)
          : 0;
      frameToken = `${fileMatch[1]}:${lineNo}`;
    }
  }
  const candidate = frameToken.length > 0 ? frameToken : errorName;
  const stackSig =
    redactRendererText(candidate, 128)
      .replace(/[^A-Za-z0-9._:/+-]/g, '_')
      .replace(/^[^A-Za-z0-9]+/, '')
      .slice(0, 128) || 'renderer:0';
  return { errorName, stackSig };
}
