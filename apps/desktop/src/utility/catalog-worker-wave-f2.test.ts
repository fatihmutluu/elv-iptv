import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CategoryRow,
  ChannelOverrideRecord,
  CustomGroupRecord,
  ImportSummary,
  ItemRow,
  SourceRow,
} from '@elv/data';
import { customGroupCategoryId } from '@elv/data';
import type { FetchLike, Result } from '@elv/domain';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MainToWorkerMessage, WorkerToMainMessage } from '../main/catalog/worker-protocol.ts';
import type { CatalogWorkerMessage } from '../shared/catalog-ipc.ts';
import {
  createCatalogWorkerRuntime,
  type WorkerClientPortLike,
  type WorkerParentPortLike,
} from './catalog-worker-runtime.ts';

class FakePortPair {
  readonly mainSide = new EventEmitter();
  readonly workerSide: WorkerClientPortLike;
  started = false;
  closed = false;

  constructor() {
    const workerEmitter = new EventEmitter();
    this.workerSide = {
      start: () => {
        this.started = true;
      },
      close: () => {
        if (this.closed) return;
        this.closed = true;
        workerEmitter.emit('close');
        this.mainSide.emit('close');
      },
      postMessage: (msg: unknown) => {
        if (!this.closed) this.mainSide.emit('message', { data: msg });
      },
      on: workerEmitter.on.bind(workerEmitter),
      once: workerEmitter.once.bind(workerEmitter),
    };
    this.mainSide.on('send', (msg: unknown) => {
      if (!this.closed && this.started) workerEmitter.emit('message', { data: msg });
    });
  }
}

const tempDirs: string[] = [];

function createTestRuntime(fetchImpl: FetchLike) {
  const dir = mkdtempSync(join(tmpdir(), 'elv-worker-f2-'));
  tempDirs.push(dir);
  const dbPath = join(dir, 'catalog.db');
  const secrets = new Map<string, string>();
  const parentEmitter = new EventEmitter();
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

  const pair = new FakePortPair();
  parentEmitter.emit('message', { data: { type: 'init', dbPath } satisfies MainToWorkerMessage });
  parentEmitter.emit('message', {
    data: { type: 'client-port', clientId: 1 } satisfies MainToWorkerMessage,
    ports: [pair.workerSide],
  });

  let reqId = 0;
  const call = <T>(rpc: unknown) => {
    const id = ++reqId;
    return new Promise<T>((resolve, reject) => {
      const onMsg = (ev: { data: CatalogWorkerMessage }) => {
        if (ev.data.reqId !== id) return;
        if (ev.data.type === 'progress') return;
        pair.mainSide.off('message', onMsg);
        if (ev.data.type === 'result') resolve(ev.data.value as T);
        else reject(new Error(`${ev.data.error.category}/${ev.data.error.code}`));
      };
      pair.mainSide.on('message', onMsg);
      pair.mainSide.emit('send', { type: 'call', reqId: id, call: rpc });
    });
  };

  return {
    ready,
    call,
    async shutdown() {
      parentEmitter.emit('message', { data: { type: 'shutdown' } satisfies MainToWorkerMessage });
      await new Promise((r) => setTimeout(r, 20));
      dispose();
    },
  };
}

function m3uFetch(text: string): FetchLike {
  return vi.fn(async (url) => ({
    status: 200,
    url,
    headers: { forEach: () => {}, get: () => null, getSetCookie: () => [] },
    body: (async function* () {
      yield new TextEncoder().encode(text);
    })(),
  }));
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('catalog-worker Wave F2 channel overrides and custom groups (#60)', () => {
  it('round-trips all 11 channel override and custom group RPC methods over MessagePort', async () => {
    const playlist = [
      '#EXTM3U',
      '#EXTINF:-1 group-title="News",Alpha News',
      'http://local.test/live/1.ts',
      '#EXTINF:-1 group-title="News",Beta News',
      'http://local.test/live/2.ts',
      '#EXTINF:-1 group-title="News",Gamma Sports',
      'http://local.test/live/3.ts',
    ].join('\n');
    const rt = createTestRuntime(m3uFetch(playlist));
    try {
      await rt.ready;

      const added = await rt.call<Result<SourceRow>>({
        method: 'addSource',
        input: { kind: 'm3u', name: 'Local', playlistUrl: 'http://local.test/list.m3u' },
      });
      expect(added.ok).toBe(true);
      if (!added.ok) return;
      const sourceId = added.value.id;

      const imported = await rt.call<Result<ImportSummary>>({
        method: 'importSource',
        id: sourceId,
      });
      expect(imported.ok).toBe(true);

      const cats = await rt.call<CategoryRow[]>({
        method: 'categories',
        sourceId,
        kind: 'live',
      });
      expect(cats.length).toBeGreaterThan(0);
      const newsCatId = cats[0]?.id;
      expect(newsCatId).toBeDefined();
      if (!newsCatId) return;

      const initialItems = await rt.call<ItemRow[]>({
        method: 'items',
        categoryId: newsCatId,
        offset: 0,
        limit: 10,
      });
      expect(initialItems).toHaveLength(3);
      const [ch1, ch2, ch3] = initialItems;
      if (!ch1 || !ch2 || !ch3) return;

      // 1. setChannelOverride + listChannelOverrides
      const setRes = await rt.call<Result<ChannelOverrideRecord>>({
        method: 'setChannelOverride',
        input: {
          itemKey: ch1.key,
          sourceId,
          customName: 'Alpha Prime',
          isHidden: true,
        },
      });
      expect(setRes.ok).toBe(true);
      if (setRes.ok) {
        expect(setRes.value.customName).toBe('Alpha Prime');
        expect(setRes.value.isHidden).toBe(true);
      }

      const overrides = await rt.call<ChannelOverrideRecord[]>({
        method: 'listChannelOverrides',
      });
      expect(overrides).toHaveLength(1);
      expect(overrides[0]?.itemKey).toBe(ch1.key);

      // Hidden channel is excluded by default, returned with includeHidden: true
      const visibleItems = await rt.call<ItemRow[]>({
        method: 'items',
        categoryId: newsCatId,
        offset: 0,
        limit: 10,
      });
      expect(visibleItems.map((i) => i.key)).not.toContain(ch1.key);

      const allIncludingHidden = await rt.call<ItemRow[]>({
        method: 'items',
        categoryId: newsCatId,
        offset: 0,
        limit: 10,
        opts: { includeHidden: true },
      });
      const hiddenEntry = allIncludingHidden.find((i) => i.key === ch1.key);
      expect(hiddenEntry?.name).toBe('Alpha Prime');
      expect(hiddenEntry?.isHidden).toBe(true);

      // 2. clearChannelOverride
      const clearRes = await rt.call<Result<void>>({
        method: 'clearChannelOverride',
        itemKey: ch1.key,
      });
      expect(clearRes.ok).toBe(true);
      expect(await rt.call<ChannelOverrideRecord[]>({ method: 'listChannelOverrides' })).toEqual(
        [],
      );

      // 3. reorderChannels
      const reorderRes = await rt.call<Result<void>>({
        method: 'reorderChannels',
        itemKeys: [ch3.key, ch2.key, ch1.key],
        sourceId,
      });
      expect(reorderRes.ok).toBe(true);
      const reordered = await rt.call<ItemRow[]>({
        method: 'items',
        categoryId: newsCatId,
        offset: 0,
        limit: 10,
      });
      expect(reordered.map((i) => i.key)).toEqual([ch3.key, ch2.key, ch1.key]);

      // 4. createCustomGroup + listCustomGroups + updateCustomGroup
      const createdGroup = await rt.call<Result<CustomGroupRecord>>({
        method: 'createCustomGroup',
        input: { name: 'Evening Watch' },
      });
      expect(createdGroup.ok).toBe(true);
      if (!createdGroup.ok) return;
      const groupId = createdGroup.value.id;

      const updatedGroup = await rt.call<Result<CustomGroupRecord>>({
        method: 'updateCustomGroup',
        groupId,
        patch: { name: 'Prime Time', sortOrder: 0 },
      });
      expect(updatedGroup.ok).toBe(true);
      if (updatedGroup.ok) {
        expect(updatedGroup.value.name).toBe('Prime Time');
      }

      // 5. setCustomGroupItems + addChannelToCustomGroup + removeChannelFromCustomGroup
      const setItemsRes = await rt.call<Result<void>>({
        method: 'setCustomGroupItems',
        groupId,
        items: [{ itemKey: ch1.key, sourceId }],
      });
      expect(setItemsRes.ok).toBe(true);

      const addItemRes = await rt.call<Result<void>>({
        method: 'addChannelToCustomGroup',
        groupId,
        itemKey: ch3.key,
        sourceId,
      });
      expect(addItemRes.ok).toBe(true);

      const groupItems = await rt.call<ItemRow[]>({
        method: 'items',
        categoryId: customGroupCategoryId(groupId),
        offset: 0,
        limit: 10,
      });
      expect(groupItems.map((i) => i.key)).toEqual([ch1.key, ch3.key]);

      const removeItemRes = await rt.call<Result<void>>({
        method: 'removeChannelFromCustomGroup',
        groupId,
        itemKey: ch1.key,
      });
      expect(removeItemRes.ok).toBe(true);

      const listedGroups = await rt.call<CustomGroupRecord[]>({
        method: 'listCustomGroups',
      });
      expect(listedGroups).toHaveLength(1);
      expect(listedGroups[0]?.name).toBe('Prime Time');
      expect(listedGroups[0]?.itemCount).toBe(1);

      // 6. deleteCustomGroup
      const deleteGroupRes = await rt.call<Result<void>>({
        method: 'deleteCustomGroup',
        groupId,
      });
      expect(deleteGroupRes.ok).toBe(true);
      expect(await rt.call<CustomGroupRecord[]>({ method: 'listCustomGroups' })).toEqual([]);
    } finally {
      await rt.shutdown();
    }
  });

  it('rejects malformed channel/group RPC messages with source-format/invalid-request', async () => {
    const rt = createTestRuntime(m3uFetch('#EXTM3U\n'));
    try {
      await rt.ready;
      await expect(
        rt.call({
          method: 'setChannelOverride',
          input: { itemKey: 'http://evil.test/ch', sourceId: 's1' },
        }),
      ).rejects.toThrow('source-format/invalid-request');
      await expect(
        rt.call({
          method: 'deleteCustomGroup',
          groupId: '../escape',
        }),
      ).rejects.toThrow('source-format/invalid-request');
    } finally {
      await rt.shutdown();
    }
  });
});
