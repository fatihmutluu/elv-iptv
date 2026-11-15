import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import type { DownloadArtifactOptions, FetchDeps } from './fetch.ts';
import { parseLock } from './lock.ts';

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 128;

/** Safety caps for {@link extractTarGz}. */
export interface TarExtractLimits {
  maxArchiveBytes?: number;
  maxOutputBytes?: number;
  maxEntries?: number;
}

function readNullTerminated(buf: Uint8Array, start: number, length: number): string {
  let end = start;
  const max = Math.min(buf.length, start + length);
  while (end < max && buf[end] !== 0) end += 1;
  return Buffer.from(buf.subarray(start, end)).toString('utf8');
}

function parseOctal(buf: Uint8Array, start: number, length: number): number {
  const raw = readNullTerminated(buf, start, length).trim();
  if (raw === '') return 0;
  if (!/^[0-7]+$/.test(raw)) {
    throw new Error(`Invalid octal field "${raw}" in tar header`);
  }
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid octal field "${raw}" in tar header`);
  }
  return value;
}

function parsePaxExtendedHeader(payload: Uint8Array): string | null {
  let pos = 0;
  let pathOverride: string | null = null;
  while (pos < payload.length) {
    let spaceIdx = pos;
    while (spaceIdx < payload.length && payload[spaceIdx] !== 0x20) spaceIdx += 1;
    if (spaceIdx >= payload.length) {
      throw new Error('Malformed PAX extended header record');
    }
    const lenStr = Buffer.from(payload.subarray(pos, spaceIdx)).toString('ascii');
    if (!/^\d+$/.test(lenStr)) {
      throw new Error(`Invalid PAX record length "${lenStr}"`);
    }
    const recordLen = Number.parseInt(lenStr, 10);
    if (
      recordLen < 5 ||
      pos + recordLen > payload.length ||
      payload[pos + recordLen - 1] !== 0x0a
    ) {
      throw new Error('Truncated or malformed PAX extended header record');
    }
    const body = Buffer.from(payload.subarray(spaceIdx + 1, pos + recordLen - 1)).toString('utf8');
    const eqIdx = body.indexOf('=');
    if (eqIdx <= 0) {
      throw new Error('Malformed PAX key=value entry');
    }
    const key = body.slice(0, eqIdx);
    const val = body.slice(eqIdx + 1);
    if (key === 'linkpath') {
      throw new Error('Unsupported tar entry type: PAX linkpath is forbidden');
    }
    if (key === 'size') {
      throw new Error('Unsupported PAX size override in tar header');
    }
    if (key === 'path') {
      pathOverride = val;
    }
    pos += recordLen;
  }
  return pathOverride;
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
 * enforcing size/entry caps and rejecting path traversal, hardlinks, symlinks and special files.
 */
export function extractTarGz(
  archivePath: string,
  destDir: string,
  limits: TarExtractLimits = {},
): void {
  const maxArchiveBytes = limits.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
  const maxOutputBytes = limits.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;

  const archiveSize = statSync(archivePath).size;
  if (archiveSize > maxArchiveBytes) {
    throw new Error(
      `Compressed archive ${archivePath} (${archiveSize} bytes) exceeds limit ${maxArchiveBytes}`,
    );
  }

  const tar = gunzipSync(readFileSync(archivePath), { maxOutputLength: maxOutputBytes });
  if (tar.length === 0 || tar.length % 512 !== 0) {
    throw new Error(`Truncated or misaligned tar stream (${tar.length} bytes)`);
  }
  mkdirSync(destDir, { recursive: true });

  let offset = 0;
  let pendingLongName: string | null = null;
  let pendingPaxPath: string | null = null;
  let sawEof = false;
  let fileEntries = 0;
  let totalWritten = 0;

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
    if (allZero) {
      if (pendingLongName !== null || pendingPaxPath !== null) {
        throw new Error('Dangling tar metadata header at EOF');
      }
      sawEof = true;
      break;
    }

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
    if (offset + padded > tar.length) {
      throw new Error(`Truncated tar padding for "${name}"`);
    }
    offset += padded;

    if (typeflag === 'L') {
      pendingLongName = readNullTerminated(payload, 0, payload.length);
      continue;
    }
    if (typeflag === 'g') {
      throw new Error('Unsupported tar entry type "g": global PAX headers are forbidden');
    }
    if (typeflag === 'x') {
      const paxPath = parsePaxExtendedHeader(payload);
      if (paxPath !== null) pendingPaxPath = paxPath;
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
        `Unsupported tar entry type "${typeflag}" for "${combinedName}" (symlinks, hardlinks and special files are forbidden)`,
      );
    }

    fileEntries += 1;
    if (fileEntries > maxEntries) {
      throw new Error(`Tar archive exceeds maximum allowed file count (${maxEntries})`);
    }
    totalWritten += payload.length;
    if (totalWritten > maxOutputBytes) {
      throw new Error(`Tar archive extracted bytes exceed limit (${maxOutputBytes})`);
    }

    const fullPath = resolveSafeEntryPath(destDir, combinedName);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, payload);
  }

  if (!sawEof) {
    throw new Error('Truncated tar archive: missing all-zero EOF block');
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
