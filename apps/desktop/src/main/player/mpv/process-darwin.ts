import type { spawn as nodeSpawn } from 'node:child_process';
import type { Duplex } from 'node:stream';
import { createMpvClient, type MpvClient } from './client.ts';
import { forgetPid, recordPid } from './pid-sweep.ts';

interface DarwinSpawnOptions {
  executable: string;
  args: readonly string[];
  platform: NodeJS.Platform;
  parentPid: number;
  connectTimeoutMs?: number;
  signal?: AbortSignal;
  pidFile?: string;
}

interface DarwinSpawnDeps {
  spawn: typeof nodeSpawn;
  retryDelayMs?: number;
  darwinWindowTimeoutMs?: number;
}

interface DarwinProcess {
  readonly pid: number;
  readonly client: MpvClient;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  quit(graceMs?: number): Promise<void>;
  kill(): void;
}

interface DarwinHelpers {
  transportArgs(platform: NodeJS.Platform, pipeName: string, parentPid: number): string[];
  wrapProcess(
    pid: number,
    client: MpvClient,
    exited: Promise<{ code: number | null; signal: string | null }>,
    killChild: (signal?: NodeJS.Signals) => void,
  ): DarwinProcess;
  abortError(): Error;
  abortableSleep(ms: number, signal?: AbortSignal): Promise<void>;
  boundedWait(promise: Promise<unknown>, timeoutMs: number): Promise<boolean>;
}

const POST_KILL_WAIT_MS = 500;

/** Spawns one macOS mpv attempt with `fd://3` IPC, `LC_NUMERIC=C` and safe PID tracking. */
function spawnDarwinOnce(
  opts: DarwinSpawnOptions,
  deps: DarwinSpawnDeps,
  transportArgs: DarwinHelpers['transportArgs'],
) {
  const child = deps.spawn(
    opts.executable,
    [...opts.args, ...transportArgs('darwin', '', opts.parentPid)],
    {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
      env: { ...process.env, LC_NUMERIC: 'C' },
    },
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
      if (opts.pidFile && pid) forgetPid(opts.pidFile, pid);
      (child.stdio?.[3] as Duplex | null | undefined)?.destroy();
      child.kill('SIGKILL');
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

/**
 * Spawns macOS mpv over `stdio[3]` (`--input-ipc-client=fd://3`), respawning if `cocoa-cb`
 * self-deadlocks at initial window creation (`osd-width=0` on macOS 26).
 */
export async function spawnDarwinMpv(
  opts: DarwinSpawnOptions,
  deps: DarwinSpawnDeps,
  helpers: DarwinHelpers,
): Promise<DarwinProcess> {
  const { transportArgs, wrapProcess, abortError, abortableSleep, boundedWait } = helpers;
  const needsWindowProbe = opts.args.includes('--force-window=immediate');
  const deadline = performance.now() + (opts.connectTimeoutMs ?? 5000);
  const windowBudgetMs = deps.darwinWindowTimeoutMs ?? 450;
  const retryMs = deps.retryDelayMs ?? 15;

  for (;;) {
    if (opts.signal?.aborted) throw abortError();
    const attempt = spawnDarwinOnce(opts, deps, transportArgs);
    if (!attempt.pid) {
      await boundedWait(attempt.exited, POST_KILL_WAIT_MS);
      throw new Error(`mpv could not start: ${attempt.getError()?.message ?? 'unknown'}`);
    }
    if (!attempt.fd3) {
      attempt.child.kill('SIGKILL');
      throw new Error('mpv IPC fd 3 did not open');
    }
    const client = createMpvClient(attempt.fd3, { replyTimeoutMs: 3000 });
    if (opts.signal?.aborted) {
      client.close();
      attempt.child.kill('SIGKILL');
      throw abortError();
    }
    if (!needsWindowProbe) {
      return wrapProcess(attempt.pid, client, attempt.exited, (sig) =>
        attempt.child.kill(sig ?? 'SIGKILL'),
      );
    }

    const attemptEnd = Math.min(deadline, performance.now() + windowBudgetMs);
    let ready = false;
    while (performance.now() < attemptEnd) {
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
      const waitMs = Math.max(1, attemptEnd - performance.now());
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
      return wrapProcess(attempt.pid, client, attempt.exited, (sig) =>
        attempt.child.kill(sig ?? 'SIGKILL'),
      );
    }
    client.close();
    attempt.child.kill('SIGKILL');
    await boundedWait(attempt.exited, POST_KILL_WAIT_MS);
    if (performance.now() >= deadline) {
      throw new Error('mpv window did not initialize in time');
    }
  }
}
