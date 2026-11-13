import { spawn } from 'node:child_process';
import type { CheckOutcome } from './runner.ts';

const quote = (arg: string) =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
/** Joins a command and arguments into one shell line, quoting where needed. */
export const commandLine = (command: string, args: string[]) =>
  [command, ...args.map(quote)].join(' ');

/** A finished process; `timedOut` is set when it was killed for exceeding `timeoutMs`. */
export interface ExecOutcome extends CheckOutcome {
  timedOut?: boolean;
}

/** Kills a child and everything it started: `taskkill /T` on Windows, the process group elsewhere (see `detached`). */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/**
 * Runs a command and captures its combined output; resolves ok when it exits with 0. With `timeoutMs` a command that
 * runs longer is killed together with its child processes and resolves not ok with `timedOut` set.
 */
export function exec(
  command: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string>; timeoutMs?: number },
): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    const child = spawn(commandLine(command, args), {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    let output = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeoutMs !== undefined) {
      const ms = opts.timeoutMs;
      timer = setTimeout(() => {
        killTree(child.pid);
        child.stdout.destroy();
        child.stderr.destroy();
        resolve({
          ok: false,
          timedOut: true,
          output: `${output}\n${command}: timed out after ${Math.round(ms / 1000)} s`,
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
      clearTimeout(timer);
      resolve({ ok: false, output: `${command}: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output });
    });
  });
}
