/** IPC channels exposed by main for ephemeral local LAN QR pairing (`#50`). */
export const LAN_PAIRING_CHANNELS = Object.freeze({
  start: 'lan-pairing:start',
  stop: 'lan-pairing:stop',
  payload: 'lan-pairing:payload',
} as const);

/** Options accepted by `lan-pairing:start`. */
export interface LanPairingStartOptions {
  readonly locale?: 'en' | 'tr';
}

/** Active ephemeral LAN pairing session metadata returned across Electron IPC (`#50`). */
export interface LanPairingSessionReply {
  readonly url: string;
  readonly token: string;
  readonly host: string;
  readonly port: number;
  readonly expiresAtMs: number;
}

/** Validated IPTV source payload delivered from main to the requesting renderer (`#50`). */
export type LanPairingPayloadEvent =
  | {
      readonly kind: 'm3u';
      readonly name: string;
      readonly url: string;
      readonly guideUrl?: string;
    }
  | {
      readonly kind: 'xtream';
      readonly name: string;
      readonly server: string;
      readonly username: string;
      readonly password: string;
      readonly guideUrl?: string;
    };

/** Frozen `window.elv.lanPairing` bridge exposed by the sandboxed Electron preload (`#50`). */
export interface LanPairingBridge {
  startSession(opts?: LanPairingStartOptions): Promise<LanPairingSessionReply>;
  stopSession(): Promise<void>;
  onPayloadReceived(listener: (payload: LanPairingPayloadEvent) => void): () => void;
}

const PAIRING_TOKEN_RE = /^[0-9a-fA-F]{32,128}$/;
const START_OPT_KEYS = new Set(['locale']);
const SESSION_REPLY_KEYS = new Set(['url', 'token', 'host', 'port', 'expiresAtMs']);
const M3U_PAYLOAD_KEYS = new Set(['kind', 'name', 'url', 'guideUrl']);
const XTREAM_PAYLOAD_KEYS = new Set(['kind', 'name', 'server', 'username', 'password', 'guideUrl']);

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' &&
  x !== null &&
  !Array.isArray(x) &&
  !Object.hasOwn(x, '__proto__') &&
  !Object.hasOwn(x, 'constructor') &&
  !Object.hasOwn(x, 'prototype');

function hasOnlyKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

function isBoundedString(x: unknown, min: number, max: number): x is string {
  return typeof x === 'string' && x.length >= min && x.length <= max;
}

/** Validates optional start arguments sent to `lan-pairing:start`. */
export function isLanPairingStartOptions(x: unknown): x is LanPairingStartOptions | undefined {
  if (x === undefined) return true;
  if (!isRecord(x) || !hasOnlyKeys(x, START_OPT_KEYS)) return false;
  return x['locale'] === undefined || x['locale'] === 'en' || x['locale'] === 'tr';
}

/** Validates a session metadata reply from `lan-pairing:start`. */
export function isLanPairingSessionReply(x: unknown): x is LanPairingSessionReply {
  if (!isRecord(x) || !hasOnlyKeys(x, SESSION_REPLY_KEYS)) return false;
  const url = x['url'];
  const token = x['token'];
  const host = x['host'];
  const port = x['port'];
  const expiresAtMs = x['expiresAtMs'];
  return (
    isBoundedString(url, 16, 512) &&
    url.startsWith('http://') &&
    typeof token === 'string' &&
    PAIRING_TOKEN_RE.test(token) &&
    isBoundedString(host, 1, 128) &&
    Number.isSafeInteger(port) &&
    (port as number) >= 1 &&
    (port as number) <= 65_535 &&
    typeof expiresAtMs === 'number' &&
    Number.isFinite(expiresAtMs) &&
    expiresAtMs > 0
  );
}

/** Validates a `lan-pairing:payload` event sent from main to preload. */
export function isLanPairingPayloadEvent(x: unknown): x is LanPairingPayloadEvent {
  if (!isRecord(x)) return false;
  const guideUrl = x['guideUrl'];
  if (guideUrl !== undefined && !isBoundedString(guideUrl, 1, 2_048)) return false;

  if (x['kind'] === 'm3u') {
    return (
      hasOnlyKeys(x, M3U_PAYLOAD_KEYS) &&
      isBoundedString(x['name'], 1, 120) &&
      isBoundedString(x['url'], 1, 2_048)
    );
  }
  if (x['kind'] === 'xtream') {
    return (
      hasOnlyKeys(x, XTREAM_PAYLOAD_KEYS) &&
      isBoundedString(x['name'], 1, 120) &&
      isBoundedString(x['server'], 1, 2_048) &&
      isBoundedString(x['username'], 1, 256) &&
      isBoundedString(x['password'], 1, 256)
    );
  }
  return false;
}
