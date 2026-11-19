import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex, EventEmitter } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpawnDeps } from './process.ts';
import { spawnMpv, transportArgs, wrapProcess } from './process.ts';

class FakeChild extends EventEmitter {
  pid = 4321;
  killed = false;
  lastSignal: NodeJS.Signals | undefined;
  stdio: Array<Duplex | null> = [null, null, null];
  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.lastSignal = signal;
    queueMicrotask(() => this.emit('exit', null, signal ?? 'SIGKILL'));
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
  const failedSockets: Duplex[] = [];
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
      if (failures-- > 0) {
        const failed = fakeSocket();
        failedSockets.push(failed);
        setImmediate(() => failed.emit('error', new Error('ENOENT')));
        return failed;
      }
      setImmediate(() => socket.emit('connect'));
      return socket;
    }) as unknown as SpawnDeps['connect'],
    retryDelayMs: 1,
  };
  return { child, deps, spawnCalls, connectPaths, failedSockets, socket };
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

  it('spawns hidden, destroys failed retry sockets, and connects when pipe is ready', async () => {
    const h = harness(2);
    const proc = await spawnMpv(base, h.deps);
    expect(proc.pid).toBe(4321);
    expect(h.connectPaths).toHaveLength(3);
    expect(h.failedSockets).toHaveLength(2);
    expect(h.failedSockets.every((s) => s.destroyed)).toBe(true);
    expect(h.socket.destroyed).toBe(false);
    const call = h.spawnCalls[0];
    if (!call) throw new Error('spawn was not called');
    expect(call.options).toMatchObject({ windowsHide: true, stdio: 'ignore' });
    expect(call.args).toContain('--idle=yes');
    expect(call.args).toContain('--elv-parent-pid=99');
    expect(call.args.find((a) => a.startsWith('--input-ipc-server='))).toMatch(
      /^--input-ipc-server=\\\\\.\\pipe\\elv-mpv-[0-9a-f]{16}$/,
    );
  });

  it('linux spawn pins LC_NUMERIC=C (#237), uses a temp socket and cleans its dir after exit', async () => {
    const h = harness();
    const proc = await spawnMpv(
      { executable: 'mpv', args: ['--idle=yes'], platform: 'linux', parentPid: 99 },
      h.deps,
    );
    const sockPath = h.connectPaths[0] ?? '';
    const tempDir = join(sockPath, '..');
    expect(sockPath).toMatch(/\.sock$/);
    expect(existsSync(tempDir)).toBe(true);
    expect(h.spawnCalls[0]?.options).toMatchObject({
      env: expect.objectContaining({ LC_NUMERIC: 'C' }),
    });
    h.child.exit(0);
    await proc.exited;
    expect(existsSync(tempDir)).toBe(false);
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

  it('kills the child with SIGKILL and rejects when the pipe never appears', async () => {
    const h = harness(100000);
    await expect(spawnMpv({ ...base, connectTimeoutMs: 30 }, h.deps)).rejects.toThrow(
      /did not open/,
    );
    expect(h.child.killed).toBe(true);
    expect(h.child.lastSignal).toBe('SIGKILL');
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

  it('quit escalates to SIGKILL after graceMs and never deadlocks if exited hangs', async () => {
    const signals: Array<NodeJS.Signals | undefined> = [];
    const neverExits = new Promise<{ code: number | null; signal: string | null }>(() => {});
    const closed = vi.fn();
    const proc = wrapProcess(
      999,
      {
        command: () => Promise.resolve({ request_id: 1, error: 'success' }),
        observe: () => 1,
        onEvent: () => () => undefined,
        onClose: () => () => undefined,
        close: closed,
      },
      neverExits,
      (sig) => signals.push(sig),
      15,
    );

    const startedAt = Date.now();
    await proc.quit(15);
    expect(Date.now() - startedAt).toBeLessThan(300);
    expect(signals).toEqual(['SIGKILL']);
    expect(closed).toHaveBeenCalledTimes(1);
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
        const s = fakeSocket();
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
        setImmediate(() => {
          ac.abort();
          socket.emit('connect');
        });
        return socket;
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
});
