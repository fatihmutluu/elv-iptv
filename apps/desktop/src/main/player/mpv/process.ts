import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import type { MpvClient } from './client.ts';
import { createMpvClient } from './client.ts';
import { forgetPid, recordPid } from './pid-sweep.ts';
import { spawnDarwinMpv } from './process-darwin.ts';

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
  /** Asks mpv to quit, then escalates to SIGKILL after `graceMs` (default 1000) with bounded wait. */
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

const POST_KILL_WAIT_MS = 500;
const INITIAL_CONNECT_RETRY_MS = 10;
const ESCALATED_CONNECT_RETRY_MS = 25;
const FAST_CONNECT_RETRIES = 5;
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

function boundedWait(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
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
      socket.destroy?.();
      reject(err);
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Wraps a spawned child and IPC client with SIGKILL escalation and bounded post-kill wait. */
export function wrapProcess(
  pid: number,
  client: MpvClient,
  exited: Promise<{ code: number | null; signal: string | null }>,
  killChild: (signal?: NodeJS.Signals) => void,
  killWaitMs = POST_KILL_WAIT_MS,
): MpvProcess {
  return {
    pid,
    client,
    exited,
    async quit(graceMs = 1000) {
      client.command(['quit']).catch(() => undefined);
      const clean = await boundedWait(exited, graceMs);
      if (!clean) {
        killChild('SIGKILL');
        await boundedWait(exited, killWaitMs);
      }
      client.close();
    },
    kill() {
      killChild('SIGKILL');
      client.close();
    },
  };
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
  if (opts.platform === 'darwin') {
    return spawnDarwinMpv(opts, deps, {
      transportArgs,
      wrapProcess: (pid, client, exited, killChild) => wrapProcess(pid, client, exited, killChild),
      abortError,
      abortableSleep,
      boundedWait,
    });
  }

  const token = randomBytes(8).toString('hex');
  const tempDir = opts.platform === 'win32' ? undefined : mkdtempSync(join(tmpdir(), 'elv-mpv-'));
  const cleanTemp = (): void => {
    if (!tempDir) return;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  };
  const endpoint =
    opts.platform === 'win32' ? `elv-mpv-${token}` : join(tempDir ?? '', `${token}.sock`);
  const connectPath = opts.platform === 'win32' ? `\\\\.\\pipe\\${endpoint}` : endpoint;
  const spawnOptions =
    opts.platform === 'win32'
      ? ({ windowsHide: true, stdio: 'ignore' } as const)
      : ({
          windowsHide: true,
          stdio: 'ignore',
          env: { ...process.env, LC_NUMERIC: 'C' },
        } as const);

  let child: ReturnType<typeof deps.spawn>;
  try {
    child = deps.spawn(
      opts.executable,
      [...opts.args, ...transportArgs(opts.platform, endpoint, opts.parentPid)],
      spawnOptions,
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
      child.kill('SIGKILL');
      cleanTemp();
      resolve(exitInfo);
    });
  });

  const killAndClean = async (): Promise<void> => {
    child.kill('SIGKILL');
    await boundedWait(exited, 100);
    cleanTemp();
  };

  let stream: Duplex | undefined;
  let retryCount = 0;
  const deadline = performance.now() + (opts.connectTimeoutMs ?? 5000);
  while (!stream) {
    if (opts.signal?.aborted) {
      await killAndClean();
      throw abortError();
    }
    if (spawnError) throw new Error(`mpv could not start: ${spawnError.message}`);
    if (exitInfo) {
      throw new Error(`mpv exited with code ${exitInfo.code ?? 'null'} before its IPC was ready`);
    }
    if (performance.now() > deadline) {
      await killAndClean();
      throw new Error('mpv IPC did not open in time');
    }
    try {
      stream = await tryConnect(deps, connectPath, opts.signal);
    } catch {
      if (opts.signal?.aborted) {
        await killAndClean();
        throw abortError();
      }
      retryCount += 1;
      const retryMs =
        deps.retryDelayMs ??
        (retryCount <= FAST_CONNECT_RETRIES
          ? INITIAL_CONNECT_RETRY_MS
          : ESCALATED_CONNECT_RETRY_MS);
      await abortableSleep(retryMs, opts.signal);
    }
  }

  if (opts.signal?.aborted) {
    stream.destroy();
    await killAndClean();
    throw abortError();
  }

  const client = createMpvClient(stream, { replyTimeoutMs: 3000 });
  return wrapProcess(pid, client, exited, (sig) => child.kill(sig ?? 'SIGKILL'));
}
