import { describe, expect, it } from 'vitest';
import { findVcvars, launcherBuildCommand } from '../src/mpv/launcher.ts';

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
