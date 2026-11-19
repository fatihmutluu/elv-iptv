import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createSystemSweepDeps,
  forgetPid,
  recordPid,
  sweepLeftovers,
  systemSweepDeps,
} from './pid-sweep.ts';

describe('pid-sweep', () => {
  const temp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'elv-pid-'));
    return { dir, file: join(dir, 'mpv-pids.json') };
  };

  it('records unique pids and deletes the file when the last pid is forgotten', () => {
    const { dir, file } = temp();
    try {
      recordPid(file, 111);
      recordPid(file, 222);
      recordPid(file, 222);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([111, 222]);

      forgetPid(file, 111);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([222]);

      forgetPid(file, 222);
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never throws from recordPid, forgetPid or sweepLeftovers when sync FS I/O fails', async () => {
    const { dir } = temp();
    // Passing an existing directory path as `file` forces EISDIR on writeFileSync/rmSync(non-recursive)
    const dirAsFile = join(dir, 'occupied-as-dir');
    mkdirSync(dirAsFile);
    try {
      expect(() => recordPid(dirAsFile, 123)).not.toThrow();
      expect(() => forgetPid(dirAsFile, 123)).not.toThrow();
      await expect(
        sweepLeftovers(dirAsFile, { isLauncher: async () => false, kill: () => undefined }),
      ).resolves.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sweeps a recorded leftover launcher pid and ignores a reused pid', async () => {
    const { dir, file } = temp();
    try {
      recordPid(file, 111);
      recordPid(file, 222);
      const killed: number[] = [];
      const swept = await sweepLeftovers(file, {
        isLauncher: async (pid) => pid === 111,
        kill: (pid) => killed.push(pid),
      });
      expect(swept).toBe(1);
      expect(killed).toEqual([111]);
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats a missing or corrupt file as empty', async () => {
    const { dir, file } = temp();
    try {
      const deps = { isLauncher: async () => true, kill: vi.fn() };
      expect(await sweepLeftovers(file, deps)).toBe(0);
      writeFileSync(file, '{oops');
      expect(await sweepLeftovers(file, deps)).toBe(0);
      expect(deps.kill).not.toHaveBeenCalled();
      forgetPid(file, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('systemSweepDeps does not take this test process for the launcher', async () => {
    expect(await systemSweepDeps.isLauncher(process.pid)).toBe(false);
  });

  it('createSystemSweepDeps checks tasklist on win32 and ps comm= on darwin and linux', async () => {
    const winDeps = createSystemSweepDeps({
      platform: 'win32',
      execFile: (_cmd, _args, _opts, cb) => cb(null, '"elv-mpv.exe","4321","Console","1","12 K"'),
    });
    expect(await winDeps.isLauncher(4321)).toBe(true);
    expect(await winDeps.isLauncher(0)).toBe(false);

    const macDeps = createSystemSweepDeps({
      platform: 'darwin',
      execFile: (_cmd, args, _opts, cb) => {
        if (args[1] === '101') cb(null, '/Applications/ELV IPTV Player.app/Contents/MacOS/mpv\n');
        else if (args[1] === '102') cb(null, '/System/Library/CoreServices/Finder.app/Finder\n');
        else cb(new Error('ESRCH'), '');
      },
    });
    expect(await macDeps.isLauncher(101)).toBe(true);
    expect(await macDeps.isLauncher(102)).toBe(false);
    expect(await macDeps.isLauncher(103)).toBe(false);

    const linuxDeps = createSystemSweepDeps({
      platform: 'linux',
      execFile: (_cmd, args, _opts, cb) => {
        cb(null, args[1] === '201' ? 'elv-mpv\n' : 'node\n');
      },
    });
    expect(await linuxDeps.isLauncher(201)).toBe(true);
    expect(await linuxDeps.isLauncher(202)).toBe(false);
  });
});
