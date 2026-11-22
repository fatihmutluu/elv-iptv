import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const dir = join(import.meta.dirname, '../../apps/desktop/resources/mpv/win32-x64');
const exe = join(dir, 'elv-mpv.exe');
const enabled = process.platform === 'win32' && existsSync(exe);
const BASE = ['--no-config', '--idle=yes', '--vo=null', '--ao=null', '--terminal=no'];
const children: ChildProcess[] = [];
const servers: Server[] = [];

afterEach(() => {
  for (const c of children.splice(0)) c.kill();
  for (const s of servers.splice(0)) s.close();
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

interface CanvasSurface {
  gen: number;
  slot: number;
  handle: bigint;
  width: number;
  height: number;
}
interface CanvasFrame {
  gen: number;
  slot: number;
  width: number;
  height: number;
}

async function openCanvasHarness(opts: { ackSurface?: boolean; ackFrame?: boolean } = {}): Promise<{
  canvasPipe: string;
  ipcPipe: string;
  surfaces: CanvasSurface[];
  frames: CanvasFrame[];
  connected: Promise<Socket>;
  waitFor: (predicate: () => boolean, timeoutMs?: number) => Promise<void>;
  spawnHost: (extra?: string[]) => ChildProcess;
}> {
  const canvasPipe = `\\\\.\\pipe\\elv-test-canvas-${randomBytes(6).toString('hex')}`;
  const ipcPipe = `\\\\.\\pipe\\elv-test-ipc-${randomBytes(6).toString('hex')}`;
  const surfaces: CanvasSurface[] = [];
  const frames: CanvasFrame[] = [];
  const waiters: Array<() => void> = [];
  let onConnected!: (socket: Socket) => void;
  const connected = new Promise<Socket>((resolve) => {
    onConnected = resolve;
  });
  const notify = (): void => {
    for (const fn of waiters.splice(0)) fn();
  };
  const waitFor = (predicate: () => boolean, timeoutMs = 8000): Promise<void> => {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`canvas wait timed out (S=${surfaces.length}, F=${frames.length})`)),
        timeoutMs,
      );
      const check = (): void => {
        if (predicate()) {
          clearTimeout(timer);
          resolve();
        } else {
          waiters.push(check);
        }
      };
      waiters.push(check);
    });
  };
  const server = createServer((socket) => {
    onConnected(socket);
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const parts = buf.slice(0, nl).trim().split(' ');
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        if (parts[0] === 'S' && parts.length === 6) {
          const gen = Number(parts[1]);
          const slot = Number(parts[2]);
          surfaces.push({
            gen,
            slot,
            handle: BigInt(parts[3] as string),
            width: Number(parts[4]),
            height: Number(parts[5]),
          });
          if (opts.ackSurface !== false) socket.write(`I ${gen} ${slot}\n`);
          notify();
        } else if (parts[0] === 'F' && parts.length === 5) {
          const gen = Number(parts[1]);
          const slot = Number(parts[2]);
          frames.push({ gen, slot, width: Number(parts[3]), height: Number(parts[4]) });
          if (opts.ackFrame !== false) socket.write(`A ${gen} ${slot}\n`);
          notify();
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(canvasPipe, () => resolve());
  });
  const spawnHost = (extra: string[] = []): ChildProcess => {
    const child = spawn(
      exe,
      [
        '--no-config',
        '--idle=yes',
        '--ao=null',
        '--terminal=no',
        `--input-ipc-server=${ipcPipe}`,
        `--elv-parent-pid=${process.pid}`,
        `--elv-canvas-pipe=${canvasPipe}`,
        ...extra,
      ],
      { stdio: 'ignore' },
    );
    children.push(child);
    return child;
  };
  return { canvasPipe, ipcPipe, surfaces, frames, connected, waitFor, spawnHost };
}

describe.skipIf(!enabled)('elv-mpv.exe', () => {
  it('answers mpv-version 0.42.0 over its pipe', async () => {
    const { pipe } = start();
    const reply = JSON.parse(await ask(pipe, ['get_property', 'mpv-version']));
    expect(reply.data).toMatch(/^mpv v?0\.42\.0/);
  });

  it('disables default bindings, VO keyboard, OSC and OSD by default (#419)', async () => {
    const { pipe } = start();
    const bindings = JSON.parse(await ask(pipe, ['get_property', 'input-default-bindings']));
    const voKeyboard = JSON.parse(await ask(pipe, ['get_property', 'input-vo-keyboard']));
    const osc = JSON.parse(await ask(pipe, ['get_property', 'osc']));
    const osdLevel = JSON.parse(await ask(pipe, ['get_property', 'osd-level']));
    expect(bindings.data).toBe(false);
    expect(voKeyboard.data).toBe(false);
    expect(osc.data).toBe(false);
    expect(osdLevel.data).toBe(0);
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

  it('starts hardened without any caller flags and keeps the OSC disabled (#419)', async () => {
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
      ['input-default-bindings', false],
      ['input-vo-keyboard', false],
      ['osc', false],
      ['osd-level', 0],
    ] as const) {
      expect(JSON.parse(await ask(pipe, ['get_property', name])).data).toBe(want);
    }
    const osc = JSON.parse(await ask(pipe, ['get_property', 'user-data/osc']));
    expect(osc.error).not.toBe('success');
    expect(osc.data).toBeUndefined();
  });

  it('is per-monitor DPI aware, so --geometry and --wid sizes are physical pixels', async () => {
    const { child, pipe } = start();
    await ask(pipe, ['get_property', 'mpv-version']);
    const script =
      'Add-Type -Namespace Elv -Name Dpi -MemberDefinition \'[DllImport("shcore.dll")] public static extern int GetProcessDpiAwareness(System.IntPtr h, out int v);\';' +
      ` $v = -1; [void][Elv.Dpi]::GetProcessDpiAwareness([System.Diagnostics.Process]::GetProcessById(${child.pid}).Handle, [ref]$v); $v`;
    const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 15000,
    });
    // PROCESS_PER_MONITOR_DPI_AWARE; Per-Monitor V2 reports the same value here.
    expect(out.stdout.trim()).toBe('2');
  }, 20000);

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

  it('rejects a malformed --elv-canvas-pipe argument with exit code 2', async () => {
    for (const bad of [
      '--elv-canvas-pipe=',
      '--elv-canvas-pipe=not-a-pipe',
      '--elv-canvas-pipe=\\\\.\\pipe\\',
    ]) {
      const { child } = start([`--elv-parent-pid=${process.pid}`, bad]);
      expect(await exited(child)).toBe(2);
    }
  });

  it('exits 5 when --elv-canvas-pipe is passed without --elv-parent-pid', async () => {
    const pipe = `\\\\.\\pipe\\elv-test-nopid-${randomBytes(6).toString('hex')}`;
    const { child } = start([`--elv-canvas-pipe=${pipe}`]);
    expect(await exited(child)).toBe(5);
  });

  it('renders D3D11 shared textures over --elv-canvas-pipe, handles R/A/I, and exits 0 on quit', async () => {
    const h = await openCanvasHarness();
    const child = h.spawnHost([
      '--vo=libmpv',
      '--force-window=no',
      '--video-timing-offset=0',
      '--keep-open=yes',
    ]);

    await h.waitFor(() => h.surfaces.filter((s) => s.gen === 1).length === 3);
    const gen1 = h.surfaces.filter((s) => s.gen === 1);
    expect(gen1.map((s) => s.slot).sort()).toEqual([0, 1, 2]);
    for (const s of gen1) {
      expect(s.handle).toBeGreaterThan(0n);
      expect(s.width).toBe(1280);
      expect(s.height).toBe(720);
    }

    const loadReply = JSON.parse(
      await ask(h.ipcPipe, ['loadfile', 'av://lavfi:color=c=magenta:s=64x64:d=2']),
    );
    expect(loadReply.error).toBe('success');
    await h.waitFor(() => h.frames.some((f) => f.gen === 1));
    const firstFrame = h.frames.find((f) => f.gen === 1);
    expect(firstFrame?.width).toBe(1280);
    expect(firstFrame?.height).toBe(720);
    expect([0, 1, 2]).toContain(firstFrame?.slot);

    const sock = await h.connected;
    sock.write('R 320 180\n');
    await h.waitFor(() => h.surfaces.filter((s) => s.gen === 2).length === 3);
    const gen2 = h.surfaces.filter((s) => s.gen === 2);
    expect(gen2.map((s) => s.slot).sort()).toEqual([0, 1, 2]);
    for (const s of gen2) {
      expect(s.handle).toBeGreaterThan(0n);
      expect(s.width).toBe(320);
      expect(s.height).toBe(180);
    }
    await h.waitFor(() => h.frames.some((f) => f.gen === 2 && f.width === 320 && f.height === 180));

    await ask(h.ipcPipe, ['quit']);
    expect(await exited(child)).toBe(0);
  }, 20000);

  it('exits 0 cleanly when the canvas pipe closes (EOF)', async () => {
    const h = await openCanvasHarness({ ackSurface: false });
    const child = h.spawnHost();
    const sock = await h.connected;
    await h.waitFor(() => h.surfaces.length >= 3);
    sock.destroy();
    expect(await exited(child)).toBe(0);
  }, 15000);

  it('closes duplicated parent NT handles on I acks across repeated resizes (no handle leak)', async () => {
    const handleCount = (): number => {
      const out = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${process.pid}).HandleCount`,
        ],
        { encoding: 'utf8', timeout: 10000 },
      );
      return Number(out.stdout.trim());
    };
    const h = await openCanvasHarness();
    const child = h.spawnHost();
    const sock = await h.connected;
    await h.waitFor(() => h.surfaces.filter((s) => s.gen === 1).length === 3);

    const before = handleCount();
    for (let i = 0; i < 20; i++) {
      const w = 160 + (i % 2) * 32;
      const height = 90 + (i % 2) * 18;
      sock.write(`R ${w} ${height}\n`);
      const targetGen = i + 2;
      await h.waitFor(() => h.surfaces.filter((s) => s.gen === targetGen).length === 3);
    }
    await ask(h.ipcPipe, ['quit']);
    expect(await exited(child)).toBe(0);
    expect(handleCount() - before).toBeLessThan(20);
  }, 25000);
});
