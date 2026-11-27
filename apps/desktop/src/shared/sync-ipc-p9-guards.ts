/** Background automatic sync indicator state (`#510`). */
export type AutoSyncStateIpc = 'idle' | 'syncing' | 'pending' | 'offline';

/** Resolved 5-case bidirectional account transfer direction (`#510`). */
type PairingDirectionIpc =
  | 'neither_signed_in'
  | 'responder_to_host'
  | 'host_to_responder'
  | 'same_account'
  | 'different_accounts';

/** Role of the local device inside a bidirectional X25519 pairing handshake (`#510`). */
type BidirectionalPairingRoleIpc = 'host' | 'responder';

/** Lifecycle state of a bidirectional X25519 pairing session (`#510`). */
export type BidirectionalPairingStatusIpc =
  | 'pending'
  | 'responder_joined'
  | 'awaiting_sas'
  | 'waiting_approval'
  | 'approved'
  | 'completed'
  | 'rejected'
  | 'expired'
  | 'locked';

/** UI-ready snapshot of an active bidirectional X25519 pairing session (`#510`). */
export interface BidirectionalPairingSnapshotIpc {
  readonly pairingId: string;
  readonly role: BidirectionalPairingRoleIpc;
  readonly code: string;
  readonly qrUri?: string;
  readonly expiresAtMs: number;
  readonly status: BidirectionalPairingStatusIpc;
  readonly sas: string | null;
  readonly direction: PairingDirectionIpc | null;
  readonly localMaskedEmail: string | null;
  readonly peerMaskedEmail: string | null;
  readonly errorCode?: string | null;
}

interface SyncSetViewingActiveRequest {
  readonly active: boolean;
}

interface SyncPairJoinRequest {
  readonly codeOrUri: string;
}

interface SyncPairPollRequest {
  readonly pairingId: string;
}

interface SyncPairConfirmRequest {
  readonly pairingId: string;
  readonly chosenDirection?: 'host_to_responder' | 'responder_to_host';
}

/** Discriminated union of all 13 Wave F9/P9 allowlisted telemetry record requests (`#458`, `#509`). */
export type TelemetryRecordRequest =
  | {
      readonly kind: 'startup';
      readonly durationMs: number;
      readonly coldStart: boolean;
    }
  | {
      readonly kind: 'screen_transition';
      readonly screen: string;
      readonly durationMs: number;
    }
  | {
      readonly kind: 'frame_jank';
      readonly screen: string;
      readonly droppedFrames: number;
      readonly maxFrameMs: number;
    }
  | {
      readonly kind: 'js_stall';
      readonly screen: string;
      readonly durationMs: number;
    }
  | {
      readonly kind: 'memory_pressure';
      readonly level: 'moderate' | 'critical';
      readonly usedMb?: number;
    }
  | {
      readonly kind: 'playback_start';
      readonly engine: string;
      readonly ttffMs: number;
      readonly isLive: boolean;
      readonly container?: string;
      readonly videoCodec?: string;
    }
  | {
      readonly kind: 'playback_rebuffer';
      readonly engine: string;
      readonly durationMs: number;
      readonly isLive: boolean;
    }
  | {
      readonly kind: 'playback_error';
      readonly engine: string;
      readonly errorCode: string;
      readonly isLive: boolean;
    }
  | {
      readonly kind: 'media_decode_failure';
      readonly engine: string;
      readonly container?: string;
      readonly videoCodec?: string;
      readonly audioCodec?: string;
      readonly errorCode: string;
      readonly hdrFormat?: string;
      readonly isLive: boolean;
    }
  | {
      readonly kind: 'sqlite_slow_op';
      readonly op: string;
      readonly durationMs: number;
    }
  | {
      readonly kind: 'app_crash';
      readonly errorName: string;
      readonly stackSig: string;
      readonly screen?: string;
      readonly fatal: boolean;
      readonly uptimeMs?: number;
    }
  | {
      readonly kind: 'unhandled_error';
      readonly errorName: string;
      readonly stackSig: string;
      readonly screen?: string;
      readonly source?: string;
    }
  | {
      readonly kind: 'catalog_import';
      readonly sourceKind: string;
      readonly stage: string;
      readonly durationMs: number;
      readonly itemCount: number;
      readonly success: boolean;
      readonly errorCode?: string;
    };

const MAX_TOKEN_LEN = 64;
const MAX_STACK_SIG_LEN = 128;
const MAX_QR_URI_BYTES = 213;
const utf8Encoder = new TextEncoder();

export const VALID_AUTO_SYNC_STATES = new Set<string>(['idle', 'syncing', 'pending', 'offline']);
const VALID_PAIRING_ROLES = new Set<string>(['host', 'responder']);
const VALID_PAIRING_STATUSES = new Set<string>([
  'pending',
  'responder_joined',
  'awaiting_sas',
  'waiting_approval',
  'approved',
  'completed',
  'rejected',
  'expired',
  'locked',
]);
const VALID_PAIRING_DIRECTIONS = new Set<string>([
  'neither_signed_in',
  'responder_to_host',
  'host_to_responder',
  'same_account',
  'different_accounts',
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

function isBoundedString(x: unknown, maxLen: number): x is string {
  return typeof x === 'string' && x.length <= maxLen && x.trim().length > 0;
}

function isOptionalBoundedString(x: unknown, maxLen: number): boolean {
  return x === undefined || isBoundedString(x, maxLen);
}

function isNullableBoundedString(x: unknown, maxLen: number): boolean {
  return x === null || isBoundedString(x, maxLen);
}

function isNonNegNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0;
}

function isOptionalNonNegNumber(x: unknown): boolean {
  return x === undefined || isNonNegNumber(x);
}

/** Validates `sync:setViewingActive` payload. */
export function isSyncSetViewingActiveRequest(x: unknown): x is SyncSetViewingActiveRequest {
  return isSafeRecord(x) && hasExactKeys(x, ['active']) && typeof x.active === 'boolean';
}

/** Validates `sync:pairJoin` payload (8-digit code or pairing QR URI). */
export function isSyncPairJoinRequest(x: unknown): x is SyncPairJoinRequest {
  return isSafeRecord(x) && hasExactKeys(x, ['codeOrUri']) && isBoundedString(x.codeOrUri, 256);
}

/** Validates `sync:pairPoll` / `sync:pairCancel` payload. */
export function isSyncPairPollRequest(x: unknown): x is SyncPairPollRequest {
  return isSafeRecord(x) && hasExactKeys(x, ['pairingId']) && isBoundedString(x.pairingId, 128);
}

const PAIR_CONFIRM_KEYS = new Set(['pairingId', 'chosenDirection']);

/** Validates `sync:pairConfirm` payload. */
export function isSyncPairConfirmRequest(x: unknown): x is SyncPairConfirmRequest {
  if (!isSafeRecord(x) || !hasSubsetKeys(x, PAIR_CONFIRM_KEYS)) return false;
  if (!isBoundedString(x.pairingId, 128)) return false;
  return (
    x.chosenDirection === undefined ||
    x.chosenDirection === 'host_to_responder' ||
    x.chosenDirection === 'responder_to_host'
  );
}

const BIDIRECTIONAL_SNAPSHOT_KEYS = new Set([
  'pairingId',
  'role',
  'code',
  'qrUri',
  'expiresAtMs',
  'status',
  'sas',
  'direction',
  'localMaskedEmail',
  'peerMaskedEmail',
  'errorCode',
]);

/** Strictly validates a {@link BidirectionalPairingSnapshotIpc}, rejecting any leaked tokens/keys. */
export function isBidirectionalPairingSnapshot(x: unknown): x is BidirectionalPairingSnapshotIpc {
  if (!isSafeRecord(x) || !hasSubsetKeys(x, BIDIRECTIONAL_SNAPSHOT_KEYS)) return false;
  if (
    !isBoundedString(x.pairingId, 128) ||
    typeof x.role !== 'string' ||
    !VALID_PAIRING_ROLES.has(x.role) ||
    !isBoundedString(x.code, 32) ||
    !isNonNegNumber(x.expiresAtMs) ||
    typeof x.status !== 'string' ||
    !VALID_PAIRING_STATUSES.has(x.status)
  ) {
    return false;
  }
  if (
    x.qrUri !== undefined &&
    (!isBoundedString(x.qrUri, MAX_QR_URI_BYTES) ||
      utf8Encoder.encode(x.qrUri).byteLength > MAX_QR_URI_BYTES)
  ) {
    return false;
  }
  if (x.sas !== null && !isBoundedString(x.sas, 16)) return false;
  if (
    x.direction !== null &&
    (typeof x.direction !== 'string' || !VALID_PAIRING_DIRECTIONS.has(x.direction))
  ) {
    return false;
  }
  if (!isNullableBoundedString(x.localMaskedEmail, 128)) return false;
  if (!isNullableBoundedString(x.peerMaskedEmail, 128)) return false;
  if (x.errorCode !== undefined && !isNullableBoundedString(x.errorCode, 128)) return false;
  return true;
}

/** Validates a pending or pushed pairing deep-link URI string. */
export function isPairDeepLinkUri(x: unknown): x is string {
  if (!isBoundedString(x, MAX_QR_URI_BYTES)) return false;
  if (utf8Encoder.encode(x).byteLength > MAX_QR_URI_BYTES) return false;
  const lower = x.trim().toLowerCase();
  return (
    lower.startsWith('elviptv://pair?') ||
    (lower.startsWith('https://') && lower.includes('/pair?'))
  );
}

const MEMORY_PRESSURE_KEYS = new Set(['kind', 'level', 'usedMb']);
const PLAYBACK_START_KEYS = new Set([
  'kind',
  'engine',
  'ttffMs',
  'isLive',
  'container',
  'videoCodec',
]);
const DECODE_FAILURE_KEYS = new Set([
  'kind',
  'engine',
  'container',
  'videoCodec',
  'audioCodec',
  'errorCode',
  'hdrFormat',
  'isLive',
]);
const APP_CRASH_KEYS = new Set(['kind', 'errorName', 'stackSig', 'screen', 'fatal', 'uptimeMs']);
const UNHANDLED_ERROR_KEYS = new Set(['kind', 'errorName', 'stackSig', 'screen', 'source']);
const CATALOG_IMPORT_KEYS = new Set([
  'kind',
  'sourceKind',
  'stage',
  'durationMs',
  'itemCount',
  'success',
  'errorCode',
]);

/** Strictly validates all 13 Wave F9/P9 {@link TelemetryRecordRequest} variants. */
export function isTelemetryRecordRequest(x: unknown): x is TelemetryRecordRequest {
  if (!isSafeRecord(x) || typeof x.kind !== 'string') return false;
  switch (x.kind) {
    case 'startup':
      return (
        hasExactKeys(x, ['kind', 'durationMs', 'coldStart']) &&
        isNonNegNumber(x.durationMs) &&
        typeof x.coldStart === 'boolean'
      );
    case 'screen_transition':
      return (
        hasExactKeys(x, ['kind', 'screen', 'durationMs']) &&
        isBoundedString(x.screen, MAX_TOKEN_LEN) &&
        isNonNegNumber(x.durationMs)
      );
    case 'frame_jank':
      return (
        hasExactKeys(x, ['kind', 'screen', 'droppedFrames', 'maxFrameMs']) &&
        isBoundedString(x.screen, MAX_TOKEN_LEN) &&
        isNonNegNumber(x.droppedFrames) &&
        isNonNegNumber(x.maxFrameMs)
      );
    case 'js_stall':
      return (
        hasExactKeys(x, ['kind', 'screen', 'durationMs']) &&
        isBoundedString(x.screen, MAX_TOKEN_LEN) &&
        isNonNegNumber(x.durationMs)
      );
    case 'memory_pressure':
      return (
        hasSubsetKeys(x, MEMORY_PRESSURE_KEYS) &&
        (x.level === 'moderate' || x.level === 'critical') &&
        isOptionalNonNegNumber(x.usedMb)
      );
    case 'playback_start':
      return (
        hasSubsetKeys(x, PLAYBACK_START_KEYS) &&
        isBoundedString(x.engine, MAX_TOKEN_LEN) &&
        isNonNegNumber(x.ttffMs) &&
        typeof x.isLive === 'boolean' &&
        isOptionalBoundedString(x.container, MAX_TOKEN_LEN) &&
        isOptionalBoundedString(x.videoCodec, MAX_TOKEN_LEN)
      );
    case 'playback_rebuffer':
      return (
        hasExactKeys(x, ['kind', 'engine', 'durationMs', 'isLive']) &&
        isBoundedString(x.engine, MAX_TOKEN_LEN) &&
        isNonNegNumber(x.durationMs) &&
        typeof x.isLive === 'boolean'
      );
    case 'playback_error':
      return (
        hasExactKeys(x, ['kind', 'engine', 'errorCode', 'isLive']) &&
        isBoundedString(x.engine, MAX_TOKEN_LEN) &&
        isBoundedString(x.errorCode, MAX_TOKEN_LEN) &&
        typeof x.isLive === 'boolean'
      );
    case 'media_decode_failure':
      return (
        hasSubsetKeys(x, DECODE_FAILURE_KEYS) &&
        isBoundedString(x.engine, MAX_TOKEN_LEN) &&
        isOptionalBoundedString(x.container, MAX_TOKEN_LEN) &&
        isOptionalBoundedString(x.videoCodec, MAX_TOKEN_LEN) &&
        isOptionalBoundedString(x.audioCodec, MAX_TOKEN_LEN) &&
        isBoundedString(x.errorCode, MAX_TOKEN_LEN) &&
        isOptionalBoundedString(x.hdrFormat, MAX_TOKEN_LEN) &&
        typeof x.isLive === 'boolean'
      );
    case 'sqlite_slow_op':
      return (
        hasExactKeys(x, ['kind', 'op', 'durationMs']) &&
        isBoundedString(x.op, MAX_TOKEN_LEN) &&
        isNonNegNumber(x.durationMs)
      );
    case 'app_crash':
      return (
        hasSubsetKeys(x, APP_CRASH_KEYS) &&
        isBoundedString(x.errorName, MAX_TOKEN_LEN) &&
        isBoundedString(x.stackSig, MAX_STACK_SIG_LEN) &&
        isOptionalBoundedString(x.screen, MAX_TOKEN_LEN) &&
        typeof x.fatal === 'boolean' &&
        isOptionalNonNegNumber(x.uptimeMs)
      );
    case 'unhandled_error':
      return (
        hasSubsetKeys(x, UNHANDLED_ERROR_KEYS) &&
        isBoundedString(x.errorName, MAX_TOKEN_LEN) &&
        isBoundedString(x.stackSig, MAX_STACK_SIG_LEN) &&
        isOptionalBoundedString(x.screen, MAX_TOKEN_LEN) &&
        isOptionalBoundedString(x.source, MAX_TOKEN_LEN)
      );
    case 'catalog_import':
      return (
        hasSubsetKeys(x, CATALOG_IMPORT_KEYS) &&
        isBoundedString(x.sourceKind, MAX_TOKEN_LEN) &&
        isBoundedString(x.stage, MAX_TOKEN_LEN) &&
        isNonNegNumber(x.durationMs) &&
        isNonNegNumber(x.itemCount) &&
        typeof x.success === 'boolean' &&
        isOptionalBoundedString(x.errorCode, MAX_TOKEN_LEN)
      );
    default:
      return false;
  }
}
