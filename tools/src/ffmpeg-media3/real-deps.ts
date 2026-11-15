import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import type { DownloadArtifactOptions, FetchDeps } from './fetch.ts';
import { parseLock } from './lock.ts';

const execFileAsync = promisify(execFile);

function readNullTerminated(buf: Uint8Array, start: number, length: number): string {
  let end = start;
  const max = Math.min(buf.length, start + length);
  while (end < max && buf[end] !== 0) end += 1;
  return Buffer.from(buf.subarray(start, end)).toString('utf8');
}

function parseOctal(buf: Uint8Array, start: number, length: number): number {
  const raw = readNullTerminated(buf, start, length).trim();
  if (raw === '') return 0;
  const value = Number.parseInt(raw, 8);
  if (Number.isNaN(value) || value < 0) {
    throw new Error(`Invalid octal field "${raw}" in tar header`);
  }
  return value;
}

function resolveSafeEntryPath(destDir: string, entryName: string): string {
  const normalized = entryName.replace(/\\/g, '/').replace(/^\.\//, '');
  if (
    normalized === '' ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').some((seg) => seg === '..')
  ) {
    throw new Error(`Unsafe tar entry path "${entryName}"`);
  }
  const root = resolve(destDir);
  const full = resolve(root, normalized);
  if (full !== root && !full.startsWith(`${root}${sep}`)) {
    throw new Error(`Unsafe tar entry path "${entryName}" escapes destination`);
  }
  return full;
}

/**
 * Safely extracts a `.tar.gz` archive into `destDir` using Node's built-in `zlib`,
 * rejecting path traversal, hardlinks, symlinks and device nodes on every OS.
 */
export function extractTarGz(archivePath: string, destDir: string): void {
  const tar = gunzipSync(readFileSync(archivePath));
  mkdirSync(destDir, { recursive: true });

  let offset = 0;
  let pendingLongName: string | null = null;
  let pendingPaxPath: string | null = null;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;

    let allZero = true;
    for (let i = 0; i < 512; i += 1) {
      if (header[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;

    const name = readNullTerminated(header, 0, 100);
    const prefix = readNullTerminated(header, 345, 155);
    const size = parseOctal(header, 124, 12);
    const typeByte = header[156] ?? 0;
    const typeflag = typeByte === 0 ? '0' : String.fromCharCode(typeByte);

    if (offset + size > tar.length) {
      throw new Error(`Truncated tar payload for "${name}"`);
    }
    const payload = tar.subarray(offset, offset + size);
    const padded = size + ((512 - (size % 512)) % 512);
    offset += padded;

    if (typeflag === 'L') {
      pendingLongName = readNullTerminated(payload, 0, payload.length);
      continue;
    }
    if (typeflag === 'x' || typeflag === 'g') {
      const paxText = Buffer.from(payload).toString('utf8');
      if (/(?:^|\n)\d+ linkpath=/.test(paxText)) {
        throw new Error('Unsupported tar entry type: PAX linkpath is forbidden');
      }
      if (typeflag === 'x') {
        const match = /(?:^|\n)\d+ path=([^\n]+)\n/.exec(paxText);
        if (match?.[1]) pendingPaxPath = match[1];
      }
      continue;
    }

    const combinedName = pendingPaxPath ?? pendingLongName ?? (prefix ? `${prefix}/${name}` : name);
    pendingLongName = null;
    pendingPaxPath = null;

    if (combinedName === '.' || combinedName === './') continue;

    if (typeflag === '5') {
      const fullDir = resolveSafeEntryPath(destDir, combinedName.replace(/\/+$/, ''));
      mkdirSync(fullDir, { recursive: true });
      continue;
    }
    if (typeflag !== '0') {
      throw new Error(
        `Unsupported tar entry type "${typeflag}" for "${combinedName}" (symlinks and special files are forbidden)`,
      );
    }

    const fullPath = resolveSafeEntryPath(destDir, combinedName);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, payload);
  }
}

async function downloadWithGh(opts: DownloadArtifactOptions): Promise<string> {
  mkdirSync(opts.outDir, { recursive: true });
  const tmpDir = mkdtempSync(join(opts.outDir, 'gh-dl-'));
  try {
    await execFileAsync(
      'gh',
      [
        'run',
        'download',
        opts.runId,
        '--repo',
        opts.repository,
        '--name',
        opts.artifactName,
        '--dir',
        tmpDir,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    const downloaded = join(tmpDir, `${opts.artifactName}.tar.gz`);
    if (!existsSync(downloaded)) {
      throw new Error(
        `gh run download succeeded for run ${opts.runId}, but ${opts.artifactName}.tar.gz was not inside ${opts.artifactName}`,
      );
    }
    const target = join(opts.outDir, `${opts.artifactName}.tar.gz`);
    rmSync(target, { force: true });
    renameSync(downloaded, target);
    return target;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Builds production {@link FetchDeps} rooted at the workspace root directory. */
export function createRealFetchDeps(repoRoot: string): FetchDeps {
  const lockPath = join(repoRoot, 'modules/engine-media3/ffmpeg-media3.lock.json');
  return {
    readLock: () => parseLock(readFileSync(lockPath, 'utf8')),
    vendorDir: join(repoRoot, 'modules/engine-media3/vendor/ffmpeg-media3'),
    cacheDir: join(repoRoot, '.cache/ffmpeg-media3'),
    downloadArtifact: downloadWithGh,
    extractArchive: async (archivePath, destDir) => {
      extractTarGz(archivePath, destDir);
    },
    sha256File: async (path) => createHash('sha256').update(readFileSync(path)).digest('hex'),
    log: (message) => {
      process.stdout.write(`${message}\n`);
    },
  };
}
