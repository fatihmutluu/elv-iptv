import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex, EventEmitter } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpawnDeps } from './process.ts';
import {
  forgetPid,
  recordPid,
  spawnMpv,
  sweepLeftovers,
  systemSweepDeps,
  transportArgs,
} from './process.ts';

class FakeChild extends EventEmitter {
  pid = 4321;
  killed = false;
  stdio: Array<Duplex | null> = [null, null, null];
  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit('exit', null, 'SIGKILL'));
    return true;
  }
  exit(code: number): void {
    this.emit('exit', code, null);
  }
}

function fakeSocket(): Duplex & { written: string[] } {
  const written: string[] = [];
  const s = new Duplex({
    read() {},
    write(chunk: Buffer, _e, cb) {
      written.push(chunk.toString());
      cb();
    },
  });
  return Object.assign(s, { written });
}

function harness(connectFailures = 0) {
  const child = new FakeChild();
  const spawnCalls: Array<{ cmd: string; args: string[]; options: Record<string, unknown> }> = [];
  const connectPaths: string[] = [];
  const socket = fakeSocket();
  let failures = connectFailures;
  const deps: SpawnDeps = {
    spawn: ((cmd: string, args: string[], options: Record<string, unknown>) => {
      spawnCalls.push({ cmd, args, options });
      if (Array.isArray(options['stdio']) && options['stdio'][3] === 'pipe') {
        child.stdio = [null, null, null, socket];
      }
      return child;
    }) as unknown as SpawnDeps['spawn'],
    connect: ((path: string) => {
      connectPaths.push(path);
      const attempt = new EventEmitter() as EventEmitter & Duplex;
      setImmediate(() => {
        if (failures-- > 0) attempt.emit('error', new Error('ENOENT'));
        else attempt.emit('connect');
      });
      return Object.assign(socket, {
        once: attempt.once.bind(attempt),
        on: Duplex.prototype.on.bind(socket),
        off: attempt.off.bind(attempt),
      });
    }) as unknown as SpawnDeps['connect'],
    retryDelayMs: 1,
  };
  return { child, deps, spawnCalls, connectPaths, socket };
}

afterEach(() => vi.useRealTimers());

describe('transportArgs', () => {
  it('for win32 has the pipe and parent pid and no url', () => {
    const args = transportArgs('win32', 'elv-mpv-abc', 77);
    expect(args).toEqual(['--input-ipc-server=\\\\.\\pipe\\elv-mpv-abc', '--elv-parent-pid=77']);
    expect(args.join(' ')).not.toMatch(/https?:/);
  });

  it('transportArgs for darwin uses fd://3', () => {
    expect(transportArgs('darwin', 'elv-mpv-abc', 77)).toEqual(['--input-ipc-client=fd://3']);
  });

  it('for linux has only the socket path', () => {
    expect(transportArgs('linux', '/tmp/x/mpv.sock', 77)).toEqual([
      '--input-ipc-server=/tmp/x/mpv.sock',
    ]);
  });
});

describe('spawnMpv', () => {
  const base = {
    executable: 'elv-mpv.exe',
    args: ['--idle=yes'],
    platform: 'win32' as const,
    parentPid: 99,
  };

  it('spawns hidden with ignored stdio, a random pipe, and retries the connection', async () => {
    const h = harness(2);
    const proc = await spawnMpv(base, h.deps);
    expect(proc.pid).toBe(4321);
    expect(h.connectPaths).toHaveLength(3);
    const call = h.spawnCalls[0];
    if (!call) throw new Error('spawn was not called');
    expect(call.options).toMatchObject({ windowsHide: true, stdio: 'ignore' });
    expect(call.args).toContain('--idle=yes');
    expect(call.args).toContain('--elv-parent-pid=99');
    expect(call.args.find((a) => a.startsWith('--input-ipc-server='))).toMatch(
      /^--input-ipc-server=\\\\\.\\pipe\\elv-mpv-[0-9a-f]{16}$/,
    );
    expect(h.connectPaths[0]).toMatch(/^\\\\\.\\pipe\\elv-mpv-[0-9a-f]{16}$/);
  });

  it('darwin spawn passes fd 3 and no pipe', async () => {
    const h = harness();
    const proc = await spawnMpv(
      {
        executable: '/Applications/ELV IPTV Player.app/Contents/MacOS/mpv',
        args: ['--idle=yes'],
        platform: 'darwin',
        parentPid: 99,
      },
      h.deps,
    );
    expect(proc.pid).toBe(4321);
    expect(h.connectPaths).toEqual([]);
    const call = h.spawnCalls[0];
    if (!call) throw new Error('spawn was not called');
    expect(call.options).toMatchObject({
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
    });
    expect(call.args).toEqual(['--idle=yes', '--input-ipc-client=fd://3']);
    void proc.client.command(['get_property', 'mpv-version']).catch(() => undefined);
    await new Promise((r) => setImmediate(r));
    expect(h.socket.written.join('')).toContain('"mpv-version"');
    h.child.exit(0);
    await expect(proc.exited).resolves.toEqual({ code: 0, signal: null });
  });

  function darwinWindowDeps(widthForAttempt: (attempt: number) => number) {
    const children: FakeChild[] = [];
    const deps: SpawnDeps = {
      spawn: (() => {
        const child = new FakeChild();
        const attempt = children.length;
        child.pid = 5000 + attempt;
        const sock = new Duplex({
          read() {},
          write(chunk: Buffer, _e, cb) {
            for (const line of chunk.toString().split('\n')) {
              if (!line) continue;
              const req = JSON.parse(line) as { request_id: number };
              const data = widthForAttempt(attempt);
              setImmediate(() =>
                sock.push(
                  `${JSON.stringify({ request_id: req.request_id, error: 'success', data })}\n`,
                ),
              );
            }
            cb();
          },
        });
        child.stdio = [null, null, null, sock];
        children.push(child);
        return child;
      }) as unknown as SpawnDeps['spawn'],
      connect: (() => {
        throw new Error('unused');
      }) as unknown as SpawnDeps['connect'],
      retryDelayMs: 2,
      darwinWindowTimeoutMs: 15,
    };
    return { children, deps };
  }

  it('darwin spawn with --force-window=immediate retries when osd-width stays 0', async () => {
    const { children, deps } = darwinWindowDeps((i) => (i === 0 ? 0 : 640));
    const proc = await spawnMpv(
      {
        executable: '/Applications/ELV IPTV Player.app/Contents/MacOS/mpv',
        args: ['--idle=yes', '--force-window=immediate'],
        platform: 'darwin',
        parentPid: 99,
      },
      deps,
    );
    expect(children).toHaveLength(2);
    expect(children[0]?.killed).toBe(true);
    expect(proc.pid).toBe(5001);
    children[1]?.exit(0);
    await proc.exited;
  });

  it('darwin spawn with --force-window=immediate rejects when osd-width never initializes', async () => {
    const { children, deps } = darwinWindowDeps(() => 0);
    await expect(
      spawnMpv(
        {
          executable: '/Applications/ELV IPTV Player.app/Contents/MacOS/mpv',
          args: ['--force-window=immediate'],
          platform: 'darwin',
          parentPid: 99,
          connectTimeoutMs: 25,
        },
        deps,
      ),
    ).rejects.toThrow(/window did not initialize/);
    expect(children[0]?.killed).toBe(true);
  });

  it('linux spawn uses a temporary Unix socket and cleans its directory on exit', async () => {
    const h = harness();
    const proc = await spawnMpv(
      { executable: 'mpv', args: ['--idle=yes'], platform: 'linux', parentPid: 99 },
      h.deps,
    );
    const sockPath = h.connectPaths[0] ?? '';
    expect(sockPath).toMatch(/\.sock$/);
    h.child.exit(0);
    await proc.exited;
  });

  it('uses a different pipe name on every launch', async () => {
    const a = harness();
    const b = harness();
    await spawnMpv(base, a.deps);
    await spawnMpv(base, b.deps);
    expect(a.connectPaths[0]).not.toBe(b.connectPaths[0]);
  });

  it('rejects and reports when the child exits before the pipe is up', async () => {
    const h = harness(1000);
    const result = spawnMpv(base, h.deps);
    setTimeout(() => h.child.exit(3), 10);
    await expect(result).rejects.toThrow(/exited with code 3/);
  });

  it('kills the child and rejects when the pipe never appears', async () => {
    const h = harness(100000);
    await expect(spawnMpv({ ...base, connectTimeoutMs: 30 }, h.deps)).rejects.toThrow(
      /did not open/,
    );
    expect(h.child.killed).toBe(true);
  });

  it('kills the child and rejects with AbortError when the signal aborts', async () => {
    const h = harness(100000);
    const ac = new AbortController();
    const result = spawnMpv({ ...base, signal: ac.signal }, h.deps);
    setTimeout(() => ac.abort(), 5);
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.child.killed).toBe(true);
  });

  it('rejects at once for a signal that is already aborted', async () => {
    const h = harness();
    const ac = new AbortController();
    ac.abort();
    await expect(spawnMpv({ ...base, signal: ac.signal }, h.deps)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(h.spawnCalls).toHaveLength(0);
  });

  it('exited resolves with the exit code', async () => {
    const h = harness();
    const proc = await spawnMpv(base, h.deps);
    h.child.exit(0);
    await expect(proc.exited).resolves.toEqual({ code: 0, signal: null });
  });

  it('quit sends quit and waits for the exit without killing', async () => {
    const h = harness();
    const proc = await spawnMpv(base, h.deps);
    const quitting = proc.quit(500);
    await new Promise((r) => setImmediate(r));
    expect(h.socket.written.join('')).toContain('"quit"');
    h.child.exit(0);
    await quitting;
    expect(h.child.killed).toBe(false);
  });

  it('quit kills the child after the grace period', async () => {
    const h = harness();
    const proc = await spawnMpv(base, h.deps);
    await proc.quit(20);
    expect(h.child.killed).toBe(true);
  });

  it('records the pid while running and forgets it on exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elv-pid-'));
    const file = join(dir, 'mpv-pids.json');
    try {
      const h = harness();
      const proc = await spawnMpv({ ...base, pidFile: file }, h.deps);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([4321]);
      h.child.exit(0);
      await proc.exited;
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pid file', () => {
  const temp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'elv-pid-'));
    return { dir, file: join(dir, 'mpv-pids.json') };
  };

  it('sweeps a recorded leftover launcher pid and ignores a reused pid', async () => {
    const { dir, file } = temp();
    try {
      recordPid(file, 111);
      recordPid(file, 222);
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
});

describe('systemSweepDeps', () => {
  it('does not take this test process for the launcher', async () => {
    expect(await systemSweepDeps.isLauncher(process.pid)).toBe(false);
  });
});

describe('spawnMpv start failure', () => {
  it('rejects early when the child cannot start and records no pid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elv-pid-'));
    const file = join(dir, 'mpv-pids.json');
    try {
      const h = harness(100000);
      h.child.pid = undefined as unknown as number;
      const result = spawnMpv(
        { executable: 'x', args: [], platform: 'win32', parentPid: 1, pidFile: file },
        h.deps,
      );
      setTimeout(() => h.child.emit('error', new Error('ENOENT')), 5);
      await expect(result).rejects.toThrow(/could not start: ENOENT/);
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('darwin spawn rejects when the child cannot start', async () => {
    const h = harness();
    h.child.pid = undefined as unknown as number;
    const result = spawnMpv(
      { executable: '/missing/mpv', args: [], platform: 'darwin', parentPid: 1 },
      h.deps,
    );
    setTimeout(() => h.child.emit('error', new Error('ENOENT')), 5);
    await expect(result).rejects.toThrow(/could not start: ENOENT/);
  });

  it('linux spawn cleans its temporary socket directory when spawn emits error without exit', async () => {
    let seenSockPath = '';
    const child = new EventEmitter() as EventEmitter & {
      pid: undefined;
      killed: boolean;
      kill(): boolean;
    };
    child.pid = undefined;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      return true;
    };
    const deps: SpawnDeps = {
      spawn: ((_cmd: string, args: string[]) => {
        const arg = args.find((a) => a.startsWith('--input-ipc-server=')) ?? '';
        seenSockPath = arg.slice('--input-ipc-server='.length);
        setTimeout(() => child.emit('error', new Error('ENOENT')), 5);
        return child;
      }) as unknown as SpawnDeps['spawn'],
      connect: (() => {
        const s = new EventEmitter() as EventEmitter & Duplex;
        setImmediate(() => s.emit('error', new Error('ENOENT')));
        return s;
      }) as unknown as SpawnDeps['connect'],
      retryDelayMs: 2,
    };
    await expect(
      spawnMpv({ executable: '/missing/mpv', args: [], platform: 'linux', parentPid: 1 }, deps),
    ).rejects.toThrow(/could not start: ENOENT/);
    const tempDir = join(seenSockPath, '..');
    expect(seenSockPath).toMatch(/\.sock$/);
    expect(existsSync(tempDir)).toBe(false);
  });

  it('win32 spawn kills the child and destroys the socket when signal aborts while tryConnect resolves', async () => {
    const ac = new AbortController();
    const child = new FakeChild();
    const socket = fakeSocket();
    const deps: SpawnDeps = {
      spawn: (() => child) as unknown as SpawnDeps['spawn'],
      connect: (() => {
        const attempt = new EventEmitter() as EventEmitter & Duplex;
        setImmediate(() => {
          ac.abort();
          attempt.emit('connect');
        });
        return Object.assign(socket, {
          once: attempt.once.bind(attempt),
          on: Duplex.prototype.on.bind(socket),
          off: attempt.off.bind(attempt),
        });
      }) as unknown as SpawnDeps['connect'],
    };
    await expect(
      spawnMpv(
        {
          executable: 'elv-mpv.exe',
          args: ['--idle=yes'],
          platform: 'win32',
          parentPid: 1,
          signal: ac.signal,
        },
        deps,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(child.killed).toBe(true);
    expect(socket.destroyed).toBe(true);
  });

  it('darwin spawn aborts promptly during the osd-width probe and if aborted before probe', async () => {
    const ac1 = new AbortController();
    const child1 = new FakeChild();
    const sock1 = fakeSocket();
    const deps1: SpawnDeps = {
      spawn: (() => {
        child1.stdio = [null, null, null, sock1];
        ac1.abort();
        return child1;
      }) as unknown as SpawnDeps['spawn'],
      connect: (() => {
        throw new Error('unused');
      }) as unknown as SpawnDeps['connect'],
    };
    await expect(
      spawnMpv(
        {
          executable: '/mpv',
          args: ['--idle=yes'],
          platform: 'darwin',
          parentPid: 1,
          signal: ac1.signal,
        },
        deps1,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(child1.killed).toBe(true);

    const ac2 = new AbortController();
    const child2 = new FakeChild();
    const sock2 = new Duplex({
      read() {},
      write(_chunk: Buffer, _e, cb) {
        // Never answer osd-width (simulating deadlocked cocoa-cb window), abort after 10 ms:
        setTimeout(() => ac2.abort(), 10);
        cb();
      },
    });
    const deps2: SpawnDeps = {
      spawn: (() => {
        child2.stdio = [null, null, null, sock2];
        return child2;
      }) as unknown as SpawnDeps['spawn'],
      connect: (() => {
        throw new Error('unused');
      }) as unknown as SpawnDeps['connect'],
      darwinWindowTimeoutMs: 2000,
    };
    const startedAt = Date.now();
    await expect(
      spawnMpv(
        {
          executable: '/mpv',
          args: ['--force-window=immediate'],
          platform: 'darwin',
          parentPid: 1,
          signal: ac2.signal,
        },
        deps2,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(child2.killed).toBe(true);
  });
});
