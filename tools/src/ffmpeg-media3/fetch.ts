import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanLicence } from './licence.ts';
import type { FfmpegMedia3Lock } from './lock.ts';

/** Arguments passed to {@link FetchDeps.downloadArtifact}. */
export interface DownloadArtifactOptions {
  repository: string;
  runId: string;
  artifactName: string;
  outDir: string;
}

/** Injectable I/O boundary for {@link fetchFfmpegMedia3} and {@link verifyInstalled}. */
export interface FetchDeps {
  readLock: () => FfmpegMedia3Lock;
  vendorDir: string;
  cacheDir: string;
  downloadArtifact: (opts: DownloadArtifactOptions) => Promise<string>;
  extractArchive: (archivePath: string, destDir: string) => Promise<void>;
  sha256File: (path: string) => Promise<string>;
  log: (message: string) => void;
}

/** Options for {@link fetchFfmpegMedia3}. */
export interface FetchOptions {
  force: boolean;
}

const MARKER_FILE = '.ffmpeg-media3-sha256';

/** Runs the full LGPL + 16 KB ELF gate on an arbitrary bundle directory, throwing on any violation. */
export function verifyDirectory(dir: string): void {
  const result = scanLicence(dir);
  if (!result.ok) {
    throw new Error(
      `ffmpeg-media3 verification failed in ${dir}:\n  - ${result.findings.join('\n  - ')}`,
    );
  }
}

/** Verifies the installed `modules/engine-media3/vendor/ffmpeg-media3` runtime against the lockfile. */
export function verifyInstalled(deps: Pick<FetchDeps, 'readLock' | 'vendorDir' | 'log'>): void {
  const lock = deps.readLock();
  if (lock.runId === null || lock.sha256 === null) {
    deps.log('ffmpeg-media3: no pinned runtime in ffmpeg-media3.lock.json; nothing to verify.');
    return;
  }
  const markerPath = join(deps.vendorDir, MARKER_FILE);
  if (!existsSync(markerPath)) {
    throw new Error(`ffmpeg-media3: missing ${markerPath}; run "pnpm ffmpeg-media3 fetch" first`);
  }
  const installedSha = readFileSync(markerPath, 'utf8').trim();
  if (installedSha !== lock.sha256) {
    throw new Error(
      `ffmpeg-media3: installed runtime SHA-256 (${installedSha}) does not match lockfile (${lock.sha256}); run "pnpm ffmpeg-media3 fetch"`,
    );
  }
  verifyDirectory(deps.vendorDir);
  deps.log(
    `ffmpeg-media3: verified FFmpeg ${lock.ffmpegVersion} + Media3 ${lock.media3Version} (${lock.sha256.slice(0, 12)}).`,
  );
}

/** Fetches, verifies and installs the locked Android FFmpeg + Media3 JNI bundle when needed. */
export async function fetchFfmpegMedia3(opts: FetchOptions, deps: FetchDeps): Promise<void> {
  const lock = deps.readLock();
  if (lock.runId === null || lock.sha256 === null) {
    deps.log('ffmpeg-media3: no pinned runtime yet; skipping fetch.');
    return;
  }

  const markerPath = join(deps.vendorDir, MARKER_FILE);
  if (!opts.force && existsSync(markerPath)) {
    const installed = readFileSync(markerPath, 'utf8').trim();
    if (installed === lock.sha256 && scanLicence(deps.vendorDir).ok) {
      deps.log(`ffmpeg-media3: up to date (${lock.sha256.slice(0, 12)}).`);
      return;
    }
  }

  const runCacheDir = join(deps.cacheDir, lock.runId);
  mkdirSync(runCacheDir, { recursive: true });
  let archivePath = join(runCacheDir, `${lock.artifactName}.tar.gz`);

  if (!existsSync(archivePath)) {
    deps.log(
      `ffmpeg-media3: downloading ${lock.artifactName} from ${lock.repository} run ${lock.runId}...`,
    );
    archivePath = await deps.downloadArtifact({
      repository: lock.repository,
      runId: lock.runId,
      artifactName: lock.artifactName,
      outDir: runCacheDir,
    });
  }

  const actualSha = await deps.sha256File(archivePath);
  if (actualSha !== lock.sha256) {
    rmSync(archivePath, { force: true });
    throw new Error(
      `ffmpeg-media3: SHA-256 mismatch for ${archivePath} (expected ${lock.sha256}, got ${actualSha})`,
    );
  }

  const stagingDir = `${deps.vendorDir}.staging`;
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });
  try {
    await deps.extractArchive(archivePath, stagingDir);
    verifyDirectory(stagingDir);
    writeFileSync(join(stagingDir, MARKER_FILE), `${lock.sha256}\n`);

    rmSync(deps.vendorDir, { recursive: true, force: true });
    mkdirSync(join(deps.vendorDir, '..'), { recursive: true });
    // Copy via rename on same volume
    const { renameSync } = await import('node:fs');
    renameSync(stagingDir, deps.vendorDir);
  } catch (err) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }

  deps.log(
    `ffmpeg-media3: installed verified FFmpeg ${lock.ffmpegVersion} + Media3 ${lock.media3Version} (${lock.sha256.slice(0, 12)}).`,
  );
}
