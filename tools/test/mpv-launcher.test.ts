import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildLauncher, findVcvars, launcherBuildCommand } from '../src/mpv/launcher.ts';
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
