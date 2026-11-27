import {
  base64UrlDecode,
  derivePairingSessionKeys,
  type PairingDirection,
  type PairingSessionKeys,
  type SyncHttpPort,
  x25519,
} from '@elv/sync';
import type {
  BidirectionalPairingSnapshotIpc,
  BidirectionalPairingStatusIpc,
} from '../../shared/sync-ipc.ts';

export type TransferDirection = 'host_to_responder' | 'responder_to_host';

export interface HostSessionState {
  readonly role: 'host';
  readonly pairingId: string;
  readonly code: string;
  readonly qrUri: string;
  readonly pollToken: string;
  readonly expiresAtMs: number;
  readonly hostPublicKey: Uint8Array;
  privateKey: Uint8Array | null;
  readonly localSignedIn: boolean;
  readonly localMaskedEmail: string | null;
  readonly localEmailHash: string | null;
  keys: PairingSessionKeys | null;
  direction: PairingDirection | null;
  peerMaskedEmail: string | null;
  localSasConfirmed: boolean;
  localChosenDirection: TransferDirection | null;
  localStatus: 'pending' | 'awaiting_sas' | 'waiting_approval';
}

export interface ResponderSessionState {
  readonly role: 'responder';
  readonly pairingId: string;
  readonly code: string;
  readonly responderToken: string;
  readonly expiresAtMs: number;
  readonly localMaskedEmail: string | null;
  readonly peerMaskedEmail: string | null;
  readonly direction: PairingDirection;
  readonly sas: string | null;
  keys: PairingSessionKeys | null;
  localSasConfirmed: boolean;
  localChosenDirection: TransferDirection | null;
  localStatus: 'awaiting_sas' | 'waiting_approval';
  bufferedReturnPayload: { readonly ciphertext: string; readonly iv: string } | null;
  transferred: boolean;
}

export type ActivePairSession = HostSessionState | ResponderSessionState;

export const MAX_COMPLETED_SNAPSHOTS = 16;

export function zeroBytes(buf: Uint8Array | null | undefined): void {
  if (buf !== null && buf !== undefined) buf.fill(0);
}

export function zeroSessionKeys(session: ActivePairSession): void {
  if (session.role === 'host') {
    zeroBytes(session.privateKey);
    session.privateKey = null;
  } else {
    session.bufferedReturnPayload = null;
  }
  if (session.keys !== null) {
    zeroBytes(session.keys.hostToResponderKey);
    zeroBytes(session.keys.responderToHostKey);
    session.keys = null;
  }
}

export function parseJsonBody(text: string): Record<string, unknown> | null {
  if (text.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function parseExpiresAt(raw: unknown, fallbackNow: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && !Number.isNaN(Date.parse(raw))) return Date.parse(raw);
  return fallbackNow + 300_000;
}

export function validHttpsLinkOrigin(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
      return undefined;
    }
    return u.origin;
  } catch {
    return undefined;
  }
}

export function toSnapshot(
  session: ActivePairSession,
  status: BidirectionalPairingStatusIpc,
  overrides?: Partial<BidirectionalPairingSnapshotIpc>,
): BidirectionalPairingSnapshotIpc {
  return {
    pairingId: session.pairingId,
    role: session.role,
    code: session.code,
    ...(session.role === 'host' && (status === 'pending' || status === 'awaiting_sas')
      ? { qrUri: session.qrUri }
      : {}),
    expiresAtMs: session.expiresAtMs,
    status,
    sas: session.role === 'responder' ? session.sas : (session.keys?.sas ?? null),
    direction: session.direction,
    localMaskedEmail: session.localMaskedEmail,
    peerMaskedEmail: session.peerMaskedEmail,
    ...overrides,
  };
}

export function expiredUnknownSnapshot(pairingId: string): BidirectionalPairingSnapshotIpc {
  return {
    pairingId,
    role: 'host',
    code: '00000000',
    expiresAtMs: 0,
    status: 'expired',
    sas: null,
    direction: null,
    localMaskedEmail: null,
    peerMaskedEmail: null,
  };
}

export function resolveEffectiveDirection(
  sessionDirection: PairingDirection | null,
  chosenDirection: TransferDirection | undefined,
):
  | { readonly ok: true; readonly direction: TransferDirection }
  | { readonly ok: false; readonly errorCode: string } {
  if (sessionDirection === 'different_accounts') {
    if (chosenDirection !== 'host_to_responder' && chosenDirection !== 'responder_to_host') {
      return { ok: false, errorCode: 'direction_choice_required' };
    }
    return { ok: true, direction: chosenDirection };
  }
  if (sessionDirection === 'host_to_responder' || sessionDirection === 'responder_to_host') {
    if (chosenDirection !== undefined && chosenDirection !== sessionDirection) {
      return { ok: false, errorCode: 'invalid_pairing_direction' };
    }
    return { ok: true, direction: sessionDirection };
  }
  return { ok: false, errorCode: 'invalid_pairing_direction' };
}

export function pairAuthHeader(session: ActivePairSession): Record<string, string> {
  return session.role === 'host'
    ? { 'X-Pair-Poll-Token': session.pollToken }
    : { 'X-Pair-Responder-Token': session.responderToken };
}

export function postPairJson(
  http: SyncHttpPort,
  url: string,
  payload: Record<string, unknown>,
  extraHeaders?: Readonly<Record<string, string>>,
): Promise<{ readonly status: number; readonly bodyText: string }> {
  return http.request({
    method: 'POST',
    url,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  });
}

export function httpErrorCode(body: Record<string, unknown> | null, status: number): string {
  return typeof body?.error === 'string' ? body.error : `http-${status}`;
}

export function deriveHostKeysIfNeeded(session: HostSessionState, responderPubB64: unknown): void {
  if (session.keys !== null || session.privateKey === null || typeof responderPubB64 !== 'string') {
    return;
  }
  const responderPub = base64UrlDecode(responderPubB64);
  let shared: Uint8Array | null = null;
  try {
    shared = x25519(session.privateKey, responderPub);
    session.keys = derivePairingSessionKeys(shared, {
      code: session.code,
      hostPublicKey: session.hostPublicKey,
      responderPublicKey: responderPub,
    });
  } finally {
    zeroBytes(shared);
    zeroBytes(session.privateKey);
    session.privateKey = null;
  }
}

export async function approveAndFetchResponderPayload(
  http: SyncHttpPort,
  baseUrl: string,
  pairingId: string,
  pollToken: string,
): Promise<
  | { readonly kind: 'waiting' }
  | { readonly kind: 'payload'; readonly ciphertext: string; readonly iv: string }
  | { readonly kind: 'error'; readonly errorCode: string }
> {
  let approveRes: { readonly status: number; readonly bodyText: string };
  try {
    approveRes = await postPairJson(
      http,
      `${baseUrl}/v1/pair/approve`,
      { pairingId, direction: 'responder_to_host' },
      { 'X-Pair-Poll-Token': pollToken },
    );
  } catch {
    return { kind: 'error', errorCode: 'network_error' };
  }
  const approveBody = parseJsonBody(approveRes.bodyText);
  if (approveRes.status < 200 || approveRes.status >= 300) {
    return { kind: 'error', errorCode: httpErrorCode(approveBody, approveRes.status) };
  }
  if (approveBody?.status !== 'completed') return { kind: 'waiting' };

  let burnRes: { readonly status: number; readonly bodyText: string };
  try {
    burnRes = await http.request({
      method: 'GET',
      url: `${baseUrl}/v1/pair/poll/${encodeURIComponent(pairingId)}`,
      headers: { Accept: 'application/json', 'X-Pair-Poll-Token': pollToken },
    });
  } catch {
    return { kind: 'error', errorCode: 'network_error' };
  }
  const burnBody = parseJsonBody(burnRes.bodyText);
  if (
    burnRes.status < 200 ||
    burnRes.status >= 300 ||
    burnBody === null ||
    typeof burnBody.encryptedPayload !== 'string' ||
    typeof burnBody.iv !== 'string'
  ) {
    return { kind: 'error', errorCode: 'pair_payload_missing' };
  }
  return { kind: 'payload', ciphertext: burnBody.encryptedPayload, iv: burnBody.iv };
}
