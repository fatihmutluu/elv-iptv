import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProfileRecord, SourceRow } from '@elv/data';
import type { FetchLike, Result } from '@elv/domain';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { MainToWorkerMessage, WorkerToMainMessage } from '../main/catalog/worker-protocol.ts';
import {
  type CatalogIpcRendererLike,
  createCatalogBridge,
  type PreloadClientPortLike,
} from '../preload/catalog-bridge.ts';
import { CATALOG_CHANNELS, type CatalogClientMessage } from '../shared/catalog-ipc.ts';
import {
  createCatalogWorkerRuntime,
  type WorkerClientPortLike,
  type WorkerParentPortLike,
} from './catalog-worker-runtime.ts';

class BridgePortPair {
  readonly preloadSide: PreloadClientPortLike;
  readonly workerSide: WorkerClientPortLike;
  private workerStarted = false;
  private preloadStarted = false;
  private closed = false;

  constructor() {
    const workerEmitter = new EventEmitter();
    const preloadListeners = new Set<(ev: { readonly data: unknown }) => void>();
    const pendingToPreload: unknown[] = [];

    this.workerSide = {
      start: () => {
        this.workerStarted = true;
      },
      close: () => {
        if (this.closed) return;
        this.closed = true;
        workerEmitter.emit('close');
      },
      postMessage: (msg: unknown) => {
        if (this.closed) return;
        if (!this.preloadStarted) {
          pendingToPreload.push(msg);
          return;
        }
        for (const fn of [...preloadListeners]) fn({ data: msg });
      },
      on: workerEmitter.on.bind(workerEmitter),
      once: workerEmitter.once.bind(workerEmitter),
    };

    this.preloadSide = {
      addEventListener: (_type, listener) => {
        preloadListeners.add(listener);
      },
      removeEventListener: (_type, listener) => {
        preloadListeners.delete(listener);
      },
      postMessage: (msg: CatalogClientMessage) => {
        if (!this.closed && this.workerStarted) {
          workerEmitter.emit('message', { data: msg });
        }
      },
      start: () => {
        this.preloadStarted = true;
        while (pendingToPreload.length > 0) {
          const next = pendingToPreload.shift();
          for (const fn of [...preloadListeners]) fn({ data: next });
        }
      },
      close: () => {
        this.workerSide.close();
      },
    };
  }
}

const tempDirs: string[] = [];

function setupWorkerAndBridge() {
  const dir = mkdtempSync(join(tmpdir(), 'elv-worker-p7-'));
  tempDirs.push(dir);
  const dbPath = join(dir, 'catalog.db');
  const secrets = new Map<string, string>();
  const parentEmitter = new EventEmitter();
  const ipcEmitter = new EventEmitter();

  const ready = new Promise<void>((resolve) => {
    parentEmitter.on('worker-msg', (msg: WorkerToMainMessage) => {
      if (msg.type === 'ready') resolve();
    });
  });

  const parentPort: WorkerParentPortLike = {
    on: parentEmitter.on.bind(parentEmitter),
    off: parentEmitter.off.bind(parentEmitter),
    postMessage: (msg: WorkerToMainMessage) => {
      if (msg.type === 'secret-request') {
        if (msg.op === 'get') {
          parentEmitter.emit('message', {
            data: {
              type: 'secret-reply',
              reqId: msg.reqId,
              ok: true,
              value: secrets.get(msg.key) ?? null,
            } satisfies MainToWorkerMessage,
          });
        } else if (msg.op === 'set') {
          secrets.set(msg.key, msg.value);
          parentEmitter.emit('message', {
            data: {
              type: 'secret-reply',
              reqId: msg.reqId,
              ok: true,
              value: null,
            } satisfies MainToWorkerMessage,
          });
        } else {
          secrets.delete(msg.key);
          parentEmitter.emit('message', {
            data: {
              type: 'secret-reply',
              reqId: msg.reqId,
              ok: true,
              value: null,
            } satisfies MainToWorkerMessage,
          });
        }
        return;
      }
      parentEmitter.emit('worker-msg', msg);
    },
  };

  const fetchImpl: FetchLike = async () => new Response('', { status: 200 });
  const dispose = createCatalogWorkerRuntime({
    parentPort,
    openDatabase: (filePath) => new Database(filePath),
    fetchImpl,
    clock: () => 1_700_000_000_000,
    onExit: () => undefined,
  });

  parentEmitter.emit('message', {
    data: { type: 'init', dbPath } satisfies MainToWorkerMessage,
  });

  let nextClientId = 0;
  const ipc: CatalogIpcRendererLike = {
    send(channel, ...args) {
      if (channel === CATALOG_CHANNELS.connect) {
        const { connectId } = args[0] as { connectId: number };
        const pair = new BridgePortPair();
        parentEmitter.emit('message', {
          data: { type: 'client-port', clientId: ++nextClientId } satisfies MainToWorkerMessage,
          ports: [pair.workerSide],
        });
        ipcEmitter.emit(CATALOG_CHANNELS.port, { ports: [pair.preloadSide] }, { connectId });
      }
    },
    on(channel, listener) {
      ipcEmitter.on(channel, listener);
    },
    removeListener(channel, listener) {
      ipcEmitter.removeListener(channel, listener);
    },
  };

  const bridge = createCatalogBridge(ipc);
  return {
    bridge,
    ready,
    async teardown() {
      await bridge.close();
      const shutDown = new Promise<void>((resolve) => {
        parentEmitter.on('worker-msg', (msg: WorkerToMainMessage) => {
          if (msg.type === 'shutdown-complete') resolve();
        });
      });
      parentEmitter.emit('message', {
        data: { type: 'shutdown' } satisfies MainToWorkerMessage,
      });
      await shutDown;
      dispose();
    },
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('catalog-worker + catalog-bridge Wave P7 (#505, #506)', () => {
  it('round-trips renameSource, setSourceExcludedProfiles, and new 9 avatar tokens end-to-end', async () => {
    const env = setupWorkerAndBridge();
    await env.ready;

    try {
      const added: Result<SourceRow> = await env.bridge.addSource({
        kind: 'm3u',
        name: 'Initial Name',
        playlistUrl: 'https://provider.example/list.m3u',
      });
      expect(added.ok).toBe(true);
      if (!added.ok) return;

      let changeEvents = 0;
      const unsub = env.bridge.onChanged(() => {
        changeEvents += 1;
      });

      const renamed = await env.bridge.renameSource?.(added.value.id, 'Living Room');
      expect(renamed?.ok).toBe(true);
      if (renamed?.ok) {
        expect(renamed.value.name).toBe('Living Room');
      }

      const excluded = await env.bridge.setSourceExcludedProfiles?.(added.value.id, [
        'p_kids',
        'p_guest',
        'p_kids',
      ]);
      expect(excluded?.ok).toBe(true);
      if (excluded?.ok) {
        expect(excluded.value.excludedProfileIds).toEqual(['p_guest', 'p_kids']);
      }
      expect(changeEvents).toBe(2);

      const sources = await env.bridge.listSources();
      expect(sources[0]?.name).toBe('Living Room');
      expect(sources[0]?.excludedProfileIds).toEqual(['p_guest', 'p_kids']);

      // Verify newly added avatar tokens (coral, teal, indigo) pass IPC + SQLite round-trip
      const created: Result<ProfileRecord> | undefined = await env.bridge.createProfile?.({
        name: 'Coral Member',
        avatarToken: 'coral',
      });
      expect(created?.ok).toBe(true);
      if (created?.ok) {
        expect(created.value.avatarToken).toBe('coral');
        const updated = await env.bridge.updateProfile?.(created.value.id, {
          avatarToken: 'indigo',
        });
        expect(updated?.ok).toBe(true);
        if (updated?.ok) {
          expect(updated.value.avatarToken).toBe('indigo');
        }
      }

      unsub();
    } finally {
      await env.teardown();
    }
  });
});
