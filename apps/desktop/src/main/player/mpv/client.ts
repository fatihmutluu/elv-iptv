import type { Duplex } from 'node:stream';
import type { MpvCommand, MpvEvent, MpvReply } from './codec.ts';
import { encodeCommand, LineDecoder } from './codec.ts';

/** mpv did not answer a command in time; the process counts as wedged. */
export class MpvWedgedError extends Error {
  constructor(message = 'mpv did not reply in time') {
    super(message);
    this.name = 'MpvWedgedError';
  }
}

/** A JSON IPC connection to one mpv process. */
export interface MpvClient {
  /** Sends a command; rejects with `MpvWedgedError` on timeout and with an error when the connection closes. */
  command(cmd: MpvCommand): Promise<MpvReply>;
  /** Starts observing a property and returns its observe id (carried by `property-change` events). */
  observe(name: string): number;
  onEvent(listener: (event: MpvEvent) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
}

interface Pending {
  resolve(reply: MpvReply): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Wraps a connected duplex stream (a named pipe or unix socket) as an mpv client. */
export function createMpvClient(stream: Duplex, opts: { replyTimeoutMs: number }): MpvClient {
  const decoder = new LineDecoder();
  const pending = new Map<number, Pending>();
  const eventListeners = new Set<(event: MpvEvent) => void>();
  const closeListeners = new Set<() => void>();
  let nextRequestId = 1;
  let nextObserveId = 1;
  let closed = false;

  const failAll = (error: Error): void => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  const handleClose = (): void => {
    if (closed) return;
    closed = true;
    failAll(new Error('mpv connection closed'));
    for (const l of [...closeListeners]) l();
  };

  stream.on('data', (chunk: Buffer) => {
    for (const message of decoder.push(chunk)) {
      if ('request_id' in message && typeof message.request_id === 'number') {
        const entry = pending.get(message.request_id);
        if (!entry) continue;
        pending.delete(message.request_id);
        clearTimeout(entry.timer);
        entry.resolve(message as MpvReply);
      } else if ('event' in message) {
        for (const l of [...eventListeners]) {
          try {
            l(message);
          } catch {
            // one failing listener must not drop the rest of the chunk
          }
        }
      }
    }
  });
  stream.on('close', handleClose);
  stream.on('end', handleClose);
  stream.on('error', handleClose);

  const command = (cmd: MpvCommand): Promise<MpvReply> => {
    if (closed) return Promise.reject(new Error('mpv connection closed'));
    const requestId = nextRequestId++;
    return new Promise<MpvReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new MpvWedgedError());
      }, opts.replyTimeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      stream.write(encodeCommand(cmd, requestId));
    });
  };

  return {
    command,
    observe(name) {
      const id = nextObserveId++;
      command(['observe_property', id, name]).catch(() => undefined);
      return id;
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    close() {
      stream.destroy();
      handleClose();
    },
  };
}
