import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FetchDeps } from './fetch.ts';
import { buildLauncher } from './launcher.ts';

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`)),
    );
  });
}

async function symlinksUnder(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) out.push(rel);
    else if (entry.isDirectory()) out.push(...(await symlinksUnder(join(dir, entry.name), rel)));
  }
  return out;
}

async function walk(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walk(join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out;
}

/** The system `tar` (bsdtar ships with Windows 10+ and macOS; Git Bash's GNU tar cannot read zip). */
function systemTar(): string {
  if (process.platform !== 'win32') return 'tar';
  const windir = process.env.SystemRoot ?? process.env.windir;
  if (windir === undefined)
    throw new Error('mpv: cannot find the Windows directory (SystemRoot) for tar.exe');
  return join(windir, 'System32', 'tar.exe');
}

/** SHA-256 of all `.c` and `.h` launcher sources in `dir` in deterministic sorted order. */
export async function hashLauncherSources(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && /\.[ch]$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (names.length === 0) throw new Error(`mpv: no launcher source files (.c/.h) found in ${dir}`);
  const hash = createHash('sha256');
  for (const name of names) {
    hash.update(`${name}\0`);
    hash.update(await readFile(join(dir, name)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Real side effects for `pnpm mpv`: https download, SHA-256, system tar, `gh run download`. */
export function realDeps(log: (line: string) => void, root: string): FetchDeps {
  const launcherDir = `${root}/apps/desktop/native/mpv-host`;
  const launcherSource = `${launcherDir}/elv-mpv.c`;
  return {
    async download(url, file) {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok || res.body === null) throw new Error(`download failed: HTTP ${res.status}`);
      await mkdir(dirname(file), { recursive: true });
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file));
    },
    async ghArtifact(entry, dir) {
      await mkdir(dir, { recursive: true });
      await run('gh', [
        'run',
        'download',
        String(entry.runId),
        '-R',
        entry.repo,
        '-n',
        entry.artifact,
        '-D',
        dir,
      ]);
    },
    async sha256(file) {
      const hash = createHash('sha256');
      await pipeline(createReadStream(file), hash);
      return hash.digest('hex');
    },
    async extract(archive, dir) {
      await mkdir(dir, { recursive: true });
      const flags = archive.endsWith('.tar.gz') ? '-xzf' : '-xf';
      await run(systemTar(), [flags, archive, '-C', dir]);
    },
    readBytes: (file) => readFile(file),
    exists: existsSync,
    async buildLauncher(runtimeDir) {
      if (process.platform !== 'win32') return;
      const win = (p: string): string => p.replaceAll('/', String.fromCharCode(92));
      await buildLauncher({ runtimeDir: win(runtimeDir), source: win(launcherSource) });
      log('mpv: built elv-mpv.exe');
    },
    async launcherSourceHash() {
      if (process.platform !== 'win32') return null;
      return hashLauncherSources(launcherDir);
    },
    log,
    readText: (file) => readFile(file, 'utf8'),
    async writeText(file, text) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, text);
    },
    async installDir(from, to) {
      await mkdir(dirname(to), { recursive: true });
      await cp(from, to, { recursive: true });
      await rm(from, { recursive: true, force: true });
    },
    removeDir: (dir) => rm(dir, { recursive: true, force: true }),
    listFiles: (dir) => walk(dir),
    findSymlinks: (dir) => symlinksUnder(dir),
    rename: (from, to) => rename(from, to),
  };
}
