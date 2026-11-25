import { elvError, err, normalizeSyncServerUrl, ok, type Result } from '@elv/domain';
import {
  base64UrlDecode,
  base64UrlEncode,
  utf8ByteLength,
  utf8Decode,
  utf8Encode,
} from './encoding';
import type { SyncHttpPort, VaultCryptoPort } from './ports';

/** Hard byte ceiling matching `@elv/ui-kit` QR encoder capacity (`MAX_QR_PAYLOAD_BYTES`). */
export const MAX_SYNC_QR_BYTES = 213;

const QR_PREFIX = 'elviptv://pair?';
const PAIR_CODE_RE = /^[A-Za-z0-9]{6,24}$/;
const EPHEMERAL_KEY_BYTES = 16;
const AES_GCM_IV_BYTES = 12;

/** Parsed parameters embedded inside a universal ELV IPTV device-pairing QR URI. */
export interface PairingQrParams {
  readonly code: string;
  readonly keyB64: string;
  readonly serverUrl?: string;
}

/** E2EE credential handoff payload encrypted under the target device's ephemeral key `k`. */
export interface QrPairingPayload {
  readonly email: string;
  readonly refreshToken: string;
  readonly vaultKeyB64: string;
}

/** Active pairing session owned by the target device waiting to be claimed. */
export interface QrPairingSession {
  readonly pairingId: string;
  readonly code: string;
  readonly pollToken: string;
  readonly expiresAt: number;
  readonly ephemeralKey: Uint8Array;
  readonly keyB64: string;
  readonly qrUri: string;
}

/** Result returned when polling a pairing session. */
export type QrPollResult =
  | { readonly status: 'pending' }
  | { readonly status: 'expired' }
  | { readonly status: 'claimed'; readonly payload: QrPairingPayload };

/** Options for {@link createQrPairingClient}. */
export interface QrPairingClientOptions {
  readonly baseUrl: string;
  readonly http: SyncHttpPort;
  readonly crypto: VaultCryptoPort;
}

/** Universal E2EE QR device-pairing client (TV, phone, tablet, desktop). */
export interface QrPairingClient {
  createSession(options?: {
    readonly includeServerUrl?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<Result<QrPairingSession>>;
  claimSession(params: {
    readonly accessToken: string;
    readonly qrUriOrParams: string | PairingQrParams;
    readonly payload: QrPairingPayload;
    readonly signal?: AbortSignal;
  }): Promise<Result<{ readonly claimed: true }>>;
  pollSession(
    session: Pick<QrPairingSession, 'pairingId' | 'code' | 'pollToken' | 'ephemeralKey'>,
    signal?: AbortSignal,
  ): Promise<Result<QrPollResult>>;
}

function validatePairingCode(code: string): boolean {
  return PAIR_CODE_RE.test(code);
}

function decodeEphemeralKey(keyB64: string): Uint8Array | null {
  try {
    const bytes = base64UrlDecode(keyB64);
    return bytes.length === EPHEMERAL_KEY_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Builds a universal `elviptv://pair?c=<code>&k=<keyB64>[&s=<serverUrl>]` QR URI.
 * Throws if parameters are invalid or the resulting UTF-8 URI exceeds {@link MAX_SYNC_QR_BYTES} (213 B).
 */
export function buildPairingQrUri(params: PairingQrParams): string {
  const code = params.code.trim();
  if (!validatePairingCode(code)) {
    throw new Error('Invalid pairing code');
  }
  const keyBytes = decodeEphemeralKey(params.keyB64);
  if (keyBytes === null) {
    throw new Error('Pairing key must decode to 16 bytes');
  }
  const canonicalKey = base64UrlEncode(keyBytes);
  let uri = `${QR_PREFIX}c=${code}&k=${canonicalKey}`;

  if (params.serverUrl !== undefined && params.serverUrl.trim().length > 0) {
    const cleanServer = normalizeSyncServerUrl(params.serverUrl, '');
    if (cleanServer.length === 0) {
      throw new Error('Invalid pairing serverUrl');
    }
    uri += `&s=${encodeURIComponent(cleanServer)}`;
  }

  if (utf8ByteLength(uri) > MAX_SYNC_QR_BYTES) {
    throw new Error(`Pairing QR URI exceeds ${MAX_SYNC_QR_BYTES} UTF-8 bytes`);
  }
  return uri;
}

/** Parses and validates a scanned `elviptv://pair?...` QR URI. */
export function parsePairingQrUri(raw: string): Result<PairingQrParams> {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || utf8ByteLength(trimmed) > MAX_SYNC_QR_BYTES) {
    return err(elvError('source-format', 'invalid-qr-uri'));
  }
  if (!trimmed.toLowerCase().startsWith(QR_PREFIX)) {
    return err(elvError('source-format', 'invalid-qr-scheme'));
  }
  const query = trimmed.slice(QR_PREFIX.length);
  const hashIdx = query.indexOf('#');
  const cleanQuery = hashIdx === -1 ? query : query.slice(0, hashIdx);

  let code: string | undefined;
  let keyB64: string | undefined;
  let serverUrl: string | undefined;

  for (const part of cleanQuery.split('&')) {
    if (part.length === 0) continue;
    const eq = part.indexOf('=');
    if (eq <= 0) return err(elvError('source-format', 'invalid-qr-param'));
    const k = part.slice(0, eq);
    let v: string;
    try {
      v = decodeURIComponent(part.slice(eq + 1));
    } catch {
      return err(elvError('source-format', 'invalid-qr-encoding'));
    }
    if (k === 'c') code = v;
    else if (k === 'k') keyB64 = v;
    else if (k === 's') serverUrl = v;
  }

  if (code === undefined || !validatePairingCode(code)) {
    return err(elvError('source-format', 'invalid-qr-code'));
  }
  if (keyB64 === undefined || decodeEphemeralKey(keyB64) === null) {
    return err(elvError('source-format', 'invalid-qr-key'));
  }
  if (serverUrl !== undefined) {
    const cleanServer = normalizeSyncServerUrl(serverUrl, '');
    if (cleanServer.length === 0) {
      return err(elvError('source-format', 'invalid-qr-server'));
    }
    return ok({ code, keyB64, serverUrl: cleanServer });
  }
  return ok({ code, keyB64 });
}

function parseJson(text: string): Record<string, unknown> | null {
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

function pairingAad(code: string): Uint8Array {
  return utf8Encode(`elv-pair-v1|${code.trim().toUpperCase()}`);
}

/** Creates an E2EE {@link QrPairingClient} where ephemeral key `k` never leaves the devices. */
export function createQrPairingClient(options: QrPairingClientOptions): QrPairingClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  return {
    async createSession(opts) {
      let resStatus: number;
      let body: Record<string, unknown> | null;
      try {
        const res = await options.http.request({
          method: 'POST',
          url: `${baseUrl}/v1/pair/create`,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: '{}',
          ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
        });
        resStatus = res.status;
        body = parseJson(res.bodyText);
      } catch {
        return err(elvError('network', 'pair-create-failed'));
      }

      if (resStatus < 200 || resStatus >= 300) {
        return err(elvError('network', `http-${resStatus}`));
      }
      const parsedExpiresAt =
        typeof body?.expiresAt === 'number'
          ? body.expiresAt
          : typeof body?.expiresAt === 'string' && !Number.isNaN(Date.parse(body.expiresAt))
            ? Date.parse(body.expiresAt)
            : null;
      if (
        body === null ||
        typeof body.pairingId !== 'string' ||
        typeof body.code !== 'string' ||
        typeof body.pollToken !== 'string' ||
        parsedExpiresAt === null
      ) {
        return err(elvError('network', 'invalid-pair-create-response'));
      }

      const ephemeralKey = options.crypto.randomBytes(EPHEMERAL_KEY_BYTES);
      const keyB64 = base64UrlEncode(ephemeralKey);
      let qrUri: string;
      try {
        qrUri = buildPairingQrUri({
          code: body.code,
          keyB64,
          ...(opts?.includeServerUrl === true ? { serverUrl: baseUrl } : {}),
        });
      } catch {
        return err(elvError('source-format', 'qr-uri-build-failed'));
      }

      return ok({
        pairingId: body.pairingId,
        code: body.code,
        pollToken: body.pollToken,
        expiresAt: parsedExpiresAt,
        ephemeralKey,
        keyB64,
        qrUri,
      });
    },

    async claimSession({ accessToken, qrUriOrParams, payload, signal }) {
      let parsed: PairingQrParams;
      if (typeof qrUriOrParams === 'string') {
        const uriRes = parsePairingQrUri(qrUriOrParams);
        if (!uriRes.ok) return uriRes;
        parsed = uriRes.value;
      } else {
        parsed = qrUriOrParams;
      }

      const normalizedCode = parsed.code.trim().toUpperCase();
      const keyBytes = decodeEphemeralKey(parsed.keyB64);
      if (keyBytes === null || !validatePairingCode(normalizedCode)) {
        return err(elvError('source-format', 'invalid-qr-params'));
      }

      if (parsed.serverUrl !== undefined && parsed.serverUrl.trim().length > 0) {
        const normalizedClientBase = normalizeSyncServerUrl(options.baseUrl, '');
        const normalizedQrServer = normalizeSyncServerUrl(parsed.serverUrl, '');
        if (
          normalizedClientBase.length === 0 ||
          normalizedQrServer.length === 0 ||
          normalizedQrServer !== normalizedClientBase
        ) {
          return err(elvError('auth', 'server_origin_mismatch'));
        }
      }

      const iv = options.crypto.randomBytes(AES_GCM_IV_BYTES);
      const plaintext = utf8Encode(JSON.stringify(payload));
      const ct = await options.crypto.encryptAesGcm(
        keyBytes,
        iv,
        plaintext,
        pairingAad(normalizedCode),
      );

      try {
        const res = await options.http.request({
          method: 'POST',
          url: `${baseUrl}/v1/pair/claim`,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            code: normalizedCode,
            encryptedPayload: base64UrlEncode(ct),
            iv: base64UrlEncode(iv),
          }),
          ...(signal !== undefined ? { signal } : {}),
        });
        if (res.status === 401 || res.status === 403) {
          return err(elvError('auth', `http-${res.status}`));
        }
        if (res.status === 410) {
          return err(elvError('auth', 'pairing-expired'));
        }
        if (res.status < 200 || res.status >= 300) {
          return err(elvError('network', `http-${res.status}`));
        }
        return ok({ claimed: true });
      } catch {
        return err(elvError('network', 'pair-claim-failed'));
      }
    },

    async pollSession(session, signal) {
      let status: number;
      let body: Record<string, unknown> | null;
      try {
        const res = await options.http.request({
          method: 'GET',
          url: `${baseUrl}/v1/pair/poll/${encodeURIComponent(session.pairingId)}`,
          headers: {
            Accept: 'application/json',
            'X-Pair-Poll-Token': session.pollToken,
          },
          ...(signal !== undefined ? { signal } : {}),
        });
        status = res.status;
        body = parseJson(res.bodyText);
      } catch {
        return err(elvError('network', 'pair-poll-failed'));
      }

      if (status === 410) {
        return ok({ status: 'expired' });
      }
      if (status < 200 || status >= 300) {
        return err(elvError('network', `http-${status}`));
      }
      if (body === null || typeof body.status !== 'string') {
        return err(elvError('network', 'invalid-pair-poll-response'));
      }
      if (body.status === 'pending') {
        return ok({ status: 'pending' });
      }
      if (
        body.status !== 'claimed' ||
        typeof body.encryptedPayload !== 'string' ||
        typeof body.iv !== 'string'
      ) {
        return err(elvError('network', 'invalid-pair-poll-response'));
      }

      try {
        const iv = base64UrlDecode(body.iv);
        if (iv.length !== AES_GCM_IV_BYTES) {
          return err(elvError('auth', 'pair-decrypt-failed'));
        }
        const ct = base64UrlDecode(body.encryptedPayload);
        const decrypted = await options.crypto.decryptAesGcm(
          session.ephemeralKey,
          iv,
          ct,
          pairingAad(session.code),
        );
        const parsedPayload = parseJson(utf8Decode(decrypted));
        if (
          parsedPayload === null ||
          typeof parsedPayload.email !== 'string' ||
          typeof parsedPayload.refreshToken !== 'string' ||
          typeof parsedPayload.vaultKeyB64 !== 'string'
        ) {
          return err(elvError('auth', 'invalid-pair-payload'));
        }
        return ok({
          status: 'claimed',
          payload: {
            email: parsedPayload.email,
            refreshToken: parsedPayload.refreshToken,
            vaultKeyB64: parsedPayload.vaultKeyB64,
          },
        });
      } catch {
        return err(elvError('auth', 'pair-decrypt-failed'));
      }
    },
  };
}
