import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CategoryRow,
  ChannelGuideOverrideRecord,
  GuideChannelOption,
  GuideSourceRecord,
  ImportSummary,
  ItemRow,
  ProgrammeReminderRecord,
  ProgrammeRow,
  SourceRow,
  StreamRequest,
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
  const dir = mkdtempSync(join(tmpdir(), 'elv-worker-f3-'));
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

function makeFixtureFetch(): FetchLike {
  const m3u = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="news.one" catchup="shift" catchup-days="7" group-title="News",News One',
    'http://local.test/live/news1.m3u8',
  ].join('\n');
  const xmltv = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<tv>',
    '  <channel id="news.one"><display-name>News One HD</display-name></channel>',
    '  <channel id="sports.one"><display-name>Sports One HD</display-name></channel>',
    '  <programme channel="news.one" start="20231114200000 +0000" stop="20231114210000 +0000">',
    '    <title>Evening Report</title>',
    '  </programme>',
    '</tv>',
  ].join('\n');

  return vi.fn(async (url: string) => {
    const bodyText = url.includes('epg') ? xmltv : m3u;
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

describe('catalog-worker + preload Wave F3 EPG ops (#220, #306, #30, #35)', () => {
  it('round-trips all 16 Wave F3 RPC methods end-to-end across preload -> worker', async () => {
    const h = createEndToEndHarness(makeFixtureFetch());
    try {
      await h.ready;
      const opened = await h.bridge.open();
      expect(opened.ok).toBe(true);

      const added: Result<SourceRow> = await h.bridge.addSource({
        kind: 'm3u',
        name: 'Local F3',
        playlistUrl: 'http://local.test/playlist.m3u',
      });
      expect(added.ok).toBe(true);
      if (!added.ok) return;
      const sourceId = added.value.id;

      const imported: Result<ImportSummary> = await h.bridge.startImport(sourceId).result;
      expect(imported.ok).toBe(true);

      const cats: CategoryRow[] = await h.bridge.categories(sourceId, 'live');
      const items: ItemRow[] = await h.bridge.items(cats[0]?.id ?? '', 0, 10);
      expect(items).toHaveLength(1);
      const channel = items[0];
      if (!channel) return;

      // 1. resolveCatchupStream (including optional programme.title for parental filtering)
      const catchup: Result<StreamRequest> =
        (await h.bridge.resolveCatchupStream?.(channel.key, {
          startMs: 1_699_990_000_000,
          stopMs: 1_699_993_600_000,
          title: 'Evening Report',
        })) ?? ({ ok: false } as never);
      expect(catchup.ok).toBe(true);
      if (catchup.ok) {
        expect(catchup.value.url).toContain('utc=');
      }

      // 2. fetchChannelArchiveEpg (M3U gracefully returns ok([]))
      const archiveEpg: Result<ProgrammeRow[]> =
        (await h.bridge.fetchChannelArchiveEpg?.(channel.key)) ?? ({ ok: false } as never);
      expect(archiveEpg.ok).toBe(true);
      if (archiveEpg.ok) expect(archiveEpg.value).toEqual([]);

      // 3-7. addGuideSource, listGuideSources, updateGuideSource, reorderGuideSources, removeGuideSource
      const g1 = await h.bridge.addGuideSource?.({
        sourceId,
        name: 'Primary XMLTV',
        url: 'http://local.test/epg-primary.xml',
      });
      const g2 = await h.bridge.addGuideSource?.({
        sourceId,
        name: 'Secondary XMLTV',
        url: 'http://local.test/epg-secondary.xml',
        epgShiftMs: 3_600_000,
      });
      expect(g1?.ok).toBe(true);
      expect(g2?.ok).toBe(true);
      if (!g1?.ok || !g2?.ok) return;

      const updatedG2 = await h.bridge.updateGuideSource?.(g2.value.id, {
        name: 'Backup Guide',
        epgShiftMs: -1_800_000,
      });
      expect(updatedG2?.ok).toBe(true);
      if (updatedG2?.ok) {
        expect(updatedG2.value.name).toBe('Backup Guide');
        expect(updatedG2.value.epgShiftMs).toBe(-1_800_000);
      }

      const reordered = await h.bridge.reorderGuideSources?.(sourceId, [g2.value.id, g1.value.id]);
      expect(reordered?.ok).toBe(true);

      const listedGuides: GuideSourceRecord[] = (await h.bridge.listGuideSources?.(sourceId)) ?? [];
      expect(listedGuides.map((g) => g.id)).toEqual([g2.value.id, g1.value.id]);

      // Import guide so guide_channels is populated
      const guideImport = await h.bridge.importGuide(sourceId);
      expect(guideImport.ok).toBe(true);

      // 8. listGuideChannels
      const guideChannels: GuideChannelOption[] =
        (await h.bridge.listGuideChannels?.(sourceId, 'sports', 10)) ?? [];
      expect(guideChannels.map((c) => c.guideId)).toEqual(['sports.one']);

      // 9-11. setChannelGuideOverride, listChannelGuideOverrides, clearChannelGuideOverride
      const setOverride = await h.bridge.setChannelGuideOverride?.({
        sourceId,
        channelKey: channel.key,
        guideSourceId: g2.value.id,
        guideId: 'sports.one',
        epgShiftMs: 900_000,
      });
      expect(setOverride?.ok).toBe(true);
      const overrides: ChannelGuideOverrideRecord[] =
        (await h.bridge.listChannelGuideOverrides?.(sourceId)) ?? [];
      expect(overrides).toHaveLength(1);
      expect(overrides[0]?.guideId).toBe('sports.one');

      const clearedOverride = await h.bridge.clearChannelGuideOverride?.(sourceId, channel.key);
      expect(clearedOverride?.ok).toBe(true);
      expect(await h.bridge.listChannelGuideOverrides?.(sourceId)).toEqual([]);

      // Remove second guide source
      const removedGuide = await h.bridge.removeGuideSource?.(g2.value.id);
      expect(removedGuide?.ok).toBe(true);
      expect((await h.bridge.listGuideSources?.(sourceId))?.map((g) => g.id)).toEqual([
        g1.value.id,
      ]);

      // 12-16. upsertReminder, listReminders, markReminderFired, removeReminder, pruneExpiredReminders
      const r1 = await h.bridge.upsertReminder?.({
        profileId: 'default',
        sourceId,
        channelKey: channel.key,
        channelName: 'News One',
        programmeTitle: 'Evening Report',
        programmeStart: 1_700_003_600_000,
        programmeStop: 1_700_007_200_000,
        leadTimeMs: 300_000,
        parentalUnlocked: false,
      });
      const r2 = await h.bridge.upsertReminder?.({
        profileId: 'default',
        sourceId,
        channelKey: channel.key,
        channelName: 'News One',
        programmeTitle: 'Past Show',
        programmeStart: 1_699_990_000_000,
        programmeStop: 1_699_993_600_000,
        parentalUnlocked: true,
      });
      expect(r1?.ok).toBe(true);
      expect(r2?.ok).toBe(true);

      const activeReminders: ProgrammeReminderRecord[] =
        (await h.bridge.listReminders?.('default', { parentalUnlocked: false })) ?? [];
      expect(activeReminders).toHaveLength(2);

      const firedRes = await h.bridge.markReminderFired?.(
        channel.key,
        1_700_003_600_000,
        'default',
      );
      expect(firedRes?.ok).toBe(true);
      const unfiredAfter = await h.bridge.listReminders?.('default', { includeFired: false });
      expect(unfiredAfter).toHaveLength(1);
      const allAfter = await h.bridge.listReminders?.('default', { includeFired: true });
      expect(allAfter).toHaveLength(2);

      const pruned = await h.bridge.pruneExpiredReminders?.(1_700_000_000_000);
      expect(pruned).toBe(1);

      const removedRem = await h.bridge.removeReminder?.(channel.key, 1_700_003_600_000, 'default');
      expect(removedRem?.ok).toBe(true);
      expect(await h.bridge.listReminders?.('default', { includeFired: true })).toEqual([]);
    } finally {
      await h.shutdown();
    }
  });

  it('rejects malicious Wave F3 IPC payloads both in preload and in worker', async () => {
    const h = createEndToEndHarness(makeFixtureFetch());
    try {
      await h.ready;
      await h.bridge.open();

      // Preload blocks invalid addGuideSource file:// URL before reaching worker
      const badGuide = await h.bridge.addGuideSource?.({
        sourceId: 's1',
        name: 'Evil',
        url: 'file:///etc/passwd',
      });
      expect(badGuide?.ok).toBe(false);

      // Worker directly rejects tampered MessagePort call with source-format/invalid-request
      const fault = await h.sendRawToWorker({
        type: 'call',
        reqId: 999,
        call: {
          method: 'upsertReminder',
          input: {
            sourceId: 's1',
            channelKey: 'm:s1:ch1',
            channelName: 'News',
            programmeTitle: 'Bad',
            programmeStart: 2000,
            programmeStop: 1000,
          },
        },
      });
      expect(fault).toMatchObject({
        type: 'fault',
        reqId: 999,
        error: { category: 'source-format', code: 'invalid-request' },
      });

      // Worker rejects tampered catchup title with control characters and non-boolean parentalUnlocked
      const badCatchupTitle = await h.sendRawToWorker({
        type: 'call',
        reqId: 1000,
        call: {
          method: 'resolveCatchupStream',
          itemKey: 'm:s1:ch1',
          programme: { startMs: 1_000, stopMs: 2_000, title: 'Bad\nTitle' },
        },
      });
      expect(badCatchupTitle).toMatchObject({
        type: 'fault',
        reqId: 1000,
        error: { category: 'source-format', code: 'invalid-request' },
      });

      const badReminderUnlocked = await h.sendRawToWorker({
        type: 'call',
        reqId: 1001,
        call: {
          method: 'listReminders',
          profileId: 'default',
          opts: { parentalUnlocked: 'yes' },
        },
      });
      expect(badReminderUnlocked).toMatchObject({
        type: 'fault',
        reqId: 1001,
        error: { category: 'source-format', code: 'invalid-request' },
      });
    } finally {
      await h.shutdown();
    }
  });
});
