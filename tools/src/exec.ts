import { spawn } from 'node:child_process';
import type { CheckOutcome } from './runner.ts';

const quote = (arg: string) =>
  /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
/** Joins a command and arguments into one shell line, quoting where needed. */
export const commandLine = (command: string, args: string[]) =>
  [command, ...args.map(quote)].join(' ');

/** Runs a command and captures its combined output; resolves ok when it exits with 0. */
export function exec(
  command: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string> },
): Promise<CheckOutcome> {
  return new Promise((resolve) => {
    const child = spawn(commandLine(command, args), {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      shell: true,
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (d: Buffer) => {
      output += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      output += d.toString();
    });
    child.on('error', (e) => resolve({ ok: false, output: `${command}: ${e.message}` }));
    child.on('close', (code) => resolve({ ok: code === 0, output }));
  });
}
