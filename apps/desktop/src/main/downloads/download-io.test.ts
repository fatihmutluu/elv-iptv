import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeWriteStream,
  openSafePartWriteStream,
  PartFileUnsafeError,
  readPartFileSize,
  writeChunk,
} from './download-io.ts';
import { createDesktopDownloadManager, type DesktopDownloadManager } from './download-manager.ts';
import { sanitizeDownloadFileName } from './managed-path.ts';

const tempDirs: string[] = [];
const managers: DesktopDownloadManager[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'elv-dl-io-'));
  tempDirs.push(dir);
  return dir;
}

async function createSymlinkOrJunction(
  targetFile: string,
  targetDir: string,
  linkPath: string,
): Promise<'file-symlink' | 'junction' | null> {
  try {
    await symlink(targetFile, linkPath);
    return 'file-symlink';
  } catch {
    if (process.platform === 'win32') {
      try {
        await symlink(targetDir, linkPath, 'junction');
        return 'junction';
      } catch {
        return null;
      }
    }
    return null;
  }
}

afterEach(async () => {
  for (const mgr of managers.splice(0)) await mgr.dispose();
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('symlink-safe .part I/O (download-io)', () => {
  it('readPartFileSize returns 0 for absent files, byte count for regular files, and throws PartFileUnsafeError for symlinks or directories', async () => {
    const dir = await makeTempDir();
    expect(await readPartFileSize(path.join(dir, 'absent.mp4.part'))).toBe(0);

    const regular = path.join(dir, 'regular.mp4.part');
    await writeFile(regular, Buffer.alloc(128, 0x11));
    expect(await readPartFileSize(regular)).toBe(128);

    const dirPart = path.join(dir, 'dir.mp4.part');
    await mkdir(dirPart);
    await expect(readPartFileSize(dirPart)).rejects.toBeInstanceOf(PartFileUnsafeError);

    const outsideDir = await makeTempDir();
    const secretFile = path.join(outsideDir, 'target.txt');
    await writeFile(secretFile, 'do-not-follow');
    const symPart = path.join(dir, 'linked.mp4.part');
    const kind = await createSymlinkOrJunction(secretFile, outsideDir, symPart);
    expect(kind).not.toBeNull();
    await expect(readPartFileSize(symPart)).rejects.toBeInstanceOf(PartFileUnsafeError);
  });

  it('openSafePartWriteStream writes/appends regular files and refuses symlinks or directories without modifying targets', async () => {
    const dir = await makeTempDir();
    const regular = path.join(dir, 'movie.mp4.part');

    const ws1 = await openSafePartWriteStream(regular, false);
    await writeChunk(ws1, Buffer.from('hello '));
    await closeWriteStream(ws1, false);

    const ws2 = await openSafePartWriteStream(regular, true);
    await writeChunk(ws2, Buffer.from('world'));
    await closeWriteStream(ws2, false);
    expect(await readFile(regular, 'utf8')).toBe('hello world');

    // Overwrite mode truncates regular file cleanly
    const ws3 = await openSafePartWriteStream(regular, false);
    await writeChunk(ws3, Buffer.from('fresh'));
    await closeWriteStream(ws3, false);
    expect(await readFile(regular, 'utf8')).toBe('fresh');

    // Rejects directory
    const dirPart = path.join(dir, 'folder.mp4.part');
    await mkdir(dirPart);
    await expect(openSafePartWriteStream(dirPart, false)).rejects.toBeInstanceOf(
      PartFileUnsafeError,
    );

    // Rejects symlink/junction without touching target
    const outsideDir = await makeTempDir();
    const victim = path.join(outsideDir, 'victim.txt');
    await writeFile(victim, 'untouched-content');
    const symPart = path.join(dir, 'evil.mp4.part');
    const kind = await createSymlinkOrJunction(victim, outsideDir, symPart);
    expect(kind).not.toBeNull();
    await expect(openSafePartWriteStream(symPart, false)).rejects.toBeInstanceOf(
      PartFileUnsafeError,
    );
    await expect(openSafePartWriteStream(symPart, true)).rejects.toBeInstanceOf(
      PartFileUnsafeError,
    );
    expect(await readFile(victim, 'utf8')).toBe('untouched-content');
  });

  it('download-runner fails closed with download-path-invalid when pre-existing .part is a symlink or directory', async () => {
    const downloadsDir = await makeTempDir();
    const outsideDir = await makeTempDir();
    const victim = path.join(outsideDir, 'victim.mp4');
    await writeFile(victim, 'original-victim-bytes');

    const itemKey = 'movie:symlink-part';
    const localFileName = sanitizeDownloadFileName(`default_${itemKey}`, '.mp4');
    const partPath = path.join(downloadsDir, `${localFileName}.part`);
    const kind = await createSymlinkOrJunction(victim, outsideDir, partPath);
    expect(kind).not.toBeNull();

    let fetched = false;
    const manager = createDesktopDownloadManager({
      downloadsDir,
      progressThrottleMs: 0,
      fetch: async () => {
        fetched = true;
        return new Response(new Uint8Array(16).fill(0x99), {
          status: 200,
          headers: { 'content-length': '16' },
        });
      },
    });
    managers.push(manager);

    await manager.enqueue({
      sourceId: 'src-1',
      itemKey,
      kind: 'movie',
      title: 'Symlink Target Test',
      streamUrl: 'https://cdn.example.test/movie.mp4',
    });

    const failed = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 3_000);
      const check = async () => {
        const rec = await manager.get(itemKey);
        if (rec?.status === 'failed') {
          clearTimeout(timer);
          off();
          resolve(rec);
        }
      };
      const off = manager.subscribe(() => void check());
      void check();
    });

    expect((failed as { errorCode: string | null }).errorCode).toBe('download-path-invalid');
    expect(fetched).toBe(false);
    expect(await readFile(victim, 'utf8')).toBe('original-victim-bytes');
  });

  it('fails closed before rename if finalPath becomes a symlink or directory during transfer', async () => {
    const downloadsDir = await makeTempDir();
    const outsideDir = await makeTempDir();
    const victim = path.join(outsideDir, 'victim-final.mp4');
    await writeFile(victim, 'keep-victim-intact');

    const itemKey = 'movie:final-symlink';
    const localFileName = sanitizeDownloadFileName(`default_${itemKey}`, '.mp4');
    const finalPath = path.join(downloadsDir, localFileName);

    const manager = createDesktopDownloadManager({
      downloadsDir,
      progressThrottleMs: 0,
      lookup: async () => ['93.184.216.34'],
      fetch: async () => {
        const kind = await createSymlinkOrJunction(victim, outsideDir, finalPath);
        expect(kind).not.toBeNull();
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { 'content-length': '4' },
        });
      },
    });
    managers.push(manager);

    await manager.enqueue({
      sourceId: 'src-1',
      itemKey,
      kind: 'movie',
      title: 'Final Symlink Race',
      streamUrl: 'https://cdn.example.test/final.mp4',
    });

    const failed = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 3_000);
      const check = async () => {
        const rec = await manager.get(itemKey);
        if (rec?.status === 'failed') {
          clearTimeout(timer);
          off();
          resolve(rec);
        }
      };
      const off = manager.subscribe(() => void check());
      void check();
    });

    expect((failed as { errorCode: string | null }).errorCode).toBe('download-path-invalid');
    expect(await readFile(victim, 'utf8')).toBe('keep-victim-intact');
  });
});
