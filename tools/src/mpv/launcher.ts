import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';

/** Runs a program and returns its exit code and standard output; rejects when it cannot start. */
export type Exec = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; verbatim?: boolean },
) => Promise<{ code: number; stdout: string }>;

const MISSING =
  'mpv: Visual Studio Build Tools with the C++ x64 tools are required to build elv-mpv.exe (install the "Desktop development with C++" workload)';
const MACOS_MIN_VERSION = '13.0';

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

/** Finds Node's bundled `include/node` directory containing `node_api.h` next to the active Node binary. */
export function findNodeIncludeDir(
  execPath: string = process.execPath,
  fsOps: { realpathSync(path: string): string; existsSync(path: string): boolean } = {
    realpathSync,
    existsSync,
  },
): string {
  let resolved = execPath;
  try {
    resolved = fsOps.realpathSync(execPath);
  } catch {
    // Fall back to execPath as given when realpath fails (e.g. broken symlink).
  }
  const pathOps = resolved.startsWith('/') ? posix : { dirname, join, resolve };
  const includeDir = pathOps.resolve(pathOps.dirname(resolved), '../include/node');
  if (!fsOps.existsSync(pathOps.join(includeDir, 'node_api.h'))) {
    throw new Error(
      `mpv: Node N-API headers (node_api.h) not found at ${includeDir}; install Node with development headers to build elv-iosurface.node`,
    );
  }
  return includeDir;
}

/** The `clang` command that compiles `elv-mpv-macos.c` into the macOS `elv-mpv` host binary. */
export function macLauncherBuildCommand(p: {
  source: string;
  includeDir: string;
  outExe: string;
}): { command: 'clang'; args: string[] } {
  return {
    command: 'clang',
    args: [
      '-O2',
      `-mmacosx-version-min=${MACOS_MIN_VERSION}`,
      '-Wall',
      '-Wextra',
      '-Werror',
      '-I',
      p.includeDir,
      p.source,
      '-o',
      p.outExe,
      '-framework',
      'OpenGL',
      '-framework',
      'IOSurface',
      '-framework',
      'CoreFoundation',
    ],
  };
}

/** The `clang` command that compiles `elv-iosurface.c` into the ABI-stable N-API `.node` addon. */
export function macIoSurfaceAddonBuildCommand(p: {
  source: string;
  nodeIncludeDir: string;
  outNode: string;
}): { command: 'clang'; args: string[] } {
  return {
    command: 'clang',
    args: [
      '-O2',
      `-mmacosx-version-min=${MACOS_MIN_VERSION}`,
      '-Wall',
      '-Wextra',
      '-Werror',
      '-shared',
      '-undefined',
      'dynamic_lookup',
      '-I',
      p.nodeIncludeDir,
      p.source,
      '-o',
      p.outNode,
      '-framework',
      'IOSurface',
      '-framework',
      'CoreFoundation',
    ],
  };
}

/** The `clang` command that compiles `elv-macos-media.m` into the ABI-stable N-API `.node` addon (`#301`). */
function macMediaAddonBuildCommand(p: {
  source: string;
  nodeIncludeDir: string;
  outNode: string;
}): { command: 'clang'; args: string[] } {
  return {
    command: 'clang',
    args: [
      '-O2',
      `-mmacosx-version-min=${MACOS_MIN_VERSION}`,
      '-Wall',
      '-Wextra',
      '-Werror',
      '-fobjc-arc',
      '-shared',
      '-undefined',
      'dynamic_lookup',
      '-I',
      p.nodeIncludeDir,
      p.source,
      '-o',
      p.outNode,
      '-framework',
      'MediaPlayer',
      '-framework',
      'AppKit',
      '-framework',
      'Foundation',
    ],
  };
}

/**
 * Builds the macOS `elv-mpv` host inside `ELV IPTV Player.app/Contents/MacOS/elv-mpv`,
 * `elv-iosurface.node`, and optionally `elv-macos-media.node` in `runtimeDir`, then ad-hoc signs
 * each binary and re-signs the app bundle.
 */
export async function buildMacLauncher(
  p: {
    runtimeDir: string;
    launcherSource: string;
    addonSource: string;
    mediaAddonSource?: string;
    nodeIncludeDir?: string;
  },
  run: Exec = spawnExec,
): Promise<void> {
  const nodeIncludeDir = p.nodeIncludeDir ?? findNodeIncludeDir();
  const appBundle = `${p.runtimeDir}/ELV IPTV Player.app`;
  const appContents = `${appBundle}/Contents`;
  const includeDir = `${appContents}/Resources/include`;
  const outExe = `${appContents}/MacOS/elv-mpv`;
  const outNode = `${p.runtimeDir}/elv-iosurface.node`;
  const outMediaNode = `${p.runtimeDir}/elv-macos-media.node`;

  const steps: { label: string; command: string; args: string[] }[] = [
    {
      label: 'building elv-mpv',
      ...macLauncherBuildCommand({ source: p.launcherSource, includeDir, outExe }),
    },
    {
      label: 'building elv-iosurface.node',
      ...macIoSurfaceAddonBuildCommand({ source: p.addonSource, nodeIncludeDir, outNode }),
    },
    ...(p.mediaAddonSource !== undefined
      ? [
          {
            label: 'building elv-macos-media.node',
            ...macMediaAddonBuildCommand({
              source: p.mediaAddonSource,
              nodeIncludeDir,
              outNode: outMediaNode,
            }),
          },
        ]
      : []),
    {
      label: 'signing elv-mpv',
      command: 'codesign',
      args: ['--force', '--sign', '-', outExe],
    },
    {
      label: 'signing elv-iosurface.node',
      command: 'codesign',
      args: ['--force', '--sign', '-', outNode],
    },
    ...(p.mediaAddonSource !== undefined
      ? [
          {
            label: 'signing elv-macos-media.node',
            command: 'codesign',
            args: ['--force', '--sign', '-', outMediaNode],
          },
        ]
      : []),
    {
      label: 'signing ELV IPTV Player.app',
      command: 'codesign',
      args: ['--force', '--sign', '-', appBundle],
    },
  ];

  for (const step of steps) {
    let res: { code: number; stdout: string };
    try {
      res = await run(step.command, step.args);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`mpv: ${step.label} failed to start ${step.command}: ${detail}`);
    }
    if (res.code !== 0) {
      throw new Error(`mpv: ${step.label} failed (exit ${res.code})\n${res.stdout}`);
    }
  }
}
