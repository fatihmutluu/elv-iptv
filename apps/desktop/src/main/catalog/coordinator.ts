import type { SecretStore } from '@elv/domain';
import type { TelemetryRecordRequest } from '../../shared/sync-ipc.ts';
import { isWorkerToMainMessage, type MainToWorkerMessage } from './worker-protocol.ts';

/** Subset of Electron's `UtilityProcess` required by {@link createCatalogCoordinator}. */
export interface UtilityChildLike<TPort = unknown> {
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  postMessage(message: MainToWorkerMessage, transfer?: TPort[]): void;
  kill(): boolean;
}

/** Subset of Electron's `MessageChannelMain` returned by `createChannel`. */
interface PortPairLike<TPort = unknown> {
  readonly port1: TPort;
  readonly port2: TPort;
}

/** Dependencies for {@link createCatalogCoordinator}. */
export interface CatalogCoordinatorDeps<TPort = unknown> {
  dbPath: string;
  workerPath: string;
  secrets: SecretStore;
  fork: (workerPath: string) => UtilityChildLike<TPort>;
  createChannel: () => PortPairLike<TPort>;
  log?: (line: string) => void;
  shutdownTimeoutMs?: number;
  /** Optional opt-in telemetry sink for SQLite slow ops & catalog/EPG import metrics (`#509`). */
  onTelemetry?: (event: TelemetryRecordRequest) => void;
}

/** Main-process lifecycle manager for the catalog `utilityProcess`. */
export interface CatalogCoordinator<TPort = unknown> {
  readonly isRunning: boolean;
  connectClient(): Promise<{ clientId: number; rendererPort: TPort }>;
  disconnectClient(clientId: number): void;
  onUnexpectedExit(listener: (code: number) => void): () => void;
  shutdown(): Promise<void>;
}

interface ActiveWorker<TPort> {
  readonly child: UtilityChildLike<TPort>;
  readonly ready: Promise<UtilityChildLike<TPort>>;
  closing: boolean;
  shutdownPromise?: Promise<void>;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;

/**
 * Spawns the catalog `utilityProcess` lazily on first client connection, bridges `SecretStore`
 * strictly over `parentPort`, transfers dedicated `MessagePort` pairs per renderer client, and
 * coordinates bounded graceful shutdown or crash recovery.
 */
export function createCatalogCoordinator<TPort = unknown>(
  deps: CatalogCoordinatorDeps<TPort>,
): CatalogCoordinator<TPort> {
  const { dbPath, workerPath, secrets, fork, createChannel } = deps;
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const shutdownTimeoutMs = deps.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;

  let active: ActiveWorker<TPort> | undefined;
  let nextClientId = 0;
  const exitListeners = new Set<(code: number) => void>();

  const handleSecretRequest = async (
    child: UtilityChildLike<TPort>,
    msg:
      | { reqId: number; op: 'get' | 'delete'; key: string }
      | { reqId: number; op: 'set'; key: string; value: string },
  ): Promise<void> => {
    try {
      if (msg.op === 'get') {
        const value = await secrets.get(msg.key);
        child.postMessage({
          type: 'secret-reply',
          reqId: msg.reqId,
          ok: true,
          value: value ?? null,
        });
      } else if (msg.op === 'set') {
        await secrets.set(msg.key, msg.value);
        child.postMessage({ type: 'secret-reply', reqId: msg.reqId, ok: true, value: null });
      } else {
        await secrets.delete(msg.key);
        child.postMessage({ type: 'secret-reply', reqId: msg.reqId, ok: true, value: null });
      }
    } catch {
      log('catalog coordinator: secret store operation failed');
      try {
        child.postMessage({
          type: 'secret-reply',
          reqId: msg.reqId,
          ok: false,
          message: 'secret store failed',
        });
      } catch {
        // worker already exited
      }
    }
  };

  const ensureWorker = (): Promise<UtilityChildLike<TPort>> => {
    if (active && !active.closing) return active.ready;

    const child = fork(workerPath);
    let settledReady = false;
    let resolveReady!: (value: UtilityChildLike<TPort>) => void;
    let rejectReady!: (reason: Error) => void;

    const ready = new Promise<UtilityChildLike<TPort>>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const state: ActiveWorker<TPort> = { child, ready, closing: false };
    active = state;

    child.on('message', (raw) => {
      if (!isWorkerToMainMessage(raw)) {
        log('catalog coordinator: dropped an invalid worker message');
        return;
      }
      if (raw.type === 'ready') {
        if (!settledReady) {
          settledReady = true;
          resolveReady(child);
        }
        return;
      }
      if (raw.type === 'secret-request') {
        void handleSecretRequest(child, raw);
        return;
      }
      if (raw.type === 'telemetry') {
        deps.onTelemetry?.(raw.event);
      }
    });

    child.on('exit', (code) => {
      if (active === state) {
        active = undefined;
      }
      if (!settledReady) {
        settledReady = true;
        rejectReady(new Error(`catalog utility process exited before ready (code ${code})`));
        return;
      }
      if (!state.closing) {
        log(`catalog coordinator: utility process exited unexpectedly (code ${code})`);
        for (const listener of [...exitListeners]) listener(code);
      }
    });

    child.postMessage({ type: 'init', dbPath });
    return ready;
  };

  return {
    get isRunning(): boolean {
      return active !== undefined && !active.closing;
    },

    async connectClient(): Promise<{ clientId: number; rendererPort: TPort }> {
      const child = await ensureWorker();
      const clientId = ++nextClientId;
      const { port1, port2 } = createChannel();
      child.postMessage({ type: 'client-port', clientId }, [port2]);
      return { clientId, rendererPort: port1 };
    },

    disconnectClient(clientId: number): void {
      if (!active || active.closing) return;
      try {
        active.child.postMessage({ type: 'client-disconnect', clientId });
      } catch {
        // worker already exited
      }
    },

    onUnexpectedExit(listener: (code: number) => void): () => void {
      exitListeners.add(listener);
      return () => {
        exitListeners.delete(listener);
      };
    },

    shutdown(): Promise<void> {
      const current = active;
      if (!current) return Promise.resolve();
      if (current.shutdownPromise) return current.shutdownPromise;

      current.closing = true;
      current.shutdownPromise = new Promise<void>((resolve) => {
        let finished = false;
        const finish = (): void => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          if (active === current) active = undefined;
          resolve();
        };

        const timer = setTimeout(() => {
          current.child.kill();
          finish();
        }, shutdownTimeoutMs);

        current.child.on('exit', () => finish());
        current.child.on('message', (raw) => {
          if (isWorkerToMainMessage(raw) && raw.type === 'shutdown-complete') {
            current.child.kill();
          }
        });

        try {
          current.child.postMessage({ type: 'shutdown' });
        } catch {
          finish();
        }
      });

      return current.shutdownPromise;
    },
  };
}
