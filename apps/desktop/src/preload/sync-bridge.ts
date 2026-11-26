import {
  type FeedbackBridge,
  type FeedbackSubmitRequest,
  type FeedbackSubmitResultIpc,
  isFeedbackSubmitRequest,
  isFeedbackSubmitResult,
  isSyncAccountState,
  isSyncActionResult,
  isSyncClaimQrRequest,
  isSyncDeleteAccountRequest,
  isSyncInitialPrefsPayload,
  isSyncPollQrRequest,
  isSyncQrPairingSession,
  isSyncQrPollStatus,
  isSyncRegisterRequest,
  isSyncSetServerUrlRequest,
  isSyncSetSyncablePrefsRequest,
  isSyncSignInRequest,
  isTelemetryRecordRequest,
  isTelemetrySetOptInRequest,
  isTelemetryStatus,
  SYNC_CHANNELS,
  type SyncAccountStateIpc,
  type SyncActionResultIpc,
  type SyncBridge,
  type SyncQrPairingSessionIpc,
  type SyncQrPollStatusIpc,
  type TelemetryBridge,
  type TelemetryRecordRequest,
  type TelemetryStatusIpc,
} from '../shared/sync-ipc.ts';

/** Subset of Electron's `ipcRenderer` used by {@link createSyncBridges}. */
export interface SyncIpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

/** Frozen preload bridges exposed as `window.elv.{sync,telemetry,feedback}` (`#26`, `#458`). */
export interface DesktopSyncPreloadBridges {
  readonly sync: SyncBridge;
  readonly telemetry: TelemetryBridge;
  readonly feedback: FeedbackBridge;
}

/**
 * Builds frozen `window.elv.sync`, `window.elv.telemetry`, and `window.elv.feedback` bridges
 * inside the sandboxed Electron preload (`#26`, `#458`). Validates every request and reply.
 */
export function createSyncBridges(ipc: SyncIpcRendererLike): DesktopSyncPreloadBridges {
  const sync: SyncBridge = Object.freeze({
    async getState(): Promise<SyncAccountStateIpc> {
      const reply = await ipc.invoke(SYNC_CHANNELS.getState);
      if (!isSyncAccountState(reply)) {
        throw new Error(`${SYNC_CHANNELS.getState} returned an unexpected reply`);
      }
      return reply;
    },

    onStateChanged(listener: (state: SyncAccountStateIpc) => void): () => void {
      const wrapped = (_event: unknown, payload: unknown): void => {
        if (!isSyncAccountState(payload)) return;
        try {
          listener(payload);
        } catch {
          // Isolate renderer listener failures.
        }
      };
      ipc.on(SYNC_CHANNELS.stateChanged, wrapped);
      return () => {
        ipc.removeListener(SYNC_CHANNELS.stateChanged, wrapped);
      };
    },

    async signIn(email: string, password: string): Promise<SyncActionResultIpc> {
      const payload = { email, password };
      if (!isSyncSignInRequest(payload)) {
        throw new Error(`${SYNC_CHANNELS.signIn} received invalid credentials payload`);
      }
      const reply = await ipc.invoke(SYNC_CHANNELS.signIn, payload);
      if (!isSyncActionResult(reply)) {
        throw new Error(`${SYNC_CHANNELS.signIn} returned an unexpected reply`);
      }
      return reply;
    },

    async register(
      email: string,
      password: string,
      confirmPassword: string,
    ): Promise<SyncActionResultIpc> {
      const payload = { email, password, confirmPassword };
      if (!isSyncRegisterRequest(payload)) {
        throw new Error(`${SYNC_CHANNELS.register} received invalid registration payload`);
      }
      const reply = await ipc.invoke(SYNC_CHANNELS.register, payload);
      if (!isSyncActionResult(reply)) {
        throw new Error(`${SYNC_CHANNELS.register} returned an unexpected reply`);
      }
      return reply;
    },

    async acknowledgeRecoveryCode(): Promise<void> {
      await ipc.invoke(SYNC_CHANNELS.ackRecovery);
    },

    async syncNow(): Promise<SyncActionResultIpc> {
      const reply = await ipc.invoke(SYNC_CHANNELS.syncNow);
      if (!isSyncActionResult(reply)) {
        throw new Error(`${SYNC_CHANNELS.syncNow} returned an unexpected reply`);
      }
      return reply;
    },

    async signOut(): Promise<void> {
      await ipc.invoke(SYNC_CHANNELS.signOut);
    },

    async deleteAccount(password: string): Promise<SyncActionResultIpc> {
      const payload = { password };
      if (!isSyncDeleteAccountRequest(payload)) {
        throw new Error(`${SYNC_CHANNELS.deleteAccount} received invalid payload`);
      }
      const reply = await ipc.invoke(SYNC_CHANNELS.deleteAccount, payload);
      if (!isSyncActionResult(reply)) {
        throw new Error(`${SYNC_CHANNELS.deleteAccount} returned an unexpected reply`);
      }
      return reply;
    },

    async createQrPairing(): Promise<SyncQrPairingSessionIpc> {
      const reply = await ipc.invoke(SYNC_CHANNELS.createQr);
      if (!isSyncQrPairingSession(reply)) {
        throw new Error(`${SYNC_CHANNELS.createQr} returned an unexpected reply`);
      }
      return reply;
    },

    async pollQrPairing(pairingId: string): Promise<SyncQrPollStatusIpc> {
      const payload = { pairingId };
      if (!isSyncPollQrRequest(payload)) {
        throw new Error(`${SYNC_CHANNELS.pollQr} received invalid pairingId`);
      }
      const reply = await ipc.invoke(SYNC_CHANNELS.pollQr, payload);
      if (!isSyncQrPollStatus(reply)) {
        throw new Error(`${SYNC_CHANNELS.pollQr} returned an unexpected reply`);
      }
      return reply;
    },

    async claimQrPairing(codeOrUri: string): Promise<SyncActionResultIpc> {
      const payload = { codeOrUri };
      if (!isSyncClaimQrRequest(payload)) {
        throw new Error(`${SYNC_CHANNELS.claimQr} received invalid pairing code`);
      }
      const reply = await ipc.invoke(SYNC_CHANNELS.claimQr, payload);
      if (!isSyncActionResult(reply)) {
        throw new Error(`${SYNC_CHANNELS.claimQr} returned an unexpected reply`);
      }
      return reply;
    },

    async setServerUrl(serverUrl: string): Promise<void> {
      const payload = { serverUrl };
      if (!isSyncSetServerUrlRequest(payload)) {
        throw new Error(`${SYNC_CHANNELS.setServerUrl} received invalid server URL`);
      }
      await ipc.invoke(SYNC_CHANNELS.setServerUrl, payload);
    },

    async setSyncablePreferences(preferences: Readonly<Record<string, unknown>>): Promise<void> {
      const payload = { preferences };
      if (!isSyncSetSyncablePrefsRequest(payload)) {
        throw new Error(`${SYNC_CHANNELS.setSyncablePrefs} received invalid preferences payload`);
      }
      await ipc.invoke(SYNC_CHANNELS.setSyncablePrefs, payload);
    },

    onInitialPreferencesReceived(
      listener: (preferences: Readonly<Record<string, unknown>>) => void,
    ): () => void {
      const wrapped = (_event: unknown, payload: unknown): void => {
        if (!isSyncInitialPrefsPayload(payload)) return;
        try {
          listener(payload);
        } catch {
          // Isolate renderer listener failures.
        }
      };
      ipc.on(SYNC_CHANNELS.initialPrefsReceived, wrapped);
      return () => {
        ipc.removeListener(SYNC_CHANNELS.initialPrefsReceived, wrapped);
      };
    },
  });

  const telemetry: TelemetryBridge = Object.freeze({
    async setOptIn(enabled: boolean): Promise<TelemetryStatusIpc> {
      const payload = { enabled };
      if (!isTelemetrySetOptInRequest(payload)) {
        throw new Error(`${SYNC_CHANNELS.telemetrySetOptIn} received invalid enabled flag`);
      }
      const reply = await ipc.invoke(SYNC_CHANNELS.telemetrySetOptIn, payload);
      if (!isTelemetryStatus(reply)) {
        throw new Error(`${SYNC_CHANNELS.telemetrySetOptIn} returned an unexpected reply`);
      }
      return reply;
    },

    async getStatus(): Promise<TelemetryStatusIpc> {
      const reply = await ipc.invoke(SYNC_CHANNELS.telemetryGetStatus);
      if (!isTelemetryStatus(reply)) {
        throw new Error(`${SYNC_CHANNELS.telemetryGetStatus} returned an unexpected reply`);
      }
      return reply;
    },

    async record(event: TelemetryRecordRequest): Promise<void> {
      if (!isTelemetryRecordRequest(event)) {
        throw new Error(`${SYNC_CHANNELS.telemetryRecord} received invalid event payload`);
      }
      await ipc.invoke(SYNC_CHANNELS.telemetryRecord, event);
    },

    async flush(): Promise<void> {
      await ipc.invoke(SYNC_CHANNELS.telemetryFlush);
    },
  });

  const feedback: FeedbackBridge = Object.freeze({
    async submit(input: FeedbackSubmitRequest): Promise<FeedbackSubmitResultIpc> {
      if (!isFeedbackSubmitRequest(input)) {
        throw new Error(`${SYNC_CHANNELS.feedbackSubmit} received invalid feedback payload`);
      }
      const reply = await ipc.invoke(SYNC_CHANNELS.feedbackSubmit, input);
      if (!isFeedbackSubmitResult(reply)) {
        throw new Error(`${SYNC_CHANNELS.feedbackSubmit} returned an unexpected reply`);
      }
      return reply;
    },
  });

  return Object.freeze({ sync, telemetry, feedback });
}
