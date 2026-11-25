import {
  type FeedbackSubmitResultIpc,
  isFeedbackSubmitRequest,
  isSyncClaimQrRequest,
  isSyncDeleteAccountRequest,
  isSyncPollQrRequest,
  isSyncRegisterRequest,
  isSyncSetServerUrlRequest,
  isSyncSignInRequest,
  isTelemetryRecordRequest,
  isTelemetrySetOptInRequest,
  SYNC_CHANNELS,
  type SyncAccountStateIpc,
  type SyncActionResultIpc,
  type SyncQrPairingSessionIpc,
  type SyncQrPollStatusIpc,
  type TelemetryStatusIpc,
} from '../../shared/sync-ipc.ts';
import { isAllowedDevNavigation } from '../dev-server.ts';
import { isAllowedAppNavigation } from '../security.ts';
import type { DesktopSyncService } from './sync-service.ts';

interface SenderFrameLike {
  readonly url?: string;
  readonly top?: unknown;
}

interface SenderWebContentsLike {
  isDestroyed?(): boolean;
  getURL?(): string;
  send?(channel: string, ...args: unknown[]): void;
}

interface SyncIpcEventLike {
  readonly sender?: SenderWebContentsLike;
  readonly senderFrame?: SenderFrameLike | null;
}

type SyncIpcHandler = (event: SyncIpcEventLike, ...args: unknown[]) => unknown;

/** Minimal `ipcMain` surface used by {@link registerSyncIpc}. */
interface SyncIpcMainLike {
  handle(channel: string, listener: SyncIpcHandler): void;
  removeHandler(channel: string): void;
}

/** Collaborators injected into {@link registerSyncIpc}. */
export interface RegisterSyncIpcDeps {
  readonly ipcMain: SyncIpcMainLike;
  readonly service: DesktopSyncService;
  readonly getBroadcastTargets?: () => readonly SenderWebContentsLike[];
  readonly devOrigin?: string | null;
  readonly log?: (line: string) => void;
}

/**
 * Verifies an IPC event originated from the top-level trusted `app://elv` (or dev) frame.
 * Fails closed when `event.senderFrame` is `null` or missing (never falls back to `event.sender.getURL()`).
 */
export function isTrustedSyncIpcEvent(event: SyncIpcEventLike, devOrigin?: string | null): boolean {
  const frame = event.senderFrame;
  if (frame === null || frame === undefined) return false;
  if (frame.top !== undefined && frame.top !== frame) return false;
  const url = typeof frame.url === 'string' ? frame.url : '';
  if (url.length === 0) return false;
  if (isAllowedAppNavigation(url)) return true;
  if (devOrigin !== null && devOrigin !== undefined && devOrigin.length > 0) {
    return isAllowedDevNavigation(url, devOrigin);
  }
  return false;
}

function sanitizeStateForIpc(state: SyncAccountStateIpc): SyncAccountStateIpc {
  return {
    status: state.status,
    email: state.email,
    lastSyncedAtIso: state.lastSyncedAtIso,
    pendingRecoveryCode: state.pendingRecoveryCode,
    errorCode: state.errorCode,
  };
}

function sanitizeActionResultForIpc(res: SyncActionResultIpc): SyncActionResultIpc {
  return {
    ok: Boolean(res.ok),
    ...(res.recoveryCode !== undefined ? { recoveryCode: res.recoveryCode } : {}),
    ...(res.errorCode !== undefined ? { errorCode: res.errorCode } : {}),
  };
}

function sanitizeQrSessionForIpc(session: SyncQrPairingSessionIpc): SyncQrPairingSessionIpc {
  return {
    pairingId: session.pairingId,
    code: session.code,
    qrUri: session.qrUri,
    expiresAtMs: session.expiresAtMs,
    status: session.status,
  };
}

function sanitizeFeedbackResultForIpc(res: FeedbackSubmitResultIpc): FeedbackSubmitResultIpc {
  return {
    ok: Boolean(res.ok),
    ...(res.id !== undefined ? { id: res.id } : {}),
    ...(res.errorCode !== undefined ? { errorCode: res.errorCode } : {}),
  };
}

/**
 * Registers all Wave F9 sync, telemetry, and feedback IPC handlers on `ipcMain` (`#26`, `#458`).
 * Enforces sender frame/origin checks, strict runtime payload guards, and allowlisted response
 * projection so raw tokens and vault keys never cross IPC. Returns the disposer.
 */
export function registerSyncIpc(deps: RegisterSyncIpcDeps): () => void {
  const { ipcMain, service, devOrigin, log } = deps;

  const assertTrusted = (event: SyncIpcEventLike, channel: string): void => {
    if (!isTrustedSyncIpcEvent(event, devOrigin)) {
      log?.(`sync ipc: rejected untrusted sender on ${channel}`);
      throw new Error(`untrusted sender for ${channel}`);
    }
  };

  const broadcastState = (state: SyncAccountStateIpc): void => {
    const safe = sanitizeStateForIpc(state);
    const targets = deps.getBroadcastTargets?.() ?? [];
    for (const target of targets) {
      if (target.isDestroyed?.()) continue;
      const url = target.getURL?.() ?? '';
      const allowed =
        isAllowedAppNavigation(url) ||
        (devOrigin !== null &&
          devOrigin !== undefined &&
          devOrigin.length > 0 &&
          isAllowedDevNavigation(url, devOrigin));
      if (!allowed) continue;
      try {
        target.send?.(SYNC_CHANNELS.stateChanged, safe);
      } catch {
        // Ignore racing window teardown.
      }
    }
  };

  const unsubscribeState = service.subscribe(broadcastState);

  ipcMain.handle(SYNC_CHANNELS.getState, (event): SyncAccountStateIpc => {
    assertTrusted(event, SYNC_CHANNELS.getState);
    return sanitizeStateForIpc(service.getState());
  });

  ipcMain.handle(SYNC_CHANNELS.signIn, async (event, raw): Promise<SyncActionResultIpc> => {
    assertTrusted(event, SYNC_CHANNELS.signIn);
    if (!isSyncSignInRequest(raw)) {
      log?.(`sync ipc: dropped invalid ${SYNC_CHANNELS.signIn} payload`);
      throw new Error(`invalid ${SYNC_CHANNELS.signIn} payload`);
    }
    return sanitizeActionResultForIpc(await service.signIn(raw.email, raw.password));
  });

  ipcMain.handle(SYNC_CHANNELS.register, async (event, raw): Promise<SyncActionResultIpc> => {
    assertTrusted(event, SYNC_CHANNELS.register);
    if (!isSyncRegisterRequest(raw)) {
      log?.(`sync ipc: dropped invalid ${SYNC_CHANNELS.register} payload`);
      throw new Error(`invalid ${SYNC_CHANNELS.register} payload`);
    }
    return sanitizeActionResultForIpc(
      await service.register(raw.email, raw.password, raw.confirmPassword),
    );
  });

  ipcMain.handle(SYNC_CHANNELS.ackRecovery, (event): void => {
    assertTrusted(event, SYNC_CHANNELS.ackRecovery);
    service.acknowledgeRecoveryCode();
  });

  ipcMain.handle(SYNC_CHANNELS.syncNow, async (event): Promise<SyncActionResultIpc> => {
    assertTrusted(event, SYNC_CHANNELS.syncNow);
    return sanitizeActionResultForIpc(await service.syncNow());
  });

  ipcMain.handle(SYNC_CHANNELS.signOut, async (event): Promise<void> => {
    assertTrusted(event, SYNC_CHANNELS.signOut);
    await service.signOut();
  });

  ipcMain.handle(SYNC_CHANNELS.deleteAccount, async (event, raw): Promise<SyncActionResultIpc> => {
    assertTrusted(event, SYNC_CHANNELS.deleteAccount);
    if (!isSyncDeleteAccountRequest(raw)) {
      log?.(`sync ipc: dropped invalid ${SYNC_CHANNELS.deleteAccount} payload`);
      throw new Error(`invalid ${SYNC_CHANNELS.deleteAccount} payload`);
    }
    return sanitizeActionResultForIpc(await service.deleteAccount(raw.password));
  });

  ipcMain.handle(SYNC_CHANNELS.createQr, async (event): Promise<SyncQrPairingSessionIpc> => {
    assertTrusted(event, SYNC_CHANNELS.createQr);
    return sanitizeQrSessionForIpc(await service.createQrPairing());
  });

  ipcMain.handle(SYNC_CHANNELS.pollQr, async (event, raw): Promise<SyncQrPollStatusIpc> => {
    assertTrusted(event, SYNC_CHANNELS.pollQr);
    if (!isSyncPollQrRequest(raw)) {
      log?.(`sync ipc: dropped invalid ${SYNC_CHANNELS.pollQr} payload`);
      throw new Error(`invalid ${SYNC_CHANNELS.pollQr} payload`);
    }
    return service.pollQrPairing(raw.pairingId);
  });

  ipcMain.handle(SYNC_CHANNELS.claimQr, async (event, raw): Promise<SyncActionResultIpc> => {
    assertTrusted(event, SYNC_CHANNELS.claimQr);
    if (!isSyncClaimQrRequest(raw)) {
      log?.(`sync ipc: dropped invalid ${SYNC_CHANNELS.claimQr} payload`);
      throw new Error(`invalid ${SYNC_CHANNELS.claimQr} payload`);
    }
    return sanitizeActionResultForIpc(await service.claimQrPairing(raw.codeOrUri));
  });

  ipcMain.handle(SYNC_CHANNELS.setServerUrl, (event, raw): void => {
    assertTrusted(event, SYNC_CHANNELS.setServerUrl);
    if (!isSyncSetServerUrlRequest(raw)) {
      log?.(`sync ipc: dropped invalid ${SYNC_CHANNELS.setServerUrl} payload`);
      throw new Error(`invalid ${SYNC_CHANNELS.setServerUrl} payload`);
    }
    service.setServerUrl(raw.serverUrl);
  });

  ipcMain.handle(SYNC_CHANNELS.telemetrySetOptIn, (event, raw): TelemetryStatusIpc => {
    assertTrusted(event, SYNC_CHANNELS.telemetrySetOptIn);
    if (!isTelemetrySetOptInRequest(raw)) {
      log?.(`sync ipc: dropped invalid ${SYNC_CHANNELS.telemetrySetOptIn} payload`);
      throw new Error(`invalid ${SYNC_CHANNELS.telemetrySetOptIn} payload`);
    }
    return service.setTelemetryOptIn(raw.enabled);
  });

  ipcMain.handle(SYNC_CHANNELS.telemetryGetStatus, (event): TelemetryStatusIpc => {
    assertTrusted(event, SYNC_CHANNELS.telemetryGetStatus);
    return service.getTelemetryStatus();
  });

  ipcMain.handle(SYNC_CHANNELS.telemetryRecord, (event, raw): void => {
    assertTrusted(event, SYNC_CHANNELS.telemetryRecord);
    if (!isTelemetryRecordRequest(raw)) {
      log?.(`sync ipc: dropped invalid ${SYNC_CHANNELS.telemetryRecord} payload`);
      throw new Error(`invalid ${SYNC_CHANNELS.telemetryRecord} payload`);
    }
    service.recordTelemetry(raw);
  });

  ipcMain.handle(SYNC_CHANNELS.telemetryFlush, async (event): Promise<void> => {
    assertTrusted(event, SYNC_CHANNELS.telemetryFlush);
    await service.flushTelemetry();
  });

  ipcMain.handle(
    SYNC_CHANNELS.feedbackSubmit,
    async (event, raw): Promise<FeedbackSubmitResultIpc> => {
      assertTrusted(event, SYNC_CHANNELS.feedbackSubmit);
      if (!isFeedbackSubmitRequest(raw)) {
        log?.(`sync ipc: dropped invalid ${SYNC_CHANNELS.feedbackSubmit} payload`);
        throw new Error(`invalid ${SYNC_CHANNELS.feedbackSubmit} payload`);
      }
      return sanitizeFeedbackResultForIpc(await service.submitFeedback(raw));
    },
  );

  const registeredChannels: readonly string[] = [
    SYNC_CHANNELS.getState,
    SYNC_CHANNELS.signIn,
    SYNC_CHANNELS.register,
    SYNC_CHANNELS.ackRecovery,
    SYNC_CHANNELS.syncNow,
    SYNC_CHANNELS.signOut,
    SYNC_CHANNELS.deleteAccount,
    SYNC_CHANNELS.createQr,
    SYNC_CHANNELS.pollQr,
    SYNC_CHANNELS.claimQr,
    SYNC_CHANNELS.setServerUrl,
    SYNC_CHANNELS.telemetrySetOptIn,
    SYNC_CHANNELS.telemetryGetStatus,
    SYNC_CHANNELS.telemetryRecord,
    SYNC_CHANNELS.telemetryFlush,
    SYNC_CHANNELS.feedbackSubmit,
  ];

  return () => {
    unsubscribeState();
    for (const channel of registeredChannels) {
      ipcMain.removeHandler(channel);
    }
    service.dispose();
  };
}
