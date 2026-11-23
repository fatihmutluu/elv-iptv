import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalPlaylistStore, MAX_LOCAL_PLAYLIST_BYTES } from './local-playlist-store.ts';

const dirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elv-local-pl-'));
  dirs.push(dir);
  return dir;
}

async function readAll(
  iter: AsyncIterable<Uint8Array> | undefined,
): Promise<Uint8Array | undefined> {
  if (!iter) return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of iter) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('createLocalPlaylistStore (#51)', () => {
  it('writes, streams, and deletes sandboxed playlist bytes inside <userData>/playlists/<sourceId>.m3u', async () => {
    const base = makeTempDir();
    const store = createLocalPlaylistStore(base);
    const payload = new TextEncoder().encode('#EXTM3U\n#EXTINF:-1,News\nhttp://a/1.ts\n');

    expect(await store.openRead('src-1')).toBeUndefined();

    await store.write('src-1', payload);
    const read = await readAll(await store.openRead('src-1'));
    expect(read).toEqual(payload);

    await store.remove('src-1');
    expect(await store.openRead('src-1')).toBeUndefined();
    // Idempotent second remove
    await expect(store.remove('src-1')).resolves.toBeUndefined();
  });

  it('blocks path traversal and invalid source IDs on write, openRead, and remove', async () => {
    const base = makeTempDir();
    const store = createLocalPlaylistStore(base);
    const bytes = new Uint8Array([1, 2, 3]);

    for (const badId of ['', '.', '..', '../escape', 'a/b', 'a\\b', 'src\0id', 'a'.repeat(129)]) {
      await expect(store.write(badId, bytes)).rejects.toThrow();
      await expect(store.openRead(badId)).rejects.toThrow();
      await expect(store.remove(badId)).rejects.toThrow();
    }
  });

  it('enforces the 64 MiB byte cap on write and openRead', async () => {
    const base = makeTempDir();
    const store = createLocalPlaylistStore(base, { maxBytes: 16 });

    expect(MAX_LOCAL_PLAYLIST_BYTES).toBe(64 * 1024 * 1024);
    await expect(store.write('src-big', new Uint8Array(17))).rejects.toThrow(/size|limit/i);
    await expect(store.write('src-ok', new Uint8Array(16))).resolves.toBeUndefined();

    // Direct tampering beyond cap on disk is also refused on openRead
    writeFileSync(join(base, 'playlists', 'src-ok.m3u'), new Uint8Array(20));
    await expect(store.openRead('src-ok')).rejects.toThrow(/size|limit/i);
  });

  it('refuses symlinks inside playlists directory', async () => {
    const base = makeTempDir();
    const store = createLocalPlaylistStore(base);
    await store.write('seed', new Uint8Array([1]));
    const outside = join(base, 'secret.txt');
    writeFileSync(outside, 'secret');
    const linkPath = join(base, 'playlists', 'evil.m3u');
    try {
      symlinkSync(outside, linkPath);
    } catch {
      // Windows without symlink privileges: skip symlink assertion gracefully
      return;
    }
    await expect(store.openRead('evil')).rejects.toThrow(/symlink|file/i);
  });
});
