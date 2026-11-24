import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { type NetworkInterfaceInfo, networkInterfaces } from 'node:os';
import {
  buildLanPairingUrl,
  constantTimeEqual,
  isPrivateLanAddress,
  isValidPairingHostHeader,
  isValidPairingOrigin,
  isValidPairingPath,
  LAN_PAIRING_MAX_BODY_BYTES,
  LAN_PAIRING_MAX_FAILED_ATTEMPTS,
  LAN_PAIRING_TTL_MS,
  type LanPairingLocale,
  type LanPairingPayload,
  type LanPairingSessionInfo,
  parseLanPairingPayload,
  renderLanPairingHtml,
} from '@elv/sources';

/** Reason an ephemeral LAN pairing session closed. */
type LanPairingCloseReason = 'delivered' | 'expired' | 'locked-out' | 'stopped';

/** Collaborators and bounds injected into {@link createLanPairingServer}. */
export interface LanPairingServerDeps {
  readonly bindHost?: string;
  readonly advertiseHost?: string;
  readonly ttlMs?: number;
  readonly maxBodyBytes?: number;
  readonly maxFailedAttempts?: number;
  readonly now?: () => number;
  readonly generateToken?: () => string;
  readonly getNetworkInterfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  readonly resolvePeerIp?: (req: IncomingMessage) => string;
  readonly onPayload?: (payload: LanPairingPayload) => void;
  readonly onClosed?: (reason: LanPairingCloseReason) => void;
}

/** Main-process ephemeral HTTP server for phone-to-TV QR LAN pairing (`#50`). */
export interface LanPairingServer {
  start(opts?: { readonly locale?: LanPairingLocale }): Promise<LanPairingSessionInfo>;
  stop(): Promise<void>;
  isActive(): boolean;
  onPayload(listener: (payload: LanPairingPayload) => void): () => void;
}

const PREFERRED_IFACE_RE = /^(wi-?fi|wlan|en\d+|eth\d+|ethernet)/i;
const VIRTUAL_IFACE_RE =
  /(vethernet|wsl|docker|vbox|vmware|vmnet|tailscale|utun|virbr|br-|tun|tap|loopback)/i;
const PAIRING_HTML_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function isNonLoopbackPrivateIpv4(info: NetworkInterfaceInfo): boolean {
  const isV4 = info.family === 'IPv4' || (info.family as unknown) === 4;
  if (!isV4 || info.internal) return false;
  if (info.address.startsWith('127.')) return false;
  return isPrivateLanAddress(info.address);
}

/**
 * Selects the best non-loopback RFC1918 IPv4 address from local OS network interfaces,
 * preferring physical Wi-Fi/Ethernet adapters over virtual bridges. Returns `null` when no
 * non-loopback private IPv4 interface is available.
 */
export function discoverLanIpv4(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string | null {
  const candidates: { readonly address: string; readonly rank: number }[] = [];
  for (const [ifaceName, entries] of Object.entries(interfaces)) {
    if (!entries) continue;
    for (const info of entries) {
      if (!isNonLoopbackPrivateIpv4(info)) continue;
      let rank = 1;
      if (VIRTUAL_IFACE_RE.test(ifaceName)) rank = 2;
      else if (PREFERRED_IFACE_RE.test(ifaceName)) rank = 0;
      candidates.push({ address: info.address, rank });
    }
  }
  candidates.sort((a, b) => a.rank - b.rank);
  return candidates[0]?.address ?? null;
}

function setSecurityHeaders(res: ServerResponse, extra?: Readonly<Record<string, string>>): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Connection', 'close');
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      res.setHeader(key, value);
    }
  }
}

function readBoundedBody(
  req: IncomingMessage,
  maxBodyBytes: number,
): Promise<
  { readonly ok: true; readonly body: string } | { readonly ok: false; readonly tooLarge: boolean }
> {
  return new Promise((resolve) => {
    const rawContentLength = req.headers['content-length'];
    if (typeof rawContentLength === 'string') {
      const parsedLength = Number.parseInt(rawContentLength, 10);
      if (Number.isFinite(parsedLength) && parsedLength > maxBodyBytes) {
        req.resume();
        resolve({ ok: false, tooLarge: true });
        return;
      }
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const finish = (
      result:
        | { readonly ok: true; readonly body: string }
        | { readonly ok: false; readonly tooLarge: boolean },
    ): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      totalBytes += buf.byteLength;
      if (totalBytes > maxBodyBytes) {
        req.pause();
        finish({ ok: false, tooLarge: true });
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      finish({ ok: true, body: Buffer.concat(chunks, totalBytes).toString('utf8') });
    });
    req.on('error', () => {
      finish({ ok: false, tooLarge: false });
    });
    req.on('aborted', () => {
      finish({ ok: false, tooLarge: false });
    });
  });
}

interface ActiveSession {
  readonly server: Server;
  readonly sockets: Set<Socket>;
  readonly token: string;
  readonly host: string;
  readonly port: number;
  readonly locale: LanPairingLocale;
  readonly expiresAtMs: number;
  readonly timer: ReturnType<typeof setTimeout>;
  failedAttempts: number;
  consumed: boolean;
  closing: boolean;
}

/**
 * Creates a single-use ephemeral main-process HTTP server for phone-to-TV LAN QR pairing (`#50`).
 * Never logs request headers, bodies, URLs, or credentials, and auto-closes immediately upon first
 * valid payload submission, TTL expiry, lockout, or explicit `stop()`.
 */
export function createLanPairingServer(deps?: LanPairingServerDeps): LanPairingServer {
  const bindHost = deps?.bindHost ?? '0.0.0.0';
  const ttlMs = deps?.ttlMs ?? LAN_PAIRING_TTL_MS;
  const maxBodyBytes = deps?.maxBodyBytes ?? LAN_PAIRING_MAX_BODY_BYTES;
  const maxFailedAttempts = deps?.maxFailedAttempts ?? LAN_PAIRING_MAX_FAILED_ATTEMPTS;
  const now = deps?.now ?? Date.now;
  const generateToken = deps?.generateToken ?? (() => randomBytes(24).toString('hex'));
  const getInterfaces = deps?.getNetworkInterfaces ?? networkInterfaces;
  const resolvePeerIp =
    deps?.resolvePeerIp ?? ((req: IncomingMessage) => req.socket.remoteAddress ?? '');

  const payloadListeners = new Set<(payload: LanPairingPayload) => void>();
  if (deps?.onPayload) payloadListeners.add(deps.onPayload);

  let active: ActiveSession | undefined;

  const emitPayload = (payload: LanPairingPayload): void => {
    for (const listener of [...payloadListeners]) {
      try {
        listener(payload);
      } catch {
        // isolate subscriber errors
      }
    }
  };

  const closeSession = (
    session: ActiveSession,
    reason: LanPairingCloseReason,
    keepOpenSocket?: Socket,
  ): Promise<void> => {
    if (session.closing) return Promise.resolve();
    session.closing = true;
    session.consumed = true;
    clearTimeout(session.timer);
    if (active === session) active = undefined;

    for (const socket of [...session.sockets]) {
      if (socket !== keepOpenSocket) {
        socket.destroy();
        session.sockets.delete(socket);
      }
    }

    return new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        try {
          deps?.onClosed?.(reason);
        } catch {
          // isolate lifecycle callback errors
        }
        resolve();
      };
      try {
        session.server.close(() => done());
      } catch {
        done();
      }
      if (keepOpenSocket === undefined) {
        for (const socket of [...session.sockets]) {
          socket.destroy();
          session.sockets.delete(socket);
        }
      } else {
        const sweep = setTimeout(() => {
          if (!keepOpenSocket.destroyed) keepOpenSocket.destroy();
          session.sockets.delete(keepOpenSocket);
          done();
        }, 500);
        sweep.unref?.();
      }
    });
  };

  const handleRequest = async (
    session: ActiveSession,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const reply = (
      statusCode: number,
      body: string,
      extraHeaders?: Readonly<Record<string, string>>,
      onFinish?: () => void,
    ): void => {
      if (res.writableEnded || res.destroyed) {
        onFinish?.();
        return;
      }
      setSecurityHeaders(res, extraHeaders);
      res.statusCode = statusCode;
      res.end(body, () => {
        onFinish?.();
      });
    };

    const fail = (statusCode: number, extraHeaders?: Readonly<Record<string, string>>): void => {
      session.failedAttempts += 1;
      const lockedOut = session.failedAttempts >= maxFailedAttempts;
      if (lockedOut) {
        void closeSession(session, 'locked-out', req.socket);
      }
      reply(statusCode, '', extraHeaders, () => {
        if (lockedOut && !req.socket.destroyed) req.socket.destroy();
      });
    };

    if (session.closing || session.consumed) {
      reply(410, '');
      return;
    }
    if (now() > session.expiresAtMs) {
      void closeSession(session, 'expired', req.socket);
      reply(410, '', undefined, () => {
        if (!req.socket.destroyed) req.socket.destroy();
      });
      return;
    }

    const peerIp = resolvePeerIp(req);
    if (!isPrivateLanAddress(peerIp)) {
      fail(403);
      return;
    }

    const hostHeader = typeof req.headers.host === 'string' ? req.headers.host : undefined;
    if (!isValidPairingHostHeader(hostHeader, session.host, session.port)) {
      fail(403);
      return;
    }

    const rawUrl = typeof req.url === 'string' ? req.url : '';
    const queryIdx = rawUrl.indexOf('?');
    const cleanPath = queryIdx === -1 ? rawUrl : rawUrl.slice(0, queryIdx);
    const expectedPath = `/pair/${session.token}`;
    if (!isValidPairingPath(rawUrl, session.token) || !constantTimeEqual(cleanPath, expectedPath)) {
      fail(404);
      return;
    }

    const method = (req.method ?? '').toUpperCase();
    if (method === 'GET') {
      const html = renderLanPairingHtml({ token: session.token, locale: session.locale });
      reply(200, html, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': PAIRING_HTML_CSP,
      });
      return;
    }

    if (method !== 'POST') {
      fail(405, { Allow: 'GET, POST' });
      return;
    }

    const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!isValidPairingOrigin(originHeader, session.host, session.port)) {
      fail(403);
      return;
    }

    const bodyResult = await readBoundedBody(req, maxBodyBytes);
    if (!bodyResult.ok) {
      fail(bodyResult.tooLarge ? 413 : 400);
      return;
    }

    if (session.closing || session.consumed) {
      reply(410, '');
      return;
    }

    const contentType =
      typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : undefined;
    const parsed = parseLanPairingPayload(bodyResult.body, contentType);
    if (!parsed.ok) {
      fail(parsed.error.code === 'payload-too-large' ? 413 : 400);
      return;
    }

    session.consumed = true;
    void closeSession(session, 'delivered', req.socket);
    emitPayload(parsed.value);
    reply(200, '{"ok":true}', { 'Content-Type': 'application/json; charset=utf-8' }, () => {
      if (!req.socket.destroyed) req.socket.destroy();
    });
  };

  return {
    async start(opts?: { readonly locale?: LanPairingLocale }): Promise<LanPairingSessionInfo> {
      if (active) {
        await closeSession(active, 'stopped');
      }

      const host = deps?.advertiseHost ?? discoverLanIpv4(getInterfaces());
      if (host === null) {
        throw new Error('lan-unavailable');
      }

      const token = generateToken();
      const locale: LanPairingLocale = opts?.locale === 'tr' ? 'tr' : 'en';
      const sockets = new Set<Socket>();

      let sessionRef: ActiveSession | undefined;
      const server = createServer(
        {
          requestTimeout: 10_000,
          headersTimeout: 5_000,
          keepAliveTimeout: 1_000,
        },
        (req, res) => {
          if (!sessionRef) {
            setSecurityHeaders(res);
            res.statusCode = 503;
            res.end();
            return;
          }
          void handleRequest(sessionRef, req, res);
        },
      );

      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.once('close', () => {
          sockets.delete(socket);
        });
      });

      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(0, bindHost);
      });

      const addr = server.address() as AddressInfo | null;
      if (!addr || typeof addr === 'string') {
        server.close();
        throw new Error('LAN pairing server failed to bind ephemeral TCP port');
      }

      const port = addr.port;
      const expiresAtMs = now() + ttlMs;
      const timer = setTimeout(() => {
        if (sessionRef) void closeSession(sessionRef, 'expired');
      }, ttlMs);
      timer.unref?.();

      const session: ActiveSession = {
        server,
        sockets,
        token,
        host,
        port,
        locale,
        expiresAtMs,
        timer,
        failedAttempts: 0,
        consumed: false,
        closing: false,
      };
      sessionRef = session;
      active = session;

      return {
        url: buildLanPairingUrl(host, port, token),
        token,
        host,
        port,
        expiresAtMs,
      };
    },

    async stop(): Promise<void> {
      if (!active) return;
      await closeSession(active, 'stopped');
    },

    isActive(): boolean {
      return active !== undefined && !active.closing;
    },

    onPayload(listener: (payload: LanPairingPayload) => void): () => void {
      payloadListeners.add(listener);
      return () => {
        payloadListeners.delete(listener);
      };
    },
  };
}
