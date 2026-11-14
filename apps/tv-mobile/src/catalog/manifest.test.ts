import { memorySecrets } from '@elv/data/testing';
import { describe, expect, it } from 'vitest';
import { addAccount, env, must, useSim } from './catalog-test-env';
import {
  decodeManifest,
  encodeManifest,
  type ManifestEntry,
  type ManifestStore,
  reconcileManifest,
} from './manifest';

const sim = useSim();

function memoryStore(initial?: string): ManifestStore & { value: string | undefined } {
  return {
    value: initial,
    read() {
      return this.value;
    },
    write(value) {
      this.value = value;
    },
  };
}

const entry: ManifestEntry = {
  id: 'src1',
  kind: 'xtream',
  name: 'Main',
  createdAt: 1_000,
  settingsJson: '{}',
};

describe('manifest encoding', () => {
  it('round-trips entries', () => {
    expect(decodeManifest(encodeManifest([entry]))).toEqual([entry]);
  });

  it('reads nothing from a missing, foreign or broken value', () => {
    for (const text of [undefined, '', 'nope', '[]', '{"v":2,"sources":[]}', '{"v":1}']) {
      expect(decodeManifest(text)).toEqual([]);
    }
  });

  it('skips entries with a bad id, kind, name, time or settings', () => {
    const bad = [
      { ...entry, id: 'a b' },
      { ...entry, kind: 'ftp' },
      { ...entry, name: 7 },
      { ...entry, createdAt: 'x' },
      { ...entry, settingsJson: '{' },
      { ...entry, settingsJson: '[]' },
      null,
    ];
    const text = JSON.stringify({ v: 1, sources: [...bad, { ...entry, id: 'ok' }] });
    expect(decodeManifest(text).map((e) => e.id)).toEqual(['ok']);
  });
});

describe('the service keeps the manifest', () => {
  it('writes every source without credentials on add, import and remove', async () => {
    const manifest = memoryStore();
    const e = await env({ manifest });
    const id = await addAccount(e, sim.url());
    expect(decodeManifest(manifest.value)).toEqual([
      { id, kind: 'xtream', name: 'Main', createdAt: 1_000, settingsJson: '{}' },
    ]);
    const m3u = must(
      await e.service.addSource({
        kind: 'm3u',
        name: 'List',
        playlistUrl: `${sim.url()}/get.php?username=demo&password=demo&type=m3u_plus&output=ts`,
      }),
    );
    must(await e.service.importSource(m3u.id));
    const stored = e.raw.prepare('SELECT settings_json AS s FROM sources WHERE id = ?').get(m3u.id);
    const listed = decodeManifest(manifest.value).find((x) => x.id === m3u.id);
    expect(listed?.settingsJson).toBe((stored as { s: string }).s);
    for (const needle of ['demo', sim.url(), '127.0.0.1']) {
      expect(manifest.value).not.toContain(needle);
    }
    must(await e.service.removeSource(id));
    expect(decodeManifest(manifest.value).map((x) => x.id)).toEqual([m3u.id]);
  });

  it('ignores a manifest store that throws', async () => {
    const e = await env({
      manifest: {
        read: () => undefined,
        write: () => {
          throw new Error('full');
        },
      },
    });
    const id = await addAccount(e, sim.url());
    expect(must(await e.service.importSource(id)).counts.live).toBeGreaterThan(0);
  });
});

describe('reconcileManifest', () => {
  it('restores purged sources with the same ids, marks them for import and keeps content keys', async () => {
    const manifest = memoryStore();
    const secrets = memorySecrets();
    const before = await env({ manifest, secrets });
    const id = await addAccount(before, sim.url());
    must(await before.service.importSource(id));
    const keys = before.raw.prepare('SELECT key FROM live ORDER BY key').all();

    const after = await env({ manifest, secrets });
    expect(await reconcileManifest(after.db, manifest)).toEqual([id]);
    expect(await after.service.listSources()).toEqual([
      { id, kind: 'xtream', name: 'Main', createdAt: 1_000, needsImport: true },
    ]);
    must(await after.service.importSource(id));
    expect(after.raw.prepare('SELECT key FROM live ORDER BY key').all()).toEqual(keys);
    expect((await after.service.listSources())[0]?.needsImport).toBe(false);
  });

  it('writes the manifest from a database that has sources and restores nothing', async () => {
    const e = await env();
    const id = await addAccount(e, sim.url());
    const manifest = memoryStore(encodeManifest([{ ...entry, id: 'gone' }]));
    expect(await reconcileManifest(e.db, manifest)).toEqual([]);
    expect(decodeManifest(manifest.value).map((x) => x.id)).toEqual([id]);
  });

  it('does nothing when both are empty or the store cannot be read', async () => {
    const e = await env();
    const manifest = memoryStore();
    expect(await reconcileManifest(e.db, manifest)).toEqual([]);
    expect(manifest.value).toBeUndefined();
    const broken: ManifestStore = {
      read: () => {
        throw new Error('io');
      },
      write: () => undefined,
    };
    expect(await reconcileManifest(e.db, broken)).toEqual([]);
    expect(await e.service.listSources()).toEqual([]);
  });
});
