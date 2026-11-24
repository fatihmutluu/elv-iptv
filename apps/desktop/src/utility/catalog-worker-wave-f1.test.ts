import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CategoryRow,
  ImportSummary,
  ItemRow,
  ParentalLockRecord,
  ParentalSettings,
  PinVerifyResult,
  ProfileRecord,
  SourceRow,
  StreamRequest,
} from '@elv/data';
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
  const dir = mkdtempSync(join(tmpdir(), 'elv-worker-f1-'));
  tempDirs.push(dir);
  const dbPath = join(dir, 'catalog.db');
  const secrets = new Map<string, string>();
  const logs: string[] = [];
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
    log: (line) => logs.push(line),
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
    secrets,
    logs,
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

describe('catalog-worker Wave F1 profiles and parental controls (#15, #31)', () => {
  it('round-trips profile CRUD, PIN lifecycle via SecretStore without logging PINs, and parental-locked resolveStream', async () => {
    const playlist = [
      '#EXTM3U',
      '#EXTINF:-1 group-title="Kids",Cartoon One',
      'http://local.test/live/1.ts',
      '#EXTINF:-1 group-title="18+ Adult",Late Night Channel',
      'http://local.test/live/2.ts',
    ].join('\n');
    const rt = createTestRuntime(m3uFetch(playlist));
    try {
      await rt.ready;

      const initialProfiles = await rt.call<ProfileRecord[]>({ method: 'listProfiles' });
      expect(initialProfiles.map((p) => p.id)).toEqual(['default']);

      const created = await rt.call<Result<ProfileRecord>>({
        method: 'createProfile',
        input: { name: 'Kids', avatarToken: 'emerald', isKids: true },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const kidsId = created.value.id;

      const updated = await rt.call<Result<ProfileRecord>>({
        method: 'updateProfile',
        id: kidsId,
        patch: { name: 'Little Kids', avatarToken: 'amber' },
      });
      expect(updated.ok).toBe(true);
      if (updated.ok) {
        expect(updated.value.name).toBe('Little Kids');
        expect(updated.value.avatarToken).toBe('amber');
      }

      // PIN lifecycle stored hashed in SecretStore under profile.<id>.pin
      expect(await rt.call<boolean>({ method: 'hasParentalPin', profileId: kidsId })).toBe(false);
      const setPin = await rt.call<Result<void>>({
        method: 'setParentalPin',
        pin: '2580',
        profileId: kidsId,
      });
      expect(setPin.ok).toBe(true);
      expect(await rt.call<boolean>({ method: 'hasParentalPin', profileId: kidsId })).toBe(true);
      const storedSecret = rt.secrets.get(`profile.${kidsId}.pin`);
      expect(storedSecret).toBeDefined();
      expect(storedSecret).not.toContain('2580');

      const badVerify = await rt.call<PinVerifyResult>({
        method: 'verifyParentalPin',
        pin: '0000',
        profileId: kidsId,
      });
      expect(badVerify.ok).toBe(false);

      const goodVerify = await rt.call<PinVerifyResult>({
        method: 'verifyParentalPin',
        pin: '2580',
        profileId: kidsId,
      });
      expect(goodVerify).toEqual({ ok: true });

      // Import synthetic playlist and verify query filtering + resolveStream parental-locked
      const added = await rt.call<Result<SourceRow>>({
        method: 'addSource',
        input: { kind: 'm3u', name: 'Test', playlistUrl: 'http://local.test/list.m3u' },
      });
      expect(added.ok).toBe(true);
      if (!added.ok) return;
      const sourceId = added.value.id;

      const imported = await rt.call<Result<ImportSummary>>({
        method: 'importSource',
        id: sourceId,
      });
      expect(imported.ok).toBe(true);

      const kidsSettings = await rt.call<ParentalSettings>({
        method: 'getParentalSettings',
        profileId: kidsId,
      });
      expect(kidsSettings.enabled).toBe(true);
      expect(kidsSettings.blockAdultKeywords).toBe(true);

      const lockedCats = await rt.call<CategoryRow[]>({
        method: 'categories',
        sourceId,
        kind: 'live',
        opts: { profileId: kidsId, parentalUnlocked: false },
      });
      expect(lockedCats.map((c) => c.name)).toEqual(['Kids']);

      const unlockedCats = await rt.call<CategoryRow[]>({
        method: 'categories',
        sourceId,
        kind: 'live',
        opts: { profileId: kidsId, parentalUnlocked: true },
      });
      expect(unlockedCats).toHaveLength(2);

      const adultCat = unlockedCats.find((c) => c.name.includes('18+'));
      expect(adultCat).toBeDefined();
      if (!adultCat) return;
      const adultItems = await rt.call<ItemRow[]>({
        method: 'items',
        categoryId: adultCat.id,
        offset: 0,
        limit: 10,
        opts: { profileId: kidsId, parentalUnlocked: true },
      });
      expect(adultItems).toHaveLength(1);
      const adultKey = adultItems[0]?.key ?? '';

      const lockedStream = await rt.call<Result<StreamRequest>>({
        method: 'resolveStream',
        itemKey: adultKey,
        opts: { profileId: kidsId, parentalUnlocked: false },
      });
      expect(lockedStream).toEqual({
        ok: false,
        error: { category: 'auth', code: 'parental-locked' },
      });

      const unlockedStream = await rt.call<Result<StreamRequest>>({
        method: 'resolveStream',
        itemKey: adultKey,
        opts: { profileId: kidsId, parentalUnlocked: true },
      });
      expect(unlockedStream.ok).toBe(true);

      // Verify newly-threaded parental opts round-trip through worker RPC without invalid-request
      expect(
        Array.isArray(
          await rt.call<unknown[]>({
            method: 'liveVariants',
            itemKey: adultKey,
            opts: { profileId: kidsId, parentalUnlocked: false },
          }),
        ),
      ).toBe(true);
      expect(
        await rt.call<unknown[]>({
          method: 'itemVersions',
          itemKey: adultKey,
          opts: { profileId: kidsId, parentalUnlocked: false },
        }),
      ).toEqual([]);
      const lockedSeasons = await rt.call<Result<unknown[]>>({
        method: 'seasons',
        seriesId: 999_999,
        opts: { profileId: kidsId, parentalUnlocked: false },
      });
      expect(lockedSeasons.ok).toBe(false);
      expect(
        await rt.call<unknown[]>({
          method: 'episodes',
          seriesId: 999_999,
          season: 1,
          opts: { profileId: kidsId, parentalUnlocked: false },
        }),
      ).toEqual([]);
      expect(
        await rt.call<unknown>({
          method: 'queryNextEpisode',
          seriesKey: `${sourceId}:series:999`,
          currentItemKey: `${sourceId}:episode:1`,
          profileId: kidsId,
          opts: { parentalUnlocked: false },
        }),
      ).toBeNull();
      for (const badRpc of [
        { method: 'liveVariants', itemKey: adultKey, opts: { profileId: '../bad' } },
        { method: 'itemVersions', itemKey: adultKey, opts: { extra: 1 } },
        { method: 'seasons', seriesId: 999_999, opts: { parentalUnlocked: 'yes' } },
        { method: 'episodes', seriesId: 999_999, season: 1, opts: { extra: 1 } },
        {
          method: 'queryNextEpisode',
          seriesKey: `${sourceId}:series:999`,
          currentItemKey: `${sourceId}:episode:1`,
          profileId: kidsId,
          opts: { extra: 1 },
        },
      ]) {
        await expect(rt.call(badRpc)).rejects.toThrow('source-format/invalid-request');
      }

      // Parental locks CRUD + settings update
      const lockRes = await rt.call<Result<void>>({
        method: 'setParentalLock',
        input: {
          profileId: kidsId,
          sourceId,
          targetKind: 'item',
          itemKind: 'live',
          targetKey: adultKey,
        },
        locked: true,
      });
      expect(lockRes.ok).toBe(true);
      const locks = await rt.call<ParentalLockRecord[]>({
        method: 'listParentalLocks',
        profileId: kidsId,
        filter: { sourceId, targetKind: 'item', itemKind: 'live' },
      });
      expect(locks).toHaveLength(1);

      const updatedSettings = await rt.call<Result<ParentalSettings>>({
        method: 'updateParentalSettings',
        profileId: kidsId,
        patch: { unlockTimeoutMin: 15 },
      });
      expect(updatedSettings.ok).toBe(true);
      if (updatedSettings.ok) expect(updatedSettings.value.unlockTimeoutMin).toBe(15);

      // Clear PIN + delete profile cleans up SecretStore
      const cleared = await rt.call<Result<void>>({
        method: 'clearParentalPin',
        currentPin: '2580',
        profileId: kidsId,
      });
      expect(cleared.ok).toBe(true);
      expect(await rt.call<boolean>({ method: 'hasParentalPin', profileId: kidsId })).toBe(false);

      const deleted = await rt.call<Result<void>>({ method: 'deleteProfile', id: kidsId });
      expect(deleted.ok).toBe(true);
      expect(rt.secrets.has(`profile.${kidsId}.pin`)).toBe(false);

      // Verify raw PIN or hash never appeared in worker logs
      const allLogs = rt.logs.join('\n');
      expect(allLogs).not.toContain('2580');
      if (storedSecret) expect(allLogs).not.toContain(storedSecret);
    } finally {
      await rt.shutdown();
    }
  });
});
