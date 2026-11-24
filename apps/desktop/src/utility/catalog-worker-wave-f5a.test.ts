import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CategoryRow,
  FailoverGroupRecord,
  ItemRow,
  SourceRow,
  StreamRequest,
  SuggestedFailoverCluster,
} from '@elv/data';
import type { FetchLike, Result } from '@elv/domain';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MainToWorkerMessage, WorkerToMainMessage } from '../main/catalog/worker-protocol.ts';
import {
  type CatalogIpcRendererLike,
  createCatalogBridge,
  type PreloadClientPortLike,
} from '../preload/catalog-bridge.ts';
import { CATALOG_CHANNELS, type CatalogWorkerMessage } from '../shared/catalog-ipc.ts';
import {
  createCatalogWorkerRuntime,
  type WorkerClientPortLike,
  type WorkerParentPortLike,
} from './catalog-worker-runtime.ts';

class FakePortPair {
  readonly preloadPort: PreloadClientPortLike;
  readonly workerPort: WorkerClientPortLike;
  private preloadStarted = false;
  private workerStarted = false;
  private closed = false;
  private readonly preloadListeners = new Set<(ev: { readonly data: unknown }) => void>();
  private readonly workerEmitter = new EventEmitter();

  constructor() {
    this.workerPort = {
      start: () => {
        this.workerStarted = true;
      },
      close: () => {
        if (this.closed) return;
        this.closed = true;
        this.workerEmitter.emit('close');
      },
      postMessage: (msg: CatalogWorkerMessage) => {
        if (this.closed || !this.preloadStarted) return;
        for (const fn of [...this.preloadListeners]) fn({ data: msg });
      },
      on: this.workerEmitter.on.bind(this.workerEmitter),
      once: this.workerEmitter.once.bind(this.workerEmitter),
    };
    this.preloadPort = {
      addEventListener: (_type, listener) => void this.preloadListeners.add(listener),
      removeEventListener: (_type, listener) => void this.preloadListeners.delete(listener),
      postMessage: (msg) => {
        if (this.closed || !this.workerStarted) return;
        this.workerEmitter.emit('message', { data: msg });
      },
      start: () => {
        this.preloadStarted = true;
      },
      close: () => {
        this.workerPort.close();
      },
    };
  }
}

const tempDirs: string[] = [];

function createEndToEndHarness(fetchImpl: FetchLike) {
  const dir = mkdtempSync(join(tmpdir(), 'elv-worker-f5a-'));
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

  const dispose = createCatalogWorkerRuntime({
    parentPort,
    openDatabase: (p) => new Database(p),
    fetchImpl,
    clock: () => 1_700_000_000_000,
    yieldNow: async () => undefined,
    log: () => undefined,
  });

  parentEmitter.emit('message', { data: { type: 'init', dbPath } satisfies MainToWorkerMessage });

  let clientSeq = 0;
  let lastPair: FakePortPair | undefined;
  const ipcRenderer: CatalogIpcRendererLike = {
    send(channel, ...args) {
      if (channel !== CATALOG_CHANNELS.connect) return;
      const { connectId } = args[0] as { connectId: number };
      const pair = new FakePortPair();
      lastPair = pair;
      parentEmitter.emit('message', {
        data: { type: 'client-port', clientId: ++clientSeq } satisfies MainToWorkerMessage,
        ports: [pair.workerPort],
      });
      ipcEmitter.emit(CATALOG_CHANNELS.port, { ports: [pair.preloadPort] }, { connectId });
    },
    on: ipcEmitter.on.bind(ipcEmitter),
    removeListener: ipcEmitter.removeListener.bind(ipcEmitter),
  };

  const bridge = createCatalogBridge(ipcRenderer);

  return {
    ready,
    bridge,
    secrets,
    sendRawToWorker(raw: unknown): Promise<CatalogWorkerMessage> {
      return new Promise((resolve) => {
        const pair = lastPair;
        if (!pair) throw new Error('port not opened yet');
        const onMsg = (ev: { readonly data: unknown }) => {
          pair.preloadPort.removeEventListener('message', onMsg);
          resolve(ev.data as CatalogWorkerMessage);
        };
        pair.preloadPort.addEventListener('message', onMsg);
        pair.preloadPort.postMessage(raw as never);
      });
    },
    async shutdown() {
      await bridge.close();
      parentEmitter.emit('message', { data: { type: 'shutdown' } satisfies MainToWorkerMessage });
      await new Promise((r) => setTimeout(r, 20));
      dispose();
    },
  };
}

function makeDualSourceFetch(): FetchLike {
  const m3uA = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="news.one" group-title="News",News One HD',
    'http://src-a.test/live/news1.ts',
    '#EXTINF:-1 group-title="Sports",Arena Sports 4K',
    'http://src-a.test/live/sports1.ts',
  ].join('\n');
  const m3uB = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="news.one" group-title="News",[TR] News One 4K',
    'http://src-b.test/live/news1.ts',
    '#EXTINF:-1 group-title="Sports",Arena Sports Backup',
    'http://src-b.test/live/sports1.ts',
  ].join('\n');

  return vi.fn(async (url: string) => {
    const bodyText = url.includes('src-b') ? m3uB : m3uA;
    return {
      status: 200,
      url,
      headers: { forEach: () => {}, get: () => null, getSetCookie: () => [] },
      body: (async function* () {
        yield new TextEncoder().encode(bodyText);
      })(),
    };
  });
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('catalog-worker + preload Wave F5A failover & network ops (#157, #317, #172)', () => {
  it('round-trips failover groups, auto-clustering, source transport updates, and stream outcomes end-to-end', async () => {
    const h = createEndToEndHarness(makeDualSourceFetch());
    try {
      await h.ready;
      expect((await h.bridge.open()).ok).toBe(true);

      const addedA: Result<SourceRow> = await h.bridge.addSource({
        kind: 'm3u',
        name: 'Provider A',
        playlistUrl: 'http://src-a.test/list.m3u',
      });
      const addedB: Result<SourceRow> = await h.bridge.addSource({
        kind: 'm3u',
        name: 'Provider B',
        playlistUrl: 'http://src-b.test/list.m3u',
      });
      expect(addedA.ok).toBe(true);
      expect(addedB.ok).toBe(true);
      if (!addedA.ok || !addedB.ok) return;

      expect((await h.bridge.startImport(addedA.value.id).result).ok).toBe(true);
      expect((await h.bridge.startImport(addedB.value.id).result).ok).toBe(true);

      // Update per-source transport dnsFamily + hostOverride and verify listSources reflects them
      await h.bridge.updateSourceSettings?.(addedA.value.id, {
        transport: { dnsFamily: 'ipv4', hostOverride: '203.0.113.10' },
      });
      const sourcesAfterSet = await h.bridge.listSources();
      const rowA = sourcesAfterSet.find((s) => s.id === addedA.value.id);
      expect(rowA?.dnsFamily).toBe('ipv4');
      expect(rowA?.hostOverride).toBe('203.0.113.10');

      // Suggest cross-source failover clusters & apply first suggestion
      const suggestions: SuggestedFailoverCluster[] =
        (await h.bridge.suggestFailoverGroups?.()) ?? [];
      expect(suggestions.length).toBeGreaterThanOrEqual(2);
      const newsCluster = suggestions.find((c) => c.normalizedKey === 'guide:news.one');
      expect(newsCluster).toBeDefined();
      if (!newsCluster) return;

      const applied = await h.bridge.applySuggestedFailoverGroups?.([newsCluster]);
      expect(applied?.ok).toBe(true);
      if (!applied?.ok) return;
      expect(applied.value).toHaveLength(1);
      const autoGroup = applied.value[0] as FailoverGroupRecord;
      expect(autoGroup.members).toHaveLength(2);

      const memberA = autoGroup.members.find((m) => m.sourceId === addedA.value.id);
      const memberB = autoGroup.members.find((m) => m.sourceId === addedB.value.id);
      expect(memberA).toBeDefined();
      expect(memberB).toBeDefined();
      const firstMemberKey = memberA?.channelKey ?? '';
      const secondMemberKey = memberB?.channelKey ?? '';
      const lookedUp = await h.bridge.getFailoverGroupByChannel?.(firstMemberKey);
      expect(lookedUp?.id).toBe(autoGroup.id);

      // resolveStream carries dnsFamily/hostOverride AND failover alternates
      const resolved: Result<StreamRequest> = await h.bridge.resolveStream(firstMemberKey);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.value.dnsFamily).toBe('ipv4');
        expect(resolved.value.hostOverride).toBe('203.0.113.10');
        expect(resolved.value.alternates?.length).toBeGreaterThanOrEqual(1);
      }

      // Reorder, rename, remove member, re-add member, create manual group, delete group
      const reordered = await h.bridge.reorderFailoverGroupMembers?.(autoGroup.id, [
        secondMemberKey,
        firstMemberKey,
      ]);
      expect(reordered?.ok).toBe(true);
      if (reordered?.ok) {
        expect(reordered.value.members.map((m) => m.channelKey)).toEqual([
          secondMemberKey,
          firstMemberKey,
        ]);
      }

      const renamed = await h.bridge.renameFailoverGroup?.(autoGroup.id, 'News Priority');
      expect(renamed?.ok).toBe(true);
      if (renamed?.ok) expect(renamed.value.name).toBe('News Priority');

      const removedMember = await h.bridge.removeFailoverGroupMember?.(
        autoGroup.id,
        firstMemberKey,
      );
      expect(removedMember?.ok).toBe(true);
      if (removedMember?.ok) expect(removedMember.value.members).toHaveLength(1);

      const readdedMember = await h.bridge.addFailoverGroupMember?.(autoGroup.id, firstMemberKey);
      expect(readdedMember?.ok).toBe(true);
      if (readdedMember?.ok) expect(readdedMember.value.members).toHaveLength(2);

      // Manual group creation with remaining sports channels
      const catsA: CategoryRow[] = await h.bridge.categories(addedA.value.id, 'live');
      const sportsCatA = catsA.find((c) => c.name === 'Sports');
      const sportsItemsA: ItemRow[] = sportsCatA ? await h.bridge.items(sportsCatA.id, 0, 10) : [];
      const created = await h.bridge.createFailoverGroup?.({
        name: 'Manual Sports',
        channelKeys: sportsItemsA.map((i) => i.key),
      });
      expect(created?.ok).toBe(true);
      if (!created?.ok) return;

      const allGroups = (await h.bridge.listFailoverGroups?.()) ?? [];
      expect(allGroups).toHaveLength(2);

      const deleted = await h.bridge.deleteFailoverGroup?.(created.value.id);
      expect(deleted?.ok).toBe(true);
      expect((await h.bridge.listFailoverGroups?.()) ?? []).toHaveLength(1);

      // Clear hostOverride via empty string patch
      await h.bridge.updateSourceSettings?.(addedA.value.id, {
        transport: { dnsFamily: 'system', hostOverride: '' },
      });
      const clearedRow = (await h.bridge.listSources()).find((s) => s.id === addedA.value.id);
      expect(clearedRow?.dnsFamily).toBe('system');
      expect(clearedRow?.hostOverride).toBeUndefined();

      // Add Xtream source with backupServers stored in SecretStore and test reportStreamOutcome
      const addedXtream = await h.bridge.addSource({
        kind: 'xtream',
        name: 'Xtream Mirrors',
        server: 'http://primary.xtream.test',
        backupServers: ['http://mirror1.xtream.test', 'http://mirror2.xtream.test'],
        username: 'demo',
        password: 'secret',
      });
      expect(addedXtream.ok).toBe(true);
      if (addedXtream.ok) {
        const storedSecret = h.secrets.get(`source.${addedXtream.value.id}.xtream`);
        expect(storedSecret).toContain('mirror1.xtream.test');
        await expect(
          h.bridge.reportStreamOutcome?.(addedXtream.value.id, 'http://primary.xtream.test', false),
        ).resolves.toBeUndefined();
      }
    } finally {
      await h.shutdown();
    }
  });

  it('rejects malicious Wave F5A IPC payloads both in preload and directly on worker MessagePort', async () => {
    const h = createEndToEndHarness(makeDualSourceFetch());
    try {
      await h.ready;
      await h.bridge.open();

      // Preload blocks invalid createFailoverGroup name
      const badCreate = await h.bridge.createFailoverGroup?.({ name: 'Bad\nName' });
      expect(badCreate?.ok).toBe(false);

      // Worker directly rejects tampered MessagePort call for reportStreamOutcome with file:// URL
      const fault1 = await h.sendRawToWorker({
        type: 'call',
        reqId: 901,
        call: {
          method: 'reportStreamOutcome',
          sourceId: 's1',
          serverUrl: 'file:///etc/passwd',
          succeeded: false,
        },
      });
      expect(fault1).toMatchObject({
        type: 'fault',
        reqId: 901,
        error: { category: 'source-format', code: 'invalid-request' },
      });

      // Worker directly rejects credentialed path URL in reportStreamOutcome (must be origin-only)
      const fault1b = await h.sendRawToWorker({
        type: 'call',
        reqId: 9011,
        call: {
          method: 'reportStreamOutcome',
          sourceId: 's1',
          serverUrl: ['http://primary.xtream.test', 'live', 'demo', 'cred', '1.ts'].join('/'),
          succeeded: false,
        },
      });
      expect(fault1b).toMatchObject({
        type: 'fault',
        reqId: 9011,
        error: { category: 'source-format', code: 'invalid-request' },
      });

      // Worker directly rejects invalid hostOverride on updateSourceSettings
      const fault2 = await h.sendRawToWorker({
        type: 'call',
        reqId: 902,
        call: {
          method: 'updateSourceSettings',
          sourceId: 's1',
          patch: { transport: { hostOverride: 'evil.example' } },
        },
      });
      expect(fault2).toMatchObject({
        type: 'fault',
        reqId: 902,
        error: { category: 'source-format', code: 'invalid-request' },
      });
    } finally {
      await h.shutdown();
    }
  });
});
