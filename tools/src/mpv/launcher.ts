import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Runs a program and returns its exit code and standard output; rejects when it cannot start. */
export type Exec = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; verbatim?: boolean },
) => Promise<{ code: number; stdout: string }>;

const MISSING =
  'mpv: Visual Studio Build Tools with the C++ x64 tools are required to build elv-mpv.exe (install the "Desktop development with C++" workload)';

/** Finds `vcvars64.bat` of the newest Visual Studio install that has the C++ x64 tools. */
export async function findVcvars(
  run: Exec,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const base = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const vswhere = `${base}\\Microsoft Visual Studio\\Installer\\vswhere.exe`;
  let stdout = '';
  try {
    ({ stdout } = await run(vswhere, [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-find',
      'VC\\Auxiliary\\Build\\vcvars64.bat',
    ]));
  } catch {
    throw new Error(MISSING);
  }
  const found = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '');
  if (found === undefined) throw new Error(MISSING);
  return found;
}

/** The `cmd.exe` call that loads the MSVC environment and compiles the launcher as a GUI-subsystem wmain program. */
export function launcherBuildCommand(p: {
  vcvars: string;
  source: string;
  includeDir: string;
  outExe: string;
}): { command: 'cmd.exe'; args: string[] } {
  const line =
    `call "${p.vcvars}" && cl /nologo /O2 /W4 /WX /utf-8 /I "${p.includeDir}" "${p.source}" ` +
    `/Fe:"${p.outExe}" /link /SUBSYSTEM:WINDOWS /ENTRY:wmainCRTStartup`;
  return { command: 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`] };
}

/** Real process runner: collects stdout, forwards stderr, honours verbatim Windows arguments. */
const spawnExec: Exec = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts?.cwd,
      windowsVerbatimArguments: opts?.verbatim,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stdout += String(d);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
  });

/**
 * Builds `elv-mpv.exe` into the runtime directory against the `include/mpv/client.h` shipped there.
 * The object file goes to a throwaway directory; the compiler output is shown only when the build fails.
 */
export async function buildLauncher(
  p: { runtimeDir: string; source: string },
  run: Exec = spawnExec,
): Promise<void> {
  const vcvars = await findVcvars(run);
  const { command, args } = launcherBuildCommand({
    vcvars,
    source: p.source,
    includeDir: `${p.runtimeDir}\\include`,
    outExe: `${p.runtimeDir}\\elv-mpv.exe`,
  });
  const work = await mkdtemp(join(tmpdir(), 'elv-mpv-build-'));
  try {
    const { code, stdout } = await run(command, args, { cwd: work, verbatim: true });
    if (code !== 0) throw new Error(`mpv: building elv-mpv.exe failed (exit ${code})\n${stdout}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
