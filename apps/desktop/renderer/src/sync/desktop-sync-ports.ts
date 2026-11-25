import type {
  FeedbackBridge,
  FeedbackSubmitRequest,
  FeedbackSubmitResultIpc,
  SyncAccountStateIpc,
  SyncActionResultIpc,
  SyncBridge,
  SyncQrPairingSessionIpc,
  SyncQrPollStatusIpc,
  TelemetryBridge,
  TelemetryStatusIpc,
} from '../../../src/shared/sync-ipc.ts';

/** Structural `SyncAccountPort` implemented by {@link createDesktopSyncPorts} (`#26`). */
export interface DesktopSyncAccountPort {
  getState(): SyncAccountStateIpc;
  subscribe(listener: (state: SyncAccountStateIpc) => void): () => void;
  signIn(email: string, password: string): Promise<SyncActionResultIpc>;
  register(email: string, password: string, confirmPassword: string): Promise<SyncActionResultIpc>;
  acknowledgeRecoveryCode(): void;
  syncNow(): Promise<SyncActionResultIpc>;
  signOut(): Promise<void>;
  deleteAccount(password: string): Promise<SyncActionResultIpc>;
  createQrPairing(): Promise<SyncQrPairingSessionIpc>;
  pollQrPairing(pairingId: string): Promise<SyncQrPollStatusIpc>;
  claimQrPairing(codeOrUri: string): Promise<SyncActionResultIpc>;
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

/** Structural `TelemetryPort` implemented by {@link createDesktopSyncPorts} (`#458`). */
export interface DesktopTelemetryPort {
  isOptedIn(): boolean;
  setOptIn(enabled: boolean): void;
  queuedCount(): number;
  getPayloadPreviewJson(): string;
  recordScreenTransition(screen: string, durationMs: number): void;
  recordMediaDecodeFailure(meta: DesktopTelemetryMediaDecodeFailure): void;
  recordPlaybackError(meta: {
    readonly engine: string;
    readonly errorCode: string;
    readonly isLive: boolean;
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

/** Renderer Wave F9 ports bundle returned by {@link createDesktopSyncPorts}. */
export interface DesktopSyncPorts {
  readonly syncAccount?: DesktopSyncAccountPort;
  readonly telemetry?: DesktopTelemetryPort;
  readonly feedback?: DesktopFeedbackPort;
  hydrate(): Promise<void>;
  setServerUrl(serverUrl: string): Promise<void>;
  dispose(): void;
}

const INITIAL_SYNC_STATE: SyncAccountStateIpc = Object.freeze({
  status: 'signed_out',
  email: null,
  lastSyncedAtIso: null,
  pendingRecoveryCode: null,
  errorCode: null,
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
 * synchronous + async ports expected by `<AppShell>` (`#26`, `#458`). Secrets and tokens
 * remain strictly inside the Electron main process.
 */
export function createDesktopSyncPorts(bridges?: DesktopSyncBridgesInput): DesktopSyncPorts {
  const syncBridge = bridges?.sync;
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
          async signIn(email, password) {
            try {
              const res = await syncBridge.signIn(email, password);
              const next = await syncBridge.getState().catch(() => null);
              if (next && !disposed) updateSyncState(next);
              return res;
            } catch {
              return { ok: false, errorCode: 'ipc_failed' };
            }
          },
          async register(email, password, confirmPassword) {
            try {
              const res = await syncBridge.register(email, password, confirmPassword);
              const next = await syncBridge.getState().catch(() => null);
              if (next && !disposed) updateSyncState(next);
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
              const next = await syncBridge.getState().catch(() => null);
              if (next && !disposed) updateSyncState(next);
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
              const next = await syncBridge.getState().catch(() => null);
              if (next && !disposed) updateSyncState(next);
              return res;
            } catch {
              return { ok: false, errorCode: 'ipc_failed' };
            }
          },
          createQrPairing: () => syncBridge.createQrPairing(),
          pollQrPairing: async (pairingId) => {
            const status = await syncBridge.pollQrPairing(pairingId);
            if (status === 'claimed') {
              const next = await syncBridge.getState().catch(() => null);
              if (next && !disposed) updateSyncState(next);
            }
            return status;
          },
          async claimQrPairing(codeOrUri) {
            try {
              return await syncBridge.claimQrPairing(codeOrUri);
            } catch {
              return { ok: false, errorCode: 'ipc_failed' };
            }
          },
        };

  let telemetryStatus: TelemetryStatusIpc = {
    optedIn: false,
    queuedCount: 0,
    previewJson: INITIAL_PREVIEW_JSON,
  };

  const applyTelemetryStatus = (next: TelemetryStatusIpc): void => {
    if (!disposed) telemetryStatus = next;
  };

  const refreshTelemetryStatus = (): void => {
    if (!telemetryBridge || disposed) return;
    void telemetryBridge
      .getStatus()
      .then(applyTelemetryStatus)
      .catch(() => undefined);
  };

  const telemetry: DesktopTelemetryPort | undefined =
    telemetryBridge === undefined
      ? undefined
      : {
          isOptedIn: () => telemetryStatus.optedIn,
          setOptIn(enabled: boolean): void {
            const next = Boolean(enabled);
            telemetryStatus = {
              ...telemetryStatus,
              optedIn: next,
              ...(next ? {} : { queuedCount: 0 }),
            };
            void telemetryBridge
              .setOptIn(next)
              .then(applyTelemetryStatus)
              .catch(() => undefined);
          },
          queuedCount: () => telemetryStatus.queuedCount,
          getPayloadPreviewJson: () => telemetryStatus.previewJson,
          recordScreenTransition(screen: string, durationMs: number): void {
            if (!telemetryStatus.optedIn) return;
            void telemetryBridge
              .record({ kind: 'screen_transition', screen, durationMs })
              .then(refreshTelemetryStatus)
              .catch(() => undefined);
          },
          recordMediaDecodeFailure(meta: DesktopTelemetryMediaDecodeFailure): void {
            if (!telemetryStatus.optedIn) return;
            void telemetryBridge
              .record({
                kind: 'media_decode_failure',
                engine: meta.engine,
                ...(meta.container !== undefined ? { container: meta.container } : {}),
                ...(meta.videoCodec !== undefined ? { videoCodec: meta.videoCodec } : {}),
                ...(meta.audioCodec !== undefined ? { audioCodec: meta.audioCodec } : {}),
                errorCode: meta.errorCode,
                ...(meta.hdrFormat !== undefined ? { hdrFormat: meta.hdrFormat } : {}),
                isLive: meta.isLive,
              })
              .then(refreshTelemetryStatus)
              .catch(() => undefined);
          },
          recordPlaybackError(meta): void {
            if (!telemetryStatus.optedIn) return;
            void telemetryBridge
              .record({
                kind: 'playback_error',
                engine: meta.engine,
                errorCode: meta.errorCode,
                isLive: meta.isLive,
              })
              .then(refreshTelemetryStatus)
              .catch(() => undefined);
          },
          async flush(): Promise<void> {
            if (!telemetryStatus.optedIn) return;
            try {
              await telemetryBridge.flush();
              const next = await telemetryBridge.getStatus().catch(() => null);
              if (next) applyTelemetryStatus(next);
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
    async hydrate(): Promise<void> {
      if (disposed) return;
      if (syncBridge !== undefined) {
        const next = await syncBridge.getState().catch(() => null);
        if (next && !disposed) updateSyncState(next);
      }
      if (telemetryBridge !== undefined) {
        const status = await telemetryBridge.getStatus().catch(() => null);
        if (status && !disposed) applyTelemetryStatus(status);
      }
    },
    async setServerUrl(serverUrl: string): Promise<void> {
      if (!syncBridge || disposed) return;
      await syncBridge.setServerUrl(serverUrl).catch(() => undefined);
    },
    dispose(): void {
      disposed = true;
      unsubscribeBridgeState?.();
      stateListeners.clear();
    },
  };
}
