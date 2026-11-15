import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type FetchDeps,
  fetchFfmpegMedia3,
  verifyDirectory,
  verifyInstalled,
} from '../src/ffmpeg-media3/fetch.ts';
import type { FfmpegMedia3Lock } from '../src/ffmpeg-media3/lock.ts';
import { createRealFetchDeps, extractTarGz } from '../src/ffmpeg-media3/real-deps.ts';
import { buildApk, type Exec } from '../src/gates/adb.ts';
import { populateValidBundle } from './ffmpeg-media3-helpers.ts';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elv-ffmpeg-media3-fetch-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function makeTarGz(
  entries: Array<{
    name: string;
    prefix?: string;
    typeflag?: string;
    content?: Uint8Array;
    linkname?: string;
  }>,
): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512, 0);
    const data = Buffer.from(entry.content ?? new Uint8Array(0));
    const typeflag = entry.typeflag ?? '0';
    header.write(entry.name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    const sizeOctal = (typeflag !== '5' && typeflag !== '2' ? data.length : 0)
      .toString(8)
      .padStart(11, '0');
    header.write(`${sizeOctal}\0`, 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.fill(0x20, 148, 156);
    header.write(typeflag, 156, 1, 'ascii');
    if (entry.linkname) header.write(entry.linkname, 157, 100, 'utf8');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    if (entry.prefix) header.write(entry.prefix, 345, 155, 'utf8');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i] ?? 0;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header);
    if (data.length > 0 && typeflag !== '5' && typeflag !== '2') {
      blocks.push(data);
      const rem = data.length % 512;
      if (rem !== 0) blocks.push(Buffer.alloc(512 - rem, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks));
}

function packDirectoryToTarGz(dir: string): Buffer {
  const entries: Array<{ name: string; typeflag: string; content?: Uint8Array }> = [];
  const walk = (cur: string): void => {
    for (const item of readdirSync(cur)) {
      const full = join(cur, item);
      const rel = relative(dir, full).replace(/\\/g, '/');
      if (statSync(full).isDirectory()) {
        entries.push({ name: `${rel}/`, typeflag: '5' });
        walk(full);
      } else {
        entries.push({ name: rel, typeflag: '0', content: readFileSync(full) });
      }
    }
  };
  walk(dir);
  return makeTarGz(entries);
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('ffmpeg-media3 fetch, archive safety and verify', () => {
  it('skips cleanly when runId and sha256 are unpinned (null)', async () => {
    const work = makeTempDir();
    const logs: string[] = [];
    const lock: FfmpegMedia3Lock = {
      repository: 'fatihmutluu/elv-iptv',
      workflow: 'ffmpeg-media3.yml',
      artifactName: 'ffmpeg-media3-android',
      ffmpegVersion: '9.0.2',
      media3Version: '1.11.1',
      runId: null,
      sha256: null,
    };
    const deps: FetchDeps = {
      readLock: () => lock,
      vendorDir: join(work, 'vendor'),
      cacheDir: join(work, 'cache'),
      downloadArtifact: async () => {
        throw new Error('must not download');
      },
      extractArchive: async () => {},
      sha256File: async () => '',
      log: (m) => logs.push(m),
    };
    await fetchFfmpegMedia3({ force: false }, deps);
    verifyInstalled(deps);
    expect(logs.some((l) => l.includes('no pinned runtime'))).toBe(true);
  });

  it('fetches, verifies SHA-256, extracts with USTAR reader, passes ELF+licence gate, and caches on repeat', async () => {
    const sourceBundle = makeTempDir();
    populateValidBundle(sourceBundle);
    const archiveBytes = packDirectoryToTarGz(sourceBundle);
    const expectedSha = sha256Bytes(archiveBytes);

    const work = makeTempDir();
    const vendorDir = join(work, 'vendor/ffmpeg-media3');
    const cacheDir = join(work, 'cache');
    let downloads = 0;

    const deps: FetchDeps = {
      readLock: () => ({
        repository: 'fatihmutluu/elv-iptv',
        workflow: 'ffmpeg-media3.yml',
        artifactName: 'ffmpeg-media3-android',
        ffmpegVersion: '9.0.2',
        media3Version: '1.11.1',
        runId: '987654321',
        sha256: expectedSha,
      }),
      vendorDir,
      cacheDir,
      downloadArtifact: async ({ outDir }) => {
        downloads += 1;
        mkdirSync(outDir, { recursive: true });
        const target = join(outDir, 'ffmpeg-media3-android.tar.gz');
        writeFileSync(target, archiveBytes);
        return target;
      },
      extractArchive: async (archivePath, destDir) => extractTarGz(archivePath, destDir),
      sha256File: async (p) => sha256Bytes(readFileSync(p)),
      log: () => {},
    };

    expect(() => verifyInstalled(deps)).toThrow(/missing/);
    await fetchFfmpegMedia3({ force: false }, deps);
    expect(downloads).toBe(1);
    expect(() => verifyInstalled(deps)).not.toThrow();
    expect(() => verifyDirectory(vendorDir)).not.toThrow();

    await fetchFfmpegMedia3({ force: false }, deps);
    expect(downloads).toBe(1);

    await fetchFfmpegMedia3({ force: true }, deps);
    expect(downloads).toBe(1);

    writeFileSync(join(vendorDir, '.ffmpeg-media3-sha256'), `${'0'.repeat(64)}\n`);
    expect(() => verifyInstalled(deps)).toThrow(/does not match lockfile/);
  });

  it('deletes corrupt archive and throws on SHA-256 mismatch or verifyDirectory failure', async () => {
    const work = makeTempDir();
    let downloadedPath = '';
    const deps: FetchDeps = {
      readLock: () => ({
        repository: 'fatihmutluu/elv-iptv',
        workflow: 'ffmpeg-media3.yml',
        artifactName: 'ffmpeg-media3-android',
        ffmpegVersion: '9.0.2',
        media3Version: '1.11.1',
        runId: '111',
        sha256: 'f'.repeat(64),
      }),
      vendorDir: join(work, 'vendor'),
      cacheDir: join(work, 'cache'),
      downloadArtifact: async ({ outDir }) => {
        mkdirSync(outDir, { recursive: true });
        downloadedPath = join(outDir, 'ffmpeg-media3-android.tar.gz');
        writeFileSync(downloadedPath, 'tampered');
        return downloadedPath;
      },
      extractArchive: async () => {},
      sha256File: async (p) => sha256Bytes(readFileSync(p)),
      log: () => {},
    };

    await expect(fetchFfmpegMedia3({ force: false }, deps)).rejects.toThrow(/SHA-256 mismatch/);
    expect(existsSync(downloadedPath)).toBe(false);
    expect(() => verifyDirectory(join(work, 'empty'))).toThrow(/verification failed/);
  });

  it('handles USTAR prefix/PAX headers and rejects path traversal, symlinks and PAX linkpaths', async () => {
    const work = makeTempDir();
    const validTar = join(work, 'valid-pax.tar.gz');
    const paxLine = '25 path=nested/hello.txt\n';
    writeFileSync(
      validTar,
      makeTarGz([
        { name: 'PaxHeader/hello', typeflag: 'x', content: Buffer.from(paxLine, 'utf8') },
        { name: 'ignored.txt', typeflag: '0', content: Buffer.from('world', 'utf8') },
        { name: 'file.txt', prefix: 'sub/dir', typeflag: '0', content: Buffer.from('ok', 'utf8') },
      ]),
    );
    const outValid = join(work, 'out-valid');
    extractTarGz(validTar, outValid);
    expect(readFileSync(join(outValid, 'nested/hello.txt'), 'utf8')).toBe('world');
    expect(readFileSync(join(outValid, 'sub/dir/file.txt'), 'utf8')).toBe('ok');

    const traversalTar = join(work, 'traversal.tar.gz');
    writeFileSync(
      traversalTar,
      makeTarGz([{ name: '../escape.txt', typeflag: '0', content: Buffer.from('nope') }]),
    );
    expect(() => extractTarGz(traversalTar, join(work, 'out1'))).toThrow(/unsafe tar entry/i);

    const symlinkTar = join(work, 'symlink.tar.gz');
    writeFileSync(
      symlinkTar,
      makeTarGz([
        { name: 'jniLibs/arm64-v8a/libavcodec.so', typeflag: '2', linkname: '/etc/passwd' },
      ]),
    );
    expect(() => extractTarGz(symlinkTar, join(work, 'out2'))).toThrow(
      /unsupported tar entry type/i,
    );

    const paxLinkTar = join(work, 'paxlink.tar.gz');
    writeFileSync(
      paxLinkTar,
      makeTarGz([
        {
          name: 'PaxHeader/link',
          typeflag: 'x',
          content: Buffer.from('24 linkpath=/etc/passwd\n', 'utf8'),
        },
        { name: 'a.txt', typeflag: '0', content: Buffer.from('x') },
      ]),
    );
    expect(() => extractTarGz(paxLinkTar, join(work, 'out3'))).toThrow(/linkpath/i);

    const fakeRepo = makeTempDir();
    mkdirSync(join(fakeRepo, 'modules/engine-media3'), { recursive: true });
    writeFileSync(
      join(fakeRepo, 'modules/engine-media3/ffmpeg-media3.lock.json'),
      JSON.stringify({
        repository: 'fatihmutluu/elv-iptv',
        workflow: 'ffmpeg-media3.yml',
        artifactName: 'ffmpeg-media3-android',
        ffmpegVersion: '9.0.2',
        media3Version: '1.11.1',
        runId: null,
        sha256: null,
      }),
    );
    const realDeps = createRealFetchDeps(fakeRepo);
    expect(realDeps.readLock().ffmpegVersion).toBe('9.0.2');
    expect(await realDeps.sha256File(validTar)).toHaveLength(64);
  });

  it('rejects hardlinks, malformed octals, global/size PAX headers, truncated archives without EOF and size-cap bombs', () => {
    const work = makeTempDir();

    const hardlinkTar = join(work, 'hardlink.tar.gz');
    writeFileSync(
      hardlinkTar,
      makeTarGz([{ name: 'a.txt', typeflag: '1', linkname: 'BUILDINFO.json' }]),
    );
    expect(() => extractTarGz(hardlinkTar, join(work, 'hl'))).toThrow(/unsupported tar entry/i);

    // Malformed octal ("00000000079\0") in size field
    const badHeader = Buffer.alloc(512, 0);
    badHeader.write('bad.txt', 0, 100, 'utf8');
    badHeader.write('0000644\0', 100, 8, 'ascii');
    badHeader.write('00000000079\0', 124, 12, 'ascii');
    badHeader.write('0', 156, 1, 'ascii');
    badHeader.write('ustar\0', 257, 6, 'ascii');
    const badOctalTar = join(work, 'badoctal.tar.gz');
    writeFileSync(badOctalTar, gzipSync(Buffer.concat([badHeader, Buffer.alloc(1024, 0)])));
    expect(() => extractTarGz(badOctalTar, join(work, 'oct'))).toThrow(/invalid octal/i);

    // Truncated tar on 512-byte boundary without all-zero EOF block
    const noEofHeader = Buffer.alloc(512, 0);
    noEofHeader.write('ok.txt', 0, 100, 'utf8');
    noEofHeader.write('0000644\0', 100, 8, 'ascii');
    noEofHeader.write('00000000002\0', 124, 12, 'ascii');
    noEofHeader.write('0', 156, 1, 'ascii');
    const payload512 = Buffer.alloc(512, 0);
    payload512.write('hi', 0, 2, 'utf8');
    const noEofTar = join(work, 'noeof.tar.gz');
    writeFileSync(noEofTar, gzipSync(Buffer.concat([noEofHeader, payload512])));
    expect(() => extractTarGz(noEofTar, join(work, 'noeof'))).toThrow(/eof|truncated/i);

    // Global PAX ('g') and PAX size= override are rejected
    const paxGlobalTar = join(work, 'paxglobal.tar.gz');
    writeFileSync(
      paxGlobalTar,
      makeTarGz([
        { name: 'PaxHeader/global', typeflag: 'g', content: Buffer.from('16 comment=abc\n') },
        { name: 'a.txt', typeflag: '0', content: Buffer.from('x') },
      ]),
    );
    expect(() => extractTarGz(paxGlobalTar, join(work, 'paxg'))).toThrow(/global|unsupported/i);

    const paxSizeTar = join(work, 'paxsize.tar.gz');
    writeFileSync(
      paxSizeTar,
      makeTarGz([
        { name: 'PaxHeader/sz', typeflag: 'x', content: Buffer.from('12 size=100\n') },
        { name: 'a.txt', typeflag: '0', content: Buffer.from('x') },
      ]),
    );
    expect(() => extractTarGz(paxSizeTar, join(work, 'paxsz'))).toThrow(/pax.*size/i);

    const badPaxLenTar = join(work, 'badpaxlen.tar.gz');
    writeFileSync(
      badPaxLenTar,
      makeTarGz([
        { name: 'PaxHeader/bad', typeflag: 'x', content: Buffer.from('99 path=foo\n') },
        { name: 'a.txt', typeflag: '0', content: Buffer.from('x') },
      ]),
    );
    expect(() => extractTarGz(badPaxLenTar, join(work, 'paxbad'))).toThrow(/pax/i);

    // Size cap enforcement
    const capTar = join(work, 'cap.tar.gz');
    writeFileSync(
      capTar,
      makeTarGz([{ name: 'big.bin', typeflag: '0', content: Buffer.alloc(4096, 1) }]),
    );
    expect(() => extractTarGz(capTar, join(work, 'capout'), { maxOutputBytes: 1024 })).toThrow();
    expect(() => extractTarGz(capTar, join(work, 'capcnt'), { maxEntries: 0 })).toThrow();
  });

  it('runs pnpm ffmpeg-media3 fetch before expo prebuild in buildApk', async () => {
    const work = makeTempDir();
    const calls: Array<{ command: string; args: string[] }> = [];
    const fakeExec: Exec = async (command, args) => {
      calls.push({ command, args });
      return { ok: true, output: '' };
    };
    await buildApk(fakeExec, work, '/sdk/platform-tools/adb');
    expect(calls.length).toBe(3);
    expect(calls[0]).toEqual({
      command: 'node',
      args: ['tools/bin/ffmpeg-media3.ts', 'fetch'],
    });
    expect(calls[1]?.args).toContain('prebuild');
    expect(calls[2]?.args).toContain('assembleRelease');
  });
});
