import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isValidManagedDownloadFileName } from '@elv/domain';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getManagedDownloadsDir,
  isManagedDownloadFileUrlShape,
  sanitizeDownloadFileName,
  validateManagedDownloadPath,
} from './managed-path.ts';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'elv-managed-path-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('managed-path', () => {
  it('computes the app-private downloads directory under userData', () => {
    expect(getManagedDownloadsDir('/app/userData')).toBe(path.join('/app/userData', 'downloads'));
  });

  it('produces deterministic, collision-resistant safe filenames with allowlisted extensions', () => {
    const a = sanitizeDownloadFileName('movie:101', '.mkv');
    const b = sanitizeDownloadFileName('movie:101', 'MKV');
    const c = sanitizeDownloadFileName('movie/101', '.mkv');
    const fallback = sanitizeDownloadFileName('../evil/../../../etc/passwd', '.exe');
    const emptySlug = sanitizeDownloadFileName('...///...', '.mp4');

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.endsWith('.mkv')).toBe(true);
    expect(fallback.endsWith('.mp4')).toBe(true);
    expect(emptySlug.startsWith('vod-')).toBe(true);
    for (const name of [a, b, c, fallback, emptySlug]) {
      expect(isValidManagedDownloadFileName(name)).toBe(true);
    }
  });

  it('validates file:// URL shapes strictly while rejecting traversal, query/hash, remote hosts, and non-video files', () => {
    expect(isManagedDownloadFileUrlShape('file:///Users/demo/downloads/movie-123.mp4')).toBe(true);
    expect(isManagedDownloadFileUrlShape('file:///C:/Users/demo/downloads/ep1.MKV')).toBe(true);
    expect(isManagedDownloadFileUrlShape('file://localhost/tmp/downloads/clip.ts')).toBe(true);

    const rejected = [
      '',
      'http://example.com/movie.mp4',
      'file:///etc/passwd',
      'file:///C:/Windows/win.ini',
      'file:///downloads/notes.txt',
      'file:///downloads/.mp4',
      'file:///downloads/../outside/movie.mp4',
      'file:///downloads/%2e%2e/outside/movie.mp4',
      'file:///downloads/movie.mp4?token=1',
      'file:///downloads/movie.mp4#t=5',
      'file://evil.example/downloads/movie.mp4',
      'file:///downloads/movie.mp4\u0000',
      'file:///downloads/movie.mp4\n',
      `file:///downloads/${'a'.repeat(4100)}.mp4`,
    ];
    for (const url of rejected) {
      expect(isManagedDownloadFileUrlShape(url), `expected rejected: ${url}`).toBe(false);
    }
  });

  it('allows only existing non-symlink video files strictly contained inside downloadsRoot', async () => {
    const base = await makeTempDir();
    const downloadsDir = path.join(base, 'downloads');
    const outsideDir = path.join(base, 'outside');
    await mkdir(downloadsDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });

    const validFile = path.join(downloadsDir, 'movie-42.mp4');
    const badExtFile = path.join(downloadsDir, 'secret.txt');
    const dirNamedMp4 = path.join(downloadsDir, 'folder.mp4');
    const outsideFile = path.join(outsideDir, 'outside.mp4');
    await writeFile(validFile, Buffer.from([0, 0, 0, 24]));
    await writeFile(badExtFile, 'secret');
    await mkdir(dirNamedMp4, { recursive: true });
    await writeFile(outsideFile, Buffer.from([0, 0, 0, 24]));

    const validUrl = pathToFileURL(validFile).toString();
    const outsideUrl = pathToFileURL(outsideFile).toString();

    const resolvedFromUrl = await validateManagedDownloadPath(downloadsDir, validUrl);
    expect(resolvedFromUrl).not.toBeNull();
    expect(path.basename(resolvedFromUrl ?? '')).toBe('movie-42.mp4');

    const resolvedFromPath = await validateManagedDownloadPath(downloadsDir, validFile);
    expect(resolvedFromPath).toBe(resolvedFromUrl);

    // Reject outside file, traversal, non-video ext, directory, missing file, and query/hash.
    expect(await validateManagedDownloadPath(downloadsDir, outsideUrl)).toBeNull();
    expect(await validateManagedDownloadPath(downloadsDir, outsideFile)).toBeNull();
    expect(
      await validateManagedDownloadPath(
        downloadsDir,
        path.join(downloadsDir, '..', 'outside', 'outside.mp4'),
      ),
    ).toBeNull();
    expect(
      await validateManagedDownloadPath(downloadsDir, pathToFileURL(badExtFile).toString()),
    ).toBeNull();
    expect(
      await validateManagedDownloadPath(downloadsDir, pathToFileURL(dirNamedMp4).toString()),
    ).toBeNull();
    expect(
      await validateManagedDownloadPath(
        downloadsDir,
        pathToFileURL(path.join(downloadsDir, 'missing.mp4')).toString(),
      ),
    ).toBeNull();
    expect(await validateManagedDownloadPath(downloadsDir, `${validUrl}?a=1`)).toBeNull();
    expect(await validateManagedDownloadPath(downloadsDir, `${validUrl}#b`)).toBeNull();

    // Symlink escape inside downloadsDir pointing to outsideFile must be rejected.
    const symlinkTarget = path.join(downloadsDir, 'escape.mp4');
    let symlinkCreated = false;
    try {
      await symlink(outsideFile, symlinkTarget);
      symlinkCreated = true;
    } catch {
      // Windows without Developer Mode/admin privilege may disallow file symlinks.
    }
    if (symlinkCreated) {
      expect(
        await validateManagedDownloadPath(downloadsDir, pathToFileURL(symlinkTarget).toString()),
      ).toBeNull();
      expect(await validateManagedDownloadPath(downloadsDir, symlinkTarget)).toBeNull();
    }
  });
});
