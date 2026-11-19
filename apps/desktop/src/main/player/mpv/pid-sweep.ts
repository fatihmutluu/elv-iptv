import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** System checks used to sweep launchers left behind by a crashed app. */
export interface SweepDeps {
  isLauncher(pid: number): Promise<boolean>;
  kill(pid: number): void;
}

type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { windowsHide?: boolean },
  callback: (err: Error | null, stdout: string) => void,
) => unknown;

function readPids(file: string): number[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed)
      ? parsed.filter((p): p is number => Number.isInteger(p) && p > 0)
      : [];
  } catch {
    return [];
  }
}

/** Adds a launcher pid to the pid file (`<userData>/mpv-pids.json`); FS errors are ignored. */
export function recordPid(file: string, pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    const pids = readPids(file);
    if (!pids.includes(pid)) pids.push(pid);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(pids));
  } catch {
    // never crash main if userData disappears or permissions fail
  }
}

/** Removes a pid after exit; the file goes away with its last pid. FS errors are ignored. */
export function forgetPid(file: string, pid: number): void {
  try {
    const rest = readPids(file).filter((p) => p !== pid);
    if (rest.length === 0) rmSync(file, { force: true });
    else writeFileSync(file, JSON.stringify(rest));
  } catch {
    // child exit callbacks must never throw in Electron main
  }
}

/** Kills recorded pids that still run the launcher (a reused pid is skipped), deletes the file, returns the kill count. */
export async function sweepLeftovers(file: string, deps: SweepDeps): Promise<number> {
  const pids = readPids(file);
  let killed = 0;
  for (const pid of pids) {
    if (await deps.isLauncher(pid)) {
      try {
        deps.kill(pid);
        killed += 1;
      } catch {
        // already exited
      }
    }
  }
  try {
    rmSync(file, { force: true });
  } catch {
    // ignore unwritable or directory path
  }
  return killed;
}

const realExecFile: ExecFileFn = (cmd, args, options, cb) =>
  execFile(cmd, [...args], options, (err, stdout) => cb(err, String(stdout)));

/** Builds platform sweep checks (`tasklist` on Windows, `ps -p <pid> -o comm=` on macOS/Linux). */
export function createSystemSweepDeps(
  opts: { platform?: NodeJS.Platform; execFile?: ExecFileFn; kill?: (pid: number) => void } = {},
): SweepDeps {
  const platform = opts.platform ?? process.platform;
  const runExec = opts.execFile ?? realExecFile;
  const runKill =
    opts.kill ??
    ((pid: number) => {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    });

  return {
    isLauncher(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(false);
      if (platform === 'win32') {
        return new Promise((resolve) => {
          runExec(
            'tasklist',
            ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
            { windowsHide: true },
            (err, out) => resolve(!err && out.toLowerCase().includes('"elv-mpv.exe"')),
          );
        });
      }
      if (platform === 'darwin' || platform === 'linux') {
        return new Promise((resolve) => {
          runExec('ps', ['-p', String(pid), '-o', 'comm='], {}, (err, out) => {
            if (err) {
              resolve(false);
              return;
            }
            const base = out.trim().split('/').at(-1)?.toLowerCase() ?? '';
            resolve(base === 'mpv' || base === 'elv-mpv');
          });
        });
      }
      return Promise.resolve(false);
    },
    kill: runKill,
  };
}

/** Real sweep checks for the current host platform. */
export const systemSweepDeps: SweepDeps = createSystemSweepDeps();
