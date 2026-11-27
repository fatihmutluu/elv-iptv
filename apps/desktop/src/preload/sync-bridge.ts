import {
  type BidirectionalPairingSnapshotIpc,
  type FeedbackBridge,
  type FeedbackSubmitRequest,
  type FeedbackSubmitResultIpc,
  isBidirectionalPairingSnapshot,
  isFeedbackSubmitRequest,
  isFeedbackSubmitResult,
  isPairDeepLinkUri,
  isSyncAccountState,
  isSyncActionResult,
  isSyncClaimQrRequest,
  isSyncDeleteAccountRequest,
  isSyncInitialPrefsPayload,
  isSyncPairConfirmRequest,
  isSyncPairJoinRequest,
  isSyncPairPollRequest,
  isSyncPollQrRequest,
  isSyncQrPairingSession,
  isSyncQrPollStatus,
  isSyncRegisterRequest,
  isSyncSetServerUrlRequest,
  isSyncSetSyncablePrefsRequest,
  isSyncSetViewingActiveRequest,
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

/** Frozen preload bridges exposed as `window.elv.{sync,telemetry,feedback}` (`#26`, `#458`, `#509`, `#510`). */
export interface DesktopSyncPreloadBridges {
  readonly sync: SyncBridge;
  readonly telemetry: TelemetryBridge;
  readonly feedback: FeedbackBridge;
}

/**
 * Builds frozen `window.elv.sync`, `window.elv.telemetry`, and `window.elv.feedback` bridges
 * inside the sandboxed Electron preload. Validates every request and reply.
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

    async markSyncDirty(): Promise<void> {
      await ipc.invoke(SYNC_CHANNELS.markSyncDirty);
    },

    async notifySyncDirty(): Promise<void> {
      await ipc.invoke(SYNC_CHANNELS.notifySyncDirty);
    },

    async notifyPlaybackPause(): Promise<void> {
      await ipc.invoke(SYNC_CHANNELS.notifyPlaybackPause);
    },

    async notifyPlaybackExitOrSwitch(): Promise<void> {
      await ipc.invoke(SYNC_CHANNELS.notifyPlaybackExitOrSwitch);
    },

    async setViewingActive(active: boolean): Promise<void> {
      const payload = { active };
      if (!isSyncSetViewingActiveRequest(payload)) {
        throw new Error(`${SYNC_CHANNELS.setViewingActive} received invalid active flag`);
      }
      await ipc.invoke(SYNC_CHANNELS.setViewingActive, payload);
    },

    async notifyReconnect(): Promise<void> {
      await ipc.invoke(SYNC_CHANNELS.notifyReconnect);
    },

    async startBidirectionalPairing(): Promise<BidirectionalPairingSnapshotIpc> {
      const reply = await ipc.invoke(SYNC_CHANNELS.pairStart);
      if (!isBidirectionalPairingSnapshot(reply)) {
        throw new Error(`${SYNC_CHANNELS.pairStart} returned an unexpected reply`);
      }
      return reply;
    },

    async joinBidirectionalPairing(codeOrUri: string): Promise<BidirectionalPairingSnapshotIpc> {
      const payload = { codeOrUri };
      if (!isSyncPairJoinRequest(payload)) {
        throw new Error(`${SYNC_CHANNELS.pairJoin} received invalid codeOrUri`);
      }
      const reply = await ipc.invoke(SYNC_CHANNELS.pairJoin, payload);
      if (!isBidirectionalPairingSnapshot(reply)) {
        throw new Error(`${SYNC_CHANNELS.pairJoin} returned an unexpected reply`);
      }
      return reply;
    },

    async pollBidirectionalPairing(pairingId: string): Promise<BidirectionalPairingSnapshotIpc> {
      const payload = { pairingId };
      if (!isSyncPairPollRequest(payload)) {
        throw new Error(`${SYNC_CHANNELS.pairPoll} received invalid pairingId`);
      }
      const reply = await ipc.invoke(SYNC_CHANNELS.pairPoll, payload);
      if (!isBidirectionalPairingSnapshot(reply)) {
        throw new Error(`${SYNC_CHANNELS.pairPoll} returned an unexpected reply`);
      }
      return reply;
    },

    async confirmBidirectionalPairing(
      pairingId: string,
      chosenDirection?: 'host_to_responder' | 'responder_to_host',
    ): Promise<SyncActionResultIpc> {
      const payload =
        chosenDirection !== undefined ? { pairingId, chosenDirection } : { pairingId };
      if (!isSyncPairConfirmRequest(payload)) {
        throw new Error(`${SYNC_CHANNELS.pairConfirm} received invalid payload`);
      }
      const reply = await ipc.invoke(SYNC_CHANNELS.pairConfirm, payload);
      if (!isSyncActionResult(reply)) {
        throw new Error(`${SYNC_CHANNELS.pairConfirm} returned an unexpected reply`);
      }
      return reply;
    },

    async cancelBidirectionalPairing(pairingId: string): Promise<void> {
      const payload = { pairingId };
      if (!isSyncPairPollRequest(payload)) {
        throw new Error(`${SYNC_CHANNELS.pairCancel} received invalid pairingId`);
      }
      await ipc.invoke(SYNC_CHANNELS.pairCancel, payload);
    },

    async consumePendingPairUri(): Promise<string | null> {
      const reply = await ipc.invoke(SYNC_CHANNELS.consumePendingPairUri);
      if (reply === null) return null;
      return isPairDeepLinkUri(reply) ? reply : null;
    },

    onPairDeepLink(listener: (uri: string) => void): () => void {
      const wrapped = (_event: unknown, payload: unknown): void => {
        if (!isPairDeepLinkUri(payload)) return;
        try {
          listener(payload);
        } catch {
          // Isolate renderer listener failures.
        }
      };
      ipc.on(SYNC_CHANNELS.pairDeepLink, wrapped);
      return () => {
        ipc.removeListener(SYNC_CHANNELS.pairDeepLink, wrapped);
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
