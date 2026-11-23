import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPendingPlaylistQueue,
  extractPlaylistPathsFromArgv,
  MAX_PLAYLIST_PATH_CHARS,
  readValidatedPlaylistFile,
} from './playlist-open.ts';

const dirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elv-playlist-open-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('extractPlaylistPathsFromArgv (#259)', () => {
  it('extracts .m3u, .m3u8, and .m3u.gz paths case-insensitively and resolves relative paths against cwd', () => {
    const cwd = join(tmpdir(), 'elv-cwd');
    const argv = [
      'C:\\Program Files\\ELV IPTV\\ELV IPTV.exe',
      '--elv-gate=live',
      '--allow-file-access=channels.m3u',
      'relative.m3u',
      'UPPER.M3U8',
      'archive.M3U.GZ',
      'C:\\Users\\demo\\tv.m3u8',
      '/opt/playlists/sports.m3u',
      'relative.m3u',
    ];

    expect(extractPlaylistPathsFromArgv(argv, cwd)).toEqual([
      resolve(cwd, 'relative.m3u'),
      resolve(cwd, 'UPPER.M3U8'),
      resolve(cwd, 'archive.M3U.GZ'),
      'C:\\Users\\demo\\tv.m3u8',
      '/opt/playlists/sports.m3u',
    ]);
  });

  it('rejects flags, empty strings, URLs, control characters, unsupported extensions, and overlong paths', () => {
    const longPath = `${'a'.repeat(MAX_PLAYLIST_PATH_CHARS)}.m3u`;
    const argv = [
      '',
      '   ',
      '--elv-gate',
      '--flag.m3u',
      'http://example.test/list.m3u',
      'https://example.test/list.m3u8',
      'file:///tmp/list.m3u',
      'ftp://example.test/list.m3u',
      'custom+proto:list.m3u',
      'bad\x00null.m3u',
      'bad\nnewline.m3u',
      'bad\x7fdel.m3u',
      'notes.txt',
      'malware.exe',
      'script.js',
      longPath,
    ];

    expect(extractPlaylistPathsFromArgv(argv, '/tmp')).toEqual([]);
  });
});

describe('readValidatedPlaylistFile (#259)', () => {
  it('reads valid .m3u and .m3u8 files returning basename and bytes with zero host path', async () => {
    const dir = makeTempDir();
    const m3uPath = join(dir, 'live-channels.m3u');
    const m3u8Path = join(dir, 'cinema.m3u8');
    const m3uBytes = new TextEncoder().encode('#EXTM3U\n#EXTINF:-1,One\nhttp://a/1.ts\n');
    const m3u8Bytes = new TextEncoder().encode('#EXTM3U\n#EXTINF:-1,Two\nhttp://a/2.ts\n');
    writeFileSync(m3uPath, m3uBytes);
    writeFileSync(m3u8Path, m3u8Bytes);

    const first = await readValidatedPlaylistFile(m3uPath);
    expect(first).not.toBeNull();
    expect(first?.name).toBe('live-channels.m3u');
    expect(Array.from(first?.bytes ?? [])).toEqual(Array.from(m3uBytes));
    expect(Object.keys(first ?? {})).toEqual(['name', 'bytes']);
    expect(first?.name).not.toContain(dir);

    const second = await readValidatedPlaylistFile(m3u8Path);
    expect(second?.name).toBe('cinema.m3u8');
    expect(Array.from(second?.bytes ?? [])).toEqual(Array.from(m3u8Bytes));
  });

  it('rejects unsupported extensions, file:// URLs, control chars, empty files, directories, and oversized files', async () => {
    const dir = makeTempDir();
    const txtPath = join(dir, 'readme.txt');
    const exePath = join(dir, 'app.exe');
    const emptyPath = join(dir, 'empty.m3u');
    const bigPath = join(dir, 'huge.m3u');
    writeFileSync(txtPath, 'hello');
    writeFileSync(exePath, 'MZ');
    writeFileSync(emptyPath, new Uint8Array(0));
    writeFileSync(bigPath, new Uint8Array(256));

    expect(await readValidatedPlaylistFile(txtPath)).toBeNull();
    expect(await readValidatedPlaylistFile(exePath)).toBeNull();
    expect(await readValidatedPlaylistFile(`file://${join(dir, 'a.m3u')}`)).toBeNull();
    expect(await readValidatedPlaylistFile(`${join(dir, 'bad')}\x00.m3u`)).toBeNull();
    expect(await readValidatedPlaylistFile(emptyPath)).toBeNull();
    expect(await readValidatedPlaylistFile(dir)).toBeNull();
    expect(await readValidatedPlaylistFile(bigPath, { maxBytes: 128 })).toBeNull();
    expect(await readValidatedPlaylistFile(join(dir, 'missing.m3u'))).toBeNull();
  });

  it('rejects symlinks to valid playlist files', async () => {
    const dir = makeTempDir();
    const targetPath = join(dir, 'real.m3u');
    const linkPath = join(dir, 'linked.m3u');
    writeFileSync(targetPath, '#EXTM3U\n#EXTINF:-1,One\nhttp://a/1.ts\n');

    let createdSymlink = false;
    try {
      symlinkSync(targetPath, linkPath);
      createdSymlink = true;
    } catch {
      // Unprivileged Windows environments without Developer Mode may disallow file symlinks.
    }

    if (createdSymlink) {
      expect(await readValidatedPlaylistFile(linkPath)).toBeNull();
    } else {
      expect(await readValidatedPlaylistFile(targetPath)).not.toBeNull();
    }
  });
});

describe('createPendingPlaylistQueue (#259)', () => {
  it('buffers up to maxItems until consumed, then pushes live payloads when subscribed', () => {
    const queue = createPendingPlaylistQueue(2);
    const a = { name: 'a.m3u', bytes: new Uint8Array([1]) };
    const b = { name: 'b.m3u', bytes: new Uint8Array([2]) };
    const c = { name: 'c.m3u', bytes: new Uint8Array([3]) };
    const d = { name: 'd.m3u', bytes: new Uint8Array([4]) };

    queue.enqueue(a);
    queue.enqueue(b);
    queue.enqueue(c);
    expect(queue.pendingCount).toBe(2);
    expect(queue.consumePending()).toEqual([b, c]);
    expect(queue.pendingCount).toBe(0);
    expect(queue.consumePending()).toEqual([]);

    const received: unknown[] = [];
    const unsubscribe = queue.subscribe((file) => received.push(file));
    const failing = vi.fn(() => {
      throw new Error('listener boom');
    });
    const unsubFail = queue.subscribe(failing);

    queue.enqueue(d);
    expect(received).toEqual([d]);
    expect(failing).toHaveBeenCalledWith(d);
    expect(queue.pendingCount).toBe(0);

    unsubFail();
    unsubscribe();
    queue.enqueue(a);
    expect(queue.pendingCount).toBe(1);
    expect(queue.consumePending()).toEqual([a]);
  });
});
