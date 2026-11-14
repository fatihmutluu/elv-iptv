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
  log(line: string): void;
  readText(file: string): Promise<string>;
  writeText(file: string, text: string): Promise<void>;
  /** Moves the staged directory to its final place, replacing what was there. */
  installDir(from: string, to: string): Promise<void>;
  removeDir(dir: string): Promise<void>;
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

const BINARY = /(\.dll|\.dylib|\.so(\.\d+)*|\/mpv|^mpv)$/;

function runtimeDir(root: string, key: string): string {
  return `${root}/apps/desktop/resources/mpv/${key}`;
}

async function scanDir(dir: string, deps: FetchDeps): Promise<LicenceVerdict> {
  const names = (await deps.listFiles(dir)).filter((n) => BINARY.test(n));
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

async function obtainArchive(
  root: string,
  key: string,
  entry: LockEntry,
  deps: FetchDeps,
): Promise<string> {
  const cache = `${root}/.cache/mpv`;
  const name =
    entry.kind === 'upstream-libmpv' ? (entry.url.split('/').pop() as string) : entry.file;
  const file = `${cache}/${name}`;
  if (deps.exists(file) && (await deps.sha256(file)) === entry.sha256) return file;
  if (entry.kind === 'upstream-libmpv') {
    deps.log(`mpv: ${key} downloading ${name}`);
    await deps.download(entry.url, file);
  } else {
    deps.log(`mpv: ${key} downloading workflow artifact ${entry.artifact}`);
    await deps.ghArtifact(entry, cache);
  }
  const actual = await deps.sha256(file);
  if (actual !== entry.sha256) {
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
    deps.log(summary(key, 'current', entry.mpv, installed.licence));
    return { status: 'current', dir, verdict: installed.licence };
  }
  const archive = await obtainArchive(opts.root, key, entry, deps);
  const staging = `${opts.root}/.cache/mpv/staging-${key}`;
  await deps.removeDir(staging);
  await deps.extract(archive, staging);
  const verdict = await scanDir(staging, deps);
  if (!verdict.ok) {
    await deps.removeDir(staging);
    throw new Error(`mpv: ${key} refused by the licence gate: ${verdict.problems.join('; ')}`);
  }
  await deps.removeDir(dir);
  await deps.installDir(staging, dir);
  await deps.buildLauncher(dir);
  const { ffmpegConfig, mpvOptions, lua } = verdict;
  const info = {
    key,
    entry,
    sha256: entry.sha256,
    installedAt: new Date().toISOString(),
    licence: { ffmpegConfig, mpvOptions, lua },
  };
  await deps.writeText(`${dir}/BUILDINFO.json`, `${JSON.stringify(info, null, 2)}\n`);
  deps.log(summary(key, 'installed', entry.mpv, verdict));
  return { status: 'installed', dir, verdict };
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
  const verdict = await scanDir(dir, deps);
  if (!verdict.ok)
    throw new Error(`mpv: ${key} refused by the licence gate: ${verdict.problems.join('; ')}`);
  deps.log(summary(key, 'verified', entry.mpv, verdict));
  return { status: 'current', dir, verdict };
}
