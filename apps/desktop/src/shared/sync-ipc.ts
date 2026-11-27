import { isValidSyncServerUrl } from '@elv/domain';
import {
  type AutoSyncStateIpc,
  type BidirectionalPairingSnapshotIpc,
  type BidirectionalPairingStatusIpc,
  isBidirectionalPairingSnapshot,
  isPairDeepLinkUri,
  isSyncPairConfirmRequest,
  isSyncPairJoinRequest,
  isSyncPairPollRequest,
  isSyncSetViewingActiveRequest,
  isTelemetryRecordRequest,
  type TelemetryRecordRequest,
  VALID_AUTO_SYNC_STATES,
} from './sync-ipc-p9-guards.ts';

export {
  type AutoSyncStateIpc,
  type BidirectionalPairingSnapshotIpc,
  type BidirectionalPairingStatusIpc,
  isBidirectionalPairingSnapshot,
  isPairDeepLinkUri,
  isSyncPairConfirmRequest,
  isSyncPairJoinRequest,
  isSyncPairPollRequest,
  isSyncSetViewingActiveRequest,
  isTelemetryRecordRequest,
  type TelemetryRecordRequest,
};

/** Strictly allowlisted Electron IPC channels for Wave F9/P9 E2EE sync, pairing, telemetry, and feedback (`#26`, `#458`, `#509`, `#510`). */
export const SYNC_CHANNELS = Object.freeze({
  getState: 'sync:getState',
  checkEmail: 'sync:check-email',
  signIn: 'sync:signIn',
  register: 'sync:register',
  ackRecovery: 'sync:ackRecovery',
  syncNow: 'sync:syncNow',
  signOut: 'sync:signOut',
  deleteAccount: 'sync:deleteAccount',
  createQr: 'sync:createQr',
  pollQr: 'sync:pollQr',
  claimQr: 'sync:claimQr',
  setServerUrl: 'sync:setServerUrl',
  setSyncablePrefs: 'sync:setSyncablePrefs',
  initialPrefsReceived: 'sync:initialPrefsReceived',
  stateChanged: 'sync:stateChanged',
  markSyncDirty: 'sync:markSyncDirty',
  notifySyncDirty: 'sync:notifySyncDirty',
  notifyPlaybackPause: 'sync:notifyPlaybackPause',
  notifyPlaybackExitOrSwitch: 'sync:notifyPlaybackExitOrSwitch',
  setViewingActive: 'sync:setViewingActive',
  notifyReconnect: 'sync:notifyReconnect',
  pairStart: 'sync:pairStart',
  pairJoin: 'sync:pairJoin',
  pairPoll: 'sync:pairPoll',
  pairConfirm: 'sync:pairConfirm',
  pairCancel: 'sync:pairCancel',
  consumePendingPairUri: 'sync:consumePendingPairUri',
  pairDeepLink: 'sync:pairDeepLink',
  telemetrySetOptIn: 'telemetry:setOptIn',
  telemetryGetStatus: 'telemetry:getStatus',
  telemetryRecord: 'telemetry:record',
  telemetryFlush: 'telemetry:flush',
  feedbackSubmit: 'feedback:submit',
} as const);

type SyncAccountStatusIpc = 'signed_out' | 'signing_in' | 'signed_in' | 'syncing';

export interface SyncAccountStateIpc {
  readonly status: SyncAccountStatusIpc;
  readonly email: string | null;
  readonly lastSyncedAtIso: string | null;
  readonly pendingRecoveryCode: string | null;
  readonly errorCode: string | null;
  readonly autoSyncState?: AutoSyncStateIpc;
}

export interface SyncActionResultIpc {
  readonly ok: boolean;
  readonly recoveryCode?: string;
  readonly errorCode?: string;
}

export interface SyncQrPairingSessionIpc {
  readonly pairingId: string;
  readonly code: string;
  readonly qrUri: string;
  readonly expiresAtMs: number;
  readonly status: 'pending' | 'claimed' | 'expired';
}

export type SyncQrPollStatusIpc = 'pending' | 'claimed' | 'expired';

/** Result of checking whether an email already has a sync account (`#513`). */
export type SyncEmailCheckStatusIpc = 'exists' | 'not_found' | 'unknown';

export interface SyncSignInRequest {
  readonly email: string;
  readonly password: string;
}

export interface SyncRegisterRequest {
  readonly email: string;
  readonly password: string;
  readonly confirmPassword: string;
}

export interface SyncDeleteAccountRequest {
  readonly password: string;
}

export interface SyncPollQrRequest {
  readonly pairingId: string;
}

export interface SyncClaimQrRequest {
  readonly codeOrUri: string;
}

export interface SyncSetServerUrlRequest {
  readonly serverUrl: string;
}

export interface SyncSetSyncablePrefsRequest {
  readonly preferences: Readonly<Record<string, unknown>>;
}

export interface TelemetrySetOptInRequest {
  readonly enabled: boolean;
}

export interface TelemetryStatusIpc {
  readonly optedIn: boolean;
  readonly queuedCount: number;
  readonly previewJson: string;
}

type FeedbackCategoryIpc =
  | 'playback_issue'
  | 'channel_epg'
  | 'ui_remote'
  | 'sync_account'
  | 'feature_request'
  | 'other';

export interface FeedbackSubmitRequest {
  readonly category: FeedbackCategoryIpc;
  readonly message: string;
  readonly includeDiagnostics: boolean;
}

export interface FeedbackSubmitResultIpc {
  readonly ok: boolean;
  readonly id?: string;
  readonly errorCode?: string;
}

/** Frozen `window.elv.sync` bridge exposed by the sandboxed Electron preload (`#26`, `#510`). */
export interface SyncBridge {
  getState(): Promise<SyncAccountStateIpc>;
  onStateChanged(listener: (state: SyncAccountStateIpc) => void): () => void;
  checkEmail?(email: string): Promise<SyncEmailCheckStatusIpc>;
  signIn(email: string, password: string): Promise<SyncActionResultIpc>;
  register(email: string, password: string, confirmPassword: string): Promise<SyncActionResultIpc>;
  acknowledgeRecoveryCode(): Promise<void>;
  syncNow(): Promise<SyncActionResultIpc>;
  signOut(): Promise<void>;
  deleteAccount(password: string): Promise<SyncActionResultIpc>;
  createQrPairing(): Promise<SyncQrPairingSessionIpc>;
  pollQrPairing(pairingId: string): Promise<SyncQrPollStatusIpc>;
  claimQrPairing(codeOrUri: string): Promise<SyncActionResultIpc>;
  setServerUrl(serverUrl: string): Promise<void>;
  setSyncablePreferences?(preferences: Readonly<Record<string, unknown>>): Promise<void>;
  onInitialPreferencesReceived?(
    listener: (preferences: Readonly<Record<string, unknown>>) => void,
  ): () => void;
  markSyncDirty?(): Promise<void>;
  notifySyncDirty?(): Promise<void>;
  notifyPlaybackPause?(): Promise<void>;
  notifyPlaybackExitOrSwitch?(): Promise<void>;
  setViewingActive?(active: boolean): Promise<void>;
  notifyReconnect?(): Promise<void>;
  startBidirectionalPairing?(): Promise<BidirectionalPairingSnapshotIpc>;
  joinBidirectionalPairing?(codeOrUri: string): Promise<BidirectionalPairingSnapshotIpc>;
  pollBidirectionalPairing?(pairingId: string): Promise<BidirectionalPairingSnapshotIpc>;
  confirmBidirectionalPairing?(
    pairingId: string,
    chosenDirection?: 'host_to_responder' | 'responder_to_host',
  ): Promise<SyncActionResultIpc>;
  cancelBidirectionalPairing?(pairingId: string): Promise<void>;
  consumePendingPairUri?(): Promise<string | null>;
  onPairDeepLink?(listener: (uri: string) => void): () => void;
}

/** Frozen `window.elv.telemetry` bridge exposed by the sandboxed Electron preload (`#458`, `#509`). */
export interface TelemetryBridge {
  setOptIn(enabled: boolean): Promise<TelemetryStatusIpc>;
  getStatus(): Promise<TelemetryStatusIpc>;
  record(event: TelemetryRecordRequest): Promise<void>;
  flush(): Promise<void>;
}

/** Frozen `window.elv.feedback` bridge exposed by the sandboxed Electron preload (`#458`). */
export interface FeedbackBridge {
  submit(input: FeedbackSubmitRequest): Promise<FeedbackSubmitResultIpc>;
}

const MAX_EMAIL_LEN = 254;
const MAX_CHECK_EMAIL_LEN = 320;
const MAX_SECRET_LEN = 512;
const MAX_QR_URI_BYTES = 213;
const MAX_FEEDBACK_MSG_LEN = 4000;
const MAX_PREVIEW_BYTES = 262_144;
const utf8Encoder = new TextEncoder();

const VALID_STATUSES = new Set<string>(['signed_out', 'signing_in', 'signed_in', 'syncing']);
const VALID_EMAIL_CHECK_STATUSES = new Set<string>(['exists', 'not_found', 'unknown']);
const VALID_QR_STATUSES = new Set<string>(['pending', 'claimed', 'expired']);
const VALID_FEEDBACK_CATEGORIES = new Set<string>([
  'playback_issue',
  'channel_epg',
  'ui_remote',
  'sync_account',
  'feature_request',
  'other',
]);

function isSafeRecord(x: unknown): x is Record<string, unknown> {
  return (
    typeof x === 'object' &&
    x !== null &&
    !Array.isArray(x) &&
    !Object.hasOwn(x, '__proto__') &&
    !Object.hasOwn(x, 'constructor') &&
    !Object.hasOwn(x, 'prototype')
  );
}

function hasExactKeys(x: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(x);
  return keys.length === allowed.length && allowed.every((k) => Object.hasOwn(x, k));
}

function hasSubsetKeys(x: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(x).every((k) => allowed.has(k));
}

function isBoundedString(x: unknown, maxLen: number, allowEmpty = false): x is string {
  if (typeof x !== 'string' || x.length > maxLen) return false;
  return allowEmpty || x.trim().length > 0;
}

function isOptionalBoundedString(x: unknown, maxLen: number): boolean {
  return x === undefined || isBoundedString(x, maxLen);
}

function isNullableBoundedString(x: unknown, maxLen: number): boolean {
  return x === null || isBoundedString(x, maxLen);
}

export function isSyncCheckEmailPayload(x: unknown): x is string {
  return typeof x === 'string' && x.length <= MAX_CHECK_EMAIL_LEN;
}

export function isSyncEmailCheckStatus(x: unknown): x is SyncEmailCheckStatusIpc {
  return typeof x === 'string' && VALID_EMAIL_CHECK_STATUSES.has(x);
}

export function isSyncSignInRequest(x: unknown): x is SyncSignInRequest {
  return (
    isSafeRecord(x) &&
    hasExactKeys(x, ['email', 'password']) &&
    isBoundedString(x.email, MAX_EMAIL_LEN) &&
    isBoundedString(x.password, MAX_SECRET_LEN)
  );
}

export function isSyncRegisterRequest(x: unknown): x is SyncRegisterRequest {
  return (
    isSafeRecord(x) &&
    hasExactKeys(x, ['email', 'password', 'confirmPassword']) &&
    isBoundedString(x.email, MAX_EMAIL_LEN) &&
    isBoundedString(x.password, MAX_SECRET_LEN) &&
    isBoundedString(x.confirmPassword, MAX_SECRET_LEN)
  );
}

export function isSyncDeleteAccountRequest(x: unknown): x is SyncDeleteAccountRequest {
  return (
    isSafeRecord(x) && hasExactKeys(x, ['password']) && isBoundedString(x.password, MAX_SECRET_LEN)
  );
}

export function isSyncPollQrRequest(x: unknown): x is SyncPollQrRequest {
  return isSafeRecord(x) && hasExactKeys(x, ['pairingId']) && isBoundedString(x.pairingId, 128);
}

export function isSyncClaimQrRequest(x: unknown): x is SyncClaimQrRequest {
  return isSafeRecord(x) && hasExactKeys(x, ['codeOrUri']) && isBoundedString(x.codeOrUri, 256);
}

const MAX_SYNCABLE_PREF_KEYS = 64;

export function isSyncSetServerUrlRequest(x: unknown): x is SyncSetServerUrlRequest {
  return isSafeRecord(x) && hasExactKeys(x, ['serverUrl']) && isValidSyncServerUrl(x.serverUrl);
}

export function isSyncInitialPrefsPayload(x: unknown): x is Readonly<Record<string, unknown>> {
  return isSafeRecord(x) && Object.keys(x).length <= MAX_SYNCABLE_PREF_KEYS;
}

export function isSyncSetSyncablePrefsRequest(x: unknown): x is SyncSetSyncablePrefsRequest {
  return (
    isSafeRecord(x) && hasExactKeys(x, ['preferences']) && isSyncInitialPrefsPayload(x.preferences)
  );
}

const SYNC_ACCOUNT_STATE_KEYS = new Set([
  'status',
  'email',
  'lastSyncedAtIso',
  'pendingRecoveryCode',
  'errorCode',
  'autoSyncState',
]);

export function isSyncAccountState(x: unknown): x is SyncAccountStateIpc {
  return (
    isSafeRecord(x) &&
    hasSubsetKeys(x, SYNC_ACCOUNT_STATE_KEYS) &&
    Object.hasOwn(x, 'status') &&
    Object.hasOwn(x, 'email') &&
    Object.hasOwn(x, 'lastSyncedAtIso') &&
    Object.hasOwn(x, 'pendingRecoveryCode') &&
    Object.hasOwn(x, 'errorCode') &&
    typeof x.status === 'string' &&
    VALID_STATUSES.has(x.status) &&
    isNullableBoundedString(x.email, MAX_EMAIL_LEN) &&
    isNullableBoundedString(x.lastSyncedAtIso, 64) &&
    isNullableBoundedString(x.pendingRecoveryCode, 64) &&
    isNullableBoundedString(x.errorCode, 128) &&
    (x.autoSyncState === undefined ||
      (typeof x.autoSyncState === 'string' && VALID_AUTO_SYNC_STATES.has(x.autoSyncState)))
  );
}

const ACTION_RESULT_KEYS = new Set(['ok', 'recoveryCode', 'errorCode']);
export function isSyncActionResult(x: unknown): x is SyncActionResultIpc {
  return (
    isSafeRecord(x) &&
    hasSubsetKeys(x, ACTION_RESULT_KEYS) &&
    typeof x.ok === 'boolean' &&
    isOptionalBoundedString(x.recoveryCode, 64) &&
    isOptionalBoundedString(x.errorCode, 128)
  );
}

export function isSyncQrPairingSession(x: unknown): x is SyncQrPairingSessionIpc {
  return (
    isSafeRecord(x) &&
    hasExactKeys(x, ['pairingId', 'code', 'qrUri', 'expiresAtMs', 'status']) &&
    isBoundedString(x.pairingId, 128) &&
    isBoundedString(x.code, 32) &&
    isBoundedString(x.qrUri, MAX_QR_URI_BYTES) &&
    utf8Encoder.encode(x.qrUri).byteLength <= MAX_QR_URI_BYTES &&
    typeof x.expiresAtMs === 'number' &&
    Number.isFinite(x.expiresAtMs) &&
    x.expiresAtMs > 0 &&
    typeof x.status === 'string' &&
    VALID_QR_STATUSES.has(x.status)
  );
}

export function isSyncQrPollStatus(x: unknown): x is SyncQrPollStatusIpc {
  return typeof x === 'string' && VALID_QR_STATUSES.has(x);
}

export function isTelemetrySetOptInRequest(x: unknown): x is TelemetrySetOptInRequest {
  return isSafeRecord(x) && hasExactKeys(x, ['enabled']) && typeof x.enabled === 'boolean';
}

export function isTelemetryStatus(x: unknown): x is TelemetryStatusIpc {
  return (
    isSafeRecord(x) &&
    hasExactKeys(x, ['optedIn', 'queuedCount', 'previewJson']) &&
    typeof x.optedIn === 'boolean' &&
    typeof x.queuedCount === 'number' &&
    Number.isInteger(x.queuedCount) &&
    x.queuedCount >= 0 &&
    typeof x.previewJson === 'string' &&
    x.previewJson.length <= MAX_PREVIEW_BYTES
  );
}

export function isFeedbackSubmitRequest(x: unknown): x is FeedbackSubmitRequest {
  return (
    isSafeRecord(x) &&
    hasExactKeys(x, ['category', 'message', 'includeDiagnostics']) &&
    typeof x.category === 'string' &&
    VALID_FEEDBACK_CATEGORIES.has(x.category) &&
    isBoundedString(x.message, MAX_FEEDBACK_MSG_LEN) &&
    typeof x.includeDiagnostics === 'boolean'
  );
}

const FEEDBACK_RESULT_KEYS = new Set(['ok', 'id', 'errorCode']);
export function isFeedbackSubmitResult(x: unknown): x is FeedbackSubmitResultIpc {
  return (
    isSafeRecord(x) &&
    hasSubsetKeys(x, FEEDBACK_RESULT_KEYS) &&
    typeof x.ok === 'boolean' &&
    isOptionalBoundedString(x.id, 128) &&
    isOptionalBoundedString(x.errorCode, 128)
  );
}
