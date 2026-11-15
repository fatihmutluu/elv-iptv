import { spawn } from 'node:child_process';
import type { CheckOutcome } from './runner.ts';

const KILL_TIMEOUT_MS = 2000;
const KILL_POLL_MS = 15;

function quote(arg: string, platform: string): string {
  if (platform === 'win32') {
    if (/^[A-Za-z0-9_@+=:,./-]+$/.test(arg)) return arg;
    const escaped = arg.replace(/"/g, '\\"');
    if (!escaped.includes('%')) return `"${escaped}"`;
    return escaped
      .split('%')
      .map((part) => (part === '' ? '' : `"${part}"`))
      .join('^%');
  }
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\$`])/g, '\\$1')}"`;
}

/** Joins a command and arguments into one shell line, quoting where needed and preventing `%` expansion on Windows. */
export const commandLine = (
  command: string,
  args: string[],
  platform: string = process.platform,
): string => [quote(command, platform), ...args.map((a) => quote(a, platform))].join(' ');

/** A finished process; `timedOut` is set when it was killed for exceeding `timeoutMs`. */
export interface ExecOutcome extends CheckOutcome {
  timedOut?: boolean;
}

/**
 * Whether a command gets its own process group: only a bounded one (`timeoutMs` set) off Windows, so a timeout can
 * kill the whole group while every other command stays in ours and receives the terminal's Ctrl+C.
 */
export const ownGroup = (platform: string, timeoutMs: number | undefined): boolean =>
  platform !== 'win32' && timeoutMs !== undefined;

type Forwarded = 'SIGINT' | 'SIGTERM';

/** The parts of `process` that signal forwarding uses; injected in tests. */
export interface SignalHost {
  pid: number;
  on(signal: Forwarded, listener: (signal: NodeJS.Signals) => void): unknown;
  off(signal: Forwarded, listener: (signal: NodeJS.Signals) => void): unknown;
  kill(pid: number, signal: NodeJS.Signals): unknown;
}

/** Live detached process groups (see {@link createGroupForwarder}). */
export interface GroupForwarder {
  add(pid: number): void;
  remove(pid: number): void;
}

/**
 * Tracks live detached process groups. While one is live, SIGINT and SIGTERM to this process (which a detached group
 * never receives from the terminal) are forwarded to every group; then the listeners are removed and the signal is
 * raised on this process again, so its default exit follows and an aborted run leaves no orphans (adb, Gradle).
 */
export function createGroupForwarder(host: SignalHost): GroupForwarder {
  const groups = new Set<number>();
  const forward = (signal: NodeJS.Signals): void => {
    for (const pid of groups) {
      try {
        host.kill(-pid, signal);
      } catch {
        // already gone
      }
    }
    groups.clear();
    unwatch();
    host.kill(host.pid, signal);
  };
  const unwatch = (): void => {
    host.off('SIGINT', forward);
    host.off('SIGTERM', forward);
  };
  return {
    add(pid) {
      if (groups.size === 0) {
        host.on('SIGINT', forward);
        host.on('SIGTERM', forward);
      }
      groups.add(pid);
    },
    remove(pid) {
      if (groups.delete(pid) && groups.size === 0) unwatch();
    },
  };
}

const liveGroups = createGroupForwarder(process);

/**
 * Sends `SIGKILL` to POSIX process group `-pid` and waits (bounded by `timeoutMs`) until
 * `kill(-pid, 0)` throws (`ESRCH`), ensuring all children and grandchildren have terminated and been reaped.
 */
export async function killPosixGroup(
  pid: number,
  host: { kill(pid: number, signal: NodeJS.Signals | 0): unknown } = process,
  timeoutMs: number = KILL_TIMEOUT_MS,
  pollMs: number = KILL_POLL_MS,
): Promise<void> {
  try {
    host.kill(-pid, 'SIGKILL');
  } catch {
    return;
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      host.kill(-pid, 0);
    } catch {
      return;
    }
    if (Date.now() >= deadline) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, pollMs);
      t.unref();
    });
  }
}

/** Kills a child and everything it started: `taskkill /T` on Windows (bounded by 2 s), its process group elsewhere. */
function killTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(cap);
        resolve();
      };
      const cap = setTimeout(finish, KILL_TIMEOUT_MS);
      cap.unref();
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', finish);
      killer.on('close', finish);
    });
  }
  return killPosixGroup(pid);
}

/**
 * Runs a command and captures its combined output; resolves ok when it exits with 0. With `timeoutMs` a command that
 * runs longer is killed together with its child processes and resolves not ok with `timedOut` set.
 */
export function exec(
  command: string,
  args: string[],
  opts: {
    cwd: string;
    env?: Record<string, string>;
    replaceEnv?: boolean;
    timeoutMs?: number;
  },
): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    const detached = ownGroup(process.platform, opts.timeoutMs);
    const baseEnv = opts.replaceEnv === true ? opts.env : { ...process.env, ...opts.env };
    const child = spawn(commandLine(command, args), {
      cwd: opts.cwd,
      env: { ...baseEnv, NO_COLOR: '1', FORCE_COLOR: '0' },
      shell: true,
      windowsHide: true,
      detached,
    });
    const pid = child.pid;
    if (detached && pid !== undefined) liveGroups.add(pid);
    let output = '';
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (outcome: ExecOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pid !== undefined) liveGroups.remove(pid);
      resolve(outcome);
    };
    if (opts.timeoutMs !== undefined) {
      const ms = opts.timeoutMs;
      timer = setTimeout(() => {
        timedOut = true;
        void killTree(pid).then(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          settle({
            ok: false,
            timedOut: true,
            output: `${output}\n${command}: timed out after ${Math.round(ms / 1000)} s`,
          });
        });
      }, ms);
    }
    child.stdout.on('data', (d: Buffer) => {
      output += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      output += d.toString();
    });
    child.on('error', (e) => {
      if (!timedOut) settle({ ok: false, output: `${command}: ${e.message}` });
    });
    child.on('close', (code) => {
      if (!timedOut) settle({ ok: code === 0, output });
    });
  });
}
