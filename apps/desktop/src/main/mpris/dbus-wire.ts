import { createConnection } from 'node:net';
import type { Duplex } from 'node:stream';
import {
  DBUS_MSG_TYPE,
  type DbusMessage,
  type DbusVariant,
  dbusVariant,
  encodeDbusMessage,
  splitCompleteTypes,
  tryDecodeDbusMessage,
} from './dbus-codec.ts';

export {
  DBUS_MSG_TYPE,
  type DbusMessage,
  type DbusVariant,
  dbusVariant,
  encodeDbusMessage,
  splitCompleteTypes,
  tryDecodeDbusMessage,
};

const MAX_SOCKET_PATH_CHARS = 256;
const DEFAULT_CALL_TIMEOUT_MS = 5000;

/** Error returned by a remote D-Bus peer. */
export class DbusRemoteError extends Error {
  readonly errorName: string;
  constructor(errorName: string, message?: string) {
    super(message ? `${errorName}: ${message}` : errorName);
    this.name = 'DbusRemoteError';
    this.errorName = errorName;
  }
}

function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function percentDecodeDbus(raw: string): string | null {
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '%') {
      if (i + 2 >= raw.length) return null;
      const hex = raw.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      const encoded = Buffer.from(ch as string, 'utf8');
      for (const b of encoded) bytes.push(b);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Extracts a safe Unix domain socket path from `$DBUS_SESSION_BUS_ADDRESS` (e.g.
 * `unix:path=/run/user/1000/bus`). Rejects non-unix transports, abstract sockets, malformed
 * percent-escapes, NUL bytes, control characters, and overly long paths.
 */
export function parseDbusSessionAddress(raw: string | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  for (const part of raw.split(';')) {
    const entry = part.trim();
    if (!entry.startsWith('unix:')) continue;
    for (const param of entry.slice('unix:'.length).split(',')) {
      const eq = param.indexOf('=');
      if (eq <= 0) continue;
      const key = param.slice(0, eq).trim();
      const val = param.slice(eq + 1).trim();
      if (key !== 'path' || val.length === 0) continue;
      const decoded = percentDecodeDbus(val);
      if (
        decoded === null ||
        decoded.length === 0 ||
        decoded.length > MAX_SOCKET_PATH_CHARS ||
        !decoded.startsWith('/') ||
        hasControlChar(decoded)
      ) {
        return null;
      }
      return decoded;
    }
  }
  return null;
}

/** Outgoing D-Bus `METHOD_CALL` descriptor. */
interface DbusCallRequest {
  readonly destination: string;
  readonly path: string;
  readonly interface?: string;
  readonly member: string;
  readonly signature?: string;
  readonly body?: readonly unknown[];
}

/** Outgoing D-Bus `SIGNAL` descriptor. */
interface DbusSignalMessage {
  readonly path: string;
  readonly interface: string;
  readonly member: string;
  readonly signature?: string;
  readonly body?: readonly unknown[];
}

/** Minimal D-Bus 1.0 session client over a Unix domain socket or injected `Duplex` stream. */
export interface DbusClient {
  connect(): Promise<void>;
  call(request: DbusCallRequest): Promise<DbusMessage>;
  sendReply(
    replySerial: number,
    destination: string | undefined,
    signature: string,
    body: readonly unknown[],
  ): void;
  sendError(
    replySerial: number,
    destination: string | undefined,
    errorName: string,
    message: string,
  ): void;
  sendSignal(signal: DbusSignalMessage): void;
  onMethodCall(listener: (msg: DbusMessage) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
}

/** Options for {@link createDbusClient}. */
export interface DbusClientOptions {
  readonly socketPath: string;
  /** Injectable socket/stream factory for deterministic unit tests. */
  readonly connect?: (socketPath: string) => Duplex;
  /** Injectable UID lookup for SASL `EXTERNAL` auth (defaults to `process.getuid?.() ?? 1000`). */
  readonly getUid?: () => number;
  /** Timeout (ms) for `connect` and `call` round-trips (default `5000`). */
  readonly timeoutMs?: number;
}

/** Creates a zero-dependency D-Bus 1.0 client speaking `EXTERNAL` SASL auth and binary wire framing. */
export function createDbusClient(options: DbusClientOptions): DbusClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const connectStream =
    options.connect ?? ((socketPath: string): Duplex => createConnection({ path: socketPath }));
  const getUid = options.getUid ?? (() => process.getuid?.() ?? 1000);

  let stream: Duplex | undefined;
  let closed = false;
  let authenticated = false;
  let nextSerial = 1;
  let rxBuf: Buffer = Buffer.alloc(0);

  const methodCallListeners = new Set<(msg: DbusMessage) => void>();
  const closeListeners = new Set<() => void>();
  const pendingCalls = new Map<
    number,
    {
      resolve(msg: DbusMessage): void;
      reject(err: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  let authResolve: (() => void) | undefined;
  let authReject: ((err: Error) => void) | undefined;
  let authTimer: ReturnType<typeof setTimeout> | undefined;

  const allocSerial = (): number => {
    const s = nextSerial;
    nextSerial = nextSerial >= 0xffff_ffff ? 1 : nextSerial + 1;
    return s;
  };

  const failPending = (err: Error): void => {
    if (authTimer !== undefined) {
      clearTimeout(authTimer);
      authTimer = undefined;
    }
    if (authReject) {
      const reject = authReject;
      authResolve = undefined;
      authReject = undefined;
      reject(err);
    }
    for (const [serial, pending] of [...pendingCalls]) {
      pendingCalls.delete(serial);
      clearTimeout(pending.timer);
      pending.reject(err);
    }
  };

  const teardown = (err?: Error): void => {
    if (closed) return;
    closed = true;
    failPending(err ?? new Error('D-Bus connection closed'));
    const active = stream;
    stream = undefined;
    if (active) {
      try {
        active.destroy();
      } catch {
        // ignore socket destroy error
      }
    }
    for (const listener of [...closeListeners]) {
      try {
        listener();
      } catch {
        // isolate close listeners
      }
    }
  };

  const handleMessage = (msg: DbusMessage): void => {
    if (msg.type === DBUS_MSG_TYPE.METHOD_RETURN && msg.replySerial !== undefined) {
      const pending = pendingCalls.get(msg.replySerial);
      if (pending) {
        pendingCalls.delete(msg.replySerial);
        clearTimeout(pending.timer);
        pending.resolve(msg);
      }
      return;
    }
    if (msg.type === DBUS_MSG_TYPE.ERROR && msg.replySerial !== undefined) {
      const pending = pendingCalls.get(msg.replySerial);
      if (pending) {
        pendingCalls.delete(msg.replySerial);
        clearTimeout(pending.timer);
        const detail = typeof msg.body[0] === 'string' ? msg.body[0] : undefined;
        pending.reject(
          new DbusRemoteError(msg.errorName ?? 'org.freedesktop.DBus.Error.Failed', detail),
        );
      }
      return;
    }
    if (msg.type === DBUS_MSG_TYPE.METHOD_CALL) {
      for (const listener of [...methodCallListeners]) {
        try {
          listener(msg);
        } catch {
          // isolate method call handlers
        }
      }
    }
  };

  const drainMessages = (): void => {
    try {
      while (rxBuf.length >= 16) {
        const decoded = tryDecodeDbusMessage(rxBuf);
        if (!decoded) break;
        rxBuf = rxBuf.subarray(decoded.bytesRead);
        handleMessage(decoded.message);
      }
    } catch (error) {
      teardown(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const onData = (chunk: Buffer | string): void => {
    if (closed) return;
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    rxBuf = rxBuf.length === 0 ? bytes : Buffer.concat([rxBuf, bytes]);

    if (!authenticated) {
      const crlf = rxBuf.indexOf('\r\n');
      if (crlf === -1) {
        if (rxBuf.length > 4096) teardown(new Error('D-Bus SASL reply too long'));
        return;
      }
      const line = rxBuf.subarray(0, crlf).toString('ascii');
      rxBuf = rxBuf.subarray(crlf + 2);
      if (!line.startsWith('OK ')) {
        teardown(new Error(`D-Bus SASL EXTERNAL authentication failed: ${line}`));
        return;
      }
      authenticated = true;
      if (authTimer !== undefined) {
        clearTimeout(authTimer);
        authTimer = undefined;
      }
      stream?.write('BEGIN\r\n');
      const resolve = authResolve;
      authResolve = undefined;
      authReject = undefined;
      resolve?.();
    }

    if (authenticated && rxBuf.length > 0) drainMessages();
  };

  const writeMessage = (msg: DbusMessage): void => {
    if (closed || !authenticated || !stream) return;
    try {
      stream.write(encodeDbusMessage(msg));
    } catch {
      // ignore broken pipe writes
    }
  };

  return {
    connect() {
      if (closed) return Promise.reject(new Error('D-Bus client is closed'));
      if (authenticated) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        authResolve = resolve;
        authReject = reject;
        authTimer = setTimeout(
          () => teardown(new Error('D-Bus authentication timed out')),
          timeoutMs,
        );
        let sock: Duplex;
        try {
          sock = connectStream(options.socketPath);
        } catch (error) {
          teardown(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        stream = sock;
        sock.on('data', onData);
        sock.on('error', (err: Error) => teardown(err));
        sock.on('close', () => teardown(new Error('D-Bus socket closed')));
        const uidHex = Buffer.from(String(getUid()), 'ascii').toString('hex');
        sock.write(
          Buffer.concat([Buffer.from([0x00]), Buffer.from(`AUTH EXTERNAL ${uidHex}\r\n`, 'ascii')]),
        );
      });
    },
    call(request) {
      if (closed || !authenticated || !stream) {
        return Promise.reject(new Error('D-Bus client is not connected'));
      }
      const serial = allocSerial();
      return new Promise<DbusMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingCalls.delete(serial);
          reject(new Error(`D-Bus call ${request.member} timed out`));
        }, timeoutMs);
        pendingCalls.set(serial, { resolve, reject, timer });
        writeMessage({
          type: DBUS_MSG_TYPE.METHOD_CALL,
          flags: 0,
          serial,
          destination: request.destination,
          path: request.path,
          ...(request.interface !== undefined ? { interface: request.interface } : {}),
          member: request.member,
          ...(request.signature !== undefined ? { signature: request.signature } : {}),
          body: request.body ?? [],
        });
      });
    },
    sendReply(replySerial, destination, signature, body) {
      writeMessage({
        type: DBUS_MSG_TYPE.METHOD_RETURN,
        flags: 0,
        serial: allocSerial(),
        replySerial,
        ...(destination !== undefined ? { destination } : {}),
        ...(signature.length > 0 ? { signature } : {}),
        body,
      });
    },
    sendError(replySerial, destination, errorName, message) {
      writeMessage({
        type: DBUS_MSG_TYPE.ERROR,
        flags: 0,
        serial: allocSerial(),
        replySerial,
        ...(destination !== undefined ? { destination } : {}),
        errorName,
        signature: 's',
        body: [message],
      });
    },
    sendSignal(signal) {
      writeMessage({
        type: DBUS_MSG_TYPE.SIGNAL,
        flags: 0,
        serial: allocSerial(),
        path: signal.path,
        interface: signal.interface,
        member: signal.member,
        ...(signal.signature !== undefined ? { signature: signal.signature } : {}),
        body: signal.body ?? [],
      });
    },
    onMethodCall(listener) {
      methodCallListeners.add(listener);
      return () => {
        methodCallListeners.delete(listener);
      };
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => {
        closeListeners.delete(listener);
      };
    },
    close() {
      teardown();
      methodCallListeners.clear();
      closeListeners.clear();
    },
  };
}
