import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildLauncher,
  buildMacLauncher,
  findNodeIncludeDir,
  findVcvars,
  launcherBuildCommand,
  macIoSurfaceAddonBuildCommand,
  macLauncherBuildCommand,
} from '../src/mpv/launcher.ts';
import { hashLauncherSources } from '../src/mpv/real-deps.ts';

describe('launcherBuildCommand', () => {
  it('quotes paths with spaces', () => {
    const { command, args } = launcherBuildCommand({
      vcvars: 'C:\\Program Files\\VS\\vcvars64.bat',
      source: 'C:\\my repo\\elv-mpv.c',
      includeDir: 'C:\\my repo\\include',
      outExe: 'C:\\my repo\\out\\elv-mpv.exe',
    });
    expect(command).toBe('cmd.exe');
    const line = args.join(' ');
    expect(line).toContain('call "C:\\Program Files\\VS\\vcvars64.bat" && cl');
    expect(line).toContain('/I "C:\\my repo\\include"');
    expect(line).toContain('"C:\\my repo\\elv-mpv.c"');
    expect(line).toContain('/Fe:"C:\\my repo\\out\\elv-mpv.exe"');
    expect(line).toContain('/SUBSYSTEM:WINDOWS /ENTRY:wmainCRTStartup');
    expect(line).toContain('/W4 /WX');
  });
});

describe('findVcvars', () => {
  it('returns the vswhere result', async () => {
    const calls: string[][] = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return { code: 0, stdout: 'C:\\VS\\VC\\Auxiliary\\Build\\vcvars64.bat\r\n' };
    };
    await expect(findVcvars(run, { 'ProgramFiles(x86)': 'C:\\PF86' })).resolves.toBe(
      'C:\\VS\\VC\\Auxiliary\\Build\\vcvars64.bat',
    );
    expect(calls[0]?.[0]).toBe('C:\\PF86\\Microsoft Visual Studio\\Installer\\vswhere.exe');
    expect(calls[0]).toContain('Microsoft.VisualStudio.Component.VC.Tools.x86.x64');
  });

  it('fails clearly without Build Tools', async () => {
    const empty = async () => ({ code: 0, stdout: '\r\n' });
    await expect(findVcvars(empty, { 'ProgramFiles(x86)': 'C:\\PF86' })).rejects.toThrow(
      /Build Tools/,
    );
    const missing = async () => {
      throw new Error('ENOENT');
    };
    await expect(findVcvars(missing, { 'ProgramFiles(x86)': 'C:\\PF86' })).rejects.toThrow(
      /Build Tools/,
    );
  });
});

describe('buildLauncher', () => {
  const VCVARS = 'C:\\VS\\vcvars64.bat\r\n';
  const paths = { runtimeDir: 'C:\\rt', source: 'C:\\src\\elv-mpv.c' };

  it('runs the compiler in a throwaway directory and removes it afterwards', async () => {
    const seen: {
      cmd: string;
      cwd: string | undefined;
      existed: boolean;
      verbatim: boolean | undefined;
    }[] = [];
    const run = async (
      cmd: string,
      args: string[],
      opts?: { cwd?: string; verbatim?: boolean },
    ) => {
      if (cmd.endsWith('vswhere.exe')) return { code: 0, stdout: VCVARS };
      seen.push({
        cmd,
        cwd: opts?.cwd,
        existed: existsSync(opts?.cwd ?? ''),
        verbatim: opts?.verbatim,
      });
      expect(args.join(' ')).toContain('/Fe:"C:\\rt\\elv-mpv.exe"');
      return { code: 0, stdout: '' };
    };
    await buildLauncher(paths, run);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.cmd).toBe('cmd.exe');
    expect(seen[0]?.verbatim).toBe(true);
    expect(seen[0]?.existed).toBe(true);
    expect(existsSync(seen[0]?.cwd ?? '')).toBe(false);
  });

  it('fails with the exit code and the compiler output, still cleaning up', async () => {
    let cwd: string | undefined;
    const run = async (cmd: string, _args: string[], opts?: { cwd?: string }) => {
      if (cmd.endsWith('vswhere.exe')) return { code: 0, stdout: VCVARS };
      cwd = opts?.cwd;
      return { code: 2, stdout: 'elv-mpv.c(9): error C2065: undeclared identifier' };
    };
    await expect(buildLauncher(paths, run)).rejects.toThrow(/failed \(exit 2\)[\s\S]*C2065/);
    expect(existsSync(cwd ?? '')).toBe(false);
  });

  it('stops before compiling when Build Tools are missing', async () => {
    const run = async () => ({ code: 0, stdout: '' });
    await expect(buildLauncher(paths, run)).rejects.toThrow(/Build Tools/);
  });
});

describe('hashLauncherSources', () => {
  it('hashes all .c and .h files in sorted order and invalidates when a header changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elv-mpv-hash-'));
    try {
      writeFileSync(join(dir, 'elv-mpv.c'), 'int main(void) { return 0; }\n');
      writeFileSync(join(dir, 'elv-mpv-canvas.h'), '/* v1 */\n');
      writeFileSync(join(dir, 'README.txt'), 'ignored\n');
      const h1 = await hashLauncherSources(dir);

      writeFileSync(join(dir, 'README.txt'), 'still ignored\n');
      expect(await hashLauncherSources(dir)).toBe(h1);

      writeFileSync(join(dir, 'elv-mpv-canvas.h'), '/* v2 */\n');
      const h2 = await hashLauncherSources(dir);
      expect(h2).not.toBe(h1);

      writeFileSync(join(dir, 'elv-mpv.c'), 'int main(void) { return 1; }\n');
      const h3 = await hashLauncherSources(dir);
      expect(h3).not.toBe(h2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('findNodeIncludeDir', () => {
  it('resolves symlinked node execPath to sibling ../include/node containing node_api.h', () => {
    const dir = findNodeIncludeDir('/opt/homebrew/bin/node', {
      realpathSync: () => '/opt/homebrew/Cellar/node/24.0.0/bin/node',
      existsSync: (p) => p === '/opt/homebrew/Cellar/node/24.0.0/include/node/node_api.h',
    });
    expect(dir).toBe('/opt/homebrew/Cellar/node/24.0.0/include/node');
  });

  it('finds real include/node/node_api.h relative to execPath on disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'elv-node-inc-'));
    try {
      const binDir = join(root, 'bin');
      const incDir = join(root, 'include', 'node');
      mkdirSync(binDir, { recursive: true });
      mkdirSync(incDir, { recursive: true });
      const nodeBin = join(binDir, 'node');
      writeFileSync(nodeBin, '');
      writeFileSync(join(incDir, 'node_api.h'), '/* header */\n');
      expect(findNodeIncludeDir(nodeBin)).toBe(realpathSync(incDir));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws a clear error when node_api.h is missing', () => {
    expect(() =>
      findNodeIncludeDir('/usr/local/bin/node', {
        realpathSync: () => {
          throw new Error('ENOENT');
        },
        existsSync: () => false,
      }),
    ).toThrow(/node_api\.h/);
  });
});

describe('macLauncherBuildCommand', () => {
  it('builds a strict clang command with OpenGL, IOSurface and CoreFoundation frameworks', () => {
    const { command, args } = macLauncherBuildCommand({
      source: '/repo/apps/desktop/native/mpv-host/elv-mpv-macos.c',
      includeDir: '/rt/ELV IPTV Player.app/Contents/Resources/include',
      outExe: '/rt/ELV IPTV Player.app/Contents/MacOS/elv-mpv',
    });
    expect(command).toBe('clang');
    expect(args).toEqual([
      '-O2',
      '-mmacosx-version-min=13.0',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-I',
      '/rt/ELV IPTV Player.app/Contents/Resources/include',
      '/repo/apps/desktop/native/mpv-host/elv-mpv-macos.c',
      '-o',
      '/rt/ELV IPTV Player.app/Contents/MacOS/elv-mpv',
      '-framework',
      'OpenGL',
      '-framework',
      'IOSurface',
      '-framework',
      'CoreFoundation',
    ]);
  });
});

describe('macIoSurfaceAddonBuildCommand', () => {
  it('builds a strict clang N-API shared library command with dynamic_lookup', () => {
    const { command, args } = macIoSurfaceAddonBuildCommand({
      source: '/repo/apps/desktop/native/mpv-host/elv-iosurface.c',
      nodeIncludeDir: '/opt/node/include/node',
      outNode: '/rt/elv-iosurface.node',
    });
    expect(command).toBe('clang');
    expect(args).toEqual([
      '-O2',
      '-mmacosx-version-min=13.0',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-shared',
      '-undefined',
      'dynamic_lookup',
      '-I',
      '/opt/node/include/node',
      '/repo/apps/desktop/native/mpv-host/elv-iosurface.c',
      '-o',
      '/rt/elv-iosurface.node',
      '-framework',
      'IOSurface',
      '-framework',
      'CoreFoundation',
    ]);
  });
});

describe('buildMacLauncher', () => {
  const paths = {
    runtimeDir: '/rt/darwin-arm64',
    launcherSource: '/repo/apps/desktop/native/mpv-host/elv-mpv-macos.c',
    addonSource: '/repo/apps/desktop/native/mpv-host/elv-iosurface.c',
    nodeIncludeDir: '/opt/node/include/node',
  };

  it('compiles elv-mpv and elv-iosurface.node then ad-hoc signs both and re-signs the app bundle', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: '' };
    };
    await buildMacLauncher(paths, run);
    expect(calls).toHaveLength(5);
    expect(calls[0]?.cmd).toBe('clang');
    expect(calls[0]?.args).toContain('-mmacosx-version-min=13.0');
    expect(calls[0]?.args).toContain('/rt/darwin-arm64/ELV IPTV Player.app/Contents/MacOS/elv-mpv');
    expect(calls[0]?.args).toContain(
      '/rt/darwin-arm64/ELV IPTV Player.app/Contents/Resources/include',
    );
    expect(calls[1]?.cmd).toBe('clang');
    expect(calls[1]?.args).toContain('-mmacosx-version-min=13.0');
    expect(calls[1]?.args).toContain('/rt/darwin-arm64/elv-iosurface.node');
    expect(calls[1]?.args).toContain('/opt/node/include/node');
    expect(calls[2]).toEqual({
      cmd: 'codesign',
      args: [
        '--force',
        '--sign',
        '-',
        '/rt/darwin-arm64/ELV IPTV Player.app/Contents/MacOS/elv-mpv',
      ],
    });
    expect(calls[3]).toEqual({
      cmd: 'codesign',
      args: ['--force', '--sign', '-', '/rt/darwin-arm64/elv-iosurface.node'],
    });
    expect(calls[4]).toEqual({
      cmd: 'codesign',
      args: ['--force', '--sign', '-', '/rt/darwin-arm64/ELV IPTV Player.app'],
    });
  });

  it('surfaces compiler exit code and output when a build step fails', async () => {
    let step = 0;
    const run = async () => {
      step += 1;
      if (step === 2) return { code: 1, stdout: 'elv-iosurface.c:12: error: undeclared' };
      return { code: 0, stdout: '' };
    };
    await expect(buildMacLauncher(paths, run)).rejects.toThrow(
      /building elv-iosurface\.node failed \(exit 1\)[\s\S]*undeclared/,
    );
  });

  it('surfaces spawn failures cleanly', async () => {
    const run = async () => {
      throw new Error('spawn clang ENOENT');
    };
    await expect(buildMacLauncher(paths, run)).rejects.toThrow(
      /building elv-mpv failed to start clang: spawn clang ENOENT/,
    );
  });

  it('compiles and signs elv-macos-media.node when mediaAddonSource is provided (#301)', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: '' };
    };
    await buildMacLauncher(
      {
        ...paths,
        mediaAddonSource: '/repo/apps/desktop/native/mpv-host/elv-macos-media.m',
      },
      run,
    );
    expect(calls).toHaveLength(7);
    expect(calls[2]?.cmd).toBe('clang');
    expect(calls[2]?.args).toContain('-fobjc-arc');
    expect(calls[2]?.args).toContain('MediaPlayer');
    expect(calls[2]?.args).toContain('/rt/darwin-arm64/elv-macos-media.node');
    expect(calls[5]).toEqual({
      cmd: 'codesign',
      args: ['--force', '--sign', '-', '/rt/darwin-arm64/elv-macos-media.node'],
    });
  });
});
