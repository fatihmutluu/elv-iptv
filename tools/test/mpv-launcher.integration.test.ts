import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const dir = join(import.meta.dirname, '../../apps/desktop/resources/mpv/win32-x64');
const exe = join(dir, 'elv-mpv.exe');
const enabled = process.platform === 'win32' && existsSync(exe);
const BASE = ['--no-config', '--idle=yes', '--vo=null', '--ao=null', '--terminal=no'];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const c of children.splice(0)) c.kill();
});

function start(extra: string[] = [], file = exe): { child: ChildProcess; pipe: string } {
  const pipe = `\\\\.\\pipe\\elv-test-${randomBytes(6).toString('hex')}`;
  const child = spawn(file, [...BASE, `--input-ipc-server=${pipe}`, ...extra], {
    stdio: 'ignore',
  });
  children.push(child);
  return { child, pipe };
}

async function ask(pipe: string, command: unknown[]): Promise<string> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      return await new Promise<string>((resolve, reject) => {
        const s = connect(pipe);
        let buf = '';
        s.on('error', reject);
        s.on('connect', () => s.write(`${JSON.stringify({ command })}\n`));
        s.on('data', (d) => {
          buf += d.toString();
          for (const line of buf.split('\n')) {
            if (line.includes('"error"')) {
              s.destroy();
              resolve(line);
              return;
            }
          }
        });
      });
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('pipe never answered');
}

const exited = (c: ChildProcess): Promise<number | null> =>
  new Promise((resolve) => {
    if (c.exitCode !== null) resolve(c.exitCode);
    else c.on('exit', (code) => resolve(code));
  });

describe.skipIf(!enabled)('elv-mpv.exe', () => {
  it('answers mpv-version 0.42.0 over its pipe', async () => {
    const { pipe } = start();
    const reply = JSON.parse(await ask(pipe, ['get_property', 'mpv-version']));
    expect(reply.data).toMatch(/^mpv v?0\.42\.0/);
  });

  it('enables default bindings and the OSC', async () => {
    const { pipe } = start();
    const bindings = JSON.parse(await ask(pipe, ['get_property', 'input-default-bindings']));
    const osc = JSON.parse(await ask(pipe, ['get_property', 'osc']));
    expect(bindings.data).toBe(true);
    expect(osc.data).toBe(true);
  });

  it('quits when its parent exits', async () => {
    const script = `
      const { spawn } = require('node:child_process');
      const c = spawn(${JSON.stringify(exe)}, ${JSON.stringify([...BASE, '--elv-parent-pid=PID'])}.map(a => a.replace('PID', process.pid)), { stdio: 'ignore', detached: true });
      console.log(c.pid);
      setTimeout(() => process.exit(0), 1500);
    `;
    const parent = spawn(process.execPath, ['-e', script], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const pid = await new Promise<number>((resolve) =>
      parent.stdout?.once('data', (d) => resolve(Number(String(d).trim()))),
    );
    await exited(parent);
    const t0 = Date.now();
    let alive = true;
    while (alive && Date.now() - t0 < 5000) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
  }, 15000);

  it('starts hardened without any caller flags and still runs the OSC', async () => {
    const pipe = `\\\\.\\pipe\\elv-test-${randomBytes(6).toString('hex')}`;
    const child = spawn(
      exe,
      ['--idle=yes', '--vo=null', '--ao=null', `--input-ipc-server=${pipe}`],
      { stdio: 'ignore' },
    );
    children.push(child);
    for (const [name, want] of [
      ['config', false],
      ['load-scripts', false],
      ['ytdl', false],
      ['load-unsafe-playlists', false],
    ] as const) {
      expect(JSON.parse(await ask(pipe, ['get_property', name])).data).toBe(want);
    }
    const osc = JSON.parse(await ask(pipe, ['get_property', 'user-data/osc']));
    expect(osc.data.visibility).toBe('auto');
  });

  it('lets the caller override a hardened default', async () => {
    const { pipe } = start(['--ytdl=yes']);
    expect(JSON.parse(await ask(pipe, ['get_property', 'ytdl'])).data).toBe(true);
  });

  it('rejects a parent pid that does not start with a digit with exit code 2', async () => {
    const { child } = start(['--elv-parent-pid=+5']);
    expect(await exited(child)).toBe(2);
  });

  it('exits 5 when the parent pid cannot be opened', async () => {
    const { child } = start(['--elv-parent-pid=4000000']);
    expect(await exited(child)).toBe(5);
  });

  it('rejects an unknown option with exit code 2', async () => {
    const { child } = start(['--no-such-option-elv=1']);
    expect(await exited(child)).toBe(2);
  });

  it('rejects an argument without dashes with exit code 2', async () => {
    const { child } = start(['plain']);
    expect(await exited(child)).toBe(2);
  });

  it('exits 3 without libmpv-2.dll', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'elv-mpv-'));
    try {
      const lone = join(tmp, 'elv-mpv.exe');
      copyFileSync(exe, lone);
      expect(spawnSync(lone, [], { timeout: 5000 }).status).toBe(3);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
