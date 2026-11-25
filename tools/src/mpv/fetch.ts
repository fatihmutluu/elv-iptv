import { type LicenceVerdict, scanLicence } from './licence.ts';
import { type LockEntry, type RuntimeLock, runtimeKey } from './lock.ts';

/** Side effects of fetching, injected so tests never touch the network or the disk. */
export interface FetchDeps {
  download(url: string, file: string): Promise<void>;
  ghArtifact(e: Extract<LockEntry, { kind: 'workflow-artifact' }>, dir: string): Promise<void>;
  sha256(file: string): Promise<string>;
  extract(archive: string, dir: string): Promise<void>;
  readBytes(file: string): Promise<Uint8Array>;
  exists(path: string): boolean;
  buildLauncher(runtimeDir: string): Promise<void>;
  /** SHA-256 of the launcher sources (`apps/desktop/native/mpv-host/*.{c,h}`), or null where no launcher is built. */
  launcherSourceHash(): Promise<string | null>;
  log(line: string): void;
  readText(file: string): Promise<string>;
  writeText(file: string, text: string): Promise<void>;
  /** Moves the staged directory to its final place, replacing what was there. */
  installDir(from: string, to: string): Promise<void>;
  removeDir(dir: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Relative paths of symbolic links under a directory. */
  findSymlinks(dir: string): Promise<string[]>;
  /** Relative paths (forward slashes) of every file under a directory. */
  listFiles(dir: string): Promise<string[]>;
}

export type FetchResult =
  | { status: 'installed' | 'current'; dir: string; verdict: LicenceVerdict }
  | { status: 'unsupported'; key: string };

export interface FetchOptions {
  root: string;
  platform: string;
  arch: string;
  lock: RuntimeLock;
  force?: boolean;
}

/** Files that embed the FFmpeg configuration or the mpv build options; other dylibs carry neither. */
const BINARY =
  /(\.[dD][lL][lL]|(^|\/)(libav(codec|format|util)|libmpv)[^/]*\.dylib|\.so(\.\d+)*|(^|\/)mpv)$/;

/** Candidate relative paths for upstream runtime build metadata embedded in CI archives. */
const RUNTIME_BUILDINFO_PATHS = [
  'RUNTIME-BUILDINFO.json',
  'ELV IPTV Player.app/Contents/Resources/BUILDINFO.json',
] as const;

function runtimeDir(root: string, key: string): string {
  return `${root}/apps/desktop/resources/mpv/${key}`;
}

/** Names that could escape the staging folder: absolute, drive-letter, UNC or containing a parent segment. */
function unsafeNames(names: string[]): string[] {
  return names.filter((n) => {
    const slashed = n.replaceAll(String.fromCharCode(92), '/');
    return (
      slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed) || slashed.split('/').includes('..')
    );
  });
}

async function assertContained(dir: string, key: string, deps: FetchDeps): Promise<string[]> {
  const names = await deps.listFiles(dir);
  const bad = unsafeNames(names);
  const links = await deps.findSymlinks(dir);
  if (bad.length > 0 || links.length > 0) {
    await deps.removeDir(dir);
    const why =
      bad.length > 0
        ? `unsafe path outside the staging folder: ${bad[0]}`
        : `symlink in archive: ${links[0]}`;
    throw new Error(`mpv: ${key} refused the archive (${why})`);
  }
  return names;
}

async function scanDir(dir: string, deps: FetchDeps, all?: string[]): Promise<LicenceVerdict> {
  const names = (all ?? (await deps.listFiles(dir))).filter((n) => BINARY.test(n));
  const files = [];
  for (const name of names) files.push({ name, bytes: await deps.readBytes(`${dir}/${name}`) });
  return scanLicence(files);
}

function summary(key: string, verb: string, mpv: string, v: LicenceVerdict): string {
  return `mpv: ${key} ${verb} (mpv ${mpv}; ffmpeg without gpl/nonfree; mpv gpl=false; lua ${v.lua ? 'yes' : 'no'})`;
}

async function readInstalled(
  dir: string,
  deps: FetchDeps,
): Promise<{ sha256: string; licence: LicenceVerdict } | null> {
  const file = `${dir}/BUILDINFO.json`;
  if (!deps.exists(file)) return null;
  try {
    const info = JSON.parse(await deps.readText(file)) as {
      sha256?: string;
      licence?: { ffmpegConfig: string | null; mpvOptions: string | null; lua: boolean };
    };
    const l = info.licence;
    if (!l || info.sha256 === undefined) return null;
    const licence: LicenceVerdict = {
      ok: true,
      problems: [],
      ffmpegConfig: l.ffmpegConfig,
      mpvOptions: l.mpvOptions,
      lua: l.lua,
    };
    return { sha256: info.sha256, licence };
  } catch {
    return null;
  }
}

async function readRuntimeBuildInfo(
  dir: string,
  deps: FetchDeps,
): Promise<Record<string, unknown> | undefined> {
  for (const rel of RUNTIME_BUILDINFO_PATHS) {
    const file = `${dir}/${rel}`;
    if (!deps.exists(file)) continue;
    try {
      const parsed: unknown = JSON.parse(await deps.readText(file));
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Ignore malformed upstream build metadata; licence gate remains authoritative.
    }
  }
  return undefined;
}

/** Builds the launcher and records the source hash it was built from in `elv-mpv.stamp`. */
async function buildStamped(dir: string, hash: string | null, deps: FetchDeps): Promise<void> {
  await deps.buildLauncher(dir);
  if (hash !== null) await deps.writeText(`${dir}/elv-mpv.stamp`, `${hash}\n`);
}

function launcherOutputs(dir: string, platform: string): string[] {
  if (platform === 'win32') return [`${dir}/elv-mpv.exe`];
  if (platform === 'darwin') {
    return [
      `${dir}/ELV IPTV Player.app/Contents/MacOS/elv-mpv`,
      `${dir}/elv-iosurface.node`,
      `${dir}/elv-macos-media.node`,
    ];
  }
  return [];
}

/** A current runtime keeps its launcher only while the stamp matches the launcher sources and all outputs exist. */
async function refreshLauncher(
  dir: string,
  key: string,
  platform: string,
  deps: FetchDeps,
): Promise<void> {
  const hash = await deps.launcherSourceHash();
  if (hash === null) return;
  const outputs = launcherOutputs(dir, platform);
  const stamp = `${dir}/elv-mpv.stamp`;
  const built = deps.exists(stamp) ? (await deps.readText(stamp)).trim() : null;
  if (built === hash && outputs.every((out) => deps.exists(out))) return;
  const label = platform === 'win32' ? 'elv-mpv.exe' : 'elv-mpv';
  deps.log(`mpv: ${key} ${label} is out of date with launcher sources; rebuilding`);
  await buildStamped(dir, hash, deps);
}

async function obtainArchive(
  root: string,
  key: string,
  entry: LockEntry,
  deps: FetchDeps,
): Promise<string> {
  const cache = `${root}/.cache/mpv/${key}`;
  const name =
    entry.kind === 'upstream-libmpv' ? (entry.url.split('/').pop() as string) : entry.file;
  const file = `${cache}/${name}`;
  if (deps.exists(file)) {
    if ((await deps.sha256(file)) === entry.sha256) return file;
    await deps.removeDir(file);
  }
  if (entry.kind === 'upstream-libmpv') {
    deps.log(`mpv: ${key} downloading ${name}`);
    const part = `${file}.part`;
    await deps.download(entry.url, part);
    await deps.rename(part, file);
  } else {
    deps.log(`mpv: ${key} downloading workflow artifact ${entry.artifact} of run ${entry.runId}`);
    await deps.ghArtifact(entry, cache);
  }
  const actual = await deps.sha256(file);
  if (actual !== entry.sha256) {
    await deps.removeDir(file);
    throw new Error(
      `mpv: ${key} SHA-256 mismatch for ${name}: expected ${entry.sha256}, got ${actual}`,
    );
  }
  return file;
}

/**
 * Installs the pinned runtime into the gitignored `apps/desktop/resources/mpv/<key>/`: verifies the
 * SHA-256 before extracting, extracts into a fresh staging directory, applies the licence gate to the
 * staged binaries and only then replaces the install directory. Nothing is executed.
 */
export async function fetchRuntime(opts: FetchOptions, deps: FetchDeps): Promise<FetchResult> {
  const key = runtimeKey(opts.platform, opts.arch);
  const entry = opts.lock[key];
  if (entry === undefined) return { status: 'unsupported', key };
  const dir = runtimeDir(opts.root, key);
  const installed = opts.force === true ? null : await readInstalled(dir, deps);
  if (installed?.sha256 === entry.sha256) {
    await refreshLauncher(dir, key, opts.platform, deps);
    deps.log(summary(key, 'current', entry.mpv, installed.licence));
    return { status: 'current', dir, verdict: installed.licence };
  }
  const archive = await obtainArchive(opts.root, key, entry, deps);
  const staging = `${opts.root}/.cache/mpv/staging-${key}`;
  await deps.removeDir(staging);
  await deps.extract(archive, staging);
  const names = await assertContained(staging, key, deps);
  const verdict = await scanDir(staging, deps, names);
  if (!verdict.ok) {
    await deps.removeDir(staging);
    throw new Error(`mpv: ${key} refused by the licence gate: ${verdict.problems.join('; ')}`);
  }
  await deps.removeDir(dir);
  await deps.installDir(staging, dir);
  await buildStamped(dir, await deps.launcherSourceHash(), deps);
  const runtimeBuild = await readRuntimeBuildInfo(dir, deps);
  const { ffmpegConfig, mpvOptions, lua } = verdict;
  const info = {
    key,
    entry,
    sha256: entry.sha256,
    installedAt: new Date().toISOString(),
    licence: { ffmpegConfig, mpvOptions, lua },
    ...(runtimeBuild !== undefined ? { runtimeBuild } : {}),
  };
  await deps.writeText(`${dir}/BUILDINFO.json`, `${JSON.stringify(info, null, 2)}\n`);
  deps.log(summary(key, 'installed', entry.mpv, verdict));
  return { status: 'installed', dir, verdict };
}

/**
 * Applies the licence gate to the binaries under any directory, without a lock entry: the CI build
 * checks its output with it before upload.
 */
export async function verifyDirectory(dir: string, deps: FetchDeps): Promise<LicenceVerdict> {
  const verdict = await scanDir(dir, deps);
  if (!verdict.ok)
    throw new Error(`mpv: ${dir} refused by the licence gate: ${verdict.problems.join('; ')}`);
  const lua = verdict.lua ? 'yes' : 'no';
  deps.log(
    `mpv: ${dir} passed the licence gate (ffmpeg without gpl/nonfree; mpv gpl=false; lua ${lua})`,
  );
  return verdict;
}

/** Rescans the installed runtime for the platform and applies the licence gate again. */
export async function verifyRuntime(
  opts: Omit<FetchOptions, 'force'>,
  deps: FetchDeps,
): Promise<FetchResult & { status: 'current' | 'unsupported' }> {
  const key = runtimeKey(opts.platform, opts.arch);
  const entry = opts.lock[key];
  if (entry === undefined) return { status: 'unsupported', key };
  const dir = runtimeDir(opts.root, key);
  if (!deps.exists(`${dir}/BUILDINFO.json`))
    throw new Error(`mpv: ${key} is not installed; run pnpm mpv fetch`);
  const info = await readInstalled(dir, deps);
  if (info?.sha256 !== entry.sha256)
    throw new Error(
      `mpv: ${key} installed runtime does not match the lock; run pnpm mpv fetch --force`,
    );
  const verdict = await scanDir(dir, deps);
  if (!verdict.ok)
    throw new Error(`mpv: ${key} refused by the licence gate: ${verdict.problems.join('; ')}`);
  deps.log(summary(key, 'verified', entry.mpv, verdict));
  return { status: 'current', dir, verdict };
}
