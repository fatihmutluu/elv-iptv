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
  /** Per-attempt budget (ms) for macOS `cocoa-cb` to render its initial window (`osd-width > 0`). */
  darwinWindowTimeoutMs?: number;
}

const realDeps: SpawnDeps = { spawn, connect: (path) => connect(path) };

/** The launcher arguments that open the IPC endpoint (and, on Windows, bind the launcher to its parent). */
export function transportArgs(
  platform: NodeJS.Platform,
  pipeName: string,
  parentPid: number,
): string[] {
  if (platform === 'win32') {
    return [`--input-ipc-server=\\\\.\\pipe\\${pipeName}`, `--elv-parent-pid=${parentPid}`];
  }
  if (platform === 'darwin') {
    return ['--input-ipc-client=fd://3'];
  }
  return [`--input-ipc-server=${pipeName}`];
}

function abortError(): Error {
  return Object.assign(new Error('mpv launch aborted'), { name: 'AbortError' });
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function tryConnect(deps: SpawnDeps, path: string, signal?: AbortSignal): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const socket = deps.connect(path);
    const onAbort = (): void => {
      socket.off('connect', onConnect);
      socket.off('error', onError);
      socket.once('error', () => undefined);
      socket.destroy?.();
      reject(abortError());
    };
    const onConnect = (): void => {
      signal?.removeEventListener('abort', onAbort);
      socket.off('error', onError);
      resolve(socket);
    };
    const onError = (err: Error): void => {
      signal?.removeEventListener('abort', onAbort);
      socket.off('connect', onConnect);
      reject(err);
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function wrapProcess(
  pid: number,
  client: MpvClient,
  exited: Promise<{ code: number | null; signal: string | null }>,
  killChild: (signal?: NodeJS.Signals) => void,
): MpvProcess {
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
        killChild();
        await exited;
      }
      client.close();
    },
    kill() {
      killChild();
      client.close();
    },
  };
}

function spawnDarwinOnce(opts: SpawnMpvOptions, deps: SpawnDeps) {
  const child = deps.spawn(
    opts.executable,
    [...opts.args, ...transportArgs('darwin', '', opts.parentPid)],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe'] },
  );
  const pid = child.pid ?? 0;
  if (opts.pidFile && pid) recordPid(opts.pidFile, pid);
  let exitInfo: { code: number | null; signal: string | null } | undefined;
  let spawnError: Error | undefined;
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once('exit', (code: number | null, signal: string | null) => {
      exitInfo = { code, signal };
      if (opts.pidFile && pid) forgetPid(opts.pidFile, pid);
      resolve(exitInfo);
    });
    child.once('error', (error: Error) => {
      spawnError = error;
      exitInfo ??= { code: null, signal: null };
      (child.stdio?.[3] as Duplex | null | undefined)?.destroy();
      child.kill();
      resolve(exitInfo);
    });
  });
  return {
    child,
    pid,
    exited,
    fd3: child.stdio?.[3] as Duplex | null | undefined,
    getExit: () => exitInfo,
    getError: () => spawnError,
  };
}

async function spawnDarwinMpv(opts: SpawnMpvOptions, deps: SpawnDeps): Promise<MpvProcess> {
  const needsWindowProbe = opts.args.includes('--force-window=immediate');
  const deadline = Date.now() + (opts.connectTimeoutMs ?? 5000);
  const windowBudgetMs = deps.darwinWindowTimeoutMs ?? 450;
  const retryMs = deps.retryDelayMs ?? 15;

  for (;;) {
    if (opts.signal?.aborted) throw abortError();
    const attempt = spawnDarwinOnce(opts, deps);
    if (!attempt.pid) {
      await attempt.exited;
      throw new Error(`mpv could not start: ${attempt.getError()?.message ?? 'unknown'}`);
    }
    if (!attempt.fd3) {
      attempt.child.kill();
      throw new Error('mpv IPC fd 3 did not open');
    }
    const client = createMpvClient(attempt.fd3, { replyTimeoutMs: 3000 });
    if (opts.signal?.aborted) {
      client.close();
      attempt.child.kill('SIGKILL');
      throw abortError();
    }
    if (!needsWindowProbe) {
      return wrapProcess(attempt.pid, client, attempt.exited, (sig) => attempt.child.kill(sig));
    }

    // On macOS 26, cocoa-cb's GLLayer.display() occasionally self-deadlocks inside CA::Transaction::commit()
    // at initial window creation (leaving osd-width at 0); respawn before handing the process to the engine.
    const attemptEnd = Math.min(deadline, Date.now() + windowBudgetMs);
    let ready = false;
    while (Date.now() < attemptEnd) {
      if (opts.signal?.aborted) {
        client.close();
        attempt.child.kill('SIGKILL');
        throw abortError();
      }
      const earlyExit = attempt.getExit();
      if (earlyExit) {
        client.close();
        throw new Error(
          `mpv exited with code ${earlyExit.code ?? 'null'} before its IPC was ready`,
        );
      }
      const waitMs = Math.max(1, attemptEnd - Date.now());
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const reply = await Promise.race([
        client.command(['get_property', 'osd-width']).catch(() => undefined),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), waitMs);
        }),
        new Promise<undefined>((resolve) => {
          onAbort = () => resolve(undefined);
          opts.signal?.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
      clearTimeout(timer);
      if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) {
        client.close();
        attempt.child.kill('SIGKILL');
        throw abortError();
      }
      if (reply?.error === 'success' && typeof reply.data === 'number' && reply.data > 0) {
        ready = true;
        break;
      }
      await abortableSleep(retryMs, opts.signal);
    }

    if (opts.signal?.aborted) {
      client.close();
      attempt.child.kill('SIGKILL');
      throw abortError();
    }
    if (ready) {
      return wrapProcess(attempt.pid, client, attempt.exited, (sig) => attempt.child.kill(sig));
    }
    client.close();
    attempt.child.kill('SIGKILL');
    await attempt.exited;
    if (Date.now() >= deadline) {
      throw new Error('mpv window did not initialize in time');
    }
  }
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
  if (opts.platform === 'darwin') return spawnDarwinMpv(opts, deps);

  const token = randomBytes(8).toString('hex');
  const tempDir = opts.platform === 'win32' ? undefined : mkdtempSync(join(tmpdir(), 'elv-mpv-'));
  const cleanTemp = (): void => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  };
  const endpoint =
    opts.platform === 'win32' ? `elv-mpv-${token}` : join(tempDir ?? '', `${token}.sock`);
  const connectPath = opts.platform === 'win32' ? `\\\\.\\pipe\\${endpoint}` : endpoint;

  let child: ReturnType<typeof deps.spawn>;
  try {
    child = deps.spawn(
      opts.executable,
      [...opts.args, ...transportArgs(opts.platform, endpoint, opts.parentPid)],
      { windowsHide: true, stdio: 'ignore' },
    );
  } catch (error) {
    cleanTemp();
    throw error;
  }
  const pid = child.pid ?? 0;
  if (opts.pidFile && pid) recordPid(opts.pidFile, pid);

  let exitInfo: { code: number | null; signal: string | null } | undefined;
  let spawnError: Error | undefined;
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once('exit', (code: number | null, signal: string | null) => {
      exitInfo = { code, signal };
      if (opts.pidFile && pid) forgetPid(opts.pidFile, pid);
      cleanTemp();
      resolve(exitInfo);
    });
    child.once('error', (error: Error) => {
      spawnError = error;
      exitInfo ??= { code: null, signal: null };
      if (opts.pidFile && pid) forgetPid(opts.pidFile, pid);
      cleanTemp();
      child.kill();
      resolve(exitInfo);
    });
  });

  let stream: Duplex | undefined;
  const deadline = Date.now() + (opts.connectTimeoutMs ?? 5000);
  const retryMs = deps.retryDelayMs ?? 25;
  while (!stream) {
    if (opts.signal?.aborted) {
      child.kill();
      cleanTemp();
      throw abortError();
    }
    if (spawnError) throw new Error(`mpv could not start: ${spawnError.message}`);
    if (exitInfo)
      throw new Error(`mpv exited with code ${exitInfo.code ?? 'null'} before its IPC was ready`);
    if (Date.now() > deadline) {
      child.kill();
      cleanTemp();
      throw new Error('mpv IPC did not open in time');
    }
    try {
      stream = await tryConnect(deps, connectPath, opts.signal);
    } catch {
      if (opts.signal?.aborted) {
        child.kill();
        cleanTemp();
        throw abortError();
      }
      await abortableSleep(retryMs, opts.signal);
    }
  }

  if (opts.signal?.aborted) {
    stream.destroy();
    child.kill();
    cleanTemp();
    throw abortError();
  }

  const client = createMpvClient(stream, { replyTimeoutMs: 3000 });
  return wrapProcess(pid, client, exited, (sig) => child.kill(sig));
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
