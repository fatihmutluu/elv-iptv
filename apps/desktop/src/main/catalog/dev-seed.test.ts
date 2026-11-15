import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SecretStore } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { checkReleaseArtifactBuffer } from '../../../../../tools/src/release-hygiene.ts';
import type { CatalogClientMessage, CatalogWorkerMessage } from '../../shared/catalog-ipc.ts';
import { type DevSeedPortLike, parseDevSeedEnv, runDesktopDevSeedOnce } from './dev-seed.ts';

function createMemorySecrets(): SecretStore & { dump(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    async get(key) {
      return map.get(key);
    },
    async set(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
    dump() {
      return Object.fromEntries(map.entries());
    },
  };
}

function createFakeCatalogCoordinator(
  initialSources: Array<{ id: string; name: string }> = [],
  options: { failNetworkOnImport?: boolean } = {},
) {
  const sources = [...initialSources];
  const importedIds: string[] = [];
  const removedIds: string[] = [];
  let closedClients = 0;

  return {
    sources,
    importedIds,
    removedIds,
    get closedClients() {
      return closedClients;
    },
    coordinator: {
      async connectClient(): Promise<{ clientId: number; rendererPort: DevSeedPortLike }> {
        const listeners = new Set<(event: { readonly data: unknown }) => void>();
        const emit = (msg: CatalogWorkerMessage): void => {
          for (const l of listeners) l({ data: msg });
        };

        const port: DevSeedPortLike = {
          on(_event, listener) {
            listeners.add(listener);
            return port;
          },
          off(_event, listener) {
            listeners.delete(listener);
            return port;
          },
          start() {},
          close() {},
          postMessage(msg: CatalogClientMessage) {
            if (msg.type !== 'call') return;
            queueMicrotask(() => {
              const { call, reqId } = msg;
              if (call.method === 'listSources') {
                emit({
                  type: 'result',
                  reqId,
                  value: sources.map((s) => ({
                    id: s.id,
                    kind: 'xtream',
                    name: s.name,
                    createdAt: 1,
                    needsImport: false,
                  })),
                });
              } else if (call.method === 'addSource' || call.method === 'addSourceFromLink') {
                const created = { id: `src-${sources.length + 1}`, name: call.input.name };
                sources.push(created);
                emit({
                  type: 'result',
                  reqId,
                  value: {
                    ok: true,
                    value: {
                      id: created.id,
                      kind: call.method === 'addSource' ? call.input.kind : 'm3u',
                      name: created.name,
                      createdAt: 1,
                      needsImport: true,
                    },
                  },
                });
              } else if (call.method === 'removeSource') {
                removedIds.push(call.id);
                const idx = sources.findIndex((s) => s.id === call.id);
                if (idx >= 0) sources.splice(idx, 1);
                emit({
                  type: 'result',
                  reqId,
                  value: { ok: true, value: undefined },
                });
              } else if (call.method === 'importSource') {
                importedIds.push(call.id);
                if (options.failNetworkOnImport) {
                  emit({
                    type: 'result',
                    reqId,
                    value: {
                      ok: false,
                      error: { category: 'network', code: 'unreachable' },
                    },
                  });
                } else {
                  emit({
                    type: 'result',
                    reqId,
                    value: {
                      ok: true,
                      value: { runId: 'run-1', counts: { live: 2, movies: 1, series: 1 } },
                    },
                  });
                }
              }
            });
          },
        };
        return { clientId: 1, rendererPort: port };
      },
      disconnectClient() {
        closedClients += 1;
      },
    },
  };
}

describe('desktop dev-seed (#10)', () => {
  it('parses DEV_XTREAM_* and DEV_M3U_URL only when unpackaged', () => {
    const xtreamEnv = {
      DEV_XTREAM_SERVER: 'http://127.0.0.1:7878',
      DEV_XTREAM_USERNAME: 'demo',
      DEV_XTREAM_PASSWORD: 'demo',
    };
    expect(parseDevSeedEnv(xtreamEnv, { isPackaged: false })).toEqual({
      kind: 'xtream',
      name: '127.0.0.1:7878',
      server: 'http://127.0.0.1:7878',
      username: 'demo',
      password: 'demo',
    });

    expect(parseDevSeedEnv(xtreamEnv, { isPackaged: true })).toBeUndefined();
    expect(parseDevSeedEnv({}, { isPackaged: false })).toBeUndefined();

    expect(
      parseDevSeedEnv(
        {
          DEV_M3U_URL: 'http://127.0.0.1:7878/playlists/demo.m3u8',
          DEV_M3U_GUIDE_URL: 'http://127.0.0.1:7878/xmltv.xml',
        },
        { isPackaged: false },
      ),
    ).toEqual({
      kind: 'm3u',
      name: '127.0.0.1:7878',
      playlistUrl: 'http://127.0.0.1:7878/playlists/demo.m3u8',
      guideUrl: 'http://127.0.0.1:7878/xmltv.xml',
    });
  });

  it('seeds once via coordinator client port and never re-seeds after removal', async () => {
    const secrets = createMemorySecrets();
    const fake = createFakeCatalogCoordinator();
    const seed = parseDevSeedEnv(
      {
        DEV_XTREAM_NAME: 'Desktop Sim',
        DEV_XTREAM_SERVER: 'http://127.0.0.1:7878',
        DEV_XTREAM_USERNAME: 'demo',
        DEV_XTREAM_PASSWORD: 'demo',
      },
      { isPackaged: false },
    );

    const first = await runDesktopDevSeedOnce({
      seed,
      coordinator: fake.coordinator,
      secrets,
    });
    expect(first).toEqual({ seeded: true, sourceId: 'src-1' });
    expect(fake.importedIds).toEqual(['src-1']);
    expect(secrets.dump()).toEqual({ 'elv.dev.seeded': '1' });
    expect(fake.closedClients).toBe(1);

    // Simulate user removing the seeded source, then restarting app
    fake.sources.length = 0;
    const second = await runDesktopDevSeedOnce({
      seed,
      coordinator: fake.coordinator,
      secrets,
    });
    expect(second).toEqual({ seeded: false });
    expect(fake.sources).toEqual([]);
  });

  it('records elv.dev.seeded and skips when sources already exist', async () => {
    const secrets = createMemorySecrets();
    const fake = createFakeCatalogCoordinator([{ id: 'existing-1', name: 'Existing' }]);
    const res = await runDesktopDevSeedOnce({
      seed: {
        kind: 'm3u',
        name: 'Sim M3U',
        playlistUrl: 'http://127.0.0.1:7878/playlists/demo.m3u8',
      },
      coordinator: fake.coordinator,
      secrets,
    });
    expect(res).toEqual({ seeded: false });
    expect(secrets.dump()).toEqual({ 'elv.dev.seeded': '1' });
    expect(fake.sources).toEqual([{ id: 'existing-1', name: 'Existing' }]);
  });

  it('rolls back added source, fires onChanged, and leaves elv.dev.seeded unset when host is unreachable', async () => {
    const secrets = createMemorySecrets();
    const offline = createFakeCatalogCoordinator([], { failNetworkOnImport: true });
    let changedEvents = 0;
    const seed = parseDevSeedEnv(
      {
        DEV_XTREAM_NAME: 'Offline Desktop Sim',
        DEV_XTREAM_SERVER: 'http://127.0.0.1:7878',
        DEV_XTREAM_USERNAME: 'demo',
        DEV_XTREAM_PASSWORD: 'demo',
      },
      { isPackaged: false },
    );

    const first = await runDesktopDevSeedOnce({
      seed,
      coordinator: offline.coordinator,
      secrets,
      onChanged: () => {
        changedEvents += 1;
      },
    });
    expect(first).toEqual({ seeded: false });
    expect(offline.removedIds).toEqual(['src-1']);
    expect(offline.sources).toEqual([]);
    expect(secrets.dump()).toEqual({});
    expect(changedEvents).toBeGreaterThanOrEqual(2);

    // Subsequent launch when simulator is reachable seeds cleanly
    const online = createFakeCatalogCoordinator();
    let onlineChanged = 0;
    const second = await runDesktopDevSeedOnce({
      seed,
      coordinator: online.coordinator,
      secrets,
      onChanged: () => {
        onlineChanged += 1;
      },
    });
    expect(second).toEqual({ seeded: true, sourceId: 'src-1' });
    expect(secrets.dump()).toEqual({ 'elv.dev.seeded': '1' });
    expect(onlineChanged).toBe(2);
  });

  it('eliminates dev-seed code and DEV_* markers from production dist/main/main.js via bundle.mjs', () => {
    const desktopRoot = join(import.meta.dirname, '..', '..', '..');
    const outDir = mkdtempSync(join(tmpdir(), 'elv-desktop-prod-bundle-'));
    try {
      execFileSync(process.execPath, [join(desktopRoot, 'scripts', 'bundle.mjs')], {
        cwd: desktopRoot,
        env: {
          ...process.env,
          APP_VARIANT: 'production',
          ELV_DESKTOP_OUT_DIR: outDir,
        },
        stdio: 'pipe',
      });
      const mainBytes = readFileSync(join(outDir, 'main', 'main.js'));
      expect(checkReleaseArtifactBuffer('dist/main/main.js', mainBytes)).toEqual([]);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
