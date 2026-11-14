import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Duplex } from 'node:stream';
import type { MpvClient } from './client.ts';
import { createMpvClient } from './client.ts';

/** Options for `spawnMpv`. */
export interface SpawnMpvOptions {
  executable: string;
  args: readonly string[];
  platform: NodeJS.Platform;
  /** Pid the launcher watches; it quits mpv when this process exits (Windows launcher only). */
  parentPid: number;
  connectTimeoutMs?: number;
  signal?: AbortSignal;
  /** When set, the child pid is recorded here while it runs so a crashed app's leftovers can be swept. */
  pidFile?: string;
}

/** A running mpv process and its IPC client. */
export interface MpvProcess {
  readonly pid: number;
  readonly client: MpvClient;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  /** Asks mpv to quit, then kills it after `graceMs` (default 1000). */
  quit(graceMs?: number): Promise<void>;
  kill(): void;
}

/** Replaceable system calls, for tests. */
export interface SpawnDeps {
  spawn: typeof spawn;
  connect: (path: string) => Duplex;
  retryDelayMs?: number;
}

const realDeps: SpawnDeps = { spawn, connect: (path) => connect(path) };

/** The launcher arguments that open the IPC server (and, on Windows, bind the launcher to its parent). */
export function transportArgs(
  platform: NodeJS.Platform,
  pipeName: string,
  parentPid: number,
): string[] {
  if (platform === 'win32') {
    return [`--input-ipc-server=\\\\.\\pipe\\${pipeName}`, `--elv-parent-pid=${parentPid}`];
  }
  return [`--input-ipc-server=${pipeName}`];
}

function abortError(): Error {
  return Object.assign(new Error('mpv launch aborted'), { name: 'AbortError' });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function tryConnect(deps: SpawnDeps, path: string): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const socket = deps.connect(path);
    socket.once('connect', () => {
      socket.off('error', reject);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

/**
 * Starts the mpv launcher with an unguessable IPC endpoint and connects to it.
 * The child is killed when the connection cannot be made, the child exits first, or the signal aborts.
 */
export async function spawnMpv(
  opts: SpawnMpvOptions,
  deps: SpawnDeps = realDeps,
): Promise<MpvProcess> {
  if (opts.signal?.aborted) throw abortError();
  const token = randomBytes(8).toString('hex');
  const endpoint =
    opts.platform === 'win32'
      ? `elv-mpv-${token}`
      : join(mkdtempSync(join(tmpdir(), 'elv-mpv-')), `${token}.sock`);
  const connectPath = opts.platform === 'win32' ? `\\\\.\\pipe\\${endpoint}` : endpoint;

  const child = deps.spawn(
    opts.executable,
    [...opts.args, ...transportArgs(opts.platform, endpoint, opts.parentPid)],
    { windowsHide: true, stdio: 'ignore' },
  );
  const pid = child.pid ?? 0;
  if (opts.pidFile) recordPid(opts.pidFile, pid);

  let exitInfo: { code: number | null; signal: string | null } | undefined;
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once('exit', (code: number | null, signal: string | null) => {
      exitInfo = { code, signal };
      if (opts.pidFile) forgetPid(opts.pidFile, pid);
      if (opts.platform !== 'win32') rmSync(dirname(endpoint), { recursive: true, force: true });
      resolve(exitInfo);
    });
  });
  child.once('error', () => child.kill());

  const deadline = Date.now() + (opts.connectTimeoutMs ?? 5000);
  const retryMs = deps.retryDelayMs ?? 25;
  let stream: Duplex | undefined;
  while (!stream) {
    if (opts.signal?.aborted) {
      child.kill();
      throw abortError();
    }
    if (exitInfo)
      throw new Error(`mpv exited with code ${exitInfo.code ?? 'null'} before its IPC was ready`);
    if (Date.now() > deadline) {
      child.kill();
      throw new Error('mpv IPC did not open in time');
    }
    try {
      stream = await tryConnect(deps, connectPath);
    } catch {
      await sleep(retryMs);
    }
  }

  const client = createMpvClient(stream, { replyTimeoutMs: 3000 });
  return {
    pid,
    client,
    exited,
    async quit(graceMs = 1000) {
      client.command(['quit']).catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), graceMs);
      });
      const late = await Promise.race([exited.then(() => false), timedOut]);
      clearTimeout(timer);
      if (late) {
        child.kill();
        await exited;
      }
      client.close();
    },
    kill() {
      child.kill();
      client.close();
    },
  };
}

function readPids(file: string): number[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((p): p is number => Number.isInteger(p)) : [];
  } catch {
    return [];
  }
}

/** Adds a launcher pid to the pid file (`<userData>/mpv-pids.json`). */
export function recordPid(file: string, pid: number): void {
  const pids = readPids(file);
  if (!pids.includes(pid)) pids.push(pid);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(pids));
}

/** Removes a pid after a clean exit; the file goes away with its last pid. */
export function forgetPid(file: string, pid: number): void {
  const rest = readPids(file).filter((p) => p !== pid);
  if (rest.length === 0) rmSync(file, { force: true });
  else writeFileSync(file, JSON.stringify(rest));
}

/** System checks used to sweep launchers left behind by a crashed app. */
export interface SweepDeps {
  isLauncher(pid: number): Promise<boolean>;
  kill(pid: number): void;
}

/** Kills recorded pids that still run the launcher (a reused pid is skipped), deletes the file, returns the kill count. */
export async function sweepLeftovers(file: string, deps: SweepDeps): Promise<number> {
  const pids = readPids(file);
  let killed = 0;
  for (const pid of pids) {
    if (await deps.isLauncher(pid)) {
      deps.kill(pid);
      killed += 1;
    }
  }
  rmSync(file, { force: true });
  return killed;
}

/** Real sweep checks: `tasklist` names the image of a Windows pid; other platforms never match. */
export const systemSweepDeps: SweepDeps = {
  isLauncher: (pid) =>
    process.platform !== 'win32'
      ? Promise.resolve(false)
      : new Promise((resolve) => {
          execFile(
            'tasklist',
            ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
            { windowsHide: true },
            (err, out) => resolve(!err && out.toLowerCase().includes('"elv-mpv.exe"')),
          );
        }),
  kill: (pid) => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  },
};
